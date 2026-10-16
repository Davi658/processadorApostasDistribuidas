/**
 * Unified persistence adapter: Re-exports MikroORM implementations under legacy names
 * to avoid maintaining two separate Units of Work, ensuring MikroORM with EntityManager
 * and transactional isolation is exclusively used throughout the entire application.
 */
export {
  MikroOrmUnitOfWork as PostgresUnitOfWork,
  MikroOrmWalletRepository as PostgresWalletRepository,
  MikroOrmWagerTransactionRepository as PostgresWagerTransactionRepository,
  MikroOrmWalletLedgerRepository as PostgresWalletLedgerRepository,
  MikroOrmOutboxRepository as PostgresOutboxRepository,
  type FailureHookPoint,
} from '../mikro-orm/mikro-orm-adapter';
