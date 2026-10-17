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
import { StaleLeaseError } from '../../domain/errors/domain.error';
import { validateReplaySnapshot } from '../validators/snapshot.validator';

export interface ReprocessResult {
  processed: number;
  rejected: number;
  rescheduled: number;
  blocked?: number;
  failed?: number;
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

  private logStructured(logData: Record<string, any>): void {
    // Strictly strip any financial payloads or sensitive amounts
    const { amount, balance, money, payload, ...safeData } = logData;
    console.log(JSON.stringify(safeData));
  }

  public async execute(
    limit = 20,
    leaseDurationMs = 30000,
    workerId = 'worker'
  ): Promise<ReprocessResult> {
    const claimedList = await this.wagerRepo.claimPendingReferences(limit, leaseDurationMs, workerId);

    if (claimedList.length === 0) {
      return { processed: 0, rejected: 0, rescheduled: 0, blocked: 0, failed: 0 };
    }

    this.logStructured({
      level: 'info',
      event: 'PENDING_REFERENCES_CLAIMED',
      workerId,
      count: claimedList.length,
      transactionIds: claimedList.map((c) => c.id),
    });

    let processed = 0;
    let rejected = 0;
    let rescheduled = 0;
    let blocked = 0;
    let failed = 0;

    for (const claimed of claimedList) {
      try {
        await this.uow.runInTransaction(async () => {
          // Canonical lock order: lock wallet first, then transaction
          const wallet = await this.walletRepo.findById(claimed.walletId, true);
          if (!wallet) {
            await this.wagerRepo.releaseLease(claimed.id, claimed.leaseToken);
            return;
          }

          // Fetch fresh transaction state under pessimistic write lock
          const tx = await this.wagerRepo.findById(claimed.id, true);
          if (!tx) {
            return;
          }

          // If already terminal, do not repeat movements or events (idempotency)
          if (tx.isTerminal()) {
            return;
          }

          // Verify lease token matches what this worker claimed
          if (tx.leaseToken !== claimed.leaseToken) {
            throw new StaleLeaseError(
              `Lease token mismatch for transaction ${claimed.id}. Claimed: ${claimed.leaseToken}, DB: ${tx.leaseToken}`
            );
          }

          // Verify lease expiration
          if (tx.leaseExpiresAt && new Date(tx.leaseExpiresAt).getTime() < Date.now()) {
            throw new StaleLeaseError(
              `Lease expired for transaction ${claimed.id} at ${tx.leaseExpiresAt}`
            );
          }

          // If already operationally blocked, skip
          if (tx.isOperationallyBlocked) {
            blocked++;
            return;
          }

          // Validate snapshot strictly before processing
          try {
            validateReplaySnapshot(tx.responseSnapshot, tx);
          } catch (snapErr) {
            // Insecure fallbacks are prohibited. Register separate auditable operational block
            const reason = snapErr instanceof Error ? snapErr.message : 'INVALID_SNAPSHOT';
            const blockedTx = tx.markOperationallyBlocked(reason);
            await this.wagerRepo.save(blockedTx);

            this.logStructured({
              level: 'error',
              event: 'PENDING_REFERENCE_OPERATIONALLY_BLOCKED',
              workerId,
              transactionId: tx.id,
              providerId: tx.providerId,
              externalTransactionId: tx.externalTransactionId,
              reason,
            });

            blocked++;
            return;
          }

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

            this.logStructured({
              level: 'info',
              event: 'PENDING_REFERENCE_RESOLVED',
              workerId,
              transactionId: tx.id,
              outcome: 'REJECTED',
              failureCode: 'REFERENCE_NOT_FOUND',
              attempts: tx.attempts,
            });

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

            this.logStructured({
              level: 'info',
              event: 'PENDING_REFERENCE_RESOLVED',
              workerId,
              transactionId: tx.id,
              outcome: result.outcome,
              attempts: tx.attempts,
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

            this.logStructured({
              level: 'info',
              event: 'PENDING_REFERENCE_RESOLVED',
              workerId,
              transactionId: tx.id,
              outcome: result.outcome,
              attempts: tx.attempts,
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
      } catch (err) {
        if (err instanceof StaleLeaseError) {
          this.logStructured({
            level: 'warn',
            event: 'PENDING_REFERENCE_STALE_LEASE',
            workerId,
            transactionId: claimed.id,
            error: err.message,
          });
          continue;
        }

        // Transient infrastructure failure:
        // Do not consume business retry attempts or falsely reject.
        // Release lease immediately for retry.
        try {
          await this.wagerRepo.releaseLease(claimed.id, claimed.leaseToken);
        } catch {
          // If DB is unreachable, lease will expire naturally
        }

        this.logStructured({
          level: 'warn',
          event: 'PENDING_REFERENCE_TRANSIENT_FAILURE',
          workerId,
          transactionId: claimed.id,
          error: err instanceof Error ? err.message : String(err),
        });

        failed++;
        // Continue to the next claimed item in the batch
      }
    }

    return { processed, rejected, rescheduled, blocked, failed };
  }
}
