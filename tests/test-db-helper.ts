import pg from 'pg';
import { DatabaseMigrator } from '../src/infrastructure/persistence/migrator';
import { getAppDatabaseConfig, getMigrationDatabaseConfig } from '../src/infrastructure/config/database.config';

export interface IsolatedTestDatabase {
  dbName: string;
  appConfig: pg.PoolConfig;
  adminConfig: pg.PoolConfig;
  closeAndDrop: () => Promise<void>;
}

export async function createIsolatedTestDatabase(prefix = 'betting_test_'): Promise<IsolatedTestDatabase> {
  const adminBaseConfig = getMigrationDatabaseConfig();
  const dbName = `${prefix}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // 1. Connect to administrative postgres database to create disposable database
  const maintenancePool = new pg.Pool({
    host: adminBaseConfig.host,
    port: adminBaseConfig.port,
    database: 'postgres',
    user: adminBaseConfig.user,
    password: adminBaseConfig.password,
  });

  try {
    await maintenancePool.query(`CREATE DATABASE ${dbName};`);
  } finally {
    await maintenancePool.end();
  }

  // 2. Run migrations on the isolated database using admin privileges
  const adminIsolatedConfig: pg.PoolConfig = {
    host: adminBaseConfig.host,
    port: adminBaseConfig.port,
    database: dbName,
    user: adminBaseConfig.user,
    password: adminBaseConfig.password,
  };

  const migrator = new DatabaseMigrator(adminIsolatedConfig);
  await migrator.up();
  await migrator.close();

  // 3. Configure application user least privileges on the isolated database
  const adminClient = new pg.Client(adminIsolatedConfig);
  await adminClient.connect();
  try {
    await adminClient.query(`
      GRANT CONNECT ON DATABASE ${dbName} TO app_user;
      GRANT USAGE ON SCHEMA public TO app_user;
      GRANT SELECT, INSERT, UPDATE ON TABLE wallets TO app_user;
      GRANT SELECT, INSERT, UPDATE ON TABLE wager_transactions TO app_user;
      GRANT SELECT, INSERT ON TABLE wallet_ledger_entries TO app_user;
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE outbox_messages TO app_user;
      REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM app_user;
      REVOKE CREATE ON SCHEMA public FROM app_user;
    `);
  } finally {
    await adminClient.end();
  }

  const appBaseConfig = getAppDatabaseConfig();
  const appIsolatedConfig: pg.PoolConfig = {
    host: appBaseConfig.host,
    port: appBaseConfig.port,
    database: dbName,
    user: appBaseConfig.user,
    password: appBaseConfig.password,
  };

  // Set environment variable so any nested components or workers inherit the isolated database
  const previousEnvDb = process.env.DB_NAME;
  process.env.DB_NAME = dbName;

  const closeAndDrop = async () => {
    // Restore environment variable
    if (previousEnvDb !== undefined) {
      process.env.DB_NAME = previousEnvDb;
    } else {
      delete process.env.DB_NAME;
    }

    // Connect to administrative postgres database to terminate connections and drop the isolated db
    const dropPool = new pg.Pool({
      host: adminBaseConfig.host,
      port: adminBaseConfig.port,
      database: 'postgres',
      user: adminBaseConfig.user,
      password: adminBaseConfig.password,
    });

    try {
      await dropPool.query(`
        SELECT pg_terminate_backend(pid) 
        FROM pg_stat_activity 
        WHERE datname = '${dbName}' AND pid <> pg_backend_pid();
      `);
      await dropPool.query(`DROP DATABASE IF EXISTS ${dbName};`);
    } catch (e) {
      console.error(`Failed to drop isolated database ${dbName}:`, e);
    } finally {
      await dropPool.end();
    }
  };

  return {
    dbName,
    appConfig: appIsolatedConfig,
    adminConfig: adminIsolatedConfig,
    closeAndDrop,
  };
}
