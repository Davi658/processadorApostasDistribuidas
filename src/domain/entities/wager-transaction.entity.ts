import { Money } from '../value-objects/money.vo';
import { InvalidWagerOperationError } from '../errors/domain.error';

export type WagerTransactionKind = 'BET' | 'OPENING';
export type WagerTransactionStatus = 'PROCESSED' | 'REJECTED';

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
  public readonly createdAt: string;
  public readonly updatedAt: string;

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
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;

    Object.freeze(this);
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
    status: WagerTransactionStatus;
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
      rejectionReason: props.rejectionReason ?? null,
      responseSnapshot: props.responseSnapshot ?? null,
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
      createdAt: now,
      updatedAt: now,
    });
  }

  public static rehydrate(props: WagerTransactionProps): WagerTransaction {
    return new WagerTransaction(props);
  }
}
