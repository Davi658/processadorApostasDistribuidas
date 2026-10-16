import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { config } from 'dotenv';

config();

export class DatabaseMigrator {
  private readonly pool: pg.Pool;

  constructor(customConfig?: pg.PoolConfig) {
    this.pool = new pg.Pool(
      customConfig ?? {
        host: process.env.MIGRATION_DB_HOST || '127.0.0.1',
        port: Number(process.env.MIGRATION_DB_PORT) || 5432,
        database: process.env.MIGRATION_DB_NAME || 'betting_db',
        user: process.env.MIGRATION_DB_USER || 'postgres',
        password: process.env.MIGRATION_DB_PASSWORD || '',
      }
    );
  }

  public async up(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const upSqlPath = join(import.meta.dir, 'migrations', '001_initial_schema.sql');
      const upSql = readFileSync(upSqlPath, 'utf-8');
      await client.query(upSql);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async down(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const downSqlPath = join(import.meta.dir, 'migrations', '001_initial_schema.down.sql');
      const downSql = readFileSync(downSqlPath, 'utf-8');
      await client.query(downSql);
      await client.query('COMMIT');
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
    await migrator.up();
    console.log('UP migrations applied successfully!');
  } else if (command === 'down') {
    console.log('Running DOWN migrations...');
    await migrator.down();
    console.log('DOWN migrations reverted successfully!');
  } else {
    console.error(`Unknown command: ${command}. Use "up" or "down".`);
    process.exit(1);
  }

  await migrator.close();
}
