import { WagerTransaction } from '../../domain/entities/wager-transaction.entity';
import { ReplaySnapshotUnavailableError } from '../../domain/errors/domain.error';
import { Money } from '../../domain/value-objects/money.vo';
import { WagerResponseDto } from '../dto/wager.dto';

/**
 * Validates the structure and consistency of a persisted wager responseSnapshot
 * before executing an idempotent replay or rescheduling.
 *
 * Rules:
 * - transactionId corresponds to the persisted transaction record;
 * - status corresponds to the persisted entity status ('PROCESSED', 'REJECTED', 'PENDING_REFERENCE');
 * - balance contains canonical amount, non-negative and matching currency;
 * - REJECTED status contains a consistent failureCode;
 * - Non-rejected states do NOT carry any failureCode;
 * - Never silently complete or normalize corrupted snapshots.
 *
 * Throws ReplaySnapshotUnavailableError if the snapshot is missing, incomplete, or corrupted.
 */
export function validateReplaySnapshot(
  snapshot: unknown,
  tx: WagerTransaction
): WagerResponseDto {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new ReplaySnapshotUnavailableError();
  }

  const snap = snapshot as Record<string, any>;

  // 1. transactionId must match the persistent transaction record
  if (typeof snap.transactionId !== 'string' || snap.transactionId !== tx.id) {
    throw new ReplaySnapshotUnavailableError();
  }

  // 2. status must match the persistent transaction status and be a valid response status
  const validStatuses = ['PROCESSED', 'REJECTED', 'PENDING_REFERENCE'];
  if (!validStatuses.includes(snap.status) || snap.status !== tx.status) {
    throw new ReplaySnapshotUnavailableError();
  }

  // 3. balance structure, currency and canonical amount check
  if (!snap.balance || typeof snap.balance !== 'object' || Array.isArray(snap.balance)) {
    throw new ReplaySnapshotUnavailableError();
  }

  const { amount, currency } = snap.balance;
  if (typeof amount !== 'string' || typeof currency !== 'string') {
    throw new ReplaySnapshotUnavailableError();
  }

  if (currency !== tx.currency) {
    throw new ReplaySnapshotUnavailableError();
  }

  try {
    // Money.create enforces non-negative, canonical 2-decimal scale, max digits, ISO currency
    Money.create(amount, currency);
  } catch {
    throw new ReplaySnapshotUnavailableError();
  }

  // 4. Failure code consistency
  if (tx.status === 'REJECTED') {
    if (typeof snap.failureCode !== 'string' || snap.failureCode.trim().length === 0) {
      throw new ReplaySnapshotUnavailableError();
    }
    if (tx.rejectionReason && snap.failureCode !== tx.rejectionReason) {
      throw new ReplaySnapshotUnavailableError();
    }
  } else {
    if (snap.failureCode !== undefined && snap.failureCode !== null) {
      throw new ReplaySnapshotUnavailableError();
    }
  }

  // Preserve historical response without mutating or normalizing fields,
  // modifying only idempotentReplay: true.
  return {
    transactionId: snap.transactionId,
    status: snap.status,
    balance: {
      amount: snap.balance.amount,
      currency: snap.balance.currency,
    },
    ...(snap.failureCode !== undefined && snap.failureCode !== null ? { failureCode: snap.failureCode } : {}),
    idempotentReplay: true,
  };
}
