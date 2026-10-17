import { PersistenceModule } from '../../infrastructure/persistence/persistence.module';
import { Module } from '@nestjs/common';
import {
  MikroOrmUnitOfWork,
  MikroOrmWagerTransactionRepository,
  MikroOrmWalletRepository,
} from '../../infrastructure/persistence/mikro-orm/mikro-orm-adapter';
import { MikroOrmWalletLedgerQueryRepository } from '../../infrastructure/persistence/mikro-orm/mikro-orm-wallet-ledger-query-repository';
import { GetWageringTransactionByIdUseCase } from '../../application/use-cases/get-wagering-transaction-by-id.use-case';
import { GetWageringTransactionByExternalIdUseCase } from '../../application/use-cases/get-wagering-transaction-by-external-id.use-case';
import { GetWalletLedgerUseCase } from '../../application/use-cases/get-wallet-ledger.use-case';
import { WageringQueryController } from './controllers/wagering-query.controller';
import { ProviderWageringQueryController } from './controllers/provider-wagering-query.controller';
import { WalletLedgerQueryController } from './controllers/wallet-ledger-query.controller';

@Module({
  imports: [PersistenceModule],
  controllers: [
    WageringQueryController,
    ProviderWageringQueryController,
    WalletLedgerQueryController,
  ],
  providers: [
    {
      provide: MikroOrmWalletLedgerQueryRepository,
      useFactory: (uow: MikroOrmUnitOfWork) => new MikroOrmWalletLedgerQueryRepository(uow),
      inject: [MikroOrmUnitOfWork],
    },
    {
      provide: GetWageringTransactionByIdUseCase,
      useFactory: (wagerRepo: MikroOrmWagerTransactionRepository) =>
        new GetWageringTransactionByIdUseCase(wagerRepo),
      inject: [MikroOrmWagerTransactionRepository],
    },
    {
      provide: GetWageringTransactionByExternalIdUseCase,
      useFactory: (wagerRepo: MikroOrmWagerTransactionRepository) =>
        new GetWageringTransactionByExternalIdUseCase(wagerRepo),
      inject: [MikroOrmWagerTransactionRepository],
    },
    {
      provide: GetWalletLedgerUseCase,
      useFactory: (
        walletRepo: MikroOrmWalletRepository,
        ledgerQueryRepo: MikroOrmWalletLedgerQueryRepository
      ) => new GetWalletLedgerUseCase(walletRepo, ledgerQueryRepo),
      inject: [MikroOrmWalletRepository, MikroOrmWalletLedgerQueryRepository],
    },
  ],
  exports: [
    GetWageringTransactionByIdUseCase,
    GetWageringTransactionByExternalIdUseCase,
    GetWalletLedgerUseCase,
    MikroOrmWalletLedgerQueryRepository,
  ],
})
export class WageringQueryModule {}
