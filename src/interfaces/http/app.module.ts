import { Module } from '@nestjs/common';
import {
  MikroOrmOutboxRepository,
  MikroOrmUnitOfWork,
  MikroOrmWagerTransactionRepository,
  MikroOrmWalletLedgerRepository,
  MikroOrmWalletRepository,
} from '../../infrastructure/persistence/mikro-orm/mikro-orm-adapter';
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
      provide: MikroOrmUnitOfWork,
      useFactory: () => new MikroOrmUnitOfWork(),
    },
    {
      provide: MikroOrmWalletRepository,
      useFactory: (uow: MikroOrmUnitOfWork) => new MikroOrmWalletRepository(uow),
      inject: [MikroOrmUnitOfWork],
    },
    {
      provide: MikroOrmWagerTransactionRepository,
      useFactory: (uow: MikroOrmUnitOfWork) => new MikroOrmWagerTransactionRepository(uow),
      inject: [MikroOrmUnitOfWork],
    },
    {
      provide: MikroOrmWalletLedgerRepository,
      useFactory: (uow: MikroOrmUnitOfWork) => new MikroOrmWalletLedgerRepository(uow),
      inject: [MikroOrmUnitOfWork],
    },
    {
      provide: MikroOrmOutboxRepository,
      useFactory: (uow: MikroOrmUnitOfWork) => new MikroOrmOutboxRepository(uow),
      inject: [MikroOrmUnitOfWork],
    },
    {
      provide: CreateWalletUseCase,
      useFactory: (
        walletRepo: MikroOrmWalletRepository,
        wagerRepo: MikroOrmWagerTransactionRepository,
        ledgerRepo: MikroOrmWalletLedgerRepository,
        outboxRepo: MikroOrmOutboxRepository,
        uow: MikroOrmUnitOfWork
      ) => new CreateWalletUseCase(walletRepo, wagerRepo, ledgerRepo, outboxRepo, uow),
      inject: [
        MikroOrmWalletRepository,
        MikroOrmWagerTransactionRepository,
        MikroOrmWalletLedgerRepository,
        MikroOrmOutboxRepository,
        MikroOrmUnitOfWork,
      ],
    },
    {
      provide: GetWalletUseCase,
      useFactory: (walletRepo: MikroOrmWalletRepository) => new GetWalletUseCase(walletRepo),
      inject: [MikroOrmWalletRepository],
    },
    {
      provide: ProcessBetUseCase,
      useFactory: (
        walletRepo: MikroOrmWalletRepository,
        wagerRepo: MikroOrmWagerTransactionRepository,
        ledgerRepo: MikroOrmWalletLedgerRepository,
        outboxRepo: MikroOrmOutboxRepository,
        uow: MikroOrmUnitOfWork
      ) => new ProcessBetUseCase(walletRepo, wagerRepo, ledgerRepo, outboxRepo, uow),
      inject: [
        MikroOrmWalletRepository,
        MikroOrmWagerTransactionRepository,
        MikroOrmWalletLedgerRepository,
        MikroOrmOutboxRepository,
        MikroOrmUnitOfWork,
      ],
    },
    {
      provide: ReconcileWalletUseCase,
      useFactory: (
        walletRepo: MikroOrmWalletRepository,
        ledgerRepo: MikroOrmWalletLedgerRepository,
        uow: MikroOrmUnitOfWork
      ) => new ReconcileWalletUseCase(walletRepo, ledgerRepo, uow),
      inject: [MikroOrmWalletRepository, MikroOrmWalletLedgerRepository, MikroOrmUnitOfWork],
    },
  ],
})
export class AppModule {}
