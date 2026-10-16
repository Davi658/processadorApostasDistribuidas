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
  host: process.env.APP_DB_HOST || '127.0.0.1',
  port: Number(process.env.APP_DB_PORT) || 5432,
  dbName: process.env.APP_DB_NAME || 'betting_db',
  user: process.env.APP_DB_USER || 'app_user',
  password: process.env.APP_DB_PASSWORD || 'app_user_secret',
  entities: [
    WalletOrmEntity,
    WagerTransactionOrmEntity,
    WalletLedgerOrmEntity,
    OutboxMessageOrmEntity,
  ],
  debug: false,
  migrations: {
    path: './src/infrastructure/persistence/migrations',
    disableForeignKeys: false,
  },
};

export default mikroOrmConfig;
