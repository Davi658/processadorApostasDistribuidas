import { Money } from '../../domain/value-objects/money.vo';
import { WalletNotFoundError } from '../../domain/errors/domain.error';
import { ReconciliationResponseDto } from '../dto/wallet.dto';
import { UnitOfWorkPort, WalletLedgerRepositoryPort, WalletRepositoryPort } from '../ports/ports';

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

      let calculated = Money.zero(wallet.currency);

      for (const entry of entries) {
        if (entry.entryType === 'CREDIT') {
          calculated = calculated.add(entry.amount);
        } else if (entry.entryType === 'DEBIT') {
          calculated = calculated.subtract(entry.amount);
        }
      }

      const difference = wallet.balance.subtract(calculated);
      const consistent = difference.isZero();

      return {
        walletId: wallet.id,
        storedBalance: {
          amount: wallet.balance.getAmount(),
          currency: wallet.currency,
        },
        calculatedBalance: {
          amount: calculated.getAmount(),
          currency: wallet.currency,
        },
        difference: {
          amount: difference.getAmount(),
          currency: wallet.currency,
        },
        consistent,
        checkedEntries: entries.length,
      };
    });
  }
}
