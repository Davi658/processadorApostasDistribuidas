import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import pg from 'pg';
import { AppModule } from '../../src/interfaces/http/app.module';
import { DomainExceptionFilter } from '../../src/interfaces/http/filters/domain-exception.filter';
import { DatabaseMigrator } from '../../src/infrastructure/persistence/migrator';
import { getMigrationDatabaseConfig } from '../../src/infrastructure/config/database.config';

describe('HTTP Endpoints Real Integration & Validation Tests', () => {
  let app: INestApplication;
  let serverUrl: string;
  let adminPool: pg.Pool;

  beforeAll(async () => {
    const migrator = new DatabaseMigrator();
    await migrator.up();
    await migrator.close();

    const migConfig = getMigrationDatabaseConfig();
    adminPool = new pg.Pool({
      host: migConfig.host,
      port: migConfig.port,
      database: migConfig.database,
      user: migConfig.user,
      password: migConfig.password,
    });

    app = await NestFactory.create(AppModule, { logger: false });
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.listen(0);

    const server = app.getHttpServer();
    const address = server.address();
    const port = typeof address === 'string' ? address : address.port;
    serverUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app.close();
    await adminPool.end();
  });

  describe('Wallet Creation & Consultation Contracts', () => {
    it('POST /wallets should create a wallet with initial balance and return 201 with aligned contract', async () => {
      const playerId = crypto.randomUUID();
      const res = await fetch(`${serverUrl}/wallets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerId,
          initialBalance: {
            amount: '150.00',
            currency: 'BRL',
          },
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.id).toBeDefined();
      expect(body.playerId).toBe(playerId);
      expect(body.balance).toEqual({ amount: '150.00', currency: 'BRL' });
      expect(body.version).toBe(1);
    });

    it('POST /wallets should allow opening with explicit zero balance "0.00"', async () => {
      const playerId = crypto.randomUUID();
      const res = await fetch(`${serverUrl}/wallets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerId,
          initialBalance: {
            amount: '0.00',
            currency: 'BRL',
          },
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.balance).toEqual({ amount: '0.00', currency: 'BRL' });
      expect(body.version).toBe(1);
    });

    it('POST /wallets should return 409 Conflict if wallet already exists for player and currency', async () => {
      const playerId = crypto.randomUUID();
      await fetch(`${serverUrl}/wallets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerId,
          initialBalance: { amount: '10.00', currency: 'BRL' },
        }),
      });

      const resDup = await fetch(`${serverUrl}/wallets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerId,
          initialBalance: { amount: '10.00', currency: 'BRL' },
        }),
      });

      expect(resDup.status).toBe(409);
      const body = (await resDup.json()) as any;
      expect(body.code).toBe('DUPLICATE_WALLET');
    });

    it('GET /wallets/:walletId should return 200 with wallet details or 404 if not found', async () => {
      const playerId = crypto.randomUUID();
      const createRes = await fetch(`${serverUrl}/wallets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerId,
          initialBalance: { amount: '50.00', currency: 'BRL' },
        }),
      });
      const created = (await createRes.json()) as any;

      const getRes = await fetch(`${serverUrl}/wallets/${created.id}`);
      expect(getRes.status).toBe(200);
      const getBody = (await getRes.json()) as any;
      expect(getBody.id).toBe(created.id);
      expect(getBody.balance).toEqual({ amount: '50.00', currency: 'BRL' });

      const notFoundRes = await fetch(`${serverUrl}/wallets/${crypto.randomUUID()}`);
      expect(notFoundRes.status).toBe(404);
    });
  });

  describe('HTTP Runtime Input Validation (Requirement 3)', () => {
    it('should return 400 when amount is passed as a number instead of string', async () => {
      const res = await fetch(`${serverUrl}/wallets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerId: crypto.randomUUID(),
          initialBalance: {
            amount: 100.0, // Invalid: number
            currency: 'BRL',
          },
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.message).toContain('must be a decimal string with exactly two decimal places');
    });

    it('should return 400 when initialBalance is passed as null, 0, false or empty string', async () => {
      for (const invalidValue of [null, 0, false, '']) {
        const res = await fetch(`${serverUrl}/wallets`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            playerId: crypto.randomUUID(),
            initialBalance: invalidValue,
          }),
        });
        expect(res.status).toBe(400);
      }
    });

    it('should return 400 when playerId is not a valid UUID', async () => {
      const res = await fetch(`${serverUrl}/wallets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerId: 'invalid-not-a-uuid',
          initialBalance: { amount: '10.00', currency: 'BRL' },
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.message).toContain('must be a valid UUID');
    });

    it('should return 400 when body contains unexpected properties', async () => {
      const res = await fetch(`${serverUrl}/wallets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerId: crypto.randomUUID(),
          unexpectedField: 'forbidden-value',
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.message).toContain('Unexpected property: "unexpectedField"');
    });

    it('POST /wagering/transactions should return 400 when Idempotency-Key header is missing', async () => {
      const res = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: 'prov-1',
          externalTransactionId: 'ext-1',
          playerId: crypto.randomUUID(),
          walletId: crypto.randomUUID(),
          roundId: 'r-1',
          gameId: 'g-1',
          kind: 'BET',
          money: { amount: '10.00', currency: 'BRL' },
        }),
      });

      expect(res.status).toBe(400);
    });

    it('POST /wagering/transactions should return 400 when Idempotency-Key is empty or whitespace only', async () => {
      const res = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': '    ',
        },
        body: JSON.stringify({
          providerId: 'prov-1',
          externalTransactionId: 'ext-1',
          playerId: crypto.randomUUID(),
          walletId: crypto.randomUUID(),
          roundId: 'r-1',
          gameId: 'g-1',
          kind: 'BET',
          money: { amount: '10.00', currency: 'BRL' },
        }),
      });

      expect(res.status).toBe(400);
    });

    it('POST /wagering/transactions should return 400 when kind is not BET', async () => {
      const res = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'some-key',
        },
        body: JSON.stringify({
          providerId: 'prov-1',
          externalTransactionId: 'ext-1',
          playerId: crypto.randomUUID(),
          walletId: crypto.randomUUID(),
          roundId: 'r-1',
          gameId: 'g-1',
          kind: 'WIN',
          money: { amount: '10.00', currency: 'BRL' },
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.message).toContain('Unsupported kind');
    });

    it('POST /wagering/transactions should return 400 when required fields are empty strings', async () => {
      const res = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'some-key',
        },
        body: JSON.stringify({
          providerId: '   ', // whitespace only
          externalTransactionId: 'ext-1',
          playerId: crypto.randomUUID(),
          walletId: crypto.randomUUID(),
          roundId: 'r-1',
          gameId: 'g-1',
          kind: 'BET',
          money: { amount: '10.00', currency: 'BRL' },
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.message).toContain('cannot be empty or contain only whitespace');
    });
  });

  describe('Wagering BET Execution, Idempotency & Reconciliation Contracts', () => {
    it('POST /wagering/transactions should process BET (200), reject on insufficient balance (422), and replay correctly', async () => {
      const playerId = crypto.randomUUID();
      const createRes = await fetch(`${serverUrl}/wallets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerId,
          initialBalance: { amount: '100.00', currency: 'BRL' },
        }),
      });
      const wallet = (await createRes.json()) as any;

      const idempKey1 = `http-idemp-1-${crypto.randomUUID()}`;
      const extTx1 = `ext-http-1-${crypto.randomUUID()}`;

      // 1. Process valid BET of 60.00
      const betRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempKey1,
        },
        body: JSON.stringify({
          providerId: 'prov-http',
          externalTransactionId: extTx1,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'round-1',
          gameId: 'game-1',
          kind: 'BET',
          money: { amount: '60.00', currency: 'BRL' },
        }),
      });

      expect(betRes.status).toBe(200);
      const betBody = (await betRes.json()) as any;
      expect(betBody.status).toBe('PROCESSED');
      expect(betBody.balance).toEqual({ amount: '40.00', currency: 'BRL' });
      expect(betBody.idempotentReplay).toBe(false);

      // 2. Reject BET of 60.00 on remaining balance 40.00
      const idempKey2 = `http-idemp-2-${crypto.randomUUID()}`;
      const extTx2 = `ext-http-2-${crypto.randomUUID()}`;

      const rejectRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempKey2,
        },
        body: JSON.stringify({
          providerId: 'prov-http',
          externalTransactionId: extTx2,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'round-2',
          gameId: 'game-1',
          kind: 'BET',
          money: { amount: '60.00', currency: 'BRL' },
        }),
      });

      expect(rejectRes.status).toBe(422);
      const rejectBody = (await rejectRes.json()) as any;
      expect(rejectBody.status).toBe('REJECTED');
      expect(rejectBody.failureCode).toBe('INSUFFICIENT_FUNDS');
      expect(rejectBody.balance).toEqual({ amount: '40.00', currency: 'BRL' });
      expect(rejectBody.idempotentReplay).toBe(false);

      // 3. Replay processed BET: must return 200 with idempotentReplay: true and original observed balance 40.00
      const replayRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempKey1,
        },
        body: JSON.stringify({
          providerId: 'prov-http',
          externalTransactionId: extTx1,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'round-1',
          gameId: 'game-1',
          kind: 'BET',
          money: { amount: '60.00', currency: 'BRL' },
        }),
      });

      expect(replayRes.status).toBe(200);
      const replayBody = (await replayRes.json()) as any;
      expect(replayBody.status).toBe('PROCESSED');
      expect(replayBody.balance).toEqual({ amount: '40.00', currency: 'BRL' });
      expect(replayBody.transactionId).toBe(betBody.transactionId);
      expect(replayBody.idempotentReplay).toBe(true);

      // 4. Replay rejected BET: must return 422 with idempotentReplay: true, preserving failureCode
      const replayRejectRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempKey2,
        },
        body: JSON.stringify({
          providerId: 'prov-http',
          externalTransactionId: extTx2,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'round-2',
          gameId: 'game-1',
          kind: 'BET',
          money: { amount: '60.00', currency: 'BRL' },
        }),
      });

      expect(replayRejectRes.status).toBe(422);
      const replayRejectBody = (await replayRejectRes.json()) as any;
      expect(replayRejectBody.status).toBe('REJECTED');
      expect(replayRejectBody.failureCode).toBe('INSUFFICIENT_FUNDS');
      expect(replayRejectBody.balance).toEqual({ amount: '40.00', currency: 'BRL' });
      expect(replayRejectBody.idempotentReplay).toBe(true);

      // 5. Reconcile endpoint verification
      const reconRes = await fetch(`${serverUrl}/wallets/${wallet.id}/reconciliation`, {
        method: 'POST',
      });
      expect(reconRes.status).toBe(200);
      const reconBody = (await reconRes.json()) as any;
      expect(reconBody.consistent).toBe(true);
      expect(reconBody.storedBalance).toEqual({ amount: '40.00', currency: 'BRL' });
      expect(reconBody.calculatedBalance).toEqual({ amount: '40.00', currency: 'BRL' });
      expect(reconBody.difference).toEqual({ amount: '0.00', currency: 'BRL' });
      expect(reconBody.checkedEntries).toBe(2);
    });
  });
});
