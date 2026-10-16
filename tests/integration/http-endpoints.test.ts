import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import pg from 'pg';
import { AppModule } from '../../src/interfaces/http/app.module';
import { DomainExceptionFilter } from '../../src/interfaces/http/filters/domain-exception.filter';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm/mikro-orm-adapter';
import { createIsolatedTestDatabase, IsolatedTestDatabase } from '../test-db-helper';

describe('HTTP Endpoints Real Integration & Validation Tests', () => {
  let app: INestApplication;
  let serverUrl: string;
  let isolatedDb: IsolatedTestDatabase;
  let adminPool: pg.Pool;

  beforeAll(async () => {
    // 1. Create disposable database for isolated execution
    isolatedDb = await createIsolatedTestDatabase('http_endpoints_');
    adminPool = new pg.Pool(isolatedDb.adminConfig);
    adminPool.on('error', () => {});

    // 2. Start NestJS application against isolated database
    app = await NestFactory.create(AppModule, { logger: false });
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.listen(0);

    const server = app.getHttpServer();
    const address = server.address();
    const port = typeof address === 'string' ? address : address.port;
    serverUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (app) {
      try {
        const uow = app.get(MikroOrmUnitOfWork);
        await uow.close();
      } catch {}
      await app.close();
    }
    if (adminPool) {
      await adminPool.end();
    }
    if (isolatedDb) {
      await isolatedDb.closeAndDrop();
    }
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

  describe('HTTP Runtime Input Validation (Requirement 3 & 4)', () => {
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

    it('should return 400 when initialBalance contains non-canonical decimal like "00.00"', async () => {
      const res = await fetch(`${serverUrl}/wallets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerId: crypto.randomUUID(),
          initialBalance: {
            amount: '00.00',
            currency: 'BRL',
          },
        }),
      });
      expect(res.status).toBe(400);
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

    it('POST /wagering/transactions should return 400 when Idempotency-Key exceeds 255 chars (256 chars)', async () => {
      const key256 = 'K'.repeat(256);
      const res = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': key256,
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
      const body = (await res.json()) as any;
      expect(body.message).toContain('255 characters');
    });

    it('POST /wagering/transactions should return 400 when kind is not in allowed kinds', async () => {
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
          kind: 'UNSUPPORTED_ACTION',
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

  describe('Idempotency-Key Lengths & Outbox Propagation (Requirement 1)', () => {
    it('should accept 128, 129, and 255 char keys without truncation and persist in outbox with full length', async () => {
      const createRes = await fetch(`${serverUrl}/wallets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerId: crypto.randomUUID(),
          initialBalance: { amount: '500.00', currency: 'BRL' },
        }),
      });
      const wallet = (await createRes.json()) as any;

      const testKeys = [
        'A'.repeat(128),
        'B'.repeat(129),
        'C'.repeat(255),
      ];

      for (const key of testKeys) {
        const extTx = `ext-${key.slice(0, 10)}-${crypto.randomUUID()}`;
        const res = await fetch(`${serverUrl}/wagering/transactions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': key,
          },
          body: JSON.stringify({
            providerId: 'prov-keys',
            externalTransactionId: extTx,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: 'r-keys',
            gameId: 'g-keys',
            kind: 'BET',
            money: { amount: '10.00', currency: 'BRL' },
          }),
        });

        expect(res.status).toBe(200);
        const body = (await res.json()) as any;
        expect(body.status).toBe('PROCESSED');

        // Verify outbox message saved with correlation_id matching full key
        const outboxRes = await adminPool.query(
          'SELECT correlation_id FROM outbox_messages WHERE correlation_id = $1;',
          [key]
        );
        expect(outboxRes.rows.length).toBeGreaterThanOrEqual(1);
        expect(outboxRes.rows[0].correlation_id).toBe(key);
        expect(outboxRes.rows[0].correlation_id.length).toBe(key.length);
      }
    });

    it('should propagate independent x-correlation-id header when provided', async () => {
      const createRes = await fetch(`${serverUrl}/wallets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerId: crypto.randomUUID(),
          initialBalance: { amount: '100.00', currency: 'BRL' },
        }),
      });
      const wallet = (await createRes.json()) as any;

      const idempKey = `idemp-independent-${crypto.randomUUID()}`;
      const correlationId = `corr-${'X'.repeat(200)}`;

      const res = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempKey,
          'x-correlation-id': correlationId,
        },
        body: JSON.stringify({
          providerId: 'prov-corr',
          externalTransactionId: `ext-corr-${crypto.randomUUID()}`,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'r-corr',
          gameId: 'g-corr',
          kind: 'BET',
          money: { amount: '15.00', currency: 'BRL' },
        }),
      });

      expect(res.status).toBe(200);
      const outboxRes = await adminPool.query(
        'SELECT correlation_id FROM outbox_messages WHERE correlation_id = $1;',
        [correlationId]
      );
      expect(outboxRes.rows.length).toBeGreaterThanOrEqual(1);
      expect(outboxRes.rows[0].correlation_id).toBe(correlationId);
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

  describe('HTTP Extended Wager Operations (WIN, LOSS, REFUND, ROLLBACK)', () => {
    it('POST /wagering/transactions should handle WIN, LOSS, REFUND, and ROLLBACK correctly via HTTP', async () => {
      const createRes = await fetch(`${serverUrl}/wallets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerId: crypto.randomUUID(),
          initialBalance: { amount: '100.00', currency: 'BRL' },
        }),
      });
      const wallet = (await createRes.json()) as any;

      // 1. BET: -30.00 -> balance: 70.00
      const betExtId = `bet-http-${crypto.randomUUID()}`;
      const betRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `key-${betExtId}`,
        },
        body: JSON.stringify({
          providerId: 'prov-http',
          externalTransactionId: betExtId,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'r-http-1',
          gameId: 'g-http-1',
          kind: 'BET',
          money: { amount: '30.00', currency: 'BRL' },
        }),
      });
      expect(betRes.status).toBe(200);
      expect(((await betRes.json()) as any).balance.amount).toBe('70.00');

      // 2. WIN: +50.00 -> balance: 120.00
      const winExtId = `win-http-${crypto.randomUUID()}`;
      const winRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `key-${winExtId}`,
        },
        body: JSON.stringify({
          providerId: 'prov-http',
          externalTransactionId: winExtId,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'r-http-1',
          gameId: 'g-http-1',
          kind: 'WIN',
          money: { amount: '50.00', currency: 'BRL' },
        }),
      });
      expect(winRes.status).toBe(200);
      expect(((await winRes.json()) as any).balance.amount).toBe('120.00');

      // 3. LOSS: 0.00 -> balance remains 120.00, version unchanged
      const lossExtId = `loss-http-${crypto.randomUUID()}`;
      const lossRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `key-${lossExtId}`,
        },
        body: JSON.stringify({
          providerId: 'prov-http',
          externalTransactionId: lossExtId,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'r-http-1',
          gameId: 'g-http-1',
          kind: 'LOSS',
          money: { amount: '0.00', currency: 'BRL' },
        }),
      });
      expect(lossRes.status).toBe(200);
      expect(((await lossRes.json()) as any).balance.amount).toBe('120.00');

      // 4. REFUND on BET: reverses BET (+30.00) -> balance: 150.00
      const refundExtId = `ref-http-${crypto.randomUUID()}`;
      const refundRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `key-${refundExtId}`,
        },
        body: JSON.stringify({
          providerId: 'prov-http',
          externalTransactionId: refundExtId,
          referenceExternalTransactionId: betExtId,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'r-http-1',
          gameId: 'g-http-1',
          kind: 'REFUND',
          money: { amount: '30.00', currency: 'BRL' },
        }),
      });
      expect(refundRes.status).toBe(200);
      expect(((await refundRes.json()) as any).balance.amount).toBe('150.00');

      // 5. ROLLBACK on WIN: reverses WIN (-50.00) -> balance: 100.00
      const rollbackExtId = `rb-http-${crypto.randomUUID()}`;
      const rollbackRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `key-${rollbackExtId}`,
        },
        body: JSON.stringify({
          providerId: 'prov-http',
          externalTransactionId: rollbackExtId,
          referenceExternalTransactionId: winExtId,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'r-http-1',
          gameId: 'g-http-1',
          kind: 'ROLLBACK',
          money: { amount: '50.00', currency: 'BRL' },
        }),
      });
      expect(rollbackRes.status).toBe(200);
      expect(((await rollbackRes.json()) as any).balance.amount).toBe('100.00');

      // 6. Reconciliation must be fully consistent
      const reconRes = await fetch(`${serverUrl}/wallets/${wallet.id}/reconciliation`, {
        method: 'POST',
      });
      expect(reconRes.status).toBe(200);
      const recon = (await reconRes.json()) as any;
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('100.00');
      expect(recon.calculatedBalance.amount).toBe('100.00');
    });

    it('POST /wagering/transactions should return 202 Accepted when reference is missing (PENDING_REFERENCE)', async () => {
      const createRes = await fetch(`${serverUrl}/wallets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerId: crypto.randomUUID(),
          initialBalance: { amount: '100.00', currency: 'BRL' },
        }),
      });
      const wallet = (await createRes.json()) as any;

      const refundExtId = `ref-async-${crypto.randomUUID()}`;
      const missingBetExtId = `bet-not-yet-${crypto.randomUUID()}`;

      const res = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `key-${refundExtId}`,
        },
        body: JSON.stringify({
          providerId: 'prov-http',
          externalTransactionId: refundExtId,
          referenceExternalTransactionId: missingBetExtId,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'r-async',
          gameId: 'g-async',
          kind: 'REFUND',
          money: { amount: '25.00', currency: 'BRL' },
        }),
      });

      expect(res.status).toBe(202);
      const body = (await res.json()) as any;
      expect(body.status).toBe('PENDING_REFERENCE');
      expect(body.transactionId).toBeDefined();
    });
  });

  describe('Transient Error Handling (Requirement 5)', () => {
    it('DomainExceptionFilter should map connection errors and PostgreSQL transient codes to 503', () => {
      const filter = new DomainExceptionFilter();
      let capturedStatus = 0;
      let capturedJson: any = null;

      const mockResponse = {
        status: (code: number) => {
          capturedStatus = code;
          return {
            json: (body: any) => {
              capturedJson = body;
            },
          };
        },
      };

      const mockHost = {
        switchToHttp: () => ({
          getResponse: () => mockResponse,
          getRequest: () => ({}),
        }),
      } as any;

      // 1. Test ECONNREFUSED
      const connError = new Error('connect ECONNREFUSED 127.0.0.1:5432');
      (connError as any).code = 'ECONNREFUSED';
      filter.catch(connError, mockHost);

      expect(capturedStatus).toBe(503);
      expect(capturedJson.code).toBe('SERVICE_UNAVAILABLE');
      expect(capturedJson.message).toBe('The service is temporarily unavailable. Please retry shortly.');

      // 2. Test PostgreSQL transient code 57P01 (admin_shutdown)
      const pgTransientError = new Error('terminating connection due to administrator command');
      (pgTransientError as any).code = '57P01';
      filter.catch(pgTransientError, mockHost);

      expect(capturedStatus).toBe(503);
      expect(capturedJson.code).toBe('SERVICE_UNAVAILABLE');

      // 3. Non-transient errors should not be 503
      const regularError = new Error('Some unexpected internal error');
      filter.catch(regularError, mockHost);
      expect(capturedStatus).toBe(500);
      expect(capturedJson.code).toBe('INTERNAL_SERVER_ERROR');
    });
  });

  describe('Idempotency Key Payload Conflict & Replay Tests', () => {
    it('3. Via HTTP, mesma Idempotency-Key com valor diferente deve retornar 409 sem novo debito, ledger ou evento na outbox, e 4. Payload identico deve realizar replay com resultado original', async () => {
      // Setup: Carteira com saldo 100.00
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

      const idempotencyKey = `idemp-conflict-test-${crypto.randomUUID()}`;
      const extTxId = `ext-tx-${crypto.randomUUID()}`;

      // 1. Processar BET inicial de 10.00
      const initialBetRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          providerId: 'prov-conflict',
          externalTransactionId: extTxId,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'r-conflict',
          gameId: 'g-conflict',
          kind: 'BET',
          money: { amount: '10.00', currency: 'BRL' },
        }),
      });

      expect(initialBetRes.status).toBe(200);
      const initialBody = (await initialBetRes.json()) as any;
      expect(initialBody.status).toBe('PROCESSED');
      expect(initialBody.balance).toEqual({ amount: '90.00', currency: 'BRL' });
      expect(initialBody.idempotentReplay).toBe(false);
      const originalTxId = initialBody.transactionId;

      // Inspecionar contadores no banco antes da tentativa de conflito
      const txCountBeforeRes = await adminPool.query(
        'SELECT COUNT(*) FROM wager_transactions WHERE wallet_id = $1;',
        [wallet.id]
      );
      const txCountBefore = Number(txCountBeforeRes.rows[0].count);
      expect(txCountBefore).toBe(2); // OPENING + BET

      const ledgerCountBeforeRes = await adminPool.query(
        'SELECT COUNT(*) FROM wallet_ledger_entries WHERE wallet_id = $1;',
        [wallet.id]
      );
      const ledgerCountBefore = Number(ledgerCountBeforeRes.rows[0].count);
      expect(ledgerCountBefore).toBe(2); // OPENING (CREDIT) + BET (DEBIT)

      const outboxCountBeforeRes = await adminPool.query(
        'SELECT COUNT(*) FROM outbox_messages WHERE aggregate_id = $1;',
        [wallet.id]
      );
      const outboxCountBefore = Number(outboxCountBeforeRes.rows[0].count);

      // 2. Submeter a MESMA Idempotency-Key com payload alterado (valor 25.00 ao inves de 10.00)
      const conflictRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          providerId: 'prov-conflict',
          externalTransactionId: extTxId,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'r-conflict',
          gameId: 'g-conflict',
          kind: 'BET',
          money: { amount: '25.00', currency: 'BRL' }, // valor diferente!
        }),
      });

      // Deve retornar 409 Conflict
      expect(conflictRes.status).toBe(409);
      const conflictBody = (await conflictRes.json()) as any;
      expect(conflictBody.code).toBe('IDEMPOTENCY_CONFLICT');

      // 3. Comprovar que NENHUM novo debito, transacao, ledger ou outbox ocorreu
      const walletAfterConflictRes = await fetch(`${serverUrl}/wallets/${wallet.id}`);
      const walletAfterConflict = (await walletAfterConflictRes.json()) as any;
      expect(walletAfterConflict.balance.amount).toBe('90.00'); // Saldo permaneceu 90.00, sem debito
      expect(walletAfterConflict.version).toBe(2); // Versao permaneceu 2

      const txCountAfterConflictRes = await adminPool.query(
        'SELECT COUNT(*) FROM wager_transactions WHERE wallet_id = $1;',
        [wallet.id]
      );
      expect(Number(txCountAfterConflictRes.rows[0].count)).toBe(txCountBefore); // Nenhuma nova transacao

      const txRowRes = await adminPool.query(
        'SELECT status, amount, currency FROM wager_transactions WHERE id = $1;',
        [originalTxId]
      );
      expect(txRowRes.rows[0].status).toBe('PROCESSED');
      expect(txRowRes.rows[0].amount).toBe('10.00');
      expect(txRowRes.rows[0].currency).toBe('BRL');

      const ledgerCountAfterConflictRes = await adminPool.query(
        'SELECT COUNT(*) FROM wallet_ledger_entries WHERE wallet_id = $1;',
        [wallet.id]
      );
      expect(Number(ledgerCountAfterConflictRes.rows[0].count)).toBe(ledgerCountBefore); // Sem novo ledger

      const outboxCountAfterConflictRes = await adminPool.query(
        'SELECT COUNT(*) FROM outbox_messages WHERE aggregate_id = $1;',
        [wallet.id]
      );
      expect(Number(outboxCountAfterConflictRes.rows[0].count)).toBe(outboxCountBefore); // Sem novo evento na outbox

      // 4. Submeter payload IDENTICO (valor 10.00) -> Replay idempotente com resultado original
      const replayRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          providerId: 'prov-conflict',
          externalTransactionId: extTxId,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'r-conflict',
          gameId: 'g-conflict',
          kind: 'BET',
          money: { amount: '10.00', currency: 'BRL' }, // payload identico
        }),
      });

      expect(replayRes.status).toBe(200);
      const replayBody = (await replayRes.json()) as any;
      expect(replayBody.status).toBe('PROCESSED');
      expect(replayBody.transactionId).toBe(originalTxId);
      expect(replayBody.balance).toEqual({ amount: '90.00', currency: 'BRL' });
      expect(replayBody.idempotentReplay).toBe(true);

      // Saldo, versao, transacoes, ledger e outbox permanecem intactos apos replay (sem novos registros ou movimentos)
      const walletAfterReplayRes = await fetch(`${serverUrl}/wallets/${wallet.id}`);
      const walletAfterReplay = (await walletAfterReplayRes.json()) as any;
      expect(walletAfterReplay.balance.amount).toBe('90.00');
      expect(walletAfterReplay.version).toBe(2);

      const txCountAfterReplayRes = await adminPool.query(
        'SELECT COUNT(*) FROM wager_transactions WHERE wallet_id = $1;',
        [wallet.id]
      );
      expect(Number(txCountAfterReplayRes.rows[0].count)).toBe(txCountBefore);

      const ledgerCountAfterReplayRes = await adminPool.query(
        'SELECT COUNT(*) FROM wallet_ledger_entries WHERE wallet_id = $1;',
        [wallet.id]
      );
      expect(Number(ledgerCountAfterReplayRes.rows[0].count)).toBe(ledgerCountBefore);

      const outboxCountAfterReplayRes = await adminPool.query(
        'SELECT COUNT(*) FROM outbox_messages WHERE aggregate_id = $1;',
        [wallet.id]
      );
      expect(Number(outboxCountAfterReplayRes.rows[0].count)).toBe(outboxCountBefore);
    });
  });
});
