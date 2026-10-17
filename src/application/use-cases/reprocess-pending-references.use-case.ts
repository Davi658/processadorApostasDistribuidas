import {
  OutboxRepositoryPort,
  UnitOfWorkPort,
  WagerTransactionRepositoryPort,
  WalletLedgerRepositoryPort,
  WalletRepositoryPort,
} from '../ports/ports';
import { ReversalProcessor } from '../services/reversal-processor.service';
import { WinProcessor } from '../services/win-processor.service';
import { WagerResponseDto } from '../dto/wager.dto';
import { WagerTransactionRejectedEvent } from '../../domain/events/events';

export interface ReprocessResult {
  processed: number;
  rejected: number;
  rescheduled: number;
}

export class ReprocessPendingReferencesUseCase {
  private readonly reversalProcessor: ReversalProcessor;
  private readonly winProcessor: WinProcessor;

  constructor(
    private readonly walletRepo: WalletRepositoryPort,
    private readonly wagerRepo: WagerTransactionRepositoryPort,
    private readonly ledgerRepo: WalletLedgerRepositoryPort,
    private readonly outboxRepo: OutboxRepositoryPort,
    private readonly uow: UnitOfWorkPort,
    private readonly maxAttempts = 5,
    reversalProcessor?: ReversalProcessor,
    winProcessor?: WinProcessor
  ) {
    this.reversalProcessor =
      reversalProcessor ??
      new ReversalProcessor(this.walletRepo, this.wagerRepo, this.ledgerRepo, this.outboxRepo);
    this.winProcessor =
      winProcessor ??
      new WinProcessor(this.walletRepo, this.wagerRepo, this.ledgerRepo, this.outboxRepo);
  }

  public async execute(limit = 20): Promise<ReprocessResult> {
    const pendingList = await this.wagerRepo.listPendingReferences(limit);
    let processed = 0;
    let rejected = 0;
    let rescheduled = 0;

    for (const pending of pendingList) {
      await this.uow.runInTransaction(async () => {
        // Fetch fresh state under transaction
        const tx = await this.wagerRepo.findById(pending.id);
        if (!tx || tx.status !== 'PENDING_REFERENCE') {
          return;
        }

        const wallet = await this.walletRepo.findById(tx.walletId, true);
        if (!wallet) return;

        const refId = tx.referenceExternalTransactionId;
        if (!refId) {
          const response: WagerResponseDto = {
            transactionId: tx.id,
            status: 'REJECTED',
            failureCode: 'REFERENCE_NOT_FOUND',
            balance: { amount: wallet.balance.getAmount(), currency: wallet.currency },
            idempotentReplay: false,
          };
          const rejectedTx = tx.markRejected('REFERENCE_NOT_FOUND', response);
          await this.wagerRepo.save(rejectedTx);

          const rejectedEvent = new WagerTransactionRejectedEvent({
            aggregateId: wallet.id,
            correlationId: crypto.randomUUID(),
            causationId: tx.idempotencyKey ?? undefined,
            data: {
              transactionId: tx.id,
              walletId: wallet.id,
              playerId: wallet.playerId,
              providerId: tx.providerId,
              externalTransactionId: tx.externalTransactionId,
              roundId: tx.roundId,
              gameId: tx.gameId,
              kind: tx.kind as any,
              amount: { amount: tx.money.getAmount(), currency: wallet.currency },
              balance: { amount: wallet.balance.getAmount(), currency: wallet.currency },
              failureCode: 'REFERENCE_NOT_FOUND',
              referenceExternalTransactionId: null,
            },
          });
          await this.outboxRepo.save(rejectedEvent);

          rejected++;
          return;
        }

        if (tx.kind === 'WIN') {
          const result = await this.winProcessor.processWin(wallet, {
            transactionId: tx.id,
            providerId: tx.providerId,
            externalTransactionId: tx.externalTransactionId,
            playerId: tx.playerId,
            walletId: tx.walletId,
            roundId: tx.roundId,
            gameId: tx.gameId,
            money: tx.money,
            referenceExternalTransactionId: refId,
            idempotencyKey: tx.idempotencyKey,
            payloadHash: tx.payloadHash,
            correlationId: crypto.randomUUID(),
            existingPendingTx: tx,
            maxAttempts: this.maxAttempts,
          });

          if (result.outcome === 'PROCESSED') {
            processed++;
          } else if (result.outcome === 'REJECTED') {
            rejected++;
          } else if (result.outcome === 'RESCHEDULED') {
            rescheduled++;
          }
        } else if (tx.kind === 'REFUND' || tx.kind === 'ROLLBACK') {
          const result = await this.reversalProcessor.processReversal(wallet, {
            transactionId: tx.id,
            providerId: tx.providerId,
            externalTransactionId: tx.externalTransactionId,
            playerId: tx.playerId,
            walletId: tx.walletId,
            roundId: tx.roundId,
            gameId: tx.gameId,
            kind: tx.kind as 'REFUND' | 'ROLLBACK',
            money: tx.money,
            referenceExternalTransactionId: refId,
            idempotencyKey: tx.idempotencyKey,
            payloadHash: tx.payloadHash,
            correlationId: crypto.randomUUID(),
            existingPendingTx: tx,
            maxAttempts: this.maxAttempts,
          });

          if (result.outcome === 'PROCESSED') {
            processed++;
          } else if (result.outcome === 'REJECTED') {
            rejected++;
          } else if (result.outcome === 'RESCHEDULED') {
            rescheduled++;
          }
        }
      });
    }

    return { processed, rejected, rescheduled };
  }
}
