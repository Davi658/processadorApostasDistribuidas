import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Controller, Get, Module, Post, HttpException, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import pg from 'pg';
import config from '../../src/infrastructure/persistence/mikro-orm/mikro-orm.config';
import { getMigrationDatabaseConfig } from '../../src/infrastructure/config/database.config';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm/mikro-orm-adapter';
import { DatabaseMigrator } from '../../src/infrastructure/persistence/migrator';
import { HttpObservability } from '../../src/infrastructure/observability/http-observability';
import { ObservabilityController, PostgresReadiness } from '../../src/infrastructure/observability/observability.controller';

@Controller('probe')
class ProbeController {
  @Post(':id') read() { return { balance: '9876.54', credential: 'response-secret' }; }
  @Get('error/:id') fail() { throw new HttpException('private-error', 422); }
}

const lines: string[] = [];
const http = new HttpObservability(line => lines.push(line));
const dbName = `m18_observability_${process.pid}`;
const adminConfig = getMigrationDatabaseConfig();
const connection = { host: adminConfig.host, port: adminConfig.port, user: adminConfig.user, password: adminConfig.password };
const uow = new MikroOrmUnitOfWork({ ...config, ...connection, dbName,
  pool: { min: 0, max: 2, acquireTimeoutMillis: 300 },
  driverOptions: { connection: { application_name: 'm18_observability', statement_timeout: 1000 } },
});
const readiness = new PostgresReadiness(uow, 150);
@Module({ controllers: [ObservabilityController, ProbeController], providers: [
  { provide: MikroOrmUnitOfWork, useValue: uow },
  { provide: HttpObservability, useValue: http },
  { provide: PostgresReadiness, useValue: readiness },
] })
class TestModule {}

describe('M18 isolated Nest HTTP and real PostgreSQL', () => {
  let app: INestApplication;
  let url: string;
  let admin: pg.Pool;
  let maintenance: pg.Pool;
  let before: pg.QueryResultRow[][];
  const snapshot = async () => {
    const values = [];
    for (const table of ['wallets', 'wager_transactions', 'wallet_ledger_entries', 'outbox_messages']) {
      values.push((await admin.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY id`)).rows);
    }
    return values;
  };
  beforeAll(async () => {
    maintenance = new pg.Pool({ ...connection, database: 'postgres' });
    await maintenance.query(`CREATE DATABASE ${dbName}`);
    admin = new pg.Pool({ ...connection, database: dbName });
    const migrator = new DatabaseMigrator({ ...connection, database: dbName });
    try { await migrator.up(); } finally { await migrator.close(); }
    await admin.query(`INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
      VALUES ($1, 'm18-player', 'BRL', 9876.54, 1, NOW(), NOW())`, [crypto.randomUUID()]);
    before = await snapshot();
    app = await NestFactory.create(TestModule, { logger: false });
    app.use(http.middleware);
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  }, 30000);

  afterAll(async () => {
    try { if (app) await app.close(); }
    finally {
      if (admin) await admin.end();
      if (maintenance) {
        try { await maintenance.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); }
        finally { await maintenance.end(); }
      }
    }
  });

  it('logs only allowed fields, preserves correlation, measures normalized routes including errors/404', async () => {
    for (let i = 0; i < 12; i++) {
      const response = await fetch(`${url}/probe/${crypto.randomUUID()}?password=query-secret&amount=9876.54`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-correlation-id': ' trace-m18 ',
          authorization: 'Bearer credential-secret', 'idempotency-key': 'unused-key' },
        body: JSON.stringify({ amount: '9876.54', balance: '9876.54', password: 'body-secret' }),
      });
      expect(response.status).toBe(201);
      await response.text();
    }
    const fallback = await fetch(`${url}/probe/${crypto.randomUUID()}`, { method: 'POST', headers: { 'idempotency-key': 'fallback-m18' } });
    await fallback.text();
    await (await fetch(`${url}/probe/error/${crypto.randomUUID()}`)).text();
    for (let i = 0; i < 3; i++) await (await fetch(`${url}/unknown/${crypto.randomUUID()}?token=secret`)).text();
    const records = lines.map(line => JSON.parse(line));
    expect(records.filter(record => record.correlationId === 'trace-m18')).toHaveLength(12);
    expect(records.some(record => record.correlationId === 'fallback-m18')).toBe(true);
    expect(records.some(record => record.status === 422)).toBe(true);
    expect(records.some(record => record.status === 404)).toBe(true);
    for (const record of records) {
      expect(Object.keys(record).sort()).toEqual(['correlationId', 'durationMs', 'method', 'route', 'status']);
      expect(record.durationMs).toBeGreaterThanOrEqual(0);
    }
    expect(lines.join('')).not.toMatch(/9876\.54|secret|Bearer|private-error|unused-key/);
    const response = await fetch(`${url}/metrics`);
    expect(response.headers.get('content-type')).toContain('version=0.0.4');
    const metrics = await response.text();
    expect(metrics).toContain('http_requests_total{method="POST",route="/probe/:id",status="201"} 13');
    expect(metrics).toContain('route="__unmatched__",status="404"} 3');
    expect(metrics).toContain('http_request_duration_seconds_bucket');
    expect(metrics).toContain('le="+Inf"} 13');
    expect(metrics).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-|trace-m18|fallback-m18|secret|9876\.54/);
  });

  it('liveness and real SELECT 1 readiness do not mutate financial rows', async () => {
    expect((await fetch(`${url}/health/live`)).status).toBe(200);
    expect((await fetch(`${url}/health/ready`)).status).toBe(200);
    expect(await snapshot()).toEqual(before);
    expect(uow.getActiveTransactionsCount()).toBe(0);
  });

  it('bounds readiness with an exhausted existing pool and recovers without leaking borrowers', async () => {
    const knex = uow.getOrm().em.getConnection().getKnex();
    const first = await knex.client.acquireConnection();
    const second = await knex.client.acquireConnection();
    try {
      const start = performance.now();
      const responses = await Promise.all(Array.from({ length: 8 }, () => fetch(`${url}/health/ready`)));
      expect(responses.every(response => response.status === 503)).toBe(true);
      for (const response of responses) expect(await response.json()).toEqual({ status: 'unavailable' });
      expect(performance.now() - start).toBeLessThan(1000);
      expect((await fetch(`${url}/health/live`)).status).toBe(200);
    } finally {
      await knex.client.releaseConnection(first);
      await knex.client.releaseConnection(second);
    }
    expect((await fetch(`${url}/health/ready`)).status).toBe(200);
    expect(await snapshot()).toEqual(before);
  });

  it('returns generic 503 when PostgreSQL rejects connections, keeps liveness, closes resources', async () => {
    await maintenance.query(`ALTER DATABASE ${dbName} ALLOW_CONNECTIONS false`);
    try {
      await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND application_name = 'm18_observability'`, [dbName]);
      const response = await fetch(`${url}/health/ready`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: 'unavailable' });
      expect((await fetch(`${url}/health/live`)).status).toBe(200);
      expect(await snapshot()).toEqual(before);
    } finally { await maintenance.query(`ALTER DATABASE ${dbName} ALLOW_CONNECTIONS true`); }
    await app.close();
    expect(uow.isClosed()).toBe(true);
    expect((await admin.query(`SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = 'm18_observability' AND datname = $1`, [dbName])).rows[0].count).toBe(0);
  });
});
