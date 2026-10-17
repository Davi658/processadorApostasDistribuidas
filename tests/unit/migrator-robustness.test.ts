import { describe, expect, it } from 'bun:test';
import net from 'node:net';
import { DatabaseMigrator } from '../../src/infrastructure/persistence/migrator';

describe('DatabaseMigrator Robustness & Failure Behavior', () => {
  it('should timeout and exhaust configured attempts against TCP server that accepts connection without handshake response', async () => {
    let connectionAttempts = 0;
    const sockets: net.Socket[] = [];

    const server = net.createServer((socket) => {
      connectionAttempts++;
      sockets.push(socket);
      // Intentionally do not send any PostgreSQL protocol handshake response
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const port = (server.address() as net.AddressInfo).port;
    const configuredRetries = 3;

    const migrator = new DatabaseMigrator({
      host: '127.0.0.1',
      port,
      database: 'betting_db',
      user: 'migration_user',
      password: 'local_migration_only',
      connectionTimeoutMillis: 150,
      maxRetries: configuredRetries,
      initialDelayMs: 30,
    });

    const start = performance.now();
    let caughtError: any = null;

    try {
      await migrator.up();
    } catch (err: any) {
      caughtError = err;
    } finally {
      await migrator.close();
      for (const s of sockets) {
        s.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const duration = performance.now() - start;

    // 1. Error message contains the real pg timeout string
    expect(caughtError).not.toBeNull();
    expect(caughtError.message).toContain('Connection terminated due to connection timeout');

    // 2. Comprove exact number of configured attempts
    expect(connectionAttempts).toBe(configuredRetries);

    // 3. Terminate within adequate bounded margin
    expect(duration).toBeGreaterThanOrEqual(400);
    expect(duration).toBeLessThan(5000);
  });

  it('should run real CLI in child process, exit non-zero and terminate within adequate bounded margin when connection is unavailable', async () => {
    const start = performance.now();
    const proc = Bun.spawn([process.execPath, 'run', 'src/infrastructure/persistence/migrator.ts', 'up'], {
      env: {
        ...process.env,
        MIGRATION_DB_HOST: '127.0.0.1',
        MIGRATION_DB_PORT: '54399',
        MIGRATION_CONNECT_TIMEOUT_MS: '200',
        MIGRATION_MAX_RETRIES: '2',
        MIGRATION_INITIAL_DELAY_MS: '40',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;
    const duration = performance.now() - start;
    const stderr = await new Response(proc.stderr).text();

    // 1. Non-zero exit code
    expect(exitCode).not.toBe(0);
    expect(exitCode).toBe(1);

    // 2. Terminate within adequate bounded margin
    expect(duration).toBeLessThan(4000);

    // 3. Migration failure message logged to stderr
    expect(stderr).toContain('Migration execution failed');
  });

  it('should reject invalid constructor options before creating pool', () => {
    // connectionTimeoutMillis: must be finite integer > 0
    expect(() => new DatabaseMigrator({ connectionTimeoutMillis: 0 })).toThrow(/connectionTimeoutMillis/);
    expect(() => new DatabaseMigrator({ connectionTimeoutMillis: -100 })).toThrow(/connectionTimeoutMillis/);
    expect(() => new DatabaseMigrator({ connectionTimeoutMillis: 1.5 })).toThrow(/connectionTimeoutMillis/);
    expect(() => new DatabaseMigrator({ connectionTimeoutMillis: NaN })).toThrow(/connectionTimeoutMillis/);
    expect(() => new DatabaseMigrator({ connectionTimeoutMillis: Infinity })).toThrow(/connectionTimeoutMillis/);
    expect(() => new DatabaseMigrator({ connectionTimeoutMillis: '1000' as any })).toThrow(/connectionTimeoutMillis/);

    // maxRetries: must be finite integer >= 1
    expect(() => new DatabaseMigrator({ maxRetries: 0 })).toThrow(/maxRetries/);
    expect(() => new DatabaseMigrator({ maxRetries: -1 })).toThrow(/maxRetries/);
    expect(() => new DatabaseMigrator({ maxRetries: 1.5 })).toThrow(/maxRetries/);
    expect(() => new DatabaseMigrator({ maxRetries: NaN })).toThrow(/maxRetries/);
    expect(() => new DatabaseMigrator({ maxRetries: Infinity })).toThrow(/maxRetries/);
    expect(() => new DatabaseMigrator({ maxRetries: '5' as any })).toThrow(/maxRetries/);

    // initialDelayMs: must be finite integer >= 0
    expect(() => new DatabaseMigrator({ initialDelayMs: -1 })).toThrow(/initialDelayMs/);
    expect(() => new DatabaseMigrator({ initialDelayMs: 2.5 })).toThrow(/initialDelayMs/);
    expect(() => new DatabaseMigrator({ initialDelayMs: NaN })).toThrow(/initialDelayMs/);
    expect(() => new DatabaseMigrator({ initialDelayMs: Infinity })).toThrow(/initialDelayMs/);
    expect(() => new DatabaseMigrator({ initialDelayMs: '50' as any })).toThrow(/initialDelayMs/);

    // Valid boundary values should be accepted without throwing
    expect(() => new DatabaseMigrator({ connectionTimeoutMillis: 1, maxRetries: 1, initialDelayMs: 0 })).not.toThrow();
  });

  it('should not allow customConfig spread to overwrite validated timeout with undefined', () => {
    const migrator = new DatabaseMigrator({ connectionTimeoutMillis: undefined });
    expect((migrator as any).connectionTimeoutMillis).toBe(3000);
  });

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

    // 2. Must terminate within adequate bounded margin
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
