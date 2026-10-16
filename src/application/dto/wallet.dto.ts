export class CreateWalletDto {
  playerId!: string;
  currency?: string;
  initialBalance?: string;
}

export class WalletResponseDto {
  walletId!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: string;
  updatedAt!: string;
}

export class ReconciliationResponseDto {
  walletId!: string;
  storedBalance!: string;
  calculatedBalance!: string;
  difference!: string;
  consistent!: boolean;
  checkedEntries!: number;
}
