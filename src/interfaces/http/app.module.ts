import { Module } from '@nestjs/common';
import {
  PostgresOutboxRepository,
  PostgresUnitOfWork,
  PostgresWagerTransactionRepository,
  PostgresWalletLedgerRepository,
  PostgresWalletRepository,
} from '../../infrastructure/persistence/postgres/postgres-adapter';
import { CreateWalletUseCase } from '../../application/use-cases/create-wallet.use-case';
import { GetWalletUseCase } from '../../application/use-cases/get-wallet.use-case';
import { ProcessBetUseCase } from '../../application/use-cases/process-bet.use-case';
import { ReconcileWalletUseCase } from '../../application/use-cases/reconcile-wallet.use-case';
import { WalletController } from './controllers/wallet.controller';
import { WageringController } from './controllers/wagering.controller';

@Module({
  controllers: [WalletController, WageringController],
  providers: [
    {
      provide: PostgresUnitOfWork,
      useFactory: () => new PostgresUnitOfWork(),
    },
    {
      provide: PostgresWalletRepository,
      useFactory: (uow: PostgresUnitOfWork) => new PostgresWalletRepository(uow),
      inject: [PostgresUnitOfWork],
    },
    {
      provide: PostgresWagerTransactionRepository,
      useFactory: (uow: PostgresUnitOfWork) => new PostgresWagerTransactionRepository(uow),
      inject: [PostgresUnitOfWork],
    },
    {
      provide: PostgresWalletLedgerRepository,
      useFactory: (uow: PostgresUnitOfWork) => new PostgresWalletLedgerRepository(uow),
      inject: [PostgresUnitOfWork],
    },
    {
      provide: PostgresOutboxRepository,
      useFactory: (uow: PostgresUnitOfWork) => new PostgresOutboxRepository(uow),
      inject: [PostgresUnitOfWork],
    },
    {
      provide: CreateWalletUseCase,
      useFactory: (
        walletRepo: PostgresWalletRepository,
        wagerRepo: PostgresWagerTransactionRepository,
        ledgerRepo: PostgresWalletLedgerRepository,
        outboxRepo: PostgresOutboxRepository,
        uow: PostgresUnitOfWork
      ) => new CreateWalletUseCase(walletRepo, wagerRepo, ledgerRepo, outboxRepo, uow),
      inject: [
        PostgresWalletRepository,
        PostgresWagerTransactionRepository,
        PostgresWalletLedgerRepository,
        PostgresOutboxRepository,
        PostgresUnitOfWork,
      ],
    },
    {
      provide: GetWalletUseCase,
      useFactory: (walletRepo: PostgresWalletRepository) => new GetWalletUseCase(walletRepo),
      inject: [PostgresWalletRepository],
    },
    {
      provide: ProcessBetUseCase,
      useFactory: (
        walletRepo: PostgresWalletRepository,
        wagerRepo: PostgresWagerTransactionRepository,
        ledgerRepo: PostgresWalletLedgerRepository,
        outboxRepo: PostgresOutboxRepository,
        uow: PostgresUnitOfWork
      ) => new ProcessBetUseCase(walletRepo, wagerRepo, ledgerRepo, outboxRepo, uow),
      inject: [
        PostgresWalletRepository,
        PostgresWagerTransactionRepository,
        PostgresWalletLedgerRepository,
        PostgresOutboxRepository,
        PostgresUnitOfWork,
      ],
    },
    {
      provide: ReconcileWalletUseCase,
      useFactory: (
        walletRepo: PostgresWalletRepository,
        ledgerRepo: PostgresWalletLedgerRepository,
        uow: PostgresUnitOfWork
      ) => new ReconcileWalletUseCase(walletRepo, ledgerRepo, uow),
      inject: [PostgresWalletRepository, PostgresWalletLedgerRepository, PostgresUnitOfWork],
    },
  ],
})
export class AppModule {}
