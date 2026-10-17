import { Module } from '@nestjs/common';
import { MikroOrmUnitOfWork, MikroOrmWalletRepository, MikroOrmWagerTransactionRepository,
  MikroOrmWalletLedgerRepository, MikroOrmOutboxRepository } from './mikro-orm/mikro-orm-adapter';

// Shared module token: command and query modules reuse these exact instances.
@Module({
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
  ],
  exports: [MikroOrmUnitOfWork, MikroOrmWalletRepository, MikroOrmWagerTransactionRepository,
    MikroOrmWalletLedgerRepository, MikroOrmOutboxRepository],
})
export class PersistenceModule {}
