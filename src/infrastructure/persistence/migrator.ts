import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { getMigrationDatabaseConfig } from '../config/database.config';

export class DatabaseMigrator {
  private readonly pool: pg.Pool;

  constructor(customConfig?: pg.PoolConfig) {
    this.pool = new pg.Pool(customConfig ?? getMigrationDatabaseConfig());
  }

  private async ensureMigrationTable(client: pg.PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(128) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }

  private isTransientConnectionError(err: any): boolean {
    if (!err) return false;
    const transientCodes = new Set([
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'ENOTFOUND',
      'EHOSTUNREACH',
      '57P03', // cannot_connect_now
      '08001', // sqlclient_unable_to_establish_sqlconnection
      '08004', // sqlserver_rejected_establishment_of_sqlconnection
      '08006', // connection_failure
    ]);
    if (err.code && transientCodes.has(String(err.code))) {
      return true;
    }
    const msg = String(err.message || '');
    return msg.includes('ECONNREFUSED') || msg.includes('connection refused') || msg.includes('the database system is starting up');
  }

  private async connectWithRetry(maxRetries = 15, initialDelayMs = 200): Promise<pg.PoolClient> {
    let attempt = 0;
    while (true) {
      try {
        return await this.pool.connect();
      } catch (err: any) {
        attempt++;
        const isTransient = this.isTransientConnectionError(err);
        if (!isTransient || attempt >= maxRetries) {
          throw err;
        }
        const delay = Math.min(initialDelayMs * Math.pow(1.5, attempt - 1), 2000);
        console.warn(`Transient connection error (${err.message || err.code}). Retrying in ${delay}ms (attempt ${attempt}/${maxRetries})...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  public async up(): Promise<string[]> {
    const client = await this.connectWithRetry();
    const appliedVersions: string[] = [];

    try {
      await client.query('BEGIN');
      // Advisory transaction lock to prevent concurrent migration executions
      await client.query('SELECT pg_advisory_xact_lock(8492019);');

      await this.ensureMigrationTable(client);

      const migrationsDir = join(import.meta.dir, 'migrations');
      const files = readdirSync(migrationsDir)
        .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
        .sort();

      const existingRes = await client.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version ASC;'
      );
      const appliedSet = new Set(existingRes.rows.map((r) => r.version));

      for (const file of files) {
        const version = file.replace('.sql', '');
        if (!appliedSet.has(version)) {
          const sql = readFileSync(join(migrationsDir, file), 'utf-8');
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (version) VALUES ($1);', [version]);
          appliedVersions.push(version);
        }
      }

      await client.query('COMMIT');
      return appliedVersions;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async down(): Promise<string | null> {
    const client = await this.connectWithRetry();

    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(8492019);');

      await this.ensureMigrationTable(client);

      const lastMigrationRes = await client.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1;'
      );

      if (lastMigrationRes.rows.length === 0) {
        await client.query('COMMIT');
        return null;
      }

      const lastVersion = lastMigrationRes.rows[0].version;
      const migrationsDir = join(import.meta.dir, 'migrations');
      const downFilePath = join(migrationsDir, `${lastVersion}.down.sql`);
      const downSql = readFileSync(downFilePath, 'utf-8');

      await client.query(downSql);
      await client.query('DELETE FROM schema_migrations WHERE version = $1;', [lastVersion]);

      await client.query('COMMIT');
      return lastVersion;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}

// CLI execution support
if (import.meta.main) {
  const migrator = new DatabaseMigrator();
  const command = process.argv[2] ?? 'up';

  if (command === 'up') {
    console.log('Running UP migrations...');
    const applied = await migrator.up();
    if (applied.length > 0) {
      console.log(`Applied migrations: ${applied.join(', ')}`);
    } else {
      console.log('No new migrations to apply.');
    }
  } else if (command === 'down') {
    console.log('Running DOWN migration...');
    const reverted = await migrator.down();
    if (reverted) {
      console.log(`Reverted migration: ${reverted}`);
    } else {
      console.log('No applied migrations to revert.');
    }
  } else {
    console.error(`Unknown command: ${command}. Use "up" or "down".`);
    process.exit(1);
  }

  await migrator.close();
}
