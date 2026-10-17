import type { WagerTransaction } from '../../domain/entities/wager-transaction.entity';
import { MoneyObjectDto } from './common.dto';

export interface WagerTransactionQueryResponseDto {
  id: string;
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyObjectDto;
  status: string;
  rejectionReason: string | null;
  referenceExternalTransactionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toWagerTransactionQueryResponse(tx: WagerTransaction): WagerTransactionQueryResponseDto {
  return {
    id: tx.id,
    walletId: tx.walletId,
    playerId: tx.playerId,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: { amount: tx.money.getAmount(), currency: tx.money.getCurrency() },
    status: tx.status,
    rejectionReason: tx.rejectionReason,
    referenceExternalTransactionId: tx.referenceExternalTransactionId,
    createdAt: tx.createdAt,
    updatedAt: tx.updatedAt,
  };
}
