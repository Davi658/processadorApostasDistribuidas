import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { AppModule } from '../../src/interfaces/http/app.module';
import { DomainExceptionFilter } from '../../src/interfaces/http/filters/domain-exception.filter';
import {
  MikroOrmOutboxRepository,
  MikroOrmUnitOfWork,
  MikroOrmWagerTransactionRepository,
  MikroOrmWalletLedgerRepository,
  MikroOrmWalletRepository,
} from '../../src/infrastructure/persistence/mikro-orm/mikro-orm-adapter';
import { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet.use-case';
import { GetWalletUseCase } from '../../src/application/use-cases/get-wallet.use-case';
import { ProcessWagerUseCase } from '../../src/application/use-cases/process-wager.use-case';
import { ReconcileWalletUseCase } from '../../src/application/use-cases/reconcile-wallet.use-case';
import { ReprocessPendingReferencesUseCase } from '../../src/application/use-cases/reprocess-pending-references.use-case';
import { ProcessWagerDto, WagerResponseDto } from '../../src/application/dto/wager.dto';
import { createIsolatedTestDatabase, IsolatedTestDatabase } from '../test-db-helper';

describe('M09: Replay de PENDING_REFERENCE e Transições Terminais (PostgreSQL Real Descartável)', () => {
  let isolatedDb: IsolatedTestDatabase;
  let adminPool: pg.Pool;
  let app: INestApplication;
  let serverUrl: string;

  let uow: MikroOrmUnitOfWork;
  let walletRepo: MikroOrmWalletRepository;
  let wagerRepo: MikroOrmWagerTransactionRepository;
  let ledgerRepo: MikroOrmWalletLedgerRepository;
  let outboxRepo: MikroOrmOutboxRepository;

  let createWalletUseCase: CreateWalletUseCase;
  let getWalletUseCase: GetWalletUseCase;
  let processWagerUseCase: ProcessWagerUseCase;
  let reconcileWalletUseCase: ReconcileWalletUseCase;
  let reprocessWorker: ReprocessPendingReferencesUseCase;

  interface DbStateSnapshot {
    wallet: { balance: string; version: number };
    transaction: {
      status: string;
      attempts: number;
      nextAttemptAt: string | null;
      responseSnapshot: any;
      updatedAt: string;
    };
    ledgerCount: number;
    outboxCount: number;
  }

  async function captureDbState(walletId: string, txId: string): Promise<DbStateSnapshot> {
    const walletRes = await adminPool.query('SELECT balance, version FROM wallets WHERE id = $1;', [walletId]);
    const txRes = await adminPool.query(
      'SELECT status, attempts, next_attempt_at, response_snapshot, updated_at FROM wager_transactions WHERE id = $1;',
      [txId]
    );
    const ledgerRes = await adminPool.query('SELECT COUNT(*) FROM wallet_ledger_entries WHERE wallet_id = $1;', [walletId]);
    const outboxRes = await adminPool.query('SELECT COUNT(*) FROM outbox_messages WHERE aggregate_id = $1;', [walletId]);

    return {
      wallet: {
        balance: walletRes.rows[0].balance,
        version: walletRes.rows[0].version,
      },
      transaction: {
        status: txRes.rows[0].status,
        attempts: txRes.rows[0].attempts,
        nextAttemptAt: txRes.rows[0].next_attempt_at ? new Date(txRes.rows[0].next_attempt_at).toISOString() : null,
        responseSnapshot: txRes.rows[0].response_snapshot,
        updatedAt: new Date(txRes.rows[0].updated_at).toISOString(),
      },
      ledgerCount: parseInt(ledgerRes.rows[0].count, 10),
      outboxCount: parseInt(outboxRes.rows[0].count, 10),
    };
  }

  async function makePendingEligible(transactionId: string): Promise<void> {
    await adminPool.query(
      "UPDATE wager_transactions SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = $1;",
      [transactionId]
    );
  }

  beforeAll(async () => {
    isolatedDb = await createIsolatedTestDatabase('m09_pending_replay_');

    adminPool = new pg.Pool({
      ...isolatedDb.adminConfig,
      max: 65,
    });
    adminPool.on('error', () => {});

    app = await NestFactory.create(AppModule, { logger: false });
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.listen(0);

    const server = app.getHttpServer();
    const address = server.address();
    const port = typeof address === 'string' ? address : address.port;
    serverUrl = `http://127.0.0.1:${port}`;

    uow = app.get(MikroOrmUnitOfWork);
    walletRepo = app.get(MikroOrmWalletRepository);
    wagerRepo = app.get(MikroOrmWagerTransactionRepository);
    ledgerRepo = app.get(MikroOrmWalletLedgerRepository);
    outboxRepo = app.get(MikroOrmOutboxRepository);

    createWalletUseCase = app.get(CreateWalletUseCase);
    getWalletUseCase = app.get(GetWalletUseCase);
    processWagerUseCase = app.get(ProcessWagerUseCase);
    reconcileWalletUseCase = app.get(ReconcileWalletUseCase);
    reprocessWorker = app.get(ReprocessPendingReferencesUseCase);
  }, 60000);

  afterAll(async () => {
    if (app) {
      try {
        const ormUow = app.get(MikroOrmUnitOfWork);
        await ormUow.close();
      } catch {}
      await app.close();
    }
    if (adminPool) {
      await adminPool.end();
    }
    if (isolatedDb) {
      await isolatedDb.closeAndDrop();
    }
  }, 60000);

  describe('Critérios A, B e C: Aceite Pendente, Replay Imediato e Saldo Histórico Preservado', () => {
    it('deve processar aceite, replay imediato e replay histórico após mutação para WIN', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const idempotencyKey = `idemp-win-${Date.now()}`;
      const payload: ProcessWagerDto = {
        walletId: wallet.id,
        playerId,
        providerId: 'EVOLUTION',
        externalTransactionId: `ext-win-${Date.now()}`,
        roundId: `round-${Date.now()}`,
        gameId: 'roulette',
        kind: 'WIN',
        money: { amount: '50.00', currency: 'BRL' },
        referenceExternalTransactionId: `bet-missing-${Date.now()}`,
      };

      // A. Aceite pendente com resposta e snapshot completos
      const resA = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(payload),
      });

      expect(resA.status).toBe(202);
      const dataA = (await resA.json()) as WagerResponseDto;
      expect(dataA.transactionId).toBeDefined();
      expect(dataA.status).toBe('PENDING_REFERENCE');
      expect(dataA.balance).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(dataA.idempotentReplay).toBe(false);

      // Verificação atômica no banco: snapshot, transação e evento de pendência
      const stateA = await captureDbState(wallet.id, dataA.transactionId);
      expect(stateA.wallet.balance).toBe('100.00');
      expect(stateA.wallet.version).toBe(1);
      expect(stateA.transaction.status).toBe('PENDING_REFERENCE');
      expect(stateA.transaction.attempts).toBe(1);
      expect(stateA.transaction.nextAttemptAt).toBeDefined();
      expect(stateA.transaction.responseSnapshot).toEqual({
        transactionId: dataA.transactionId,
        status: 'PENDING_REFERENCE',
        balance: { amount: '100.00', currency: 'BRL' },
        idempotentReplay: false,
      });

      const pendingEventsRes = await adminPool.query(
        "SELECT event_type, payload FROM outbox_messages WHERE aggregate_id = $1 AND event_type = 'WagerTransactionPendingReference';",
        [wallet.id]
      );
      expect(pendingEventsRes.rows.length).toBe(1);
      expect(pendingEventsRes.rows[0].payload.transactionId).toBe(dataA.transactionId);

      // B. Replay imediato -> 202 e mesmo resultado de aceitação
      const resB = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(payload),
      });

      expect(resB.status).toBe(202);
      const dataB = (await resB.json()) as WagerResponseDto;
      expect(dataB.transactionId).toBe(dataA.transactionId);
      expect(dataB.status).toBe('PENDING_REFERENCE');
      expect(dataB.balance).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(dataB.idempotentReplay).toBe(true);

      const stateB = await captureDbState(wallet.id, dataA.transactionId);
      expect(stateB.wallet.balance).toBe(stateA.wallet.balance);
      expect(stateB.wallet.version).toBe(stateA.wallet.version);
      expect(stateB.transaction.status).toBe(stateA.transaction.status);
      expect(stateB.transaction.attempts).toBe(stateA.transaction.attempts);
      expect(stateB.transaction.nextAttemptAt).toBe(stateA.transaction.nextAttemptAt);
      expect(stateB.transaction.responseSnapshot).toEqual(stateA.transaction.responseSnapshot);
      expect(stateB.ledgerCount).toBe(stateA.ledgerCount);
      expect(stateB.outboxCount).toBe(stateA.outboxCount);

      // C. Outra operação altera saldo; replay conserva saldo histórico
      const independentBetKey = `bet-indep-${Date.now()}`;
      const betPayload: ProcessWagerDto = {
        walletId: wallet.id,
        playerId,
        providerId: 'EVOLUTION',
        externalTransactionId: `ext-bet-indep-${Date.now()}`,
        roundId: `round-indep-${Date.now()}`,
        gameId: 'roulette',
        kind: 'BET',
        money: { amount: '30.00', currency: 'BRL' },
      };

      const betRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'idempotency-key': independentBetKey,
        },
        body: JSON.stringify(betPayload),
      });
      expect(betRes.status).toBe(200);

      // Carteira agora possui saldo 70.00 BRL e version 2
      const walletAfterBet = await getWalletUseCase.execute(wallet.id);
      expect(walletAfterBet.balance.amount).toBe('70.00');
      expect(walletAfterBet.version).toBe(2);

      // Replay da WIN pendente: deve preservar o saldo histórico de 100.00 BRL
      const resC = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(payload),
      });

      expect(resC.status).toBe(202);
      const dataC = (await resC.json()) as WagerResponseDto;
      expect(dataC.transactionId).toBe(dataA.transactionId);
      expect(dataC.status).toBe('PENDING_REFERENCE');
      expect(dataC.balance).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(dataC.idempotentReplay).toBe(true);

      const stateC = await captureDbState(wallet.id, dataA.transactionId);
      expect(stateC.wallet.balance).toBe('70.00'); // Não alterado pelo replay
      expect(stateC.wallet.version).toBe(2); // Não alterado pelo replay
      expect(stateC.transaction.attempts).toBe(1); // Replay não incrementa attempts
      expect(stateC.transaction.nextAttemptAt).toBe(stateA.transaction.nextAttemptAt); // Replay não modifica nextAttemptAt

      const rec = await reconcileWalletUseCase.execute(wallet.id);
      expect(rec.consistent).toBe(true);
    });

    it('deve processar aceite, replay imediato e replay histórico após mutação para REFUND', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '200.00', currency: 'BRL' },
      });

      const idempotencyKey = `idemp-refund-${Date.now()}`;
      const payload: ProcessWagerDto = {
        walletId: wallet.id,
        playerId,
        providerId: 'PRAGMATIC',
        externalTransactionId: `ext-ref-${Date.now()}`,
        roundId: `round-${Date.now()}`,
        gameId: 'slots',
        kind: 'REFUND',
        money: { amount: '40.00', currency: 'BRL' },
        referenceExternalTransactionId: `bet-missing-${Date.now()}`,
      };

      // A. Aceite pendente
      const resA = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(payload),
      });

      expect(resA.status).toBe(202);
      const dataA = (await resA.json()) as WagerResponseDto;
      expect(dataA.status).toBe('PENDING_REFERENCE');
      expect(dataA.balance).toEqual({ amount: '200.00', currency: 'BRL' });
      expect(dataA.idempotentReplay).toBe(false);

      const stateA = await captureDbState(wallet.id, dataA.transactionId);
      expect(stateA.transaction.responseSnapshot).toEqual({
        transactionId: dataA.transactionId,
        status: 'PENDING_REFERENCE',
        balance: { amount: '200.00', currency: 'BRL' },
        idempotentReplay: false,
      });

      // B. Replay imediato
      const resB = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(payload),
      });

      expect(resB.status).toBe(202);
      const dataB = (await resB.json()) as WagerResponseDto;
      expect(dataB.balance).toEqual({ amount: '200.00', currency: 'BRL' });
      expect(dataB.idempotentReplay).toBe(true);

      const stateB = await captureDbState(wallet.id, dataA.transactionId);
      expect(stateB.wallet.balance).toBe('200.00');
      expect(stateB.transaction.attempts).toBe(1);

      // C. Mutação independente e replay
      const indepBetRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'idempotency-key': `bet-indep-ref-${Date.now()}`,
        },
        body: JSON.stringify({
          walletId: wallet.id,
          playerId,
          providerId: 'PRAGMATIC',
          externalTransactionId: `ext-bet-ref-${Date.now()}`,
          roundId: `round-indep-${Date.now()}`,
          gameId: 'slots',
          kind: 'BET',
          money: { amount: '50.00', currency: 'BRL' },
        }),
      });
      expect(indepBetRes.status).toBe(200);

      const resC = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(payload),
      });

      expect(resC.status).toBe(202);
      const dataC = (await resC.json()) as WagerResponseDto;
      expect(dataC.balance).toEqual({ amount: '200.00', currency: 'BRL' }); // Saldo histórico
      expect(dataC.idempotentReplay).toBe(true);

      const stateC = await captureDbState(wallet.id, dataA.transactionId);
      expect(stateC.wallet.balance).toBe('150.00');
      expect(stateC.transaction.attempts).toBe(1);
    });

    it('deve processar aceite, replay imediato e replay histórico após mutação para ROLLBACK', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '300.00', currency: 'BRL' },
      });

      const idempotencyKey = `idemp-roll-${Date.now()}`;
      const payload: ProcessWagerDto = {
        walletId: wallet.id,
        playerId,
        providerId: 'EVOLUTION',
        externalTransactionId: `ext-roll-${Date.now()}`,
        roundId: `round-${Date.now()}`,
        gameId: 'blackjack',
        kind: 'ROLLBACK',
        money: { amount: '60.00', currency: 'BRL' },
        referenceExternalTransactionId: `win-missing-${Date.now()}`,
      };

      // A. Aceite pendente
      const resA = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(payload),
      });

      expect(resA.status).toBe(202);
      const dataA = (await resA.json()) as WagerResponseDto;
      expect(dataA.status).toBe('PENDING_REFERENCE');
      expect(dataA.balance).toEqual({ amount: '300.00', currency: 'BRL' });
      expect(dataA.idempotentReplay).toBe(false);

      const stateA = await captureDbState(wallet.id, dataA.transactionId);
      expect(stateA.transaction.responseSnapshot).toEqual({
        transactionId: dataA.transactionId,
        status: 'PENDING_REFERENCE',
        balance: { amount: '300.00', currency: 'BRL' },
        idempotentReplay: false,
      });

      // B. Replay imediato
      const resB = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(payload),
      });

      expect(resB.status).toBe(202);
      const dataB = (await resB.json()) as WagerResponseDto;
      expect(dataB.balance).toEqual({ amount: '300.00', currency: 'BRL' });
      expect(dataB.idempotentReplay).toBe(true);

      // C. Mutação independente e replay
      await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'idempotency-key': `bet-indep-roll-${Date.now()}`,
        },
        body: JSON.stringify({
          walletId: wallet.id,
          playerId,
          providerId: 'EVOLUTION',
          externalTransactionId: `ext-bet-roll-${Date.now()}`,
          roundId: `round-indep-${Date.now()}`,
          gameId: 'blackjack',
          kind: 'BET',
          money: { amount: '100.00', currency: 'BRL' },
        }),
      });

      const resC = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(payload),
      });

      expect(resC.status).toBe(202);
      const dataC = (await resC.json()) as WagerResponseDto;
      expect(dataC.balance).toEqual({ amount: '300.00', currency: 'BRL' }); // Saldo histórico mantido
      expect(dataC.idempotentReplay).toBe(true);

      const stateC = await captureDbState(wallet.id, dataA.transactionId);
      expect(stateC.wallet.balance).toBe('200.00');
      expect(stateC.transaction.attempts).toBe(1);
    });
  });

  describe('Critério D: Reprocessamento sem Referência e Invariância do Replay', () => {
    it('deve aplicar backoff no retry sem que o replay altere attempts, nextAttemptAt ou snapshot (WIN)', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '150.00', currency: 'BRL' },
      });

      const idempotencyKey = `idemp-crit-d-${Date.now()}`;
      const payload: ProcessWagerDto = {
        walletId: wallet.id,
        playerId,
        providerId: 'EVOLUTION',
        externalTransactionId: `ext-d-${Date.now()}`,
        roundId: `round-${Date.now()}`,
        gameId: 'baccarat',
        kind: 'WIN',
        money: { amount: '25.00', currency: 'BRL' },
        referenceExternalTransactionId: `bet-d-missing-${Date.now()}`,
      };

      const resInit = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify(payload),
      });
      const dataInit = (await resInit.json()) as WagerResponseDto;
      expect(dataInit.status).toBe('PENDING_REFERENCE');

      // 1. Executa reprocessador manualmente sem que a referência exista
      await makePendingEligible(dataInit.transactionId);
      const reprocessRes = await reprocessWorker.execute(10);
      expect(reprocessRes.rescheduled).toBeGreaterThanOrEqual(1);

      // Estado pós-reprocessamento: attempts incrementou para 2, snapshot preservado
      const stateAfterRetry = await captureDbState(wallet.id, dataInit.transactionId);
      expect(stateAfterRetry.transaction.attempts).toBe(2);
      expect(stateAfterRetry.transaction.responseSnapshot).toEqual({
        transactionId: dataInit.transactionId,
        status: 'PENDING_REFERENCE',
        balance: { amount: '150.00', currency: 'BRL' },
        idempotentReplay: false,
      });

      // 2. Replay HTTP: não deve alterar attempts (deve permanecer 2), nextAttemptAt ou snapshot
      const resReplay = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify(payload),
      });

      expect(resReplay.status).toBe(202);
      const dataReplay = (await resReplay.json()) as WagerResponseDto;
      expect(dataReplay.balance).toEqual({ amount: '150.00', currency: 'BRL' });
      expect(dataReplay.idempotentReplay).toBe(true);

      const stateAfterReplay = await captureDbState(wallet.id, dataInit.transactionId);
      expect(stateAfterReplay.transaction.attempts).toBe(2); // Invariante: replay não incrementou
      expect(stateAfterReplay.transaction.nextAttemptAt).toBe(stateAfterRetry.transaction.nextAttemptAt);
      expect(stateAfterReplay.transaction.responseSnapshot).toEqual(stateAfterRetry.transaction.responseSnapshot);
      expect(stateAfterReplay.wallet.balance).toBe(stateAfterRetry.wallet.balance);
      expect(stateAfterReplay.wallet.version).toBe(stateAfterRetry.wallet.version);
      expect(stateAfterReplay.ledgerCount).toBe(stateAfterRetry.ledgerCount);
      expect(stateAfterReplay.outboxCount).toBe(stateAfterRetry.outboxCount);
    });

    it('deve aplicar backoff no retry sem que o replay altere attempts, nextAttemptAt ou snapshot (REFUND)', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '180.00', currency: 'BRL' },
      });

      const idempotencyKey = `idemp-crit-d-ref-${Date.now()}`;
      const payload: ProcessWagerDto = {
        walletId: wallet.id,
        playerId,
        providerId: 'EVOLUTION',
        externalTransactionId: `ext-d-ref-${Date.now()}`,
        roundId: `round-${Date.now()}`,
        gameId: 'baccarat',
        kind: 'REFUND',
        money: { amount: '20.00', currency: 'BRL' },
        referenceExternalTransactionId: `bet-d-ref-missing-${Date.now()}`,
      };

      const resInit = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify(payload),
      });
      const dataInit = (await resInit.json()) as WagerResponseDto;

      await makePendingEligible(dataInit.transactionId);
      await reprocessWorker.execute(10);

      const stateAfterRetry = await captureDbState(wallet.id, dataInit.transactionId);
      expect(stateAfterRetry.transaction.attempts).toBe(2);

      const resReplay = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify(payload),
      });

      expect(resReplay.status).toBe(202);
      const dataReplay = (await resReplay.json()) as WagerResponseDto;
      expect(dataReplay.balance).toEqual({ amount: '180.00', currency: 'BRL' });
      expect(dataReplay.idempotentReplay).toBe(true);

      const stateAfterReplay = await captureDbState(wallet.id, dataInit.transactionId);
      expect(stateAfterReplay.transaction.attempts).toBe(2);
      expect(stateAfterReplay.transaction.nextAttemptAt).toBe(stateAfterRetry.transaction.nextAttemptAt);
    });
  });

  describe('Critério E: Resolução com Referência Válida e Replay Terminal', () => {
    it('deve resolver WIN pendente para PROCESSED e replay deve retornar resultado terminal sem efeitos colaterais', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const providerId = 'EVOLUTION';
      const roundId = `round-${Date.now()}`;
      const betExtId = `bet-ext-${Date.now()}`;

      // 1. Cria a WIN pendente primeiro (fora de ordem)
      const winIdempotencyKey = `idemp-win-res-${Date.now()}`;
      const winPayload: ProcessWagerDto = {
        walletId: wallet.id,
        playerId,
        providerId,
        externalTransactionId: `win-ext-${Date.now()}`,
        roundId,
        gameId: 'roulette',
        kind: 'WIN',
        money: { amount: '80.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      };

      const winRes1 = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': winIdempotencyKey },
        body: JSON.stringify(winPayload),
      });
      expect(winRes1.status).toBe(202);
      const winData1 = (await winRes1.json()) as WagerResponseDto;
      expect(winData1.status).toBe('PENDING_REFERENCE');

      // 2. Referência BET chega e é processada
      const betRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': `bet-res-${Date.now()}` },
        body: JSON.stringify({
          walletId: wallet.id,
          playerId,
          providerId,
          externalTransactionId: betExtId,
          roundId,
          gameId: 'roulette',
          kind: 'BET',
          money: { amount: '30.00', currency: 'BRL' },
        }),
      });
      expect(betRes.status).toBe(200);

      // 3. Execução manual do reprocessador resolve a WIN pendente
      await makePendingEligible(winData1.transactionId);
      const reprocessRes = await reprocessWorker.execute(10);
      expect(reprocessRes.processed).toBeGreaterThanOrEqual(1);

      // Saldo após WIN resolvida: 100.00 - 30.00 (BET) + 80.00 (WIN) = 150.00 BRL
      const walletAfterResolution = await getWalletUseCase.execute(wallet.id);
      expect(walletAfterResolution.balance.amount).toBe('150.00');

      const stateTerminal = await captureDbState(wallet.id, winData1.transactionId);
      expect(stateTerminal.transaction.status).toBe('PROCESSED');
      expect(stateTerminal.transaction.responseSnapshot).toEqual({
        transactionId: winData1.transactionId,
        status: 'PROCESSED',
        balance: { amount: '150.00', currency: 'BRL' },
        idempotentReplay: false,
      });

      // 4. Replay HTTP: deve retornar 200 OK com snapshot terminal e idempotentReplay: true
      const replayRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': winIdempotencyKey },
        body: JSON.stringify(winPayload),
      });

      expect(replayRes.status).toBe(200);
      const replayData = (await replayRes.json()) as WagerResponseDto;
      expect(replayData.transactionId).toBe(winData1.transactionId);
      expect(replayData.status).toBe('PROCESSED');
      expect(replayData.balance).toEqual({ amount: '150.00', currency: 'BRL' });
      expect(replayData.idempotentReplay).toBe(true);

      // 5. Outra operação altera saldo; novo replay mantém resultado histórico
      await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': `bet-after-${Date.now()}` },
        body: JSON.stringify({
          walletId: wallet.id,
          playerId,
          providerId,
          externalTransactionId: `bet-after-ext-${Date.now()}`,
          roundId: `round-other-${Date.now()}`,
          gameId: 'roulette',
          kind: 'BET',
          money: { amount: '20.00', currency: 'BRL' },
        }),
      });

      const replayRes2 = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': winIdempotencyKey },
        body: JSON.stringify(winPayload),
      });

      expect(replayRes2.status).toBe(200);
      const replayData2 = (await replayRes2.json()) as WagerResponseDto;
      expect(replayData2.balance).toEqual({ amount: '150.00', currency: 'BRL' }); // Permanece 150.00 histórico
      expect(replayData2.idempotentReplay).toBe(true);

      const stateAfterReplay2 = await captureDbState(wallet.id, winData1.transactionId);
      expect(stateAfterReplay2.wallet.balance).toBe('130.00'); // Saldo atual no banco
      expect(stateAfterReplay2.transaction.responseSnapshot.balance.amount).toBe('150.00'); // Snapshot histórico
    });

    it('deve resolver REFUND pendente para PROCESSED e replay deve retornar resultado terminal sem efeitos colaterais', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '200.00', currency: 'BRL' },
      });

      const providerId = 'PRAGMATIC';
      const roundId = `round-${Date.now()}`;
      const betExtId = `bet-ref-ext-${Date.now()}`;

      // 1. REFUND pendente
      const refundKey = `idemp-ref-res-${Date.now()}`;
      const refundPayload: ProcessWagerDto = {
        walletId: wallet.id,
        playerId,
        providerId,
        externalTransactionId: `ref-ext-${Date.now()}`,
        roundId,
        gameId: 'slots',
        kind: 'REFUND',
        money: { amount: '50.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      };

      const refundRes1 = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': refundKey },
        body: JSON.stringify(refundPayload),
      });
      expect(refundRes1.status).toBe(202);
      const refundData1 = (await refundRes1.json()) as WagerResponseDto;

      // 2. BET chega
      await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': `bet-ref-key-${Date.now()}` },
        body: JSON.stringify({
          walletId: wallet.id,
          playerId,
          providerId,
          externalTransactionId: betExtId,
          roundId,
          gameId: 'slots',
          kind: 'BET',
          money: { amount: '50.00', currency: 'BRL' },
        }),
      });

      // 3. Resolução
      await makePendingEligible(refundData1.transactionId);
      const reprocessRes = await reprocessWorker.execute(10);
      expect(reprocessRes.processed).toBeGreaterThanOrEqual(1);

      // Saldo após REFUND: 200.00 - 50.00 + 50.00 = 200.00 BRL
      const walletAfter = await getWalletUseCase.execute(wallet.id);
      expect(walletAfter.balance.amount).toBe('200.00');

      // 4. Replay HTTP
      const replayRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': refundKey },
        body: JSON.stringify(refundPayload),
      });

      expect(replayRes.status).toBe(200);
      const replayData = (await replayRes.json()) as WagerResponseDto;
      expect(replayData.status).toBe('PROCESSED');
      expect(replayData.balance).toEqual({ amount: '200.00', currency: 'BRL' });
      expect(replayData.idempotentReplay).toBe(true);
    });

    it('deve resolver ROLLBACK pendente para PROCESSED e replay deve retornar resultado terminal sem efeitos colaterais', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '300.00', currency: 'BRL' },
      });

      const providerId = 'EVOLUTION';
      const roundId = `round-${Date.now()}`;
      const betExtId = `bet-roll-ext-${Date.now()}`;

      // 1. ROLLBACK pendente (reversão de BET)
      const rollKey = `idemp-roll-res-${Date.now()}`;
      const rollPayload: ProcessWagerDto = {
        walletId: wallet.id,
        playerId,
        providerId,
        externalTransactionId: `roll-ext-${Date.now()}`,
        roundId,
        gameId: 'blackjack',
        kind: 'ROLLBACK',
        money: { amount: '70.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      };

      const rollRes1 = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': rollKey },
        body: JSON.stringify(rollPayload),
      });
      expect(rollRes1.status).toBe(202);
      const rollData1 = (await rollRes1.json()) as WagerResponseDto;

      // 2. BET chega
      await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': `bet-roll-key-${Date.now()}` },
        body: JSON.stringify({
          walletId: wallet.id,
          playerId,
          providerId,
          externalTransactionId: betExtId,
          roundId,
          gameId: 'blackjack',
          kind: 'BET',
          money: { amount: '70.00', currency: 'BRL' },
        }),
      });

      // 3. Resolução
      await makePendingEligible(rollData1.transactionId);
      const reprocessRes = await reprocessWorker.execute(10);
      expect(reprocessRes.processed).toBeGreaterThanOrEqual(1);

      // Saldo após ROLLBACK da BET: 300.00 - 70.00 + 70.00 = 300.00 BRL
      const replayRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': rollKey },
        body: JSON.stringify(rollPayload),
      });

      expect(replayRes.status).toBe(200);
      const replayData = (await replayRes.json()) as WagerResponseDto;
      expect(replayData.status).toBe('PROCESSED');
      expect(replayData.balance).toEqual({ amount: '300.00', currency: 'BRL' });
      expect(replayData.idempotentReplay).toBe(true);
    });
  });

  describe('Critério F: Resolução com Rejeição Terminal e Replay Consistente (422)', () => {
    it('deve registrar REJECTED terminal com REFERENCE_NOT_FOUND ao esgotar tentativas e responder 422 no replay', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const key = `idemp-exhaust-${Date.now()}`;
      const payload: ProcessWagerDto = {
        walletId: wallet.id,
        playerId,
        providerId: 'EVOLUTION',
        externalTransactionId: `ext-exhaust-${Date.now()}`,
        roundId: `round-${Date.now()}`,
        gameId: 'roulette',
        kind: 'WIN',
        money: { amount: '10.00', currency: 'BRL' },
        referenceExternalTransactionId: `bet-never-${Date.now()}`,
      };

      const resInit = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify(payload),
      });
      const dataInit = (await resInit.json()) as WagerResponseDto;

      // Força tentativas até o limite máximo (maxAttempts = 5)
      await adminPool.query('UPDATE wager_transactions SET attempts = 5 WHERE id = $1;', [dataInit.transactionId]);
      await makePendingEligible(dataInit.transactionId);

      const reprocessRes = await reprocessWorker.execute(10);
      expect(reprocessRes.rejected).toBeGreaterThanOrEqual(1);

      const stateTerminal = await captureDbState(wallet.id, dataInit.transactionId);
      expect(stateTerminal.transaction.status).toBe('REJECTED');
      expect(stateTerminal.transaction.responseSnapshot).toEqual({
        transactionId: dataInit.transactionId,
        status: 'REJECTED',
        failureCode: 'REFERENCE_NOT_FOUND',
        balance: { amount: '100.00', currency: 'BRL' },
        idempotentReplay: false,
      });

      // Replay da rejeição terminal: deve retornar HTTP 422 Unprocessable Entity
      const replayRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify(payload),
      });

      expect(replayRes.status).toBe(422);
      const replayData = (await replayRes.json()) as WagerResponseDto;
      expect(replayData.transactionId).toBe(dataInit.transactionId);
      expect(replayData.status).toBe('REJECTED');
      expect(replayData.failureCode).toBe('REFERENCE_NOT_FOUND');
      expect(replayData.balance).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(replayData.idempotentReplay).toBe(true);

      const stateAfterReplay = await captureDbState(wallet.id, dataInit.transactionId);
      expect(stateAfterReplay.transaction.status).toBe('REJECTED');
      expect(stateAfterReplay.ledgerCount).toBe(stateTerminal.ledgerCount);
      expect(stateAfterReplay.outboxCount).toBe(stateTerminal.outboxCount);
    });

    it('deve registrar REJECTED terminal com REFERENCE_INCOMPATIBLE quando referência for incompatível (REFUND)', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const providerId = 'EVOLUTION';
      const roundId = `round-${Date.now()}`;
      const betExtId = `bet-incomp-ext-${Date.now()}`;

      // 1. Cria BET com valor 30.00 BRL
      await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': `bet-incomp-${Date.now()}` },
        body: JSON.stringify({
          walletId: wallet.id,
          playerId,
          providerId,
          externalTransactionId: betExtId,
          roundId,
          gameId: 'roulette',
          kind: 'BET',
          money: { amount: '30.00', currency: 'BRL' },
        }),
      });

      // 2. Cria REFUND com valor 40.00 BRL (incompatível com o valor da BET)
      const refKey = `idemp-incomp-ref-${Date.now()}`;
      const refPayload: ProcessWagerDto = {
        walletId: wallet.id,
        playerId,
        providerId,
        externalTransactionId: `ref-incomp-ext-${Date.now()}`,
        roundId,
        gameId: 'roulette',
        kind: 'REFUND',
        money: { amount: '40.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      };

      const refRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': refKey },
        body: JSON.stringify(refPayload),
      });

      // Como a referência existe de imediato, o processador rejeita de imediato com 422
      expect(refRes.status).toBe(422);
      const refData = (await refRes.json()) as WagerResponseDto;
      expect(refData.status).toBe('REJECTED');
      expect(refData.failureCode).toBe('REFERENCE_INCOMPATIBLE');

      // Replay
      const replayRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': refKey },
        body: JSON.stringify(refPayload),
      });

      expect(replayRes.status).toBe(422);
      const replayData = (await replayRes.json()) as WagerResponseDto;
      expect(replayData.idempotentReplay).toBe(true);
      expect(replayData.failureCode).toBe('REFERENCE_INCOMPATIBLE');
    });
  });

  describe('Critério G: Payload Divergente em Estado Pendente e Terminal Dispara 409', () => {
    it('deve disparar HTTP 409 em payload divergente durante estado PENDING_REFERENCE sem corromper a pendência', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const idempotencyKey = `idemp-diverg-pend-${Date.now()}`;
      const payload: ProcessWagerDto = {
        walletId: wallet.id,
        playerId,
        providerId: 'EVOLUTION',
        externalTransactionId: `ext-div-${Date.now()}`,
        roundId: `round-${Date.now()}`,
        gameId: 'roulette',
        kind: 'WIN',
        money: { amount: '50.00', currency: 'BRL' },
        referenceExternalTransactionId: `bet-missing-${Date.now()}`,
      };

      const resInit = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify(payload),
      });
      expect(resInit.status).toBe(202);
      const dataInit = (await resInit.json()) as WagerResponseDto;

      const stateBefore = await captureDbState(wallet.id, dataInit.transactionId);

      // Envia mesma chave com payload alterado (ex: amount diferente)
      const divergentPayload: ProcessWagerDto = {
        ...payload,
        money: { amount: '60.00', currency: 'BRL' },
      };

      const resDiverg = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify(divergentPayload),
      });

      expect(resDiverg.status).toBe(409);

      // Confirma que a pendência não foi corrompida no banco
      const stateAfter = await captureDbState(wallet.id, dataInit.transactionId);
      expect(stateAfter.transaction.status).toBe('PENDING_REFERENCE');
      expect(stateAfter.transaction.attempts).toBe(stateBefore.transaction.attempts);
      expect(stateAfter.transaction.responseSnapshot).toEqual(stateBefore.transaction.responseSnapshot);
      expect(stateAfter.wallet.balance).toBe(stateBefore.wallet.balance);
      expect(stateAfter.ledgerCount).toBe(stateBefore.ledgerCount);
      expect(stateAfter.outboxCount).toBe(stateBefore.outboxCount);
    });

    it('deve disparar HTTP 409 em payload divergente durante estado terminal PROCESSED', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const idempotencyKey = `idemp-diverg-term-${Date.now()}`;
      const payload: ProcessWagerDto = {
        walletId: wallet.id,
        playerId,
        providerId: 'EVOLUTION',
        externalTransactionId: `ext-div-term-${Date.now()}`,
        roundId: `round-${Date.now()}`,
        gameId: 'roulette',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      };

      const resInit = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify(payload),
      });
      expect(resInit.status).toBe(200);

      const divergentPayload: ProcessWagerDto = {
        ...payload,
        money: { amount: '15.00', currency: 'BRL' },
      };

      const resDiverg = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify(divergentPayload),
      });

      expect(resDiverg.status).toBe(409);
    });
  });

  describe('Critério H: Duplicatas Concorrentes Durante a Aceitação', () => {
    it('deve persistir exatamente 1 pendência e emitir exatamente 1 evento na disputa concorrente', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '500.00', currency: 'BRL' },
      });

      const idempotencyKey = `idemp-race-pend-${Date.now()}`;
      const payload: ProcessWagerDto = {
        walletId: wallet.id,
        playerId,
        providerId: 'EVOLUTION',
        externalTransactionId: `ext-race-${Date.now()}`,
        roundId: `round-race-${Date.now()}`,
        gameId: 'roulette',
        kind: 'WIN',
        money: { amount: '50.00', currency: 'BRL' },
        referenceExternalTransactionId: `bet-missing-race-${Date.now()}`,
      };

      // Dispara 20 requisições simultâneas com a mesma chave e payload
      const requests = Array.from({ length: 20 }, () =>
        fetch(`${serverUrl}/wagering/transactions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'idempotency-key': idempotencyKey },
          body: JSON.stringify(payload),
        })
      );

      const responses = await Promise.all(requests);
      const jsonResults: WagerResponseDto[] = [];
      for (const res of responses) {
        expect(res.status).toBe(202);
        jsonResults.push((await res.json()) as WagerResponseDto);
      }

      // Exatamente 1 aceite original e 19 replays idempotentes
      const originalAccepts = jsonResults.filter((r) => r.idempotentReplay === false);
      const idempotentReplays = jsonResults.filter((r) => r.idempotentReplay === true);
      expect(originalAccepts.length).toBe(1);
      expect(idempotentReplays.length).toBe(19);

      // Todas as respostas possuem o mesmo transactionId e status
      const winnerTxId = originalAccepts[0].transactionId;
      for (const r of jsonResults) {
        expect(r.transactionId).toBe(winnerTxId);
        expect(r.status).toBe('PENDING_REFERENCE');
        expect(r.balance).toEqual({ amount: '500.00', currency: 'BRL' });
      }

      // Conferência física no banco de dados
      const txRows = await adminPool.query(
        'SELECT id, status, attempts, response_snapshot FROM wager_transactions WHERE idempotency_key = $1;',
        [idempotencyKey]
      );
      expect(txRows.rows.length).toBe(1);
      expect(txRows.rows[0].status).toBe('PENDING_REFERENCE');
      expect(txRows.rows[0].attempts).toBe(1);

      const outboxRows = await adminPool.query(
        "SELECT id FROM outbox_messages WHERE event_type = 'WagerTransactionPendingReference' AND aggregate_id = $1;",
        [wallet.id]
      );
      expect(outboxRows.rows.length).toBe(1);

      const walletCheck = await getWalletUseCase.execute(wallet.id);
      expect(walletCheck.balance.amount).toBe('500.00');
      expect(walletCheck.version).toBe(1);
    });
  });

  describe('Critério I: Falha antes do Commit e Reenvio Seguro', () => {
    it('deve realizar rollback completo em falha antes do commit e permitir aceite único no reenvio', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const idempotencyKey = `idemp-fail-pend-${Date.now()}`;
      const payload: ProcessWagerDto = {
        walletId: wallet.id,
        playerId,
        providerId: 'EVOLUTION',
        externalTransactionId: `ext-fail-${Date.now()}`,
        roundId: `round-${Date.now()}`,
        gameId: 'roulette',
        kind: 'WIN',
        money: { amount: '30.00', currency: 'BRL' },
        referenceExternalTransactionId: `bet-missing-${Date.now()}`,
      };

      // Injeta falha antes do commit (no hook after_tx_save)
      uow.setTestHook('after_tx_save', () => {
        throw new Error('SIMULATED_FAILURE_BEFORE_COMMIT');
      });

      try {
        const failRes = await fetch(`${serverUrl}/wagering/transactions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'idempotency-key': idempotencyKey },
          body: JSON.stringify(payload),
        });
        expect(failRes.status).toBe(500);
      } finally {
        uow.clearTestHooks();
      }

      // Confere ausência de aceite parcial no banco
      const txRowsAfterFail = await adminPool.query(
        'SELECT id FROM wager_transactions WHERE idempotency_key = $1;',
        [idempotencyKey]
      );
      expect(txRowsAfterFail.rows.length).toBe(0);

      const outboxAfterFail = await adminPool.query(
        "SELECT id FROM outbox_messages WHERE event_type = 'WagerTransactionPendingReference' AND aggregate_id = $1;",
        [wallet.id]
      );
      expect(outboxAfterFail.rows.length).toBe(0);

      // Reenvio legítimo com a mesma chave: deve aceitar com 202 com sucesso
      const successRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify(payload),
      });

      expect(successRes.status).toBe(202);
      const successData = (await successRes.json()) as WagerResponseDto;
      expect(successData.status).toBe('PENDING_REFERENCE');
      expect(successData.idempotentReplay).toBe(false);

      const txRowsAfterSuccess = await adminPool.query(
        'SELECT id, status FROM wager_transactions WHERE idempotency_key = $1;',
        [idempotencyKey]
      );
      expect(txRowsAfterSuccess.rows.length).toBe(1);
      expect(txRowsAfterSuccess.rows[0].status).toBe('PENDING_REFERENCE');
    });
  });

  describe('Compatibilidade com Pendências Legadas sem Snapshot', () => {
    it('deve fornecer resposta determinística e completa para pendência legada sem response_snapshot sem usar saldo atual', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      // Simula uma transação legada que foi salva com response_snapshot NULL
      const legacyTxId = crypto.randomUUID();
      const legacyKey = `idemp-legacy-${Date.now()}`;
      const extTxId = `ext-legacy-${Date.now()}`;
      const legacyPayload: ProcessWagerDto = {
        walletId: wallet.id,
        playerId,
        providerId: 'EVOLUTION',
        externalTransactionId: extTxId,
        roundId: 'round-1',
        gameId: 'roulette',
        kind: 'WIN',
        money: { amount: '10.00', currency: 'BRL' },
        referenceExternalTransactionId: 'bet-ref-1',
      };
      const payloadHash = ProcessWagerUseCase.computePayloadHash(legacyPayload, legacyKey);

      await adminPool.query(
        `INSERT INTO wager_transactions (
          id, wallet_id, player_id, provider_id, external_transaction_id,
          round_id, game_id, kind, amount, currency, status,
          idempotency_key, payload_hash, response_snapshot, reference_external_transaction_id,
          attempts, next_attempt_at, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10, $11,
          $12, $13, NULL, $14,
          1, NOW() + INTERVAL '10 seconds', NOW(), NOW()
        );`,
        [
          legacyTxId,
          wallet.id,
          playerId,
          'EVOLUTION',
          extTxId,
          'round-1',
          'roulette',
          'WIN',
          '10.00',
          'BRL',
          'PENDING_REFERENCE',
          legacyKey,
          payloadHash,
          'bet-ref-1',
        ]
      );

      // Altera o saldo atual da carteira via operação independente (de 100.00 para 60.00)
      await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': `bet-alter-${Date.now()}` },
        body: JSON.stringify({
          walletId: wallet.id,
          playerId,
          providerId: 'EVOLUTION',
          externalTransactionId: `ext-alter-${Date.now()}`,
          roundId: 'round-alter',
          gameId: 'roulette',
          kind: 'BET',
          money: { amount: '40.00', currency: 'BRL' },
        }),
      });

      const currentWallet = await getWalletUseCase.execute(wallet.id);
      expect(currentWallet.balance.amount).toBe('60.00');

      // Replay da transação legada que não tinha response_snapshot:
      // Não pode fabricar o saldo histórico usando o saldo atual da carteira (60.00)
      // Deve recuperar o saldo histórico a partir dos lançamentos da época (100.00)
      const replayRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': legacyKey },
        body: JSON.stringify(legacyPayload),
      });

      expect(replayRes.status).toBe(202);
      const replayData = (await replayRes.json()) as WagerResponseDto;
      expect(replayData.transactionId).toBe(legacyTxId);
      expect(replayData.status).toBe('PENDING_REFERENCE');
      expect(replayData.idempotentReplay).toBe(true);
      // Saldo histórico recuperado do ledger da época: 100.00 (e NÃO 60.00 atual)
      expect(replayData.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    });
  });
});
