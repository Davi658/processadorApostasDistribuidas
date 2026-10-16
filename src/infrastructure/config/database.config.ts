import { config } from 'dotenv';

config();

export interface DatabaseConnectionConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
}

export function getAppDatabaseConfig(): DatabaseConnectionConfig {
  return {
    host: process.env.APP_DB_HOST || '127.0.0.1',
    port: Number(process.env.APP_DB_PORT) || 5432,
    database: process.env.APP_DB_NAME || 'betting_db',
    user: process.env.APP_DB_USER || 'app_user',
    password: process.env.APP_DB_PASSWORD || 'app_user_secret',
  };
}

export function getMigrationDatabaseConfig(): DatabaseConnectionConfig {
  return {
    host: process.env.MIGRATION_DB_HOST || process.env.APP_DB_HOST || '127.0.0.1',
    port: Number(process.env.MIGRATION_DB_PORT) || Number(process.env.APP_DB_PORT) || 5432,
    database: process.env.MIGRATION_DB_NAME || process.env.APP_DB_NAME || 'betting_db',
    user: process.env.MIGRATION_DB_USER || 'postgres',
    password: process.env.MIGRATION_DB_PASSWORD || '',
  };
}
