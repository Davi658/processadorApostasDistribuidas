import { Money } from '../value-objects/money.vo';
import { InvalidWagerOperationError } from '../errors/domain.error';

export type WagerTransactionKind = 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK' | 'OPENING';
export type WagerTransactionStatus = 'PENDING' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED';

export interface WagerTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  status: WagerTransactionStatus;
  rejectionReason: string | null;
  idempotencyKey: string | null;
  payloadHash: string | null;
  responseSnapshot: Record<string, any> | null;
  referenceExternalTransactionId?: string | null;
  attempts?: number;
  nextAttemptAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export class WagerTransaction {
  public readonly id: string;
  public readonly walletId: string;
  public readonly playerId: string;
  public readonly providerId: string;
  public readonly externalTransactionId: string;
  public readonly roundId: string;
  public readonly gameId: string;
  public readonly kind: WagerTransactionKind;
  public readonly money: Money;
  public readonly status: WagerTransactionStatus;
  public readonly rejectionReason: string | null;
  public readonly idempotencyKey: string | null;
  public readonly payloadHash: string | null;
  public readonly responseSnapshot: Record<string, any> | null;
  public readonly referenceExternalTransactionId: string | null;
  public readonly attempts: number;
  public readonly nextAttemptAt: string | null;
  public readonly createdAt: string;
  public readonly updatedAt: string;

  public get currency(): string {
    return this.money.getCurrency();
  }

  private constructor(props: WagerTransactionProps) {
    this.id = props.id;
    this.walletId = props.walletId;
    this.playerId = props.playerId;
    this.providerId = props.providerId;
    this.externalTransactionId = props.externalTransactionId;
    this.roundId = props.roundId;
    this.gameId = props.gameId;
    this.kind = props.kind;
    this.money = props.money;
    this.status = props.status;
    this.rejectionReason = props.rejectionReason;
    this.idempotencyKey = props.idempotencyKey;
    this.payloadHash = props.payloadHash;
    this.responseSnapshot = props.responseSnapshot;
    this.referenceExternalTransactionId = props.referenceExternalTransactionId ?? null;
    this.attempts = props.attempts ?? 0;
    this.nextAttemptAt = props.nextAttemptAt ?? null;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;

    Object.freeze(this);
  }

  public isTerminal(): boolean {
    return ['PROCESSED', 'REJECTED', 'FAILED'].includes(this.status);
  }

  public markProcessed(responseSnapshot?: Record<string, any>): WagerTransaction {
    if (this.isTerminal()) {
      throw new InvalidWagerOperationError(`Cannot transition transaction from terminal status "${this.status}"`);
    }

    return new WagerTransaction({
      ...this,
      status: 'PROCESSED',
      responseSnapshot: responseSnapshot ?? this.responseSnapshot,
      updatedAt: new Date().toISOString(),
    });
  }

  public markRejected(failureCode: string, responseSnapshot?: Record<string, any>): WagerTransaction {
    if (this.isTerminal()) {
      throw new InvalidWagerOperationError(`Cannot transition transaction from terminal status "${this.status}"`);
    }

    return new WagerTransaction({
      ...this,
      status: 'REJECTED',
      rejectionReason: failureCode,
      responseSnapshot: responseSnapshot ?? this.responseSnapshot,
      updatedAt: new Date().toISOString(),
    });
  }

  public markFailed(reason: string): WagerTransaction {
    if (this.isTerminal()) {
      throw new InvalidWagerOperationError(`Cannot transition transaction from terminal status "${this.status}"`);
    }

    return new WagerTransaction({
      ...this,
      status: 'FAILED',
      rejectionReason: reason,
      updatedAt: new Date().toISOString(),
    });
  }

  public markPendingReference(nextAttemptAt: string): WagerTransaction {
    if (this.isTerminal()) {
      throw new InvalidWagerOperationError(`Cannot transition transaction from terminal status "${this.status}"`);
    }

    return new WagerTransaction({
      ...this,
      status: 'PENDING_REFERENCE',
      attempts: this.attempts + 1,
      nextAttemptAt,
      updatedAt: new Date().toISOString(),
    });
  }

  public static createPending(props: {
    id: string;
    walletId: string;
    playerId: string;
    providerId: string;
    externalTransactionId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: Money;
    idempotencyKey: string;
    payloadHash: string;
    referenceExternalTransactionId?: string | null;
  }): WagerTransaction {
    if (props.kind === 'BET' && !props.money.isPositive()) {
      throw new InvalidWagerOperationError('BET amount must be strictly greater than zero');
    }

    const now = new Date().toISOString();
    return new WagerTransaction({
      ...props,
      status: 'PENDING',
      rejectionReason: null,
      responseSnapshot: null,
      referenceExternalTransactionId: props.referenceExternalTransactionId ?? null,
      attempts: 0,
      nextAttemptAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  public static createPendingReference(props: {
    id: string;
    walletId: string;
    playerId: string;
    providerId: string;
    externalTransactionId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: Money;
    idempotencyKey: string;
    payloadHash: string;
    referenceExternalTransactionId: string;
    nextAttemptAt: string;
    responseSnapshot?: Record<string, any> | null;
  }): WagerTransaction {
    const now = new Date().toISOString();
    return new WagerTransaction({
      ...props,
      status: 'PENDING_REFERENCE',
      rejectionReason: null,
      responseSnapshot: props.responseSnapshot ?? null,
      attempts: 1,
      createdAt: now,
      updatedAt: now,
    });
  }

  public static createBet(props: {
    id: string;
    walletId: string;
    playerId: string;
    providerId: string;
    externalTransactionId: string;
    roundId: string;
    gameId: string;
    money: Money;
    status?: WagerTransactionStatus;
    rejectionReason?: string | null;
    idempotencyKey: string;
    payloadHash: string;
    responseSnapshot?: Record<string, any> | null;
  }): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidWagerOperationError('BET amount must be strictly greater than zero');
    }

    const now = new Date().toISOString();
    return new WagerTransaction({
      ...props,
      kind: 'BET',
      status: props.status ?? 'PENDING',
      rejectionReason: props.rejectionReason ?? null,
      responseSnapshot: props.responseSnapshot ?? null,
      referenceExternalTransactionId: null,
      attempts: 0,
      nextAttemptAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  public static createOpening(props: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
  }): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidWagerOperationError('Opening amount must be strictly greater than zero');
    }

    const now = new Date().toISOString();
    return new WagerTransaction({
      id: props.id,
      walletId: props.walletId,
      playerId: props.playerId,
      providerId: 'SYSTEM',
      externalTransactionId: `OPENING_${props.walletId}`,
      roundId: 'OPENING',
      gameId: 'OPENING',
      kind: 'OPENING',
      money: props.money,
      status: 'PROCESSED',
      rejectionReason: null,
      idempotencyKey: `OPENING_${props.walletId}`,
      payloadHash: null,
      responseSnapshot: {
        walletId: props.walletId,
        playerId: props.playerId,
        balance: props.money.getAmount(),
        currency: props.money.getCurrency(),
      },
      referenceExternalTransactionId: null,
      attempts: 0,
      nextAttemptAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  public static rehydrate(props: WagerTransactionProps): WagerTransaction {
    return new WagerTransaction(props);
  }
}
