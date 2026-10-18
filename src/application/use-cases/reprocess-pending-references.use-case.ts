import type { OperationalObservabilityPort, OperationalResult } from '../ports/operational-observability';
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

export function isTransientError(err: unknown): boolean {
  if (!err) return false;
  const errorObj = err as any;
  const message = (errorObj.message || String(err)).toLowerCase();
  const code = String(errorObj.code || errorObj.sqlState || '');

  const transientCodes = [
    '40P01',
    '55P03',
    '40001',
    '57P01',
    '57014',
    '08006',
    '08001',
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
  ];
  if (transientCodes.includes(code)) {
    return true;
  }

  const transientPatterns = [
    'deadlock',
    'lock timeout',
    'statement timeout',
    'canceling statement due to statement timeout',
    'could not obtain lock',
    'serialization failure',
    'connection timeout',
    'connection terminated',
    'transient',
    'socket hang up',
    'econnreset',
    'etimedout',
    'econnrefused',
  ];

  return transientPatterns.some((pattern) => message.includes(pattern));
}

type ReprocessItemOutcome =
  | { outcome: 'PROCESSED'; transactionId: string; attempts: number; providerId?: string }
  | { outcome: 'REJECTED'; transactionId: string; attempts: number; failureCode?: string; providerId?: string }
  | { outcome: 'RESCHEDULED' | 'PENDING_REFERENCE'; transactionId: string; attempts: number; providerId?: string }
  | { outcome: 'BLOCKED'; transactionId: string; reason: string; providerId?: string }
  | { outcome: 'SKIPPED' };

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
    winProcessor?: WinProcessor,
    private readonly telemetry?: OperationalObservabilityPort
  ) {
    this.reversalProcessor =
      reversalProcessor ??
      new ReversalProcessor(this.walletRepo, this.wagerRepo, this.ledgerRepo, this.outboxRepo);
    this.winProcessor =
      winProcessor ??
      new WinProcessor(this.walletRepo, this.wagerRepo, this.ledgerRepo, this.outboxRepo);
  }

  private logStructured(logData: Record<string, any>): void {
    const results: Record<string, OperationalResult> = {
      PENDING_REFERENCES_CLAIMED: 'claimed', PENDING_REFERENCE_RESOLVED: logData.outcome === 'PROCESSED' ? 'processed' : 'rejected',
      PENDING_REFERENCE_RESCHEDULED: 'rescheduled', PENDING_REFERENCE_OPERATIONALLY_BLOCKED: 'blocked',
      PENDING_REFERENCE_STALE_LEASE: 'stale_lease', PENDING_REFERENCE_SHUTDOWN_ABORTED: 'aborted',
      PENDING_REFERENCE_TRANSIENT_FAILURE: 'transient_failure', PENDING_REFERENCE_UNEXPECTED_ERROR: 'unexpected_failure',
    };
    this.telemetry?.event('references', 'reprocess', results[logData.event] ?? 'unknown', {
      transactionId: logData.transactionId,
      correlationId: null,
      durationMs: logData.durationMs ?? 0,
      walletId: logData.walletId ?? null,
      providerId: logData.providerId ?? null,
      messageId: logData.messageId ?? null,
    });
  }

  public async execute(
    limit = 20,
    leaseDurationMs = 30000,
    workerId = 'worker',
    abortSignal?: AbortSignal
  ): Promise<ReprocessResult> {
    if (abortSignal?.aborted) {
      return { processed: 0, rejected: 0, rescheduled: 0, blocked: 0, failed: 0 };
    }

    const claimStarted = performance.now();
    const claimedList = await this.wagerRepo.claimPendingReferences(limit, leaseDurationMs, workerId);

    if (claimedList.length === 0) {
      return { processed: 0, rejected: 0, rescheduled: 0, blocked: 0, failed: 0 };
    }

    this.logStructured({
      level: 'info',
      event: 'PENDING_REFERENCES_CLAIMED',
      durationMs: performance.now() - claimStarted,
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
      const started = performance.now();
      let itemProviderId: string | null = null;
      if (abortSignal?.aborted) {
        break;
      }

      try {
        const itemResult = await this.uow.runInTransaction<ReprocessItemOutcome>(async () => {
          if (abortSignal?.aborted) {
            throw new Error('ABORTED_BY_SHUTDOWN');
          }

          // Canonical lock order: lock wallet first, then transaction
          const wallet = await this.walletRepo.findById(claimed.walletId, true);
          if (!wallet) {
            await this.wagerRepo.releaseLease(claimed.id, claimed.leaseToken);
            return { outcome: 'SKIPPED' };
          }

          // Fetch fresh transaction state under pessimistic write lock
          const tx = await this.wagerRepo.findById(claimed.id, true);
          if (!tx) {
            return { outcome: 'SKIPPED' };
          }
          itemProviderId = tx.providerId;

          // If already terminal, do not repeat movements or events (idempotency)
          if (tx.isTerminal()) {
            return { outcome: 'SKIPPED' };
          }

          // Verify lease token matches what this worker claimed
          if (tx.leaseToken !== claimed.leaseToken) {
            throw new StaleLeaseError(
              `Lease token mismatch for transaction ${claimed.id}. Claimed: ${claimed.leaseToken}, DB: ${tx.leaseToken}`
            );
          }

          // Validate lease validity and expiration strictly using PostgreSQL clock
          const isLeaseActive = await this.wagerRepo.isLeaseValid(claimed.id, claimed.leaseToken);
          if (!isLeaseActive) {
            throw new StaleLeaseError(
              `Lease is no longer active in PostgreSQL for transaction ${claimed.id} with token ${claimed.leaseToken}`
            );
          }

          // If already operationally blocked, skip
          if (tx.isOperationallyBlocked) {
            return {
              outcome: 'BLOCKED',
              transactionId: tx.id,
              reason: tx.operationalBlockReason ?? 'ALREADY_BLOCKED',
              providerId: tx.providerId,
            };
          }

          // Validate snapshot strictly before processing
          try {
            validateReplaySnapshot(tx.responseSnapshot, tx);
          } catch (snapErr) {
            const reason = snapErr instanceof Error ? snapErr.message : 'INVALID_SNAPSHOT';
            const blockedOk = await this.wagerRepo.markOperationallyBlocked(
              claimed.id,
              claimed.leaseToken,
              reason
            );

            if (!blockedOk) {
              throw new StaleLeaseError(
                `Failed to apply operational block: lease is stale for transaction ${claimed.id}`
              );
            }

            return {
              outcome: 'BLOCKED',
              transactionId: tx.id,
              reason,
              providerId: tx.providerId,
            };
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

            return {
              outcome: 'REJECTED',
              transactionId: tx.id,
              attempts: tx.attempts,
              failureCode: 'REFERENCE_NOT_FOUND',
              providerId: tx.providerId,
            };
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

            return {
              outcome: result.outcome,
              transactionId: tx.id,
              attempts: tx.attempts,
              providerId: tx.providerId,
            };
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

            return {
              outcome: result.outcome,
              transactionId: tx.id,
              attempts: tx.attempts,
              providerId: tx.providerId,
            };
          }

          return { outcome: 'SKIPPED' };
        }, abortSignal);

        // ONLY update counters and emit success logs AFTER transaction commit confirmation
        if (itemResult.outcome === 'PROCESSED') {
          processed++;
          this.logStructured({
            level: 'info',
            event: 'PENDING_REFERENCE_RESOLVED',
            workerId,
            transactionId: itemResult.transactionId,
            durationMs: performance.now() - started,
            outcome: 'PROCESSED',
            attempts: itemResult.attempts,
            walletId: claimed.walletId,
            providerId: itemResult.providerId ?? itemProviderId ?? null,
          });
        } else if (itemResult.outcome === 'REJECTED') {
          rejected++;
          this.logStructured({
            level: 'info',
            event: 'PENDING_REFERENCE_RESOLVED',
            workerId,
            transactionId: itemResult.transactionId,
            durationMs: performance.now() - started,
            outcome: 'REJECTED',
            failureCode: itemResult.failureCode,
            attempts: itemResult.attempts,
            walletId: claimed.walletId,
            providerId: itemResult.providerId ?? itemProviderId ?? null,
          });
        } else if (itemResult.outcome === 'RESCHEDULED' || itemResult.outcome === 'PENDING_REFERENCE') {
          rescheduled++;
          this.logStructured({
            level: 'info',
            event: 'PENDING_REFERENCE_RESCHEDULED',
            workerId,
            transactionId: itemResult.transactionId,
            durationMs: performance.now() - started,
            attempts: itemResult.attempts,
            walletId: claimed.walletId,
            providerId: itemResult.providerId ?? itemProviderId ?? null,
          });
        } else if (itemResult.outcome === 'BLOCKED') {
          blocked++;
          this.logStructured({
            level: 'error',
            event: 'PENDING_REFERENCE_OPERATIONALLY_BLOCKED',
            workerId,
            transactionId: itemResult.transactionId,
            durationMs: performance.now() - started,
            reason: itemResult.reason,
            walletId: claimed.walletId,
            providerId: itemResult.providerId ?? itemProviderId ?? null,
          });
        }
      } catch (err) {
        if (err instanceof StaleLeaseError) {
          this.logStructured({
            level: 'warn',
            event: 'PENDING_REFERENCE_STALE_LEASE',
            workerId,
            transactionId: claimed.id,
            durationMs: performance.now() - started,
            error: err.message,
            walletId: claimed.walletId,
            providerId: itemProviderId ?? null,
          });
          continue;
        }

        const isShutdownAborted =
          abortSignal?.aborted ||
          (err instanceof Error &&
            (err.message === 'ABORTED_BY_SHUTDOWN' ||
              err.message === 'DRAIN_TIMEOUT_EXCEEDED' ||
              err.message.includes('rollback-only') ||
              (err as any).cause?.message === 'DRAIN_TIMEOUT_EXCEEDED' ||
              (err as any).rollbackReason?.message === 'DRAIN_TIMEOUT_EXCEEDED'));

        if (isShutdownAborted) {
          this.logStructured({
            level: 'warn',
            event: 'PENDING_REFERENCE_SHUTDOWN_ABORTED',
            workerId,
            transactionId: claimed.id,
            durationMs: performance.now() - started,
            reason: err instanceof Error ? err.message : String(err),
            walletId: claimed.walletId,
            providerId: itemProviderId ?? null,
          });
          break;
        }

        if (isTransientError(err)) {
          // Known transient error: safe retry without consuming attempts or falsely rejecting
          try {
            await this.wagerRepo.releaseLease(claimed.id, claimed.leaseToken);
          } catch {
            // Lease will expire naturally in DB
          }

          this.logStructured({
            level: 'warn',
            event: 'PENDING_REFERENCE_TRANSIENT_FAILURE',
            workerId,
            transactionId: claimed.id,
            durationMs: performance.now() - started,
            error: err instanceof Error ? err.message : String(err),
            walletId: claimed.walletId,
            providerId: itemProviderId ?? null,
          });

          failed++;
          continue;
        }

        // Permanent / unexpected defect: explicit auditable signaling without calling everything transient
        try {
          await this.wagerRepo.releaseLease(claimed.id, claimed.leaseToken);
        } catch {
          // Lease will expire naturally in DB
        }

        this.logStructured({
          level: 'error',
          event: 'PENDING_REFERENCE_UNEXPECTED_ERROR',
          workerId,
          transactionId: claimed.id,
          errorName: err instanceof Error ? err.name : 'UnknownError',
          errorMessage: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          walletId: claimed.walletId,
          providerId: itemProviderId ?? null,
        });

        failed++;
        // Continue to the next claimed item in the batch: one failure cannot block the rest of the batch
      }
    }

    return { processed, rejected, rescheduled, blocked, failed };
  }
}
