import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { createIsolatedTestDatabase, IsolatedTestDatabase } from '../test-db-helper';
import {
  MikroOrmOutboxRepository,
  MikroOrmUnitOfWork,
  MikroOrmWagerTransactionRepository,
  MikroOrmWalletLedgerRepository,
  MikroOrmWalletRepository,
} from '../../src/infrastructure/persistence/mikro-orm/mikro-orm-adapter';
import { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet.use-case';
import { ProcessWagerUseCase } from '../../src/application/use-cases/process-wager.use-case';
import { ReprocessPendingReferencesUseCase } from '../../src/application/use-cases/reprocess-pending-references.use-case';
import { IntegrationEvent, IntegrationEventEnvelope } from '../../src/domain/events/events';
import { IdempotencyConflictError } from '../../src/domain/errors/domain.error';

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('M13: Financial Outbox & Transactional Event Persistence Suite', () => {
  let isolatedDb: IsolatedTestDatabase;
  let externalClient: pg.Client;
  let uow: MikroOrmUnitOfWork;
  let walletRepo: MikroOrmWalletRepository;
  let wagerRepo: MikroOrmWagerTransactionRepository;
  let ledgerRepo: MikroOrmWalletLedgerRepository;
  let outboxRepo: MikroOrmOutboxRepository;

  let createWalletUseCase: CreateWalletUseCase;
  let processWagerUseCase: ProcessWagerUseCase;
  let reprocessUseCase: ReprocessPendingReferencesUseCase;

  beforeAll(async () => {
    isolatedDb = await createIsolatedTestDatabase('m13_outbox_');

    // External independent client to verify MVCC boundaries and transactional isolation
    externalClient = new pg.Client({
      ...isolatedDb.appConfig,
      application_name: 'm13_external_observer',
    });
    await externalClient.connect();

    uow = new MikroOrmUnitOfWork();
    await uow.init();

    walletRepo = new MikroOrmWalletRepository(uow);
    wagerRepo = new MikroOrmWagerTransactionRepository(uow);
    ledgerRepo = new MikroOrmWalletLedgerRepository(uow);
    outboxRepo = new MikroOrmOutboxRepository(uow);

    createWalletUseCase = new CreateWalletUseCase(walletRepo, wagerRepo, ledgerRepo, outboxRepo, uow);
    processWagerUseCase = new ProcessWagerUseCase(walletRepo, wagerRepo, ledgerRepo, outboxRepo, uow);
    reprocessUseCase = new ReprocessPendingReferencesUseCase(walletRepo, wagerRepo, ledgerRepo, outboxRepo, uow, 5);
  });

  afterAll(async () => {
    uow.clearTestHooks();
    await uow.close();
    await externalClient.end();
    await isolatedDb.closeAndDrop();
  });

  // Helper to query outbox rows directly via external client for a specific wallet/aggregate
  async function queryExternalOutbox(walletId: string): Promise<any[]> {
    const res = await externalClient.query(
      `SELECT id, aggregate_type, aggregate_id, event_type, version, correlation_id, causation_id, occurred_at, payload, created_at, published_at
       FROM outbox_messages
       WHERE aggregate_id = $1
       ORDER BY created_at ASC, id ASC;`,
      [walletId]
    );
    return res.rows;
  }

  // =========================================================================
  // 1. AUDITORIA E CONTRATO DE EVENTOS (MATRIZ COMPLETA DE OPERAÇÕES)
  // =========================================================================
  describe('1. Matriz de Auditoria e Contrato de Eventos', () => {
    it('1.1 Abertura positiva: persiste exatamente 2 eventos (Processed + BalanceChanged)', async () => {
      const playerId = uuidv4();
      const res = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '150.00', currency: 'BRL' },
      });

      const events = await queryExternalOutbox(res.id);
      expect(events.length).toBe(2);

      const [processedEvent, balanceEvent] = events;
      expect(processedEvent.event_type).toBe('WagerTransactionProcessed');
      expect(processedEvent.payload.kind).toBe('OPENING');
      expect(processedEvent.payload.amount).toEqual({ amount: '150.00', currency: 'BRL' });
      expect(processedEvent.payload.balance).toEqual({ amount: '150.00', currency: 'BRL' });
      expect(processedEvent.published_at).toBeNull();

      expect(balanceEvent.event_type).toBe('WalletBalanceChanged');
      expect(balanceEvent.payload.previousBalance).toEqual({ amount: '0.00', currency: 'BRL' });
      expect(balanceEvent.payload.currentBalance).toEqual({ amount: '150.00', currency: 'BRL' });
      expect(balanceEvent.payload.version).toBe(1);
      expect(balanceEvent.published_at).toBeNull();
    });

    it('1.2 Abertura zero: não persiste nenhum evento na outbox (0 eventos)', async () => {
      const playerId = uuidv4();
      const res = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '0.00', currency: 'BRL' },
      });

      const events = await queryExternalOutbox(res.id);
      expect(events.length).toBe(0);
    });

    it('1.3 BET processado com movimento: persiste exatamente 2 eventos (Processed + BalanceChanged)', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: uuidv4(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const idempotencyKey = `bet_m13_${uuidv4()}`;
      const betRes = await processWagerUseCase.execute(idempotencyKey, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: 'prv_m13',
        externalTransactionId: `ext_bet_${uuidv4()}`,
        roundId: `round_${uuidv4()}`,
        gameId: 'slot_m13',
        kind: 'BET',
        money: { amount: '30.00', currency: 'BRL' },
      });

      expect(betRes.status).toBe('PROCESSED');
      expect(betRes.balance.amount).toBe('70.00');

      const events = await queryExternalOutbox(wallet.id);
      // 2 events from positive opening + 2 from BET = 4 total
      expect(events.length).toBe(4);

      const betEvents = events.slice(2);
      expect(betEvents.length).toBe(2);

      const [processedEvent, balanceEvent] = betEvents;
      expect(processedEvent.event_type).toBe('WagerTransactionProcessed');
      expect(processedEvent.payload.kind).toBe('BET');
      expect(processedEvent.payload.amount).toEqual({ amount: '30.00', currency: 'BRL' });
      expect(processedEvent.payload.balance).toEqual({ amount: '70.00', currency: 'BRL' });
      expect(processedEvent.correlation_id).toBe(idempotencyKey);
      expect(processedEvent.causation_id).toBe(idempotencyKey);

      expect(balanceEvent.event_type).toBe('WalletBalanceChanged');
      expect(balanceEvent.payload.previousBalance).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(balanceEvent.payload.currentBalance).toEqual({ amount: '70.00', currency: 'BRL' });
      expect(balanceEvent.payload.version).toBe(2);
    });

    it('1.4 BET rejeitado por saldo insuficiente: persiste somente 1 evento (Rejected)', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: uuidv4(),
        initialBalance: { amount: '20.00', currency: 'BRL' },
      });

      const idempotencyKey = `bet_fail_${uuidv4()}`;
      const betRes = await processWagerUseCase.execute(idempotencyKey, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: 'prv_m13',
        externalTransactionId: `ext_fail_${uuidv4()}`,
        roundId: `round_${uuidv4()}`,
        gameId: 'slot_m13',
        kind: 'BET',
        money: { amount: '50.00', currency: 'BRL' },
      });

      expect(betRes.status).toBe('REJECTED');
      expect(betRes.failureCode).toBe('INSUFFICIENT_FUNDS');

      const events = await queryExternalOutbox(wallet.id);
      // 2 from opening + 1 from rejected BET = 3 total
      expect(events.length).toBe(3);

      const rejectedEvent = events[2];
      expect(rejectedEvent.event_type).toBe('WagerTransactionRejected');
      expect(rejectedEvent.payload.kind).toBe('BET');
      expect(rejectedEvent.payload.failureCode).toBe('INSUFFICIENT_FUNDS');
      expect(rejectedEvent.payload.amount).toEqual({ amount: '50.00', currency: 'BRL' });
      expect(rejectedEvent.payload.balance).toEqual({ amount: '20.00', currency: 'BRL' });
      expect(rejectedEvent.correlation_id).toBe(idempotencyKey);
      expect(rejectedEvent.causation_id).toBe(idempotencyKey);
    });

    it('1.5 LOSS: persiste somente 1 evento (Processed) e nenhum evento de saldo', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: uuidv4(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const idempotencyKey = `loss_${uuidv4()}`;
      const lossRes = await processWagerUseCase.execute(idempotencyKey, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: 'prv_m13',
        externalTransactionId: `ext_loss_${uuidv4()}`,
        roundId: `round_${uuidv4()}`,
        gameId: 'slot_m13',
        kind: 'LOSS',
        money: { amount: '10.00', currency: 'BRL' },
      });

      expect(lossRes.status).toBe('PROCESSED');
      expect(lossRes.balance.amount).toBe('100.00');

      const events = await queryExternalOutbox(wallet.id);
      // 2 from opening + 1 from LOSS = 3 total
      expect(events.length).toBe(3);

      const lossEvent = events[2];
      expect(lossEvent.event_type).toBe('WagerTransactionProcessed');
      expect(lossEvent.payload.kind).toBe('LOSS');
      expect(lossEvent.payload.amount).toEqual({ amount: '10.00', currency: 'BRL' });
      expect(lossEvent.payload.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    });

    it('1.6 WIN com movimento: persiste 2 eventos (Processed + BalanceChanged)', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: uuidv4(),
        initialBalance: { amount: '50.00', currency: 'BRL' },
      });

      const winRes = await processWagerUseCase.execute(`win_${uuidv4()}`, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: 'prv_m13',
        externalTransactionId: `ext_win_${uuidv4()}`,
        roundId: `round_${uuidv4()}`,
        gameId: 'slot_m13',
        kind: 'WIN',
        money: { amount: '25.00', currency: 'BRL' },
      });

      expect(winRes.status).toBe('PROCESSED');
      expect(winRes.balance.amount).toBe('75.00');

      const events = await queryExternalOutbox(wallet.id);
      expect(events.length).toBe(4); // 2 opening + 2 win

      const winEvents = events.slice(2);
      expect(winEvents[0].event_type).toBe('WagerTransactionProcessed');
      expect(winEvents[0].payload.kind).toBe('WIN');
      expect(winEvents[0].payload.amount).toEqual({ amount: '25.00', currency: 'BRL' });
      expect(winEvents[0].payload.balance).toEqual({ amount: '75.00', currency: 'BRL' });

      expect(winEvents[1].event_type).toBe('WalletBalanceChanged');
      expect(winEvents[1].payload.previousBalance).toEqual({ amount: '50.00', currency: 'BRL' });
      expect(winEvents[1].payload.currentBalance).toEqual({ amount: '75.00', currency: 'BRL' });
    });

    it('1.7 WIN aceito como PENDING_REFERENCE: persiste 1 evento de pendência', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: uuidv4(),
        initialBalance: { amount: '50.00', currency: 'BRL' },
      });

      const winRes = await processWagerUseCase.execute(`win_pend_${uuidv4()}`, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: 'prv_m13',
        externalTransactionId: `ext_win_pend_${uuidv4()}`,
        roundId: `round_${uuidv4()}`,
        gameId: 'slot_m13',
        kind: 'WIN',
        money: { amount: '15.00', currency: 'BRL' },
        referenceExternalTransactionId: `ref_missing_${uuidv4()}`,
      });

      expect(winRes.status).toBe('PENDING_REFERENCE');

      const events = await queryExternalOutbox(wallet.id);
      expect(events.length).toBe(3); // 2 opening + 1 pending reference

      const pendingEvent = events[2];
      expect(pendingEvent.event_type).toBe('WagerTransactionPendingReference');
      expect(pendingEvent.payload.kind).toBe('WIN');
      expect(pendingEvent.payload.attempts).toBe(1);
      expect(pendingEvent.payload.referenceExternalTransactionId).toBeDefined();
    });

    it('1.8 Reagendamento via worker: não duplica evento de pendência (0 novos eventos)', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: uuidv4(),
        initialBalance: { amount: '50.00', currency: 'BRL' },
      });

      const winTxId = `ext_win_resched_${uuidv4()}`;
      await processWagerUseCase.execute(`win_resched_${uuidv4()}`, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: 'prv_m13',
        externalTransactionId: winTxId,
        roundId: `round_${uuidv4()}`,
        gameId: 'slot_m13',
        kind: 'WIN',
        money: { amount: '15.00', currency: 'BRL' },
        referenceExternalTransactionId: `ref_missing_${uuidv4()}`,
      });

      const eventsBeforeReprocess = await queryExternalOutbox(wallet.id);
      expect(eventsBeforeReprocess.length).toBe(3);

      // Force past next_attempt_at so worker claims it
      await externalClient.query(
        `UPDATE wager_transactions 
         SET next_attempt_at = NOW() - INTERVAL '1 minute' 
         WHERE external_transaction_id = $1;`,
        [winTxId]
      );

      // Worker runs and reference is still missing -> outcome is RESCHEDULED
      const workerRes = await reprocessUseCase.execute(20, 30000, 'worker_m13');
      expect(workerRes.processed).toBe(0);

      const eventsAfterReprocess = await queryExternalOutbox(wallet.id);
      // No new outbox events should be emitted during rescheduling!
      expect(eventsAfterReprocess.length).toBe(3);
    });

    it('1.9 Resolução posterior via worker: persiste exatamente os 2 eventos terminais', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: uuidv4(),
        initialBalance: { amount: '50.00', currency: 'BRL' },
      });

      const refBetExtId = `bet_parent_${uuidv4()}`;
      const roundId = `round_${uuidv4()}`;
      const winExtId = `win_child_${uuidv4()}`;

      // Submit WIN before parent BET exists -> PENDING_REFERENCE
      await processWagerUseCase.execute(`win_future_${uuidv4()}`, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: 'prv_m13',
        externalTransactionId: winExtId,
        roundId,
        gameId: 'slot_m13',
        kind: 'WIN',
        money: { amount: '40.00', currency: 'BRL' },
        referenceExternalTransactionId: refBetExtId,
      });

      const eventsBeforeResolution = await queryExternalOutbox(wallet.id);
      expect(eventsBeforeResolution.length).toBe(3); // 2 opening + 1 pending

      // Now parent BET arrives and is processed
      await processWagerUseCase.execute(`bet_parent_key_${uuidv4()}`, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: 'prv_m13',
        externalTransactionId: refBetExtId,
        roundId,
        gameId: 'slot_m13',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      });

      // Force past next_attempt_at so worker claims it
      await externalClient.query(
        `UPDATE wager_transactions 
         SET next_attempt_at = NOW() - INTERVAL '1 minute' 
         WHERE external_transaction_id = $1;`,
        [winExtId]
      );

      // Worker reprocesses and finds PROCESSED parent BET -> resolves to PROCESSED
      const workerRes = await reprocessUseCase.execute(20, 30000, 'worker_m13');
      expect(workerRes.processed).toBe(1);

      const eventsAfterResolution = await queryExternalOutbox(wallet.id);
      // 2 opening + 1 pending + 2 parent bet + 2 resolved win = 7 total
      expect(eventsAfterResolution.length).toBe(7);

      const terminalEvents = eventsAfterResolution.slice(5);
      expect(terminalEvents[0].event_type).toBe('WagerTransactionProcessed');
      expect(terminalEvents[0].payload.kind).toBe('WIN');
      expect(terminalEvents[0].payload.amount).toEqual({ amount: '40.00', currency: 'BRL' });

      expect(terminalEvents[1].event_type).toBe('WalletBalanceChanged');
      expect(terminalEvents[1].payload.currentBalance).toEqual({ amount: '80.00', currency: 'BRL' });
    });

    it('1.10 REFUND processado com movimento: persiste 2 eventos (Processed + BalanceChanged)', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: uuidv4(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const betExtId = `bet_to_refund_${uuidv4()}`;
      const roundId = `round_${uuidv4()}`;

      await processWagerUseCase.execute(`bet_key_${uuidv4()}`, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: 'prv_m13',
        externalTransactionId: betExtId,
        roundId,
        gameId: 'slot_m13',
        kind: 'BET',
        money: { amount: '20.00', currency: 'BRL' },
      });

      const refundRes = await processWagerUseCase.execute(`refund_key_${uuidv4()}`, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: 'prv_m13',
        externalTransactionId: `refund_ext_${uuidv4()}`,
        roundId,
        gameId: 'slot_m13',
        kind: 'REFUND',
        money: { amount: '20.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      });

      expect(refundRes.status).toBe('PROCESSED');
      expect(refundRes.balance.amount).toBe('100.00');

      const events = await queryExternalOutbox(wallet.id);
      // 2 opening + 2 bet + 2 refund = 6 total
      expect(events.length).toBe(6);

      const refundEvents = events.slice(4);
      expect(refundEvents[0].event_type).toBe('WagerTransactionProcessed');
      expect(refundEvents[0].payload.kind).toBe('REFUND');
      expect(refundEvents[0].payload.amount).toEqual({ amount: '20.00', currency: 'BRL' });

      expect(refundEvents[1].event_type).toBe('WalletBalanceChanged');
      expect(refundEvents[1].payload.previousBalance).toEqual({ amount: '80.00', currency: 'BRL' });
      expect(refundEvents[1].payload.currentBalance).toEqual({ amount: '100.00', currency: 'BRL' });
    });

    it('1.11 ROLLBACK de WIN (débito): persiste 2 eventos (Processed + BalanceChanged)', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: uuidv4(),
        initialBalance: { amount: '50.00', currency: 'BRL' },
      });

      const winExtId = `win_to_rollback_${uuidv4()}`;
      const roundId = `round_${uuidv4()}`;

      await processWagerUseCase.execute(`win_key_${uuidv4()}`, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: 'prv_m13',
        externalTransactionId: winExtId,
        roundId,
        gameId: 'slot_m13',
        kind: 'WIN',
        money: { amount: '30.00', currency: 'BRL' },
      });

      // Rollback of WIN -> Debits wallet balance
      const rollbackRes = await processWagerUseCase.execute(`rollback_key_${uuidv4()}`, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: 'prv_m13',
        externalTransactionId: `rollback_ext_${uuidv4()}`,
        roundId,
        gameId: 'slot_m13',
        kind: 'ROLLBACK',
        money: { amount: '30.00', currency: 'BRL' },
        referenceExternalTransactionId: winExtId,
      });

      expect(rollbackRes.status).toBe('PROCESSED');
      expect(rollbackRes.balance.amount).toBe('50.00');

      const events = await queryExternalOutbox(wallet.id);
      // 2 opening + 2 win + 2 rollback = 6 total
      expect(events.length).toBe(6);

      const rollbackEvents = events.slice(4);
      expect(rollbackEvents[0].event_type).toBe('WagerTransactionProcessed');
      expect(rollbackEvents[0].payload.kind).toBe('ROLLBACK');

      expect(rollbackEvents[1].event_type).toBe('WalletBalanceChanged');
      expect(rollbackEvents[1].payload.previousBalance).toEqual({ amount: '80.00', currency: 'BRL' });
      expect(rollbackEvents[1].payload.currentBalance).toEqual({ amount: '50.00', currency: 'BRL' });
    });

    it('1.12 Replay e Conflito de idempotência: nenhum evento adicional é emitido', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: uuidv4(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const idempotencyKey = `replay_test_${uuidv4()}`;
      const dto = {
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: 'prv_m13',
        externalTransactionId: `ext_replay_${uuidv4()}`,
        roundId: `round_${uuidv4()}`,
        gameId: 'slot_m13',
        kind: 'BET' as const,
        money: { amount: '25.00', currency: 'BRL' },
      };

      const firstRes = await processWagerUseCase.execute(idempotencyKey, dto);
      expect(firstRes.status).toBe('PROCESSED');
      expect(firstRes.idempotentReplay).toBe(false);

      const eventsAfterFirst = await queryExternalOutbox(wallet.id);
      expect(eventsAfterFirst.length).toBe(4); // 2 opening + 2 bet

      // Replay with identical payload
      const replayRes = await processWagerUseCase.execute(idempotencyKey, dto);
      expect(replayRes.status).toBe('PROCESSED');
      expect(replayRes.idempotentReplay).toBe(true);

      const eventsAfterReplay = await queryExternalOutbox(wallet.id);
      expect(eventsAfterReplay.length).toBe(4); // exactly 0 new events!

      // Conflict: same idempotency key, altered amount
      await expect(
        processWagerUseCase.execute(idempotencyKey, {
          ...dto,
          money: { amount: '99.00', currency: 'BRL' },
        })
      ).rejects.toThrow(IdempotencyConflictError);

      const eventsAfterConflict = await queryExternalOutbox(wallet.id);
      expect(eventsAfterConflict.length).toBe(4); // zero new events!
    });

    it('1.13 WIN rejeitado por referência incompatível: persiste somente 1 evento (Rejected)', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: uuidv4(),
        initialBalance: { amount: '50.00', currency: 'BRL' },
      });

      // Create a BET with provider A
      const betExtId = `bet_compat_${uuidv4()}`;
      await processWagerUseCase.execute(`bet_key_${uuidv4()}`, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: 'prv_A',
        externalTransactionId: betExtId,
        roundId: `round_${uuidv4()}`,
        gameId: 'slot_1',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      });

      // Submit WIN with different round -> REFERENCE_INCOMPATIBLE
      const winRes = await processWagerUseCase.execute(`win_incompat_${uuidv4()}`, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: 'prv_A',
        externalTransactionId: `win_ext_${uuidv4()}`,
        roundId: `different_round_${uuidv4()}`,
        gameId: 'slot_1',
        kind: 'WIN',
        money: { amount: '20.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      });

      expect(winRes.status).toBe('REJECTED');
      expect(winRes.failureCode).toBe('REFERENCE_INCOMPATIBLE');

      const events = await queryExternalOutbox(wallet.id);
      // 2 opening + 2 bet + 1 rejected win = 5 total
      expect(events.length).toBe(5);
      const rejectedEvent = events[4];
      expect(rejectedEvent.event_type).toBe('WagerTransactionRejected');
      expect(rejectedEvent.payload.kind).toBe('WIN');
      expect(rejectedEvent.payload.failureCode).toBe('REFERENCE_INCOMPATIBLE');
    });

    it('1.14 REFUND aceito como PENDING_REFERENCE: persiste 1 evento de pendência', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: uuidv4(),
        initialBalance: { amount: '60.00', currency: 'BRL' },
      });

      const refundRes = await processWagerUseCase.execute(`refund_pend_${uuidv4()}`, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: 'prv_m13',
        externalTransactionId: `refund_pend_ext_${uuidv4()}`,
        roundId: `round_${uuidv4()}`,
        gameId: 'slot_m13',
        kind: 'REFUND',
        money: { amount: '15.00', currency: 'BRL' },
        referenceExternalTransactionId: `ref_missing_${uuidv4()}`,
      });

      expect(refundRes.status).toBe('PENDING_REFERENCE');

      const events = await queryExternalOutbox(wallet.id);
      expect(events.length).toBe(3); // 2 opening + 1 pending reference
      expect(events[2].event_type).toBe('WagerTransactionPendingReference');
      expect(events[2].payload.kind).toBe('REFUND');
      expect(events[2].payload.amount).toEqual({ amount: '15.00', currency: 'BRL' });
    });

    it('1.15 REFUND rejeitado: persiste 1 evento (Rejected)', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: uuidv4(),
        initialBalance: { amount: '60.00', currency: 'BRL' },
      });

      const betExtId = `bet_rejected_parent_${uuidv4()}`;
      // Submit a rejected BET
      await processWagerUseCase.execute(`bet_fail_${uuidv4()}`, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: 'prv_m13',
        externalTransactionId: betExtId,
        roundId: `round_${uuidv4()}`,
        gameId: 'slot_m13',
        kind: 'BET',
        money: { amount: '900.00', currency: 'BRL' },
      });

      // REFUND referencing a REJECTED bet -> REFERENCE_NOT_PROCESSED
      const refundRes = await processWagerUseCase.execute(`refund_fail_${uuidv4()}`, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: 'prv_m13',
        externalTransactionId: `refund_fail_ext_${uuidv4()}`,
        roundId: `round_${uuidv4()}`,
        gameId: 'slot_m13',
        kind: 'REFUND',
        money: { amount: '900.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      });

      expect(refundRes.status).toBe('REJECTED');
      expect(refundRes.failureCode).toBe('REFERENCE_NOT_PROCESSED');

      const events = await queryExternalOutbox(wallet.id);
      // 2 opening + 1 rejected bet + 1 rejected refund = 4 total
      expect(events.length).toBe(4);
      expect(events[3].event_type).toBe('WagerTransactionRejected');
      expect(events[3].payload.kind).toBe('REFUND');
      expect(events[3].payload.failureCode).toBe('REFERENCE_NOT_PROCESSED');
    });

    it('1.16 ROLLBACK de BET (crédito): persiste 2 eventos (Processed + BalanceChanged)', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: uuidv4(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const betExtId = `bet_rb_${uuidv4()}`;
      const roundId = `round_${uuidv4()}`;

      await processWagerUseCase.execute(`bet_key_${uuidv4()}`, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: 'prv_m13',
        externalTransactionId: betExtId,
        roundId,
        gameId: 'slot_m13',
        kind: 'BET',
        money: { amount: '40.00', currency: 'BRL' },
      });

      const rbRes = await processWagerUseCase.execute(`rb_key_${uuidv4()}`, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: 'prv_m13',
        externalTransactionId: `rb_ext_${uuidv4()}`,
        roundId,
        gameId: 'slot_m13',
        kind: 'ROLLBACK',
        money: { amount: '40.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      });

      expect(rbRes.status).toBe('PROCESSED');
      expect(rbRes.balance.amount).toBe('100.00');

      const events = await queryExternalOutbox(wallet.id);
      // 2 opening + 2 bet + 2 rollback = 6 total
      expect(events.length).toBe(6);
      expect(events[4].event_type).toBe('WagerTransactionProcessed');
      expect(events[4].payload.kind).toBe('ROLLBACK');
      expect(events[5].event_type).toBe('WalletBalanceChanged');
      expect(events[5].payload.currentBalance).toEqual({ amount: '100.00', currency: 'BRL' });
    });

    it('1.17 ROLLBACK aceito como PENDING_REFERENCE: persiste 1 evento de pendência', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: uuidv4(),
        initialBalance: { amount: '50.00', currency: 'BRL' },
      });

      const rbRes = await processWagerUseCase.execute(`rb_pend_${uuidv4()}`, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: 'prv_m13',
        externalTransactionId: `rb_pend_ext_${uuidv4()}`,
        roundId: `round_${uuidv4()}`,
        gameId: 'slot_m13',
        kind: 'ROLLBACK',
        money: { amount: '10.00', currency: 'BRL' },
        referenceExternalTransactionId: `ref_missing_${uuidv4()}`,
      });

      expect(rbRes.status).toBe('PENDING_REFERENCE');

      const events = await queryExternalOutbox(wallet.id);
      expect(events.length).toBe(3); // 2 opening + 1 pending
      expect(events[2].event_type).toBe('WagerTransactionPendingReference');
      expect(events[2].payload.kind).toBe('ROLLBACK');
    });

    it('1.18 ROLLBACK rejeitado por saldo insuficiente ao estornar WIN: persiste 1 evento (Rejected)', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: uuidv4(),
        initialBalance: { amount: '10.00', currency: 'BRL' },
      });

      const winExtId = `win_big_${uuidv4()}`;
      const roundId = `round_${uuidv4()}`;

      // WIN adds 100.00 -> balance becomes 110.00
      await processWagerUseCase.execute(`win_key_${uuidv4()}`, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: 'prv_m13',
        externalTransactionId: winExtId,
        roundId,
        gameId: 'slot_m13',
        kind: 'WIN',
        money: { amount: '100.00', currency: 'BRL' },
      });

      // Another BET spends 105.00 -> balance becomes 5.00
      await processWagerUseCase.execute(`bet_drain_${uuidv4()}`, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: 'prv_m13',
        externalTransactionId: `bet_drain_ext_${uuidv4()}`,
        roundId,
        gameId: 'slot_m13',
        kind: 'BET',
        money: { amount: '105.00', currency: 'BRL' },
      });

      // Now ROLLBACK of the WIN needs to debit 100.00, but balance is only 5.00
      const rbRes = await processWagerUseCase.execute(`rb_insuf_${uuidv4()}`, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: 'prv_m13',
        externalTransactionId: `rb_insuf_ext_${uuidv4()}`,
        roundId,
        gameId: 'slot_m13',
        kind: 'ROLLBACK',
        money: { amount: '100.00', currency: 'BRL' },
        referenceExternalTransactionId: winExtId,
      });

      expect(rbRes.status).toBe('REJECTED');
      expect(rbRes.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');

      const events = await queryExternalOutbox(wallet.id);
      // 2 opening + 2 win + 2 bet + 1 rejected rollback = 7 total
      expect(events.length).toBe(7);
      expect(events[6].event_type).toBe('WagerTransactionRejected');
      expect(events[6].payload.kind).toBe('ROLLBACK');
      expect(events[6].payload.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    });
  });

  // =========================================================================
  // 2. ENVELOPE E PERSISTÊNCIA DA OUTBOX
  // =========================================================================
  describe('2. Validação do Envelope, Tipagem Monetária e Reconstrução', () => {
    it('2.1 Valida campos do envelope, imutabilidade de IDs e estado inicial não publicado', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: uuidv4(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const customCorrelation = `custom-corr-partner#9988_${uuidv4()}`;
      const idempotencyKey = `bet_envelope_${uuidv4()}`;

      await processWagerUseCase.execute(idempotencyKey, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: 'prv_m13',
        externalTransactionId: `ext_env_${uuidv4()}`,
        roundId: `round_${uuidv4()}`,
        gameId: 'slot_m13',
        kind: 'BET',
        money: { amount: '12.34', currency: 'BRL' },
        correlationId: customCorrelation,
      });

      const events = await queryExternalOutbox(wallet.id);
      const betEvents = events.slice(2);
      expect(betEvents.length).toBe(2);

      for (const ev of betEvents) {
        // eventId must be a valid UUID
        expect(ev.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
        expect(ev.aggregate_type).toBe('Wallet');
        expect(ev.aggregate_id).toBe(wallet.id);
        expect(ev.version).toBe(1);
        expect(ev.correlation_id).toBe(customCorrelation);
        expect(ev.causation_id).toBe(idempotencyKey);
        expect(ev.occurred_at).toBeInstanceOf(Date);
        expect(ev.published_at).toBeNull();
      }

      // Check monetary payload exactness: amount & balance MUST NOT be numbers
      const processedPayload = betEvents[0].payload;
      expect(typeof processedPayload.amount.amount).toBe('string');
      expect(typeof processedPayload.amount.currency).toBe('string');
      expect(typeof processedPayload.balance.amount).toBe('string');
      expect(typeof processedPayload.balance.currency).toBe('string');
      expect(processedPayload.amount).toEqual({ amount: '12.34', currency: 'BRL' });
      expect(processedPayload.balance).toEqual({ amount: '87.66', currency: 'BRL' });

      const balancePayload = betEvents[1].payload;
      expect(typeof balancePayload.previousBalance.amount).toBe('string');
      expect(typeof balancePayload.currentBalance.amount).toBe('string');
      expect(balancePayload.previousBalance).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(balancePayload.currentBalance).toEqual({ amount: '87.66', currency: 'BRL' });
    });

    it('2.2 Suporta correlationId não-UUID longo (até 255 chars) preservando conteúdo exato', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: uuidv4(),
        initialBalance: { amount: '50.00', currency: 'BRL' },
      });

      const longCustomCorrelation = 'X'.repeat(250);
      const idempotencyKey = `bet_long_corr_${uuidv4()}`;

      await processWagerUseCase.execute(idempotencyKey, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: 'prv_m13',
        externalTransactionId: `ext_long_${uuidv4()}`,
        roundId: `round_${uuidv4()}`,
        gameId: 'slot_m13',
        kind: 'BET',
        money: { amount: '5.00', currency: 'BRL' },
        correlationId: longCustomCorrelation,
      });

      const events = await queryExternalOutbox(wallet.id);
      const betEvent = events[2];
      expect(betEvent.correlation_id).toBe(longCustomCorrelation);
      expect(betEvent.correlation_id.length).toBe(250);
    });

    it('2.3 listUnpublished e findById no OutboxRepositoryPort', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: uuidv4(),
        initialBalance: { amount: '40.00', currency: 'BRL' },
      });

      const unpublished = await outboxRepo.listUnpublished(100);
      expect(unpublished.length).toBeGreaterThanOrEqual(2);

      const target = unpublished.find((e) => e.aggregateId === wallet.id);
      expect(target).toBeDefined();

      const byId = await outboxRepo.findById(target!.eventId);
      expect(byId).toBeDefined();
      expect(byId!.eventId).toBe(target!.eventId);
      expect(byId!.eventType).toBe(target!.eventType);
      expect(byId!.aggregateId).toBe(wallet.id);
      expect(byId!.version).toBe(1);
      expect(byId!.occurredAt).toBe(target!.occurredAt);
      expect(byId!.data).toEqual(target!.data);
    });

    it('2.4 Reconstrução de evento sem regenerar identidade ou timestamp', () => {
      const originalEnvelope: IntegrationEventEnvelope<{ foo: string }> = {
        eventId: '11111111-2222-3333-4444-555555555555',
        eventType: 'CustomTestEvent',
        version: 1,
        aggregateId: 'wallet_123',
        correlationId: 'corr_456',
        causationId: 'cause_789',
        occurredAt: '2026-10-17T12:00:00.000Z',
        data: { foo: 'bar' },
      };

      const reconstructed = IntegrationEvent.reconstruct(originalEnvelope);
      expect(reconstructed.eventId).toBe(originalEnvelope.eventId);
      expect(reconstructed.occurredAt).toBe(originalEnvelope.occurredAt);
      expect(reconstructed.eventType).toBe(originalEnvelope.eventType);
      expect(reconstructed.version).toBe(1);
      expect(reconstructed.aggregateId).toBe(originalEnvelope.aggregateId);
      expect(reconstructed.correlationId).toBe(originalEnvelope.correlationId);
      expect(reconstructed.causationId).toBe(originalEnvelope.causationId ?? undefined);
      expect(reconstructed.data).toEqual(originalEnvelope.data);

      const reEnveloped = reconstructed.toEnvelope();
      expect(reEnveloped).toEqual(originalEnvelope);
    });
  });

  // =========================================================================
  // 3. ATOMICIDADE REAL POSTGRESQL & BARREIRAS EXPLÍCITAS
  // =========================================================================
  describe('3. Atomicidade Real PostgreSQL e Barreiras de Isolamento', () => {
    it('3.1 Barreira MVCC: eventos e alterações financeiras NÃO ficam visíveis antes do commit', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: uuidv4(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const idempotencyKey = `bet_mvcc_${uuidv4()}`;
      const extTxId = `ext_mvcc_${uuidv4()}`;

      const insideHookReached = createDeferred<void>();
      const allowCommitProceed = createDeferred<void>();

      // Set hook at before_commit: pause inside transaction after flushes but before SQL COMMIT
      uow.setTestHook('before_commit', async () => {
        insideHookReached.resolve();
        await allowCommitProceed.promise;
      });

      let executePromise: Promise<any>;
      try {
        executePromise = processWagerUseCase.execute(idempotencyKey, {
          walletId: wallet.id,
          playerId: wallet.playerId,
          providerId: 'prv_m13',
          externalTransactionId: extTxId,
          roundId: `round_${uuidv4()}`,
          gameId: 'slot_m13',
          kind: 'BET',
          money: { amount: '40.00', currency: 'BRL' },
        });

        // Wait until transaction has flushed to PostgreSQL but hasn't committed
        await insideHookReached.promise;

        // --- EXTERNAL CONNECTION OBSERVATION (PRE-COMMIT) ---
        // 1. Wallets must still show old balance (100.00) and old version (1)
        const walletPreCommit = await externalClient.query(
          'SELECT balance, version FROM wallets WHERE id = $1;',
          [wallet.id]
        );
        expect(walletPreCommit.rows[0].balance).toBe('100.00');
        expect(walletPreCommit.rows[0].version).toBe(1);

        // 2. Wager transaction must not exist yet
        const txPreCommit = await externalClient.query(
          'SELECT id FROM wager_transactions WHERE idempotency_key = $1;',
          [idempotencyKey]
        );
        expect(txPreCommit.rows.length).toBe(0);

        // 3. Ledger entry must not exist yet
        const ledgerPreCommit = await externalClient.query(
          'SELECT id FROM wallet_ledger_entries WHERE wallet_id = $1 AND amount = 40.00;',
          [wallet.id]
        );
        expect(ledgerPreCommit.rows.length).toBe(0);

        // 4. Outbox events for this BET must not be visible
        const outboxPreCommit = await queryExternalOutbox(wallet.id);
        // Only the initial opening events (2), no BET events
        expect(outboxPreCommit.length).toBe(2);

        // Allow transaction to proceed with COMMIT
        allowCommitProceed.resolve();
        const result = await executePromise;
        expect(result.status).toBe('PROCESSED');

        // --- EXTERNAL CONNECTION OBSERVATION (POST-COMMIT) ---
        // 1. Wallets must now show debited balance (60.00) and version 2
        const walletPostCommit = await externalClient.query(
          'SELECT balance, version FROM wallets WHERE id = $1;',
          [wallet.id]
        );
        expect(walletPostCommit.rows[0].balance).toBe('60.00');
        expect(walletPostCommit.rows[0].version).toBe(2);

        // 2. Transaction must exist
        const txPostCommit = await externalClient.query(
          'SELECT status FROM wager_transactions WHERE idempotency_key = $1;',
          [idempotencyKey]
        );
        expect(txPostCommit.rows[0].status).toBe('PROCESSED');

        // 3. Ledger entry must exist
        const ledgerPostCommit = await externalClient.query(
          'SELECT entry_type, amount FROM wallet_ledger_entries WHERE wallet_id = $1 AND amount = 40.00;',
          [wallet.id]
        );
        expect(ledgerPostCommit.rows.length).toBe(1);
        expect(ledgerPostCommit.rows[0].entry_type).toBe('DEBIT');

        // 4. All outbox events must now be visible with published_at null
        const outboxPostCommit = await queryExternalOutbox(wallet.id);
        expect(outboxPostCommit.length).toBe(4);
        expect(outboxPostCommit[2].event_type).toBe('WagerTransactionProcessed');
        expect(outboxPostCommit[3].event_type).toBe('WalletBalanceChanged');
      } finally {
        uow.clearTestHooks();
      }
    });

    it('3.2 Falha após a primeira gravação de outbox: reverte saldo, versão, transação, ledger e outbox; reenvio tem sucesso', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: uuidv4(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const idempotencyKey = `bet_fail_first_${uuidv4()}`;
      const extTxId = `ext_fail_first_${uuidv4()}`;

      let outboxSaveCount = 0;
      uow.setTestHook('after_outbox_save', async () => {
        outboxSaveCount++;
        if (outboxSaveCount === 1) {
          throw new Error('SIMULATED_FAILURE_AFTER_FIRST_OUTBOX_SAVE');
        }
      });

      try {
        await expect(
          processWagerUseCase.execute(idempotencyKey, {
            walletId: wallet.id,
            playerId: wallet.playerId,
            providerId: 'prv_m13',
            externalTransactionId: extTxId,
            roundId: `round_${uuidv4()}`,
            gameId: 'slot_m13',
            kind: 'BET',
            money: { amount: '35.00', currency: 'BRL' },
          })
        ).rejects.toThrow('SIMULATED_FAILURE_AFTER_FIRST_OUTBOX_SAVE');

        // --- VERIFY POSTGRESQL ROLLBACK VIA EXTERNAL CLIENT ---
        const walletRow = (
          await externalClient.query('SELECT balance, version FROM wallets WHERE id = $1;', [wallet.id])
        ).rows[0];
        expect(walletRow.balance).toBe('100.00');
        expect(walletRow.version).toBe(1);

        const txRows = (
          await externalClient.query('SELECT id FROM wager_transactions WHERE idempotency_key = $1;', [
            idempotencyKey,
          ])
        ).rows;
        expect(txRows.length).toBe(0);

        const ledgerRows = (
          await externalClient.query(
            'SELECT id FROM wallet_ledger_entries WHERE wallet_id = $1 AND amount = 35.00;',
            [wallet.id]
          )
        ).rows;
        expect(ledgerRows.length).toBe(0);

        const outboxRows = await queryExternalOutbox(wallet.id);
        // Only initial opening events (2), ZERO events from failed BET attempt!
        expect(outboxRows.length).toBe(2);
      } finally {
        uow.clearTestHooks();
      }

      // --- RESEND / RETRY WITH SAME IDEMPOTENCY KEY ---
      const retryRes = await processWagerUseCase.execute(idempotencyKey, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: 'prv_m13',
        externalTransactionId: extTxId,
        roundId: `round_${uuidv4()}`,
        gameId: 'slot_m13',
        kind: 'BET',
        money: { amount: '35.00', currency: 'BRL' },
      });

      expect(retryRes.status).toBe('PROCESSED');
      expect(retryRes.balance.amount).toBe('65.00');

      // Verify that after retry, exactly the expected 2 events are persisted (total 4)
      const outboxAfterRetry = await queryExternalOutbox(wallet.id);
      expect(outboxAfterRetry.length).toBe(4);
      expect(outboxAfterRetry[2].event_type).toBe('WagerTransactionProcessed');
      expect(outboxAfterRetry[3].event_type).toBe('WalletBalanceChanged');
    });

    it('3.3 Falha após a última gravação de outbox: reverte tudo; reenvio gera exatamente o conjunto esperado', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: uuidv4(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const idempotencyKey = `bet_fail_last_${uuidv4()}`;
      const extTxId = `ext_fail_last_${uuidv4()}`;

      let outboxSaveCount = 0;
      uow.setTestHook('after_outbox_save', async () => {
        outboxSaveCount++;
        // Fail on 2nd outbox save (after last outbox message is flushed)
        if (outboxSaveCount === 2) {
          throw new Error('SIMULATED_FAILURE_AFTER_LAST_OUTBOX_SAVE');
        }
      });

      try {
        await expect(
          processWagerUseCase.execute(idempotencyKey, {
            walletId: wallet.id,
            playerId: wallet.playerId,
            providerId: 'prv_m13',
            externalTransactionId: extTxId,
            roundId: `round_${uuidv4()}`,
            gameId: 'slot_m13',
            kind: 'BET',
            money: { amount: '45.00', currency: 'BRL' },
          })
        ).rejects.toThrow('SIMULATED_FAILURE_AFTER_LAST_OUTBOX_SAVE');

        // External client check: all rolled back
        const walletRow = (
          await externalClient.query('SELECT balance, version FROM wallets WHERE id = $1;', [wallet.id])
        ).rows[0];
        expect(walletRow.balance).toBe('100.00');
        expect(walletRow.version).toBe(1);

        const outboxRows = await queryExternalOutbox(wallet.id);
        expect(outboxRows.length).toBe(2);
      } finally {
        uow.clearTestHooks();
      }

      // Retry with same idempotency key
      const retryRes = await processWagerUseCase.execute(idempotencyKey, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: 'prv_m13',
        externalTransactionId: extTxId,
        roundId: `round_${uuidv4()}`,
        gameId: 'slot_m13',
        kind: 'BET',
        money: { amount: '45.00', currency: 'BRL' },
      });

      expect(retryRes.status).toBe('PROCESSED');
      expect(retryRes.balance.amount).toBe('55.00');

      const outboxAfterRetry = await queryExternalOutbox(wallet.id);
      expect(outboxAfterRetry.length).toBe(4);
    });

    it('3.4 Concorrência de duplicatas: requisições concorrentes idênticas não multiplicam eventos', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: uuidv4(),
        initialBalance: { amount: '200.00', currency: 'BRL' },
      });

      const idempotencyKey = `concurrent_m13_${uuidv4()}`;
      const dto = {
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: 'prv_m13',
        externalTransactionId: `ext_concurrent_${uuidv4()}`,
        roundId: `round_${uuidv4()}`,
        gameId: 'slot_m13',
        kind: 'BET' as const,
        money: { amount: '20.00', currency: 'BRL' },
      };

      // Dispatch 5 concurrent identical requests
      const promises = Array.from({ length: 5 }, () =>
        processWagerUseCase.execute(idempotencyKey, dto)
      );

      const results = await Promise.all(promises);

      // All 5 must succeed with status PROCESSED
      for (const res of results) {
        expect(res.status).toBe('PROCESSED');
        expect(res.balance.amount).toBe('180.00');
      }

      // Exactly one must be original (idempotentReplay: false) and 4 must be replays
      const originals = results.filter((r) => !r.idempotentReplay);
      const replays = results.filter((r) => r.idempotentReplay);
      expect(originals.length).toBe(1);
      expect(replays.length).toBe(4);

      // Verify in PostgreSQL: exactly 2 outbox events generated for this BET (4 total with opening)
      const events = await queryExternalOutbox(wallet.id);
      expect(events.length).toBe(4);
      expect(events[2].event_type).toBe('WagerTransactionProcessed');
      expect(events[3].event_type).toBe('WalletBalanceChanged');
    });

    it('3.5 Falha técnica genérica antes do commit: nenhum evento financeiro ou de outbox é confirmado', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: uuidv4(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const idempotencyKey = `tech_fail_${uuidv4()}`;
      const extTxId = `ext_tech_${uuidv4()}`;

      // Simulate technical infrastructure failure at before_commit
      uow.setTestHook('before_commit', async () => {
        throw new Error('DATABASE_DISK_FULL_SIMULATED');
      });

      try {
        await expect(
          processWagerUseCase.execute(idempotencyKey, {
            walletId: wallet.id,
            playerId: wallet.playerId,
            providerId: 'prv_m13',
            externalTransactionId: extTxId,
            roundId: `round_${uuidv4()}`,
            gameId: 'slot_m13',
            kind: 'BET',
            money: { amount: '50.00', currency: 'BRL' },
          })
        ).rejects.toThrow('DATABASE_DISK_FULL_SIMULATED');

        // Verify that wallet balance is intact
        const walletRow = (
          await externalClient.query('SELECT balance, version FROM wallets WHERE id = $1;', [wallet.id])
        ).rows[0];
        expect(walletRow.balance).toBe('100.00');
        expect(walletRow.version).toBe(1);

        // Verify transaction does not exist
        const txRows = (
          await externalClient.query('SELECT id FROM wager_transactions WHERE idempotency_key = $1;', [
            idempotencyKey,
          ])
        ).rows;
        expect(txRows.length).toBe(0);

        // Verify ledger does not exist
        const ledgerRows = (
          await externalClient.query(
            'SELECT id FROM wallet_ledger_entries WHERE wallet_id = $1 AND amount = 50.00;',
            [wallet.id]
          )
        ).rows;
        expect(ledgerRows.length).toBe(0);

        // Verify outbox has ONLY opening events, zero BET events
        const outboxRows = await queryExternalOutbox(wallet.id);
        expect(outboxRows.length).toBe(2);
      } finally {
        uow.clearTestHooks();
      }
    });
  });
});
