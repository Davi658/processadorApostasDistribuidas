import { describe, expect, it } from 'bun:test';
import pg from 'pg';
import { DatabaseMigrator } from '../../src/infrastructure/persistence/migrator';

describe('Reversible Migrations on Disposable Database', () => {
  it('should successfully run UP and DOWN migrations on a newly created disposable database', async () => {
    const disposableDbName = `betting_disposable_${Date.now()}`;
    const adminPool = new pg.Pool({
      host: process.env.MIGRATION_DB_HOST || '127.0.0.1',
      port: Number(process.env.MIGRATION_DB_PORT) || 5432,
      database: 'postgres',
      user: process.env.MIGRATION_DB_USER || 'postgres',
      password: process.env.MIGRATION_DB_PASSWORD || '',
    });

    try {
      // 1. Create disposable database
      await adminPool.query(`CREATE DATABASE ${disposableDbName};`);

      const disposableConfig: pg.PoolConfig = {
        host: process.env.MIGRATION_DB_HOST || '127.0.0.1',
        port: Number(process.env.MIGRATION_DB_PORT) || 5432,
        database: disposableDbName,
        user: process.env.MIGRATION_DB_USER || 'postgres',
        password: process.env.MIGRATION_DB_PASSWORD || '',
      };

      const migrator = new DatabaseMigrator(disposableConfig);

      // 2. Run UP migration
      await migrator.up();

      // Verify tables exist
      const client = new pg.Client(disposableConfig);
      await client.connect();

      const tablesRes = await client.query<{ table_name: string }>(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
          AND table_name IN ('wallets', 'wager_transactions', 'wallet_ledger_entries', 'outbox_messages');
      `);
      expect(tablesRes.rows.length).toBe(4);

      // Verify trigger exists
      const triggerRes = await client.query<{ trigger_name: string }>(`
        SELECT DISTINCT trigger_name 
        FROM information_schema.triggers 
        WHERE event_object_table = 'wallet_ledger_entries' 
          AND trigger_name = 'trg_protect_wallet_ledger_entries';
      `);
      expect(triggerRes.rows.length).toBe(1);

      // 3. Run DOWN migration
      await migrator.down();

      // Verify tables no longer exist
      const tablesAfterDown = await client.query<{ table_name: string }>(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
          AND table_name IN ('wallets', 'wager_transactions', 'wallet_ledger_entries', 'outbox_messages');
      `);
      expect(tablesAfterDown.rows.length).toBe(0);

      // Verify trigger no longer exists
      const triggerAfterDown = await client.query<{ trigger_name: string }>(`
        SELECT trigger_name 
        FROM information_schema.triggers 
        WHERE trigger_name = 'trg_protect_wallet_ledger_entries';
      `);
      expect(triggerAfterDown.rows.length).toBe(0);

      await client.end();
      await migrator.close();

      // Clean up disposable database
      await adminPool.query(`DROP DATABASE IF EXISTS ${disposableDbName} WITH (FORCE);`);
    } finally {
      await adminPool.end();
    }
  }, 30000);
});
