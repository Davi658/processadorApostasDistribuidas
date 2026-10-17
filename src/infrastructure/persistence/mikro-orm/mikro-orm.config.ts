import { type Options } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import {
  WalletOrmEntity,
  WagerTransactionOrmEntity,
  WalletLedgerOrmEntity,
  OutboxMessageOrmEntity,
} from './entities/orm-entities';
import { config } from 'dotenv';

config();

const mikroOrmConfig: Options = {
  driver: PostgreSqlDriver,
  get host() {
    return process.env.APP_DB_HOST || '127.0.0.1';
  },
  get port() {
    return Number(process.env.APP_DB_PORT) || 5432;
  },
  get dbName() {
    return process.env.DB_NAME || process.env.APP_DB_NAME || 'betting_db';
  },
  get user() {
    return process.env.APP_DB_USER || 'app_user';
  },
  get password() {
    return process.env.APP_DB_PASSWORD || 'app_user_secret';
  },
  entities: [
    WalletOrmEntity,
    WagerTransactionOrmEntity,
    WalletLedgerOrmEntity,
    OutboxMessageOrmEntity,
  ],
  debug: false,
  // Also bound queries outside a UnitOfWork (notably the atomic claim).
  // PostgreSQL enforces these limits even when JavaScript requests cancellation.
  driverOptions: {
    connection: {
      get lock_timeout() { return Number(process.env.DB_LOCK_TIMEOUT_MS) || 5000; },
      get statement_timeout() { return Number(process.env.DB_STATEMENT_TIMEOUT_MS) || 10000; },
    },
  },
  migrations: {
    path: './src/infrastructure/persistence/migrations',
    disableForeignKeys: false,
  },
};

export default mikroOrmConfig;
