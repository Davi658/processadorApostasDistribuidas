import { describe, expect, it } from 'bun:test';
import { DatabaseMigrator } from '../../src/infrastructure/persistence/migrator';

describe('DatabaseMigrator Robustness & Failure Behavior', () => {
  it('should terminate within documented bounded time when database connection is unavailable', async () => {
    // Port 54399 is unused and refuses connection immediately
    const migrator = new DatabaseMigrator({
      host: '127.0.0.1',
      port: 54399,
      database: 'betting_db',
      user: 'migration_user',
      password: 'local_migration_only',
      connectionTimeoutMillis: 500,
      maxRetries: 3,
      initialDelayMs: 50,
    });

    const start = performance.now();
    let thrownError: any = null;

    try {
      await migrator.up();
    } catch (err: any) {
      thrownError = err;
    } finally {
      await migrator.close();
    }

    const duration = performance.now() - start;

    // 1. Must fail with original transient connection cause preserved
    expect(thrownError).not.toBeNull();
    const isConnRefused =
      thrownError.code === 'ECONNREFUSED' ||
      String(thrownError.message).includes('ECONNREFUSED') ||
      String(thrownError.message).includes('connect');
    expect(isConnRefused).toBe(true);

    // 2. Must terminate within bounded time: 3 attempts with 50ms delay + backoff < 3000ms
    expect(duration).toBeLessThan(3000);
  });

  it('should fail SQL execution errors immediately without retry, issuing ROLLBACK', async () => {
    // Test that once connection is acquired, SQL execution errors fail immediately without retry
    let queryAttempts = 0;
    const executedQueries: string[] = [];

    const mockClient = {
      query: async (queryText: string, params?: any[]) => {
        executedQueries.push(queryText);
        if (queryText === 'BEGIN') return {};
        if (queryText.includes('pg_advisory_xact_lock')) return {};
        if (queryText.includes('CREATE TABLE IF NOT EXISTS schema_migrations')) return {};
        if (queryText.includes('SELECT version FROM schema_migrations')) {
          return { rows: [] };
        }
        if (queryText === 'ROLLBACK') return {};
        if (queryText === 'COMMIT') return {};

        // Simulate a syntax or constraint SQL failure on a migration file
        queryAttempts++;
        const sqlError: any = new Error('syntax error at or near "MALFORMED_SQL_STATEMENT"');
        sqlError.code = '42601';
        throw sqlError;
      },
      release: () => {},
    };

    const mockPool = {
      connect: async () => mockClient,
      end: async () => {},
    };

    const migrator = new DatabaseMigrator({
      connectionTimeoutMillis: 1000,
      maxRetries: 3,
      initialDelayMs: 50,
    });
    // Replace internal pool with mockPool to isolate SQL execution phase
    (migrator as any).pool = mockPool;

    let caughtError: any = null;
    try {
      await migrator.up();
    } catch (err: any) {
      caughtError = err;
    } finally {
      await migrator.close();
    }

    // 1. Original SQL error code and message are preserved
    expect(caughtError).not.toBeNull();
    expect(caughtError.code).toBe('42601');
    expect(caughtError.message).toContain('MALFORMED_SQL_STATEMENT');

    // 2. The failing migration query was attempted exactly ONCE (zero retry on SQL failure)
    expect(queryAttempts).toBe(1);

    // 3. ROLLBACK was executed to preserve atomicity
    expect(executedQueries).toContain('ROLLBACK');
    expect(executedQueries).not.toContain('COMMIT');
  });

  it('should ensure migrator.close() drains and closes pool in finally block', async () => {
    let poolEnded = false;
    const mockPool = {
      connect: async () => {
        throw new Error('Immediate non-transient fatal error');
      },
      end: async () => {
        poolEnded = true;
      },
    };

    const migrator = new DatabaseMigrator();
    (migrator as any).pool = mockPool;

    try {
      await migrator.up();
    } catch {
      // Expected failure
    } finally {
      await migrator.close();
    }

    expect(poolEnded).toBe(true);
  });
});
