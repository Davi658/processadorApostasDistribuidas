export class MoneyDto {
  amount!: string;
  currency!: string;
}

export class ProcessBetDto {
  providerId!: string;
  externalTransactionId!: string;
  playerId!: string;
  walletId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  money!: MoneyDto;
}

export class WagerResponseDto {
  status!: 'PROCESSED' | 'REJECTED';
  transactionId!: string;
  walletId!: string;
  providerId!: string;
  externalTransactionId!: string;
  amount!: string;
  currency!: string;
  observedBalance!: string;
  reason?: string | null;
}
