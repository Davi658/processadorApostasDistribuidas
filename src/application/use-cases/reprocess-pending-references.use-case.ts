import {
  OutboxRepositoryPort,
  UnitOfWorkPort,
  WagerTransactionRepositoryPort,
  WalletLedgerRepositoryPort,
  WalletRepositoryPort,
} from '../ports/ports';
import { ReversalProcessor } from '../services/reversal-processor.service';

export interface ReprocessResult {
  processed: number;
  rejected: number;
  rescheduled: number;
}

export class ReprocessPendingReferencesUseCase {
  private readonly reversalProcessor: ReversalProcessor;

  constructor(
    private readonly walletRepo: WalletRepositoryPort,
    private readonly wagerRepo: WagerTransactionRepositoryPort,
    private readonly ledgerRepo: WalletLedgerRepositoryPort,
    private readonly outboxRepo: OutboxRepositoryPort,
    private readonly uow: UnitOfWorkPort,
    private readonly maxAttempts = 5,
    reversalProcessor?: ReversalProcessor
  ) {
    this.reversalProcessor =
      reversalProcessor ??
      new ReversalProcessor(this.walletRepo, this.wagerRepo, this.ledgerRepo, this.outboxRepo);
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

        const refId = tx.referenceExternalTransactionId;
        if (!refId) {
          const rejectedTx = tx.markRejected('REFERENCE_NOT_FOUND');
          await this.wagerRepo.save(rejectedTx);
          rejected++;
          return;
        }

        const wallet = await this.walletRepo.findById(tx.walletId, true);
        if (!wallet) return;

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
      });
    }

    return { processed, rejected, rescheduled };
  }
}
