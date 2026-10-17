import { CurrencyMismatchError, WalletNotFoundError } from '../../domain/errors/domain.error';
import { ReconciliationResponseDto } from '../dto/wallet.dto';
import { UnitOfWorkPort, WalletLedgerRepositoryPort, WalletRepositoryPort } from '../ports/ports';

// Report totals may exceed a single NUMERIC(18,2) column, especially when diagnosing drift.
function formatCents(cents: bigint): string {
  const magnitude = cents < 0n ? -cents : cents;
  return `${cents < 0n ? '-' : ''}${magnitude / 100n}.${(magnitude % 100n).toString().padStart(2, '0')}`;
}

export class ReconcileWalletUseCase {
  constructor(
    private readonly walletRepo: WalletRepositoryPort,
    private readonly ledgerRepo: WalletLedgerRepositoryPort,
    private readonly uow: UnitOfWorkPort
  ) {}

  public async execute(walletId: string): Promise<ReconciliationResponseDto> {
    if (!walletId || typeof walletId !== 'string' || walletId.trim() === '') {
      throw new WalletNotFoundError(walletId);
    }

    return this.uow.runInTransaction(async () => {
      // Consistent read view using row lock on the wallet
      const wallet = await this.walletRepo.findById(walletId.trim(), true);
      if (!wallet) {
        throw new WalletNotFoundError(walletId.trim());
      }

      const entries = await this.ledgerRepo.listByWalletId(wallet.id);

      // Timestamp/UUID order is not a financial sequence. Bound only persisted Money,
      // not intermediate report sums, so high turnover cannot overflow reconciliation.
      let calculatedCents = 0n;

      for (const entry of entries) {
        if (entry.amount.getCurrency() !== wallet.currency) {
          throw new CurrencyMismatchError('Ledger amount currency does not match wallet currency');
        }
        if (entry.entryType === 'CREDIT') {
          calculatedCents += entry.amount.getCents();
        } else if (entry.entryType === 'DEBIT') {
          calculatedCents -= entry.amount.getCents();
        }
      }

      const differenceCents = wallet.balance.getCents() - calculatedCents;
      const consistent = differenceCents === 0n;

      return {
        walletId: wallet.id,
        storedBalance: {
          amount: wallet.balance.getAmount(),
          currency: wallet.currency,
        },
        calculatedBalance: {
          amount: formatCents(calculatedCents),
          currency: wallet.currency,
        },
        difference: {
          amount: formatCents(differenceCents),
          currency: wallet.currency,
        },
        consistent,
        checkedEntries: entries.length,
      };
    });
  }
}
