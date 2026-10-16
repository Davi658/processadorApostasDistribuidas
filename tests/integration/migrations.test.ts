import { describe, expect, it } from 'bun:test';
import pg from 'pg';
import { DatabaseMigrator } from '../../src/infrastructure/persistence/migrator';
import { getMigrationDatabaseConfig } from '../../src/infrastructure/config/database.config';

describe('Reversible Migrations on Disposable Database', () => {
  it('should successfully run UP and DOWN migrations incrementally on a newly created disposable database', async () => {
    const adminConfig = getMigrationDatabaseConfig();
    const disposableDbName = `betting_disposable_${Date.now()}`;
    const adminPool = new pg.Pool({
      host: adminConfig.host,
      port: adminConfig.port,
      database: 'postgres',
      user: adminConfig.user,
      password: adminConfig.password,
    });

    try {
      // 1. Create disposable database
      await adminPool.query(`CREATE DATABASE ${disposableDbName};`);

      const disposableConfig: pg.PoolConfig = {
        host: adminConfig.host,
        port: adminConfig.port,
        database: disposableDbName,
        user: adminConfig.user,
        password: adminConfig.password,
      };

      const migrator = new DatabaseMigrator(disposableConfig);

      // 2. Run UP migrations
      const applied = await migrator.up();
      expect(applied.length).toBe(3);
      expect(applied).toContain('001_initial_schema');
      expect(applied).toContain('002_reinforce_schema_and_outbox');
      expect(applied).toContain('003_protect_terminals_and_composite_fk');

      // Verify tables and constraints exist
      const client = new pg.Client(disposableConfig);
      await client.connect();

      const tablesRes = await client.query<{ table_name: string }>(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
          AND table_name IN ('wallets', 'wager_transactions', 'wallet_ledger_entries', 'outbox_messages', 'schema_migrations');
      `);
      expect(tablesRes.rows.length).toBe(5);

      // Verify trigger exists
      const triggerRes = await client.query<{ trigger_name: string }>(`
        SELECT DISTINCT trigger_name 
        FROM information_schema.triggers 
        WHERE event_object_table = 'wallet_ledger_entries' 
          AND trigger_name = 'trg_protect_wallet_ledger_entries';
      `);
      expect(triggerRes.rows.length).toBe(1);

      // 3. Run DOWN migration 003
      const reverted003 = await migrator.down();
      expect(reverted003).toBe('003_protect_terminals_and_composite_fk');

      // 4. Run DOWN migration 002
      const reverted002 = await migrator.down();
      expect(reverted002).toBe('002_reinforce_schema_and_outbox');

      // 5. Run DOWN migration 001
      const reverted001 = await migrator.down();
      expect(reverted001).toBe('001_initial_schema');

      // Verify tables no longer exist (except schema_migrations which is empty)
      const tablesAfterDown = await client.query<{ table_name: string }>(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
          AND table_name IN ('wallets', 'wager_transactions', 'wallet_ledger_entries', 'outbox_messages');
      `);
      expect(tablesAfterDown.rows.length).toBe(0);

      await client.end();
      await migrator.close();

      // Clean up disposable database
      await adminPool.query(`DROP DATABASE IF EXISTS ${disposableDbName} WITH (FORCE);`);
    } finally {
      await adminPool.end();
    }
  }, 30000);
});
