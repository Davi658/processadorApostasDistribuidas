import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { getMigrationDatabaseConfig } from '../config/database.config';

export interface MigratorOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  connectionTimeoutMillis?: number;
}

function parseAndValidateInteger(
  value: unknown,
  name: string,
  min: number,
  isStrictlyGreaterThan = false
): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    (isStrictlyGreaterThan ? value <= min : value < min)
  ) {
    const comparator = isStrictlyGreaterThan ? `> ${min}` : `>= ${min}`;
    throw new Error(`Invalid ${name}: must be a finite integer ${comparator}, got ${value}`);
  }
  return value;
}

function resolveOption(
  customVal: unknown,
  envVal: string | undefined,
  defaultVal: number,
  name: string,
  min: number,
  isStrictlyGreaterThan = false
): number {
  if (customVal !== undefined) {
    return parseAndValidateInteger(customVal, name, min, isStrictlyGreaterThan);
  }
  if (envVal !== undefined && envVal.trim() !== '') {
    const parsed = Number(envVal);
    return parseAndValidateInteger(parsed, name, min, isStrictlyGreaterThan);
  }
  return defaultVal;
}

export class DatabaseMigrator {
  private readonly pool: pg.Pool;
  private readonly maxRetries: number;
  private readonly initialDelayMs: number;
  private readonly connectionTimeoutMillis: number;

  constructor(customConfig?: pg.PoolConfig & MigratorOptions) {
    const timeoutMs = resolveOption(
      customConfig?.connectionTimeoutMillis,
      process.env.MIGRATION_CONNECT_TIMEOUT_MS,
      3000,
      'connectionTimeoutMillis',
      0,
      true
    );

    this.maxRetries = resolveOption(
      customConfig?.maxRetries,
      process.env.MIGRATION_MAX_RETRIES,
      10,
      'maxRetries',
      1,
      false
    );

    this.initialDelayMs = resolveOption(
      customConfig?.initialDelayMs,
      process.env.MIGRATION_INITIAL_DELAY_MS,
      200,
      'initialDelayMs',
      0,
      false
    );

    this.connectionTimeoutMillis = timeoutMs;

    const baseConfig = customConfig ?? getMigrationDatabaseConfig();
    const {
      connectionTimeoutMillis: _rawTimeout,
      maxRetries: _rawMaxRetries,
      initialDelayMs: _rawInitialDelay,
      ...poolConfig
    } = baseConfig as any;

    this.pool = new pg.Pool({
      ...poolConfig,
      connectionTimeoutMillis: timeoutMs,
    });
    this.pool.on('error', () => {});
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

    const transientMessageSnippets = [
      'connection terminated due to connection timeout',
      'connection terminated unexpectedly',
      'the database system is starting up',
      'connection refused',
      'timeout expired',
      'econnrefused',
      'econnreset',
      'etimedout',
    ];

    let current: any = err;
    let depth = 0;
    while (current && depth < 5) {
      if (current.code && transientCodes.has(String(current.code))) {
        return true;
      }
      const msg = String(current.message || '').toLowerCase();
      for (const snippet of transientMessageSnippets) {
        if (msg.includes(snippet)) {
          return true;
        }
      }
      current = current.cause;
      depth++;
    }

    return false;
  }

  private async connectWithRetry(): Promise<pg.PoolClient> {
    let attempt = 0;
    while (true) {
      try {
        return await this.pool.connect();
      } catch (err: any) {
        attempt++;
        const isTransient = this.isTransientConnectionError(err);
        if (!isTransient || attempt >= this.maxRetries) {
          throw err;
        }
        const delay = Math.min(this.initialDelayMs * Math.pow(1.5, attempt - 1), 2000);
        console.warn(`Transient connection error (${err.message || err.code}). Retrying in ${delay}ms (attempt ${attempt}/${this.maxRetries})...`);
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

  try {
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
      process.exitCode = 1;
    }
  } catch (error) {
    console.error('Migration execution failed:', error);
    process.exitCode = 1;
  } finally {
    await migrator.close();
  }
}
