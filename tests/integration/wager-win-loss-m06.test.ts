import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
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
import { DatabaseMigrator } from '../../src/infrastructure/persistence/migrator';
import { ProcessWagerDto } from '../../src/application/dto/wager.dto';
import { Money } from '../../src/domain/value-objects/money.vo';
import { createIsolatedTestDatabase, IsolatedTestDatabase } from '../test-db-helper';

describe('M06: WIN e LOSS — Suíte de Testes Reais HTTP e PostgreSQL em Banco Descartável', () => {
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

  async function makePendingEligible(transactionId: string): Promise<void> {
    await adminPool.query(
      "UPDATE wager_transactions SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = $1;",
      [transactionId]
    );
  }

  beforeAll(async () => {
    // 1. Criar banco de dados isolado e descartável com migrações aplicadas
    isolatedDb = await createIsolatedTestDatabase('m06_win_loss_');

    adminPool = new pg.Pool({
      ...isolatedDb.adminConfig,
      max: 65,
    });
    adminPool.on('error', () => {});

    // 2. Subir servidor NestJS conectado ao banco descartável
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
  }, 30000);

  afterAll(async () => {
    uow?.clearTestHooks();
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
  }, 30000);

  beforeEach(() => {
    uow.clearTestHooks();
  });

  // Helper para buscar eventos de outbox discriminando pelo triggerTransactionId ou transactionId no payload
  async function findOutboxEventsForTransaction(txId: string) {
    const res = await adminPool.query(
      `SELECT * FROM outbox_messages 
       WHERE payload->>'transactionId' = $1 
          OR payload->>'triggerTransactionId' = $1
       ORDER BY created_at ASC`,
      [txId]
    );
    return res.rows;
  }

  // =========================================================================
  // 1. WIN VÁLIDA
  // =========================================================================
  describe('1. WIN Válida: Crédito, Versão, Ledger, Outbox e Reconciliação', () => {
    it('deve creditar exatamente o valor informado, incrementar version uma vez, gerar ledger CREDIT e 2 outbox events na mesma transação', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const idempotencyKey = `idemp-win-${crypto.randomUUID()}`;
      const extTxId = `ext-win-${crypto.randomUUID()}`;
      const payload: ProcessWagerDto = {
        providerId: 'provider_m06',
        externalTransactionId: extTxId,
        playerId,
        walletId: wallet.id,
        roundId: 'round_win_1',
        gameId: 'slot_win',
        kind: 'WIN',
        money: { amount: '50.00', currency: 'BRL' },
      };

      const httpRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(payload),
      });

      expect(httpRes.status).toBe(200);
      const resData = (await httpRes.json()) as any;
      expect(resData.status).toBe('PROCESSED');
      expect(resData.balance).toEqual({ amount: '150.00', currency: 'BRL' });
      expect(resData.idempotentReplay).toBe(false);
      expect(typeof resData.transactionId).toBe('string');

      uow.getEntityManager().clear();

      // Prova PostgreSQL: Saldo 150.00 e Version incrementada exatamente em 1
      const walletRow = (await adminPool.query('SELECT * FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      expect(walletRow.balance).toBe('150.00');
      expect(Number(walletRow.version)).toBe(2);
      expect(new Date(walletRow.updated_at).getTime()).toBeGreaterThanOrEqual(new Date(walletRow.created_at).getTime());

      // Prova PostgreSQL: Transações (diferenciando OPENING de WIN)
      const txRows = (
        await adminPool.query('SELECT * FROM wager_transactions WHERE wallet_id = $1 ORDER BY created_at ASC', [wallet.id])
      ).rows;
      expect(txRows.length).toBe(2);

      const openingTx = txRows.find((t) => t.kind === 'OPENING')!;
      expect(openingTx).toBeDefined();
      expect(openingTx.amount).toBe('100.00');

      const winTx = txRows.find((t) => t.kind === 'WIN')!;
      expect(winTx).toBeDefined();
      expect(winTx.id).toBe(resData.transactionId);
      expect(winTx.status).toBe('PROCESSED');
      expect(winTx.amount).toBe('50.00');
      expect(winTx.currency).toBe('BRL');
      expect(winTx.idempotency_key).toBe(idempotencyKey);
      expect(winTx.response_snapshot).toBeDefined();
      expect(winTx.response_snapshot.balance.amount).toBe('150.00');

      // Prova PostgreSQL: Ledger CREDIT
      const ledgerRows = (
        await adminPool.query('SELECT * FROM wallet_ledger_entries WHERE wallet_id = $1 ORDER BY created_at ASC', [wallet.id])
      ).rows;
      expect(ledgerRows.length).toBe(2);

      const winLedger = ledgerRows.find((l) => l.transaction_id === resData.transactionId)!;
      expect(winLedger).toBeDefined();
      expect(winLedger.entry_type).toBe('CREDIT');
      expect(winLedger.amount).toBe('50.00');
      expect(winLedger.balance_before).toBe('100.00');
      expect(winLedger.balance_after).toBe('150.00');

      // Prova PostgreSQL: Outbox (exatamente 2 eventos para o WIN)
      const outboxEvents = await findOutboxEventsForTransaction(resData.transactionId);
      expect(outboxEvents.length).toBe(2);

      const processedEvent = outboxEvents.find((e) => e.event_type === 'WagerTransactionProcessed')!;
      expect(processedEvent).toBeDefined();
      expect(processedEvent.payload.kind).toBe('WIN');
      expect(processedEvent.payload.transactionId).toBe(resData.transactionId);
      expect(processedEvent.payload.amount).toEqual({ amount: '50.00', currency: 'BRL' });
      expect(processedEvent.payload.balance).toEqual({ amount: '150.00', currency: 'BRL' });

      const balanceChangedEvent = outboxEvents.find((e) => e.event_type === 'WalletBalanceChanged')!;
      expect(balanceChangedEvent).toBeDefined();
      expect(balanceChangedEvent.payload.triggerTransactionId).toBe(resData.transactionId);
      expect(balanceChangedEvent.payload.previousBalance).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(balanceChangedEvent.payload.currentBalance).toEqual({ amount: '150.00', currency: 'BRL' });
      expect(balanceChangedEvent.payload.version).toBe(2);

      // Reconciliação
      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('150.00');
      expect(recon.calculatedBalance.amount).toBe('150.00');
    });
  });

  // =========================================================================
  // 2. ENTRADAS INVÁLIDAS DE WIN
  // =========================================================================
  describe('2. Entradas Inválidas de WIN: Valor Zero/Negativo, Formato, Moeda e Vínculo Player', () => {
    it('deve rejeitar WIN com valor zero ("0.00") com 400 Bad Request e sem efeitos parciais', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const httpRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'idempotency-key': `idemp-win-zero-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: `ext-win-zero-${crypto.randomUUID()}`,
          playerId,
          walletId: wallet.id,
          roundId: 'round_zero',
          gameId: 'slot_zero',
          kind: 'WIN',
          money: { amount: '0.00', currency: 'BRL' },
        }),
      });

      expect(httpRes.status).toBe(400);

      // Confirmar no banco que nada mudou
      const walletRow = (await adminPool.query('SELECT * FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      expect(walletRow.balance).toBe('100.00');
      expect(Number(walletRow.version)).toBe(1);

      const winCount = await adminPool.query("SELECT count(*) FROM wager_transactions WHERE wallet_id = $1 AND kind = 'WIN'", [wallet.id]);
      expect(Number(winCount.rows[0].count)).toBe(0);
    });

    it('deve rejeitar WIN com valor negativo ("-10.00") com 400 Bad Request', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '50.00', currency: 'BRL' },
      });

      const httpRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'idempotency-key': `idemp-win-neg-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: `ext-win-neg-${crypto.randomUUID()}`,
          playerId,
          walletId: wallet.id,
          roundId: 'round_neg',
          gameId: 'slot_neg',
          kind: 'WIN',
          money: { amount: '-10.00', currency: 'BRL' },
        }),
      });

      expect(httpRes.status).toBe(400);
    });

    it('deve rejeitar formatos não canônicos ("10", "10.5", " 10.00 ") com 400 Bad Request', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '50.00', currency: 'BRL' },
      });

      const invalidAmounts = ['10', '10.5', '10.000', ' 10.00', '10.00 '];
      for (const badAmount of invalidAmounts) {
        const httpRes = await fetch(`${serverUrl}/wagering/transactions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'idempotency-key': `idemp-bad-fmt-${crypto.randomUUID()}`,
          },
          body: JSON.stringify({
            providerId: 'provider_m06',
            externalTransactionId: `ext-bad-fmt-${crypto.randomUUID()}`,
            playerId,
            walletId: wallet.id,
            roundId: 'round_fmt',
            gameId: 'slot_fmt',
            kind: 'WIN',
            money: { amount: badAmount, currency: 'BRL' },
          }),
        });
        expect(httpRes.status).toBe(400);
      }
    });

    it('deve rejeitar WIN com moeda incompatível com a carteira (422 Unprocessable Entity)', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      // Pelo validador HTTP, moedas diferentes de BRL são bloqueadas com 400 ou no use case com 422
      // Testamos a tentativa via use case diretamente para garantir a política de domínio
      await expect(
        processWagerUseCase.execute(`idemp-win-usd-${crypto.randomUUID()}`, {
          providerId: 'provider_m06',
          externalTransactionId: `ext-win-usd-${crypto.randomUUID()}`,
          playerId,
          walletId: wallet.id,
          roundId: 'round_usd',
          gameId: 'slot_usd',
          kind: 'WIN',
          money: { amount: '50.00', currency: 'USD' },
        })
      ).rejects.toThrow();

      const walletRow = (await adminPool.query('SELECT * FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      expect(walletRow.balance).toBe('100.00');
      expect(Number(walletRow.version)).toBe(1);
    });

    it('deve rejeitar WIN para wallet que não pertence ao player informado (400 Bad Request)', async () => {
      const player1 = crypto.randomUUID();
      const player2 = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId: player1,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const httpRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'idempotency-key': `idemp-win-bad-player-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: `ext-win-bad-player-${crypto.randomUUID()}`,
          playerId: player2, // Player 2 tentando creditar wallet do Player 1
          walletId: wallet.id,
          roundId: 'round_bad_player',
          gameId: 'slot_bad_player',
          kind: 'WIN',
          money: { amount: '50.00', currency: 'BRL' },
        }),
      });

      expect(httpRes.status).toBe(400);

      const walletRow = (await adminPool.query('SELECT * FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      expect(walletRow.balance).toBe('100.00');
      expect(Number(walletRow.version)).toBe(1);
    });
  });

  // =========================================================================
  // 3. CRÉDITO NO LIMITE MONEY E OVERFLOW
  // =========================================================================
  describe('3. Crédito no Limite Money e Rejeição de Overflow', () => {
    it('deve creditar com sucesso quando a WIN atinge exatamente o limite Money ("9999999999999999.99")', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '0.00', currency: 'BRL' },
      });

      const idempotencyKey = `idemp-win-limit-${crypto.randomUUID()}`;
      const extTxId = `ext-win-limit-${crypto.randomUUID()}`;

      const httpRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: extTxId,
          playerId,
          walletId: wallet.id,
          roundId: 'round_limit',
          gameId: 'slot_limit',
          kind: 'WIN',
          money: { amount: Money.MAX_LIMIT, currency: 'BRL' },
        }),
      });

      expect(httpRes.status).toBe(200);
      const resData = (await httpRes.json()) as any;
      expect(resData.status).toBe('PROCESSED');
      expect(resData.balance.amount).toBe(Money.MAX_LIMIT);

      uow.getEntityManager().clear();

      const walletRow = (await adminPool.query('SELECT * FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      expect(walletRow.balance).toBe(Money.MAX_LIMIT);
      expect(Number(walletRow.version)).toBe(2);

      const ledger = (await adminPool.query('SELECT * FROM wallet_ledger_entries WHERE transaction_id = $1', [resData.transactionId])).rows[0];
      expect(ledger.amount).toBe(Money.MAX_LIMIT);
      expect(ledger.balance_before).toBe('0.00');
      expect(ledger.balance_after).toBe(Money.MAX_LIMIT);

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe(Money.MAX_LIMIT);
      expect(recon.calculatedBalance.amount).toBe(Money.MAX_LIMIT);
    });

    it('deve rejeitar crédito adicional que cause overflow com erro de domínio e ausência de alterações parciais', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: Money.MAX_LIMIT, currency: 'BRL' },
      });

      const badKey = `idemp-overflow-${crypto.randomUUID()}`;
      const badExtId = `ext-overflow-${crypto.randomUUID()}`;

      const httpRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'idempotency-key': badKey,
        },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: badExtId,
          playerId,
          walletId: wallet.id,
          roundId: 'round_overflow',
          gameId: 'slot_overflow',
          kind: 'WIN',
          money: { amount: '0.01', currency: 'BRL' },
        }),
      });

      expect(httpRes.status).toBe(400);
      const errBody = (await httpRes.json()) as any;
      expect(errBody.code).toBe('MONEY_OVERFLOW');

      uow.getEntityManager().clear();

      // Prova PostgreSQL: Saldo permanece exatamente MAX_LIMIT, version permanece inalterada (1 da abertura)
      const walletRow = (await adminPool.query('SELECT * FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      expect(walletRow.balance).toBe(Money.MAX_LIMIT);
      expect(Number(walletRow.version)).toBe(1);

      // Nenhuma transação gravada para a tentativa que deu overflow
      const checkTx = await adminPool.query('SELECT count(*) FROM wager_transactions WHERE idempotency_key = $1', [badKey]);
      expect(Number(checkTx.rows[0].count)).toBe(0);

      // Nenhum ledger gravado para o badExtId
      const checkLedger = await adminPool.query(
        "SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = $1 AND transaction_id NOT IN (SELECT id FROM wager_transactions WHERE kind = 'OPENING')",
        [wallet.id]
      );
      expect(Number(checkLedger.rows[0].count)).toBe(0);

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe(Money.MAX_LIMIT);
    });
  });

  // =========================================================================
  // 4. LOSS VÁLIDA
  // =========================================================================
  describe('4. LOSS Válida: Sem Mutação de Saldo/Versão/UpdatedAt, Sem Ledger e Somente WagerTransactionProcessed', () => {
    it('deve persistir PROCESSED, não alterar saldo/version/updatedAt, não gerar ledger e emitir somente WagerTransactionProcessed', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      // Capturar estado exato da wallet antes da LOSS
      const walletBefore = (await adminPool.query('SELECT * FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      const balanceBefore = walletBefore.balance;
      const versionBefore = Number(walletBefore.version);
      const updatedAtBefore = walletBefore.updated_at;

      const idempotencyKey = `idemp-loss-${crypto.randomUUID()}`;
      const extTxId = `ext-loss-${crypto.randomUUID()}`;
      const payload: ProcessWagerDto = {
        providerId: 'provider_m06',
        externalTransactionId: extTxId,
        playerId,
        walletId: wallet.id,
        roundId: 'round_loss_1',
        gameId: 'slot_loss',
        kind: 'LOSS',
        money: { amount: '25.00', currency: 'BRL' },
      };

      const httpRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(payload),
      });

      expect(httpRes.status).toBe(200);
      const resData = (await httpRes.json()) as any;
      expect(resData.status).toBe('PROCESSED');
      expect(resData.balance).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(resData.idempotentReplay).toBe(false);
      expect(typeof resData.transactionId).toBe('string');

      uow.getEntityManager().clear();

      // Prova PostgreSQL: Saldo, Versão e UpdatedAt da Wallet permanecem RIGOROSAMENTE INTACTOS
      const walletAfter = (await adminPool.query('SELECT * FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      expect(walletAfter.balance).toBe(balanceBefore);
      expect(Number(walletAfter.version)).toBe(versionBefore);
      expect(new Date(walletAfter.updated_at).toISOString()).toBe(new Date(updatedAtBefore).toISOString());

      // Prova PostgreSQL: Transação PROCESSED de kind LOSS
      const lossTx = (await adminPool.query('SELECT * FROM wager_transactions WHERE id = $1', [resData.transactionId])).rows[0];
      expect(lossTx).toBeDefined();
      expect(lossTx.kind).toBe('LOSS');
      expect(lossTx.status).toBe('PROCESSED');
      expect(lossTx.amount).toBe('25.00');
      expect(lossTx.response_snapshot).toBeDefined();
      expect(lossTx.response_snapshot.balance.amount).toBe('100.00');

      // Prova PostgreSQL: Zero entradas de ledger para a LOSS
      const ledgerRows = (await adminPool.query('SELECT * FROM wallet_ledger_entries WHERE transaction_id = $1', [resData.transactionId])).rows;
      expect(ledgerRows.length).toBe(0);

      // Prova PostgreSQL: Outbox contém SOMENTE WagerTransactionProcessed, NUNCA WalletBalanceChanged
      const outboxEvents = await findOutboxEventsForTransaction(resData.transactionId);
      expect(outboxEvents.length).toBe(1);
      expect(outboxEvents[0].event_type).toBe('WagerTransactionProcessed');
      expect(outboxEvents[0].payload.kind).toBe('LOSS');
      expect(outboxEvents[0].payload.transactionId).toBe(resData.transactionId);
      expect(outboxEvents[0].payload.amount).toEqual({ amount: '25.00', currency: 'BRL' });

      // Reconciliação permanece 100% consistente
      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('100.00');
      expect(recon.calculatedBalance.amount).toBe('100.00');
    });

    it('deve aceitar LOSS com valor zero ("0.00") conforme política documentada sem alterar carteira', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const httpRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'idempotency-key': `idemp-loss-zero-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: `ext-loss-zero-${crypto.randomUUID()}`,
          playerId,
          walletId: wallet.id,
          roundId: 'round_loss_zero',
          gameId: 'slot_loss_zero',
          kind: 'LOSS',
          money: { amount: '0.00', currency: 'BRL' },
        }),
      });

      expect(httpRes.status).toBe(200);
      const resData = (await httpRes.json()) as any;
      expect(resData.status).toBe('PROCESSED');
      expect(resData.balance.amount).toBe('100.00');

      uow.getEntityManager().clear();

      const walletRow = (await adminPool.query('SELECT * FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      expect(walletRow.balance).toBe('100.00');
      expect(Number(walletRow.version)).toBe(1);

      const ledger = await adminPool.query('SELECT count(*) FROM wallet_ledger_entries WHERE transaction_id = $1', [resData.transactionId]);
      expect(Number(ledger.rows[0].count)).toBe(0);
    });

    it('LOSS nunca movimenta saldo mesmo quando submetida com valor positivo alto', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '50.00', currency: 'BRL' },
      });

      const httpRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'idempotency-key': `idemp-loss-high-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: `ext-loss-high-${crypto.randomUUID()}`,
          playerId,
          walletId: wallet.id,
          roundId: 'round_loss_high',
          gameId: 'slot_loss_high',
          kind: 'LOSS',
          money: { amount: '500.00', currency: 'BRL' },
        }),
      });

      expect(httpRes.status).toBe(200);
      const resData = (await httpRes.json()) as any;
      expect(resData.status).toBe('PROCESSED');
      expect(resData.balance.amount).toBe('50.00'); // Saldo permanece 50.00!

      uow.getEntityManager().clear();

      const walletRow = (await adminPool.query('SELECT * FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      expect(walletRow.balance).toBe('50.00');
      expect(Number(walletRow.version)).toBe(1);
    });
  });

  // =========================================================================
  // 5. ENTRADAS INVÁLIDAS DE LOSS
  // =========================================================================
  describe('5. Entradas Inválidas de LOSS', () => {
    it('deve rejeitar LOSS com valor negativo ("-5.00") com 400 Bad Request', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '50.00', currency: 'BRL' },
      });

      const httpRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'idempotency-key': `idemp-loss-neg-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: `ext-loss-neg-${crypto.randomUUID()}`,
          playerId,
          walletId: wallet.id,
          roundId: 'round_loss_neg',
          gameId: 'slot_loss_neg',
          kind: 'LOSS',
          money: { amount: '-5.00', currency: 'BRL' },
        }),
      });

      expect(httpRes.status).toBe(400);
    });

    it('deve rejeitar LOSS com tentativa de fornecer referenceExternalTransactionId com 400 Bad Request', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '50.00', currency: 'BRL' },
      });

      const httpRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'idempotency-key': `idemp-loss-ref-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: `ext-loss-ref-${crypto.randomUUID()}`,
          playerId,
          walletId: wallet.id,
          roundId: 'round_loss_ref',
          gameId: 'slot_loss_ref',
          kind: 'LOSS',
          money: { amount: '10.00', currency: 'BRL' },
          referenceExternalTransactionId: 'ref_forbidden_on_loss',
        }),
      });

      expect(httpRes.status).toBe(400);
      const resBody = (await httpRes.json()) as any;
      expect(resBody.message).toContain('referenceExternalTransactionId is not permitted for kind="LOSS"');
    });
  });

  // =========================================================================
  // 6. REPLAY E CONFLITOS DE WIN E LOSS
  // =========================================================================
  describe('6. Replay e Conflitos de Idempotência para WIN e LOSS', () => {
    it('Replay de WIN: repetir retorna transactionId e saldo originais com idempotentReplay=true, mesmo após alteração posterior do saldo', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const winKey = `idemp-win-replay-${crypto.randomUUID()}`;
      const winPayload: ProcessWagerDto = {
        providerId: 'provider_m06',
        externalTransactionId: `ext-win-rep-${crypto.randomUUID()}`,
        playerId,
        walletId: wallet.id,
        roundId: 'round_rep_1',
        gameId: 'slot_rep',
        kind: 'WIN',
        money: { amount: '50.00', currency: 'BRL' },
      };

      // 1. Primeira submissão da WIN
      const firstRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': winKey },
        body: JSON.stringify(winPayload),
      });
      expect(firstRes.status).toBe(200);
      const firstData = (await firstRes.json()) as any;
      expect(firstData.idempotentReplay).toBe(false);
      expect(firstData.balance.amount).toBe('150.00');

      // 2. Operação interveniente altera o saldo (uma BET de 30.00)
      const betRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': `idemp-intervening-${crypto.randomUUID()}` },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: `ext-bet-int-${crypto.randomUUID()}`,
          playerId,
          walletId: wallet.id,
          roundId: 'round_int',
          gameId: 'slot_rep',
          kind: 'BET',
          money: { amount: '30.00', currency: 'BRL' },
        }),
      });
      expect(betRes.status).toBe(200);
      const betData = (await betRes.json()) as any;
      expect(betData.balance.amount).toBe('120.00');

      // 3. Replay da WIN original: DEVE retornar o saldo histórico (150.00), e NÃO o saldo atual (120.00)!
      const replayRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': winKey },
        body: JSON.stringify(winPayload),
      });
      expect(replayRes.status).toBe(200);
      const replayData = (await replayRes.json()) as any;
      expect(replayData.idempotentReplay).toBe(true);
      expect(replayData.transactionId).toBe(firstData.transactionId);
      expect(replayData.status).toBe('PROCESSED');
      expect(replayData.balance.amount).toBe('150.00'); // Saldo original preservado no snapshot!

      uow.getEntityManager().clear();

      // Saldo atual da carteira não foi afetado pelo replay (continua 120.00)
      const walletRow = (await adminPool.query('SELECT * FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      expect(walletRow.balance).toBe('120.00');
      expect(Number(walletRow.version)).toBe(3); // 1 (opening) + 1 (WIN) + 1 (BET)

      // Nenhum novo evento emitido no replay
      const outboxEvents = await findOutboxEventsForTransaction(firstData.transactionId);
      expect(outboxEvents.length).toBe(2); // Apenas os 2 originais da WIN
    });

    it('Replay de LOSS: repetir retorna transactionId e saldo originais com idempotentReplay=true', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const lossKey = `idemp-loss-rep-${crypto.randomUUID()}`;
      const lossPayload: ProcessWagerDto = {
        providerId: 'provider_m06',
        externalTransactionId: `ext-loss-rep-${crypto.randomUUID()}`,
        playerId,
        walletId: wallet.id,
        roundId: 'round_loss_rep',
        gameId: 'slot_loss_rep',
        kind: 'LOSS',
        money: { amount: '20.00', currency: 'BRL' },
      };

      const firstRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': lossKey },
        body: JSON.stringify(lossPayload),
      });
      expect(firstRes.status).toBe(200);
      const firstData = (await firstRes.json()) as any;
      expect(firstData.idempotentReplay).toBe(false);

      const replayRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': lossKey },
        body: JSON.stringify(lossPayload),
      });
      expect(replayRes.status).toBe(200);
      const replayData = (await replayRes.json()) as any;
      expect(replayData.idempotentReplay).toBe(true);
      expect(replayData.transactionId).toBe(firstData.transactionId);

      const outboxEvents = await findOutboxEventsForTransaction(firstData.transactionId);
      expect(outboxEvents.length).toBe(1); // Somente 1 evento, sem duplicação no replay
    });

    it('Conflito de Payload (409): Mesma idempotency-key com payload divergente retorna 409 Conflict', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const key = `idemp-conflict-${crypto.randomUUID()}`;
      const extId = `ext-conflict-${crypto.randomUUID()}`;

      // Primeira submissão: WIN de 25.00
      const res1 = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: extId,
          playerId,
          walletId: wallet.id,
          roundId: 'round_c1',
          gameId: 'slot_c',
          kind: 'WIN',
          money: { amount: '25.00', currency: 'BRL' },
        }),
      });
      expect(res1.status).toBe(200);

      // Segunda submissão com mesma chave, mas amount diferente (30.00)
      const res2 = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: extId,
          playerId,
          walletId: wallet.id,
          roundId: 'round_c1',
          gameId: 'slot_c',
          kind: 'WIN',
          money: { amount: '30.00', currency: 'BRL' },
        }),
      });
      expect(res2.status).toBe(409);
      const errBody = (await res2.json()) as any;
      expect(errBody.code).toBe('IDEMPOTENCY_CONFLICT');

      uow.getEntityManager().clear();

      // Saldo da carteira permanece 125.00, sem efeito da segunda requisição
      const walletRow = (await adminPool.query('SELECT * FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      expect(walletRow.balance).toBe('125.00');
      expect(Number(walletRow.version)).toBe(2);
    });

    it('Conflito de Identificador Externo: Reutilizar providerId e externalTransactionId sob outra chave retorna 409 Conflict', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const extId = `ext-dup-provider-${crypto.randomUUID()}`;

      // Primeiro envio com Key 1
      const res1 = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': `key-1-${crypto.randomUUID()}` },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: extId,
          playerId,
          walletId: wallet.id,
          roundId: 'round_dup',
          gameId: 'slot_dup',
          kind: 'WIN',
          money: { amount: '20.00', currency: 'BRL' },
        }),
      });
      expect(res1.status).toBe(200);

      // Segundo envio com o mesmo providerId/externalTransactionId sob Key 2
      const res2 = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': `key-2-${crypto.randomUUID()}` },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: extId,
          playerId,
          walletId: wallet.id,
          roundId: 'round_dup',
          gameId: 'slot_dup',
          kind: 'WIN',
          money: { amount: '20.00', currency: 'BRL' },
        }),
      });
      expect(res2.status).toBe(409);
      const errBody = (await res2.json()) as any;
      expect(errBody.code).toBe('IDEMPOTENCY_CONFLICT');
    });
  });

  // =========================================================================
  // 7. CONCORRÊNCIA REAL
  // =========================================================================
  describe('7. Concorrência Real: 50 WIN Idênticas, 50 LOSS Idênticas e WIN Distintas Simultâneas', () => {
    it('50 WIN idênticas concorrentes: exatamente um crédito, version incrementada em 1 e 1 transação financeira', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const sharedKey = `idemp-win-50-${crypto.randomUUID()}`;
      const extId = `ext-win-50-${crypto.randomUUID()}`;
      const payload = {
        providerId: 'provider_m06',
        externalTransactionId: extId,
        playerId,
        walletId: wallet.id,
        roundId: 'round_50_win',
        gameId: 'slot_50',
        kind: 'WIN',
        money: { amount: '25.00', currency: 'BRL' },
      };

      // Disparar 50 requisições simultâneas
      const promises = Array.from({ length: 50 }, () =>
        fetch(`${serverUrl}/wagering/transactions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'idempotency-key': sharedKey },
          body: JSON.stringify(payload),
        })
      );

      const results = await Promise.all(promises);
      for (const res of results) {
        expect(res.status).toBe(200);
      }

      const jsonResponses = await Promise.all(results.map((r) => r.json() as Promise<any>));
      const firstTxId = jsonResponses[0].transactionId;

      // Todos devem reportar o mesmo transactionId e saldo 125.00
      for (const data of jsonResponses) {
        expect(data.transactionId).toBe(firstTxId);
        expect(data.status).toBe('PROCESSED');
        expect(data.balance.amount).toBe('125.00');
      }

      // Exatamente uma requisição foi a primeira (idempotentReplay=false) e 49 foram replays (idempotentReplay=true)
      const nonReplays = jsonResponses.filter((d) => d.idempotentReplay === false);
      const replays = jsonResponses.filter((d) => d.idempotentReplay === true);
      expect(nonReplays.length).toBe(1);
      expect(replays.length).toBe(49);

      uow.getEntityManager().clear();

      // Prova PostgreSQL: Saldo 125.00 e Version 2
      const walletRow = (await adminPool.query('SELECT * FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      expect(walletRow.balance).toBe('125.00');
      expect(Number(walletRow.version)).toBe(2);

      // Exatamente 1 transação WIN gravada
      const txRows = (await adminPool.query("SELECT * FROM wager_transactions WHERE wallet_id = $1 AND kind = 'WIN'", [wallet.id])).rows;
      expect(txRows.length).toBe(1);

      // Exatamente 1 lançamento CREDIT no ledger para a WIN
      const ledgerRows = (await adminPool.query('SELECT * FROM wallet_ledger_entries WHERE transaction_id = $1', [firstTxId])).rows;
      expect(ledgerRows.length).toBe(1);

      // Exatamente 2 eventos de outbox para a WIN
      const outboxEvents = await findOutboxEventsForTransaction(firstTxId);
      expect(outboxEvents.length).toBe(2);

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('125.00');
    });

    it('50 LOSS idênticas concorrentes: exatamente uma transação, um evento e zero movimentos de saldo', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const sharedKey = `idemp-loss-50-${crypto.randomUUID()}`;
      const extId = `ext-loss-50-${crypto.randomUUID()}`;
      const payload = {
        providerId: 'provider_m06',
        externalTransactionId: extId,
        playerId,
        walletId: wallet.id,
        roundId: 'round_50_loss',
        gameId: 'slot_50_loss',
        kind: 'LOSS',
        money: { amount: '15.00', currency: 'BRL' },
      };

      const promises = Array.from({ length: 50 }, () =>
        fetch(`${serverUrl}/wagering/transactions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'idempotency-key': sharedKey },
          body: JSON.stringify(payload),
        })
      );

      const results = await Promise.all(promises);
      for (const res of results) {
        expect(res.status).toBe(200);
      }

      const jsonResponses = await Promise.all(results.map((r) => r.json() as Promise<any>));
      const firstTxId = jsonResponses[0].transactionId;

      const nonReplays = jsonResponses.filter((d) => d.idempotentReplay === false);
      const replays = jsonResponses.filter((d) => d.idempotentReplay === true);
      expect(nonReplays.length).toBe(1);
      expect(replays.length).toBe(49);

      uow.getEntityManager().clear();

      // Prova PostgreSQL: Saldo 100.00 e Version 1 (intactos!)
      const walletRow = (await adminPool.query('SELECT * FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      expect(walletRow.balance).toBe('100.00');
      expect(Number(walletRow.version)).toBe(1);

      // Exatamente 1 transação LOSS no banco
      const txRows = (await adminPool.query("SELECT * FROM wager_transactions WHERE wallet_id = $1 AND kind = 'LOSS'", [wallet.id])).rows;
      expect(txRows.length).toBe(1);

      // Exatamente ZERO lançamentos no ledger
      const ledgerRows = (await adminPool.query('SELECT * FROM wallet_ledger_entries WHERE transaction_id = $1', [firstTxId])).rows;
      expect(ledgerRows.length).toBe(0);

      // Exatamente 1 evento de outbox (WagerTransactionProcessed)
      const outboxEvents = await findOutboxEventsForTransaction(firstTxId);
      expect(outboxEvents.length).toBe(1);
      expect(outboxEvents[0].event_type).toBe('WagerTransactionProcessed');

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('100.00');
    });

    it('WIN distintas concorrentes na mesma wallet: soma exata, sem lost update e com versão correta', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const NUM_WINS = 10;
      const WIN_AMOUNT = '10.00';

      const promises = Array.from({ length: NUM_WINS }, (_, i) => {
        const key = `idemp-distinct-win-${i}-${crypto.randomUUID()}`;
        const extId = `ext-distinct-win-${i}-${crypto.randomUUID()}`;
        return fetch(`${serverUrl}/wagering/transactions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'idempotency-key': key },
          body: JSON.stringify({
            providerId: 'provider_m06',
            externalTransactionId: extId,
            playerId,
            walletId: wallet.id,
            roundId: `round_dist_${i}`,
            gameId: 'slot_dist',
            kind: 'WIN',
            money: { amount: WIN_AMOUNT, currency: 'BRL' },
          }),
        });
      });

      const results = await Promise.all(promises);
      for (const res of results) {
        expect(res.status).toBe(200);
      }

      uow.getEntityManager().clear();

      // Prova PostgreSQL: Saldo deve ser 100.00 + (10 * 10.00) = 200.00
      const walletRow = (await adminPool.query('SELECT * FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      expect(walletRow.balance).toBe('200.00');
      // Versão deve ser 1 (opening) + 10 (WINs) = 11
      expect(Number(walletRow.version)).toBe(11);

      // Exatamente 10 transações WIN gravadas
      const txRows = (await adminPool.query("SELECT * FROM wager_transactions WHERE wallet_id = $1 AND kind = 'WIN'", [wallet.id])).rows;
      expect(txRows.length).toBe(NUM_WINS);

      // Exatamente 10 lançamentos CREDIT para as WINs no ledger (+ 1 de opening)
      const ledgerRows = (await adminPool.query('SELECT * FROM wallet_ledger_entries WHERE wallet_id = $1', [wallet.id])).rows;
      expect(ledgerRows.length).toBe(NUM_WINS + 1);

      // Reconciliação
      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('200.00');
      expect(recon.calculatedBalance.amount).toBe('200.00');
    });
  });

  // =========================================================================
  // 8. FALHAS INJETADAS E ROLLBACK INTEGRAL
  // =========================================================================
  describe('8. Falhas Injetadas e Rollback Integral Auditado por Identificadores', () => {
    // 8.1 WIN - Falha pós wallet_save
    it('WIN: deve reverter integralmente quando a falha ocorre pós-wallet_save e permitir reenvio único', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const key = `idemp-fail-w-save-${crypto.randomUUID()}`;
      const extId = `ext-fail-w-save-${crypto.randomUUID()}`;

      try {
        uow.setTestFailurePoint('after_wallet_save', () => {
          throw new Error('Falha simulada pós-wallet_save na WIN');
        });

        const httpRes = await fetch(`${serverUrl}/wagering/transactions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'idempotency-key': key },
          body: JSON.stringify({
            providerId: 'provider_m06',
            externalTransactionId: extId,
            playerId,
            walletId: wallet.id,
            roundId: 'round_f1',
            gameId: 'slot_f',
            kind: 'WIN',
            money: { amount: '50.00', currency: 'BRL' },
          }),
        });
        expect(httpRes.status).toBe(500);
      } finally {
        uow.clearTestHooks();
      }

      uow.getEntityManager().clear();

      // Prova de Rollback Integral
      const walletRow = (await adminPool.query('SELECT * FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      expect(walletRow.balance).toBe('100.00');
      expect(Number(walletRow.version)).toBe(1);

      const txCount = await adminPool.query('SELECT count(*) FROM wager_transactions WHERE idempotency_key = $1', [key]);
      expect(Number(txCount.rows[0].count)).toBe(0);

      // Reenvio bem-sucedido com efeito único
      const retryRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: extId,
          playerId,
          walletId: wallet.id,
          roundId: 'round_f1',
          gameId: 'slot_f',
          kind: 'WIN',
          money: { amount: '50.00', currency: 'BRL' },
        }),
      });
      expect(retryRes.status).toBe(200);

      const walletRowAfter = (await adminPool.query('SELECT * FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      expect(walletRowAfter.balance).toBe('150.00');
      expect(Number(walletRowAfter.version)).toBe(2);
    });

    // 8.2 WIN - Falha pós tx_save
    it('WIN: deve reverter integralmente quando a falha ocorre pós-tx_save e permitir reenvio único', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const key = `idemp-fail-tx-save-${crypto.randomUUID()}`;
      const extId = `ext-fail-tx-save-${crypto.randomUUID()}`;

      try {
        uow.setTestFailurePoint('after_tx_save', () => {
          throw new Error('Falha simulada pós-tx_save na WIN');
        });

        const httpRes = await fetch(`${serverUrl}/wagering/transactions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'idempotency-key': key },
          body: JSON.stringify({
            providerId: 'provider_m06',
            externalTransactionId: extId,
            playerId,
            walletId: wallet.id,
            roundId: 'round_f2',
            gameId: 'slot_f',
            kind: 'WIN',
            money: { amount: '40.00', currency: 'BRL' },
          }),
        });
        expect(httpRes.status).toBe(500);
      } finally {
        uow.clearTestHooks();
      }

      uow.getEntityManager().clear();

      const walletRow = (await adminPool.query('SELECT * FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      expect(walletRow.balance).toBe('100.00');
      expect(Number(walletRow.version)).toBe(1);

      const txCount = await adminPool.query('SELECT count(*) FROM wager_transactions WHERE idempotency_key = $1', [key]);
      expect(Number(txCount.rows[0].count)).toBe(0);

      // Reenvio bem-sucedido
      const retryRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: extId,
          playerId,
          walletId: wallet.id,
          roundId: 'round_f2',
          gameId: 'slot_f',
          kind: 'WIN',
          money: { amount: '40.00', currency: 'BRL' },
        }),
      });
      expect(retryRes.status).toBe(200);

      const walletRowAfter = (await adminPool.query('SELECT * FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      expect(walletRowAfter.balance).toBe('140.00');
      expect(Number(walletRowAfter.version)).toBe(2);
    });

    // 8.3 WIN - Falha pós ledger_save
    it('WIN: deve reverter integralmente quando a falha ocorre pós-ledger_save e permitir reenvio único', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const key = `idemp-fail-led-save-${crypto.randomUUID()}`;
      const extId = `ext-fail-led-save-${crypto.randomUUID()}`;

      try {
        uow.setTestFailurePoint('after_ledger_save', () => {
          throw new Error('Falha simulada pós-ledger_save na WIN');
        });

        const httpRes = await fetch(`${serverUrl}/wagering/transactions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'idempotency-key': key },
          body: JSON.stringify({
            providerId: 'provider_m06',
            externalTransactionId: extId,
            playerId,
            walletId: wallet.id,
            roundId: 'round_f3',
            gameId: 'slot_f',
            kind: 'WIN',
            money: { amount: '35.00', currency: 'BRL' },
          }),
        });
        expect(httpRes.status).toBe(500);
      } finally {
        uow.clearTestHooks();
      }

      uow.getEntityManager().clear();

      const walletRow = (await adminPool.query('SELECT * FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      expect(walletRow.balance).toBe('100.00');
      expect(Number(walletRow.version)).toBe(1);

      // Reenvio bem-sucedido
      const retryRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: extId,
          playerId,
          walletId: wallet.id,
          roundId: 'round_f3',
          gameId: 'slot_f',
          kind: 'WIN',
          money: { amount: '35.00', currency: 'BRL' },
        }),
      });
      expect(retryRes.status).toBe(200);

      const walletRowAfter = (await adminPool.query('SELECT * FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      expect(walletRowAfter.balance).toBe('135.00');
      expect(Number(walletRowAfter.version)).toBe(2);
    });

    // 8.4 WIN - Falha pós primeira outbox_save
    it('WIN: deve reverter integralmente quando a falha ocorre pós-outbox_save e permitir reenvio único', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const key = `idemp-fail-out-save-${crypto.randomUUID()}`;
      const extId = `ext-fail-out-save-${crypto.randomUUID()}`;

      try {
        uow.setTestFailurePoint('after_outbox_save', () => {
          throw new Error('Falha simulada pós-outbox_save na WIN');
        });

        const httpRes = await fetch(`${serverUrl}/wagering/transactions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'idempotency-key': key },
          body: JSON.stringify({
            providerId: 'provider_m06',
            externalTransactionId: extId,
            playerId,
            walletId: wallet.id,
            roundId: 'round_f4',
            gameId: 'slot_f',
            kind: 'WIN',
            money: { amount: '60.00', currency: 'BRL' },
          }),
        });
        expect(httpRes.status).toBe(500);
      } finally {
        uow.clearTestHooks();
      }

      uow.getEntityManager().clear();

      const walletRow = (await adminPool.query('SELECT * FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      expect(walletRow.balance).toBe('100.00');
      expect(Number(walletRow.version)).toBe(1);

      // Reenvio bem-sucedido
      const retryRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: extId,
          playerId,
          walletId: wallet.id,
          roundId: 'round_f4',
          gameId: 'slot_f',
          kind: 'WIN',
          money: { amount: '60.00', currency: 'BRL' },
        }),
      });
      expect(retryRes.status).toBe(200);

      const walletRowAfter = (await adminPool.query('SELECT * FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      expect(walletRowAfter.balance).toBe('160.00');
      expect(Number(walletRowAfter.version)).toBe(2);
    });

    // 8.5 LOSS - Falha pós tx_save
    it('LOSS: deve reverter integralmente quando a falha ocorre pós-tx_save e permitir reenvio único', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const key = `idemp-fail-loss-tx-${crypto.randomUUID()}`;
      const extId = `ext-fail-loss-tx-${crypto.randomUUID()}`;

      try {
        uow.setTestFailurePoint('after_tx_save', () => {
          throw new Error('Falha simulada pós-tx_save na LOSS');
        });

        const httpRes = await fetch(`${serverUrl}/wagering/transactions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'idempotency-key': key },
          body: JSON.stringify({
            providerId: 'provider_m06',
            externalTransactionId: extId,
            playerId,
            walletId: wallet.id,
            roundId: 'round_fl1',
            gameId: 'slot_fl',
            kind: 'LOSS',
            money: { amount: '20.00', currency: 'BRL' },
          }),
        });
        expect(httpRes.status).toBe(500);
      } finally {
        uow.clearTestHooks();
      }

      uow.getEntityManager().clear();

      const txCount = await adminPool.query('SELECT count(*) FROM wager_transactions WHERE idempotency_key = $1', [key]);
      expect(Number(txCount.rows[0].count)).toBe(0);

      // Reenvio bem-sucedido
      const retryRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: extId,
          playerId,
          walletId: wallet.id,
          roundId: 'round_fl1',
          gameId: 'slot_fl',
          kind: 'LOSS',
          money: { amount: '20.00', currency: 'BRL' },
        }),
      });
      expect(retryRes.status).toBe(200);

      const txCountAfter = await adminPool.query('SELECT count(*) FROM wager_transactions WHERE idempotency_key = $1', [key]);
      expect(Number(txCountAfter.rows[0].count)).toBe(1);
    });

    // 8.6 LOSS - Falha pós outbox_save
    it('LOSS: deve reverter integralmente quando a falha ocorre pós-outbox_save e permitir reenvio único', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const key = `idemp-fail-loss-out-${crypto.randomUUID()}`;
      const extId = `ext-fail-loss-out-${crypto.randomUUID()}`;

      try {
        uow.setTestFailurePoint('after_outbox_save', () => {
          throw new Error('Falha simulada pós-outbox_save na LOSS');
        });

        const httpRes = await fetch(`${serverUrl}/wagering/transactions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'idempotency-key': key },
          body: JSON.stringify({
            providerId: 'provider_m06',
            externalTransactionId: extId,
            playerId,
            walletId: wallet.id,
            roundId: 'round_fl2',
            gameId: 'slot_fl',
            kind: 'LOSS',
            money: { amount: '10.00', currency: 'BRL' },
          }),
        });
        expect(httpRes.status).toBe(500);
      } finally {
        uow.clearTestHooks();
      }

      uow.getEntityManager().clear();

      const txCount = await adminPool.query('SELECT count(*) FROM wager_transactions WHERE idempotency_key = $1', [key]);
      expect(Number(txCount.rows[0].count)).toBe(0);

      // Reenvio bem-sucedido
      const retryRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: extId,
          playerId,
          walletId: wallet.id,
          roundId: 'round_fl2',
          gameId: 'slot_fl',
          kind: 'LOSS',
          money: { amount: '10.00', currency: 'BRL' },
        }),
      });
      expect(retryRes.status).toBe(200);

      const txCountAfter = await adminPool.query('SELECT count(*) FROM wager_transactions WHERE idempotency_key = $1', [key]);
      expect(Number(txCountAfter.rows[0].count)).toBe(1);
    });
  });

  // =========================================================================
  // 9. REFERÊNCIA OPCIONAL DE WIN
  // =========================================================================
  describe('9. Referência Opcional de WIN: Validação de BET, Compatibilidade e Rejeição Auditável', () => {
    it('9.1: WIN com referência válida a uma BET processada é executada com sucesso e persiste o vínculo', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      // 1. Criar e processar a BET da rodada
      const betExtId = `ext-bet-ref-${crypto.randomUUID()}`;
      const betRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': `key-bet-${crypto.randomUUID()}` },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: betExtId,
          playerId,
          walletId: wallet.id,
          roundId: 'round_with_ref_1',
          gameId: 'slot_ref',
          kind: 'BET',
          money: { amount: '20.00', currency: 'BRL' },
        }),
      });
      expect(betRes.status).toBe(200);

      // 2. Submeter WIN informando referenceExternalTransactionId apontando para a BET
      const winExtId = `ext-win-ref-${crypto.randomUUID()}`;
      const winRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': `key-win-${crypto.randomUUID()}` },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: winExtId,
          playerId,
          walletId: wallet.id,
          roundId: 'round_with_ref_1',
          gameId: 'slot_ref',
          kind: 'WIN',
          money: { amount: '80.00', currency: 'BRL' },
          referenceExternalTransactionId: betExtId,
        }),
      });

      expect(winRes.status).toBe(200);
      const winData = (await winRes.json()) as any;
      expect(winData.status).toBe('PROCESSED');
      expect(winData.balance.amount).toBe('160.00'); // 100 - 20 (BET) + 80 (WIN) = 160.00

      uow.getEntityManager().clear();

      // Prova PostgreSQL: reference_external_transaction_id persistido no banco
      const winTx = (await adminPool.query('SELECT * FROM wager_transactions WHERE id = $1', [winData.transactionId])).rows[0];
      expect(winTx.reference_external_transaction_id).toBe(betExtId);

      // Prova PostgreSQL: Evento na outbox contém referenceExternalTransactionId
      const outboxEvents = await findOutboxEventsForTransaction(winData.transactionId);
      const processedEvent = outboxEvents.find((e) => e.event_type === 'WagerTransactionProcessed')!;
      expect(processedEvent.payload.referenceExternalTransactionId).toBe(betExtId);

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('160.00');
    });

    it('9.2: WIN com referência a BET ausente ou ainda não processada gera PENDING_REFERENCE (202 Accepted) e outbox de pendência', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const missingBetExtId = `missing-bet-${crypto.randomUUID()}`;
      const winRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': `key-win-missing-${crypto.randomUUID()}` },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: `ext-win-missing-${crypto.randomUUID()}`,
          playerId,
          walletId: wallet.id,
          roundId: 'round_missing',
          gameId: 'slot_ref',
          kind: 'WIN',
          money: { amount: '50.00', currency: 'BRL' },
          referenceExternalTransactionId: missingBetExtId,
        }),
      });

      expect(winRes.status).toBe(202);
      const winData = (await winRes.json()) as any;
      expect(winData.status).toBe('PENDING_REFERENCE');
      expect(winData.balance.amount).toBe('100.00');

      uow.getEntityManager().clear();

      // Saldo da carteira não foi alterado e versão permanece 1
      const walletRow = (await adminPool.query('SELECT * FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      expect(walletRow.balance).toBe('100.00');
      expect(Number(walletRow.version)).toBe(1);

      // Transação persistida em status PENDING_REFERENCE com snapshot
      const pendingTx = (await adminPool.query('SELECT * FROM wager_transactions WHERE id = $1', [winData.transactionId])).rows[0];
      expect(pendingTx.status).toBe('PENDING_REFERENCE');
      expect(pendingTx.reference_external_transaction_id).toBe(missingBetExtId);
      expect(pendingTx.attempts).toBe(1);
      expect(pendingTx.next_attempt_at).toBeDefined();

      // Zero ledger entries para a pendência
      const ledgerCount = await adminPool.query('SELECT count(*) FROM wallet_ledger_entries WHERE transaction_id = $1', [winData.transactionId]);
      expect(Number(ledgerCount.rows[0].count)).toBe(0);

      // Outbox emite WagerTransactionPendingReference
      const outboxEvents = await findOutboxEventsForTransaction(winData.transactionId);
      expect(outboxEvents.length).toBe(1);
      expect(outboxEvents[0].event_type).toBe('WagerTransactionPendingReference');
      expect(outboxEvents[0].payload.referenceExternalTransactionId).toBe(missingBetExtId);
      expect(outboxEvents[0].payload.kind).toBe('WIN');
    });

    it('9.3: WIN com referência a BET de outra rodada ou outra carteira é rejeitada com 422 e REFERENCE_INCOMPATIBLE', async () => {
      const player1 = crypto.randomUUID();
      const player2 = crypto.randomUUID();
      const wallet1 = await createWalletUseCase.execute({ playerId: player1, initialBalance: { amount: '100.00', currency: 'BRL' } });
      const wallet2 = await createWalletUseCase.execute({ playerId: player2, initialBalance: { amount: '100.00', currency: 'BRL' } });

      // BET processada na Wallet 1
      const betExtIdWallet1 = `ext-bet-w1-${crypto.randomUUID()}`;
      await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': `key-bet-w1-${crypto.randomUUID()}` },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: betExtIdWallet1,
          playerId: player1,
          walletId: wallet1.id,
          roundId: 'round_compat_1',
          gameId: 'slot_ref',
          kind: 'BET',
          money: { amount: '20.00', currency: 'BRL' },
        }),
      });

      // Tentativa de WIN na Wallet 2 referenciando a BET da Wallet 1
      const winRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': `key-win-cross-${crypto.randomUUID()}` },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: `ext-win-cross-${crypto.randomUUID()}`,
          playerId: player2,
          walletId: wallet2.id,
          roundId: 'round_compat_1',
          gameId: 'slot_ref',
          kind: 'WIN',
          money: { amount: '50.00', currency: 'BRL' },
          referenceExternalTransactionId: betExtIdWallet1,
        }),
      });

      expect(winRes.status).toBe(422);
      const winData = (await winRes.json()) as any;
      expect(winData.status).toBe('REJECTED');
      expect(winData.failureCode).toBe('REFERENCE_INCOMPATIBLE');

      uow.getEntityManager().clear();

      const wallet2Row = (await adminPool.query('SELECT * FROM wallets WHERE id = $1', [wallet2.id])).rows[0];
      expect(wallet2Row.balance).toBe('100.00');
    });

    it('9.4: WIN com referência a transação que não é BET (ex: referenciando uma WIN anterior) é rejeitada com 422 e REFERENCE_INCOMPATIBLE', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      // Primeira WIN (independente)
      const firstWinExtId = `ext-first-win-${crypto.randomUUID()}`;
      await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': `key-win1-${crypto.randomUUID()}` },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: firstWinExtId,
          playerId,
          walletId: wallet.id,
          roundId: 'round_not_bet',
          gameId: 'slot_ref',
          kind: 'WIN',
          money: { amount: '30.00', currency: 'BRL' },
        }),
      });

      // Segunda WIN referenciando a primeira WIN em vez de uma BET
      const secondWinRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': `key-win2-${crypto.randomUUID()}` },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: `ext-second-win-${crypto.randomUUID()}`,
          playerId,
          walletId: wallet.id,
          roundId: 'round_not_bet',
          gameId: 'slot_ref',
          kind: 'WIN',
          money: { amount: '20.00', currency: 'BRL' },
          referenceExternalTransactionId: firstWinExtId,
        }),
      });

      expect(secondWinRes.status).toBe(422);
      const winData = (await secondWinRes.json()) as any;
      expect(winData.status).toBe('REJECTED');
      expect(winData.failureCode).toBe('REFERENCE_INCOMPATIBLE');
    });

    it('9.5: WIN com referência a BET que foi REJECTED é rejeitada com 422 e REFERENCE_NOT_PROCESSED', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '10.00', currency: 'BRL' },
      });

      // BET rejeitada por saldo insuficiente (saldo 10.00, tentativa 50.00)
      const rejBetExtId = `ext-rej-bet-${crypto.randomUUID()}`;
      const betRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': `key-rej-bet-${crypto.randomUUID()}` },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: rejBetExtId,
          playerId,
          walletId: wallet.id,
          roundId: 'round_rej',
          gameId: 'slot_ref',
          kind: 'BET',
          money: { amount: '50.00', currency: 'BRL' },
        }),
      });
      expect(betRes.status).toBe(422);

      // WIN referenciando a BET rejeitada
      const winRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': `key-win-on-rej-${crypto.randomUUID()}` },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: `ext-win-on-rej-${crypto.randomUUID()}`,
          playerId,
          walletId: wallet.id,
          roundId: 'round_rej',
          gameId: 'slot_ref',
          kind: 'WIN',
          money: { amount: '25.00', currency: 'BRL' },
          referenceExternalTransactionId: rejBetExtId,
        }),
      });

      expect(winRes.status).toBe(422);
      const winData = (await winRes.json()) as any;
      expect(winData.status).toBe('REJECTED');
      expect(winData.failureCode).toBe('REFERENCE_NOT_PROCESSED');
    });
  });

  // =========================================================================
  // 10. WIN COM REFERÊNCIA FORA DE ORDEM, MÚLTIPLAS WINS NA MESMA BET E RESOLUÇÃO
  // =========================================================================
  describe('10. WIN com Referência Fora de Ordem, Múltiplas WINs na Mesma BET e Resolução', () => {
    it('10.1: WIN chega antes da BET → PENDING_REFERENCE (202); BET chega; execução manual resolve com um crédito', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const betExtId = `bet-ooo-10-1-${crypto.randomUUID()}`;
      const winExtId = `win-ooo-10-1-${crypto.randomUUID()}`;
      const winKey = `key-win-ooo-10-1-${crypto.randomUUID()}`;

      // 1. WIN chega antes da BET existir -> PENDING_REFERENCE (HTTP 202)
      const winRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': winKey },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: winExtId,
          playerId,
          walletId: wallet.id,
          roundId: 'round_ooo_10_1',
          gameId: 'slot_ref',
          kind: 'WIN',
          money: { amount: '45.00', currency: 'BRL' },
          referenceExternalTransactionId: betExtId,
        }),
      });
      expect(winRes.status).toBe(202);
      const winData = (await winRes.json()) as any;
      expect(winData.status).toBe('PENDING_REFERENCE');
      expect(winData.balance.amount).toBe('100.00');

      // Carteira intacta
      const midWallet = await getWalletUseCase.execute(wallet.id);
      expect(midWallet.balance.amount).toBe('100.00');
      expect(midWallet.version).toBe(1);

      // 2. BET chega e é processada com sucesso
      const betRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': `key-bet-ooo-10-1-${crypto.randomUUID()}` },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: betExtId,
          playerId,
          walletId: wallet.id,
          roundId: 'round_ooo_10_1',
          gameId: 'slot_ref',
          kind: 'BET',
          money: { amount: '20.00', currency: 'BRL' },
        }),
      });
      expect(betRes.status).toBe(200);

      // Saldo após BET: 100 - 20 = 80.00, version = 2
      const walletAfterBet = await getWalletUseCase.execute(wallet.id);
      expect(walletAfterBet.balance.amount).toBe('80.00');
      expect(walletAfterBet.version).toBe(2);

      // 3. Execução manual do reprocessador
      await makePendingEligible(winData.transactionId);
      const reprocessResult = await reprocessWorker.execute(10);
      expect(reprocessResult.processed).toBe(1);

      uow.getEntityManager().clear();

      // Transação agora é PROCESSED
      const updatedWinTx = (await adminPool.query('SELECT * FROM wager_transactions WHERE id = $1', [winData.transactionId])).rows[0];
      expect(updatedWinTx.status).toBe('PROCESSED');

      // Carteira creditada exatamente uma vez: 80.00 + 45.00 = 125.00, version = 3
      const finalWallet = await getWalletUseCase.execute(wallet.id);
      expect(finalWallet.balance.amount).toBe('125.00');
      expect(finalWallet.version).toBe(3);

      // Reconciliação perfeita
      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('125.00');

      // Replay terminal após resolução preserva resultado histórico
      const replayRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': winKey },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: winExtId,
          playerId,
          walletId: wallet.id,
          roundId: 'round_ooo_10_1',
          gameId: 'slot_ref',
          kind: 'WIN',
          money: { amount: '45.00', currency: 'BRL' },
          referenceExternalTransactionId: betExtId,
        }),
      });
      expect(replayRes.status).toBe(200);
      const replayData = (await replayRes.json()) as any;
      expect(replayData.status).toBe('PROCESSED');
      expect(replayData.idempotentReplay).toBe(true);
      expect(replayData.balance.amount).toBe('125.00');
    });

    it('10.2: Referência incompatível (BET em outra carteira/player) → reprocessador rejeita sem crédito', async () => {
      const player1 = crypto.randomUUID();
      const player2 = crypto.randomUUID();
      const wallet1 = await createWalletUseCase.execute({ playerId: player1, initialBalance: { amount: '100.00', currency: 'BRL' } });
      const wallet2 = await createWalletUseCase.execute({ playerId: player2, initialBalance: { amount: '100.00', currency: 'BRL' } });

      const betExtId = `bet-cross-10-2-${crypto.randomUUID()}`;
      const winExtId = `win-cross-10-2-${crypto.randomUUID()}`;

      // WIN chega na Wallet 2 apontando para betExtId ainda inexistente -> 202 PENDING_REFERENCE
      const winRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': `key-win-cross-10-2-${crypto.randomUUID()}` },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: winExtId,
          playerId: player2,
          walletId: wallet2.id,
          roundId: 'round_cross_10_2',
          gameId: 'slot_ref',
          kind: 'WIN',
          money: { amount: '30.00', currency: 'BRL' },
          referenceExternalTransactionId: betExtId,
        }),
      });
      expect(winRes.status).toBe(202);
      const winData = (await winRes.json()) as any;
      expect(winData.status).toBe('PENDING_REFERENCE');

      // A BET chega na Wallet 1 (player 1) e é processada
      await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': `key-bet-cross-10-2-${crypto.randomUUID()}` },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: betExtId,
          playerId: player1,
          walletId: wallet1.id,
          roundId: 'round_cross_10_2',
          gameId: 'slot_ref',
          kind: 'BET',
          money: { amount: '20.00', currency: 'BRL' },
        }),
      });

      // Execução manual do reprocessador
      await makePendingEligible(winData.transactionId);
      const reprocessResult = await reprocessWorker.execute(10);
      expect(reprocessResult.rejected).toBe(1);

      uow.getEntityManager().clear();

      // Transação na Wallet 2 rejeitada por incompatibilidade
      const rejectedTx = (await adminPool.query('SELECT * FROM wager_transactions WHERE id = $1', [winData.transactionId])).rows[0];
      expect(rejectedTx.status).toBe('REJECTED');
      expect(rejectedTx.rejection_reason).toBe('REFERENCE_INCOMPATIBLE');

      // Saldo da Wallet 2 intacto
      const finalWallet2 = await getWalletUseCase.execute(wallet2.id);
      expect(finalWallet2.balance.amount).toBe('100.00');
      expect(finalWallet2.version).toBe(1);

      // Zero lançamentos no ledger para a WIN rejeitada
      const ledgerRows = (await adminPool.query('SELECT * FROM wallet_ledger_entries WHERE transaction_id = $1', [winData.transactionId])).rows;
      expect(ledgerRows.length).toBe(0);

      // Reconciliação perfeita
      const recon = await reconcileWalletUseCase.execute(wallet2.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('100.00');
    });

    it('10.3: Referência rejeitada (BET REJECTED por saldo insuficiente) → reprocessador rejeita sem crédito', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '10.00', currency: 'BRL' },
      });

      const betExtId = `bet-rej-10-3-${crypto.randomUUID()}`;
      const winExtId = `win-rej-10-3-${crypto.randomUUID()}`;

      // WIN chega pendente referenciando a BET futura
      const winRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': `key-win-rej-10-3-${crypto.randomUUID()}` },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: winExtId,
          playerId,
          walletId: wallet.id,
          roundId: 'round_rej_10_3',
          gameId: 'slot_ref',
          kind: 'WIN',
          money: { amount: '30.00', currency: 'BRL' },
          referenceExternalTransactionId: betExtId,
        }),
      });
      expect(winRes.status).toBe(202);
      const winData = (await winRes.json()) as any;

      // BET chega depois e é rejeitada por saldo insuficiente (10.00 disponível vs 50.00 solicitados)
      const betRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': `key-bet-rej-10-3-${crypto.randomUUID()}` },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: betExtId,
          playerId,
          walletId: wallet.id,
          roundId: 'round_rej_10_3',
          gameId: 'slot_ref',
          kind: 'BET',
          money: { amount: '50.00', currency: 'BRL' },
        }),
      });
      expect(betRes.status).toBe(422);

      // Execução manual do reprocessador
      await makePendingEligible(winData.transactionId);
      const reprocessResult = await reprocessWorker.execute(10);
      expect(reprocessResult.rejected).toBe(1);

      uow.getEntityManager().clear();

      // Transação WIN rejeitada com REFERENCE_NOT_PROCESSED
      const rejectedTx = (await adminPool.query('SELECT * FROM wager_transactions WHERE id = $1', [winData.transactionId])).rows[0];
      expect(rejectedTx.status).toBe('REJECTED');
      expect(rejectedTx.rejection_reason).toBe('REFERENCE_NOT_PROCESSED');

      // Saldo inalterado
      const finalWallet = await getWalletUseCase.execute(wallet.id);
      expect(finalWallet.balance.amount).toBe('10.00');
      expect(finalWallet.version).toBe(1);
    });

    it('10.4: Duas WIN distintas vinculadas à mesma BET sequencialmente → ambas processam, créditos exatos, version, ledger, outbox e replay', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      // 1. Processar BET de 20.00 (saldo 80.00, version = 2)
      const betExtId = `bet-multi-seq-${crypto.randomUUID()}`;
      await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': `key-bet-seq-${crypto.randomUUID()}` },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: betExtId,
          playerId,
          walletId: wallet.id,
          roundId: 'round_multi_seq',
          gameId: 'slot_ref',
          kind: 'BET',
          money: { amount: '20.00', currency: 'BRL' },
        }),
      });

      // 2. Primeira WIN vinculada à BET: ganho de 30.00
      const win1ExtId = `win1-multi-seq-${crypto.randomUUID()}`;
      const win1Key = `key-win1-seq-${crypto.randomUUID()}`;
      const win1Res = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': win1Key },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: win1ExtId,
          playerId,
          walletId: wallet.id,
          roundId: 'round_multi_seq',
          gameId: 'slot_ref',
          kind: 'WIN',
          money: { amount: '30.00', currency: 'BRL' },
          referenceExternalTransactionId: betExtId,
        }),
      });
      expect(win1Res.status).toBe(200);
      const win1Data = (await win1Res.json()) as any;
      expect(win1Data.status).toBe('PROCESSED');
      expect(win1Data.balance.amount).toBe('110.00'); // 80 + 30 = 110.00

      // 3. Segunda WIN distinta vinculada à mesma BET: ganho de 40.00 (permitido pela Migration 004!)
      const win2ExtId = `win2-multi-seq-${crypto.randomUUID()}`;
      const win2Key = `key-win2-seq-${crypto.randomUUID()}`;
      const win2Res = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': win2Key },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: win2ExtId,
          playerId,
          walletId: wallet.id,
          roundId: 'round_multi_seq',
          gameId: 'slot_ref',
          kind: 'WIN',
          money: { amount: '40.00', currency: 'BRL' },
          referenceExternalTransactionId: betExtId,
        }),
      });
      expect(win2Res.status).toBe(200);
      const win2Data = (await win2Res.json()) as any;
      expect(win2Data.status).toBe('PROCESSED');
      expect(win2Data.balance.amount).toBe('150.00'); // 110 + 40 = 150.00

      uow.getEntityManager().clear();

      // Prova PostgreSQL: Saldo 150.00, Versão 4 (1 opening + 1 bet + 1 win1 + 1 win2)
      const walletRow = (await adminPool.query('SELECT * FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      expect(walletRow.balance).toBe('150.00');
      expect(Number(walletRow.version)).toBe(4);

      // Ambas as transações persistidas como PROCESSED apontando para a mesma BET
      const winRows = (await adminPool.query("SELECT * FROM wager_transactions WHERE reference_external_transaction_id = $1 AND kind = 'WIN'", [betExtId])).rows;
      expect(winRows.length).toBe(2);
      expect(winRows.every((r: any) => r.status === 'PROCESSED')).toBe(true);

      // Ledger: 4 lançamentos (1 opening CREDIT, 1 bet DEBIT, 2 win CREDIT)
      const ledgerRows = (await adminPool.query('SELECT * FROM wallet_ledger_entries WHERE wallet_id = $1', [wallet.id])).rows;
      expect(ledgerRows.length).toBe(4);

      // Outbox: eventos emitidos para ambas as WINs
      const outbox1 = await findOutboxEventsForTransaction(win1Data.transactionId);
      expect(outbox1.some((e) => e.event_type === 'WagerTransactionProcessed')).toBe(true);
      expect(outbox1.some((e) => e.event_type === 'WalletBalanceChanged')).toBe(true);

      const outbox2 = await findOutboxEventsForTransaction(win2Data.transactionId);
      expect(outbox2.some((e) => e.event_type === 'WagerTransactionProcessed')).toBe(true);
      expect(outbox2.some((e) => e.event_type === 'WalletBalanceChanged')).toBe(true);

      // Reconciliação perfeita
      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('150.00');

      // Replays individuais continuam idempotentes
      const replayWin1 = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': win1Key },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: win1ExtId,
          playerId,
          walletId: wallet.id,
          roundId: 'round_multi_seq',
          gameId: 'slot_ref',
          kind: 'WIN',
          money: { amount: '30.00', currency: 'BRL' },
          referenceExternalTransactionId: betExtId,
        }),
      });
      expect(replayWin1.status).toBe(200);
      const replayWin1Data = (await replayWin1.json()) as any;
      expect(replayWin1Data.idempotentReplay).toBe(true);
      expect(replayWin1Data.balance.amount).toBe('110.00'); // Snapshot histórico preservado!

      const replayWin2 = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': win2Key },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: win2ExtId,
          playerId,
          walletId: wallet.id,
          roundId: 'round_multi_seq',
          gameId: 'slot_ref',
          kind: 'WIN',
          money: { amount: '40.00', currency: 'BRL' },
          referenceExternalTransactionId: betExtId,
        }),
      });
      expect(replayWin2.status).toBe(200);
      const replayWin2Data = (await replayWin2.json()) as any;
      expect(replayWin2Data.idempotentReplay).toBe(true);
      expect(replayWin2Data.balance.amount).toBe('150.00');
    });

    it('10.5: Duas WIN distintas vinculadas à mesma BET concorrentemente → ambas processam, créditos exatos sem lost update', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      // BET de 10.00 (saldo 90.00, version = 2)
      const betExtId = `bet-multi-con-${crypto.randomUUID()}`;
      await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': `key-bet-con-${crypto.randomUUID()}` },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: betExtId,
          playerId,
          walletId: wallet.id,
          roundId: 'round_multi_con',
          gameId: 'slot_ref',
          kind: 'BET',
          money: { amount: '10.00', currency: 'BRL' },
        }),
      });

      // Disparo concorrente de duas WINs distintas apontando para a mesma BET
      const win1ExtId = `win1-con-${crypto.randomUUID()}`;
      const win2ExtId = `win2-con-${crypto.randomUUID()}`;

      const [res1, res2] = await Promise.all([
        fetch(`${serverUrl}/wagering/transactions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'idempotency-key': `key-win1-con-${crypto.randomUUID()}` },
          body: JSON.stringify({
            providerId: 'provider_m06',
            externalTransactionId: win1ExtId,
            playerId,
            walletId: wallet.id,
            roundId: 'round_multi_con',
            gameId: 'slot_ref',
            kind: 'WIN',
            money: { amount: '25.00', currency: 'BRL' },
            referenceExternalTransactionId: betExtId,
          }),
        }),
        fetch(`${serverUrl}/wagering/transactions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'idempotency-key': `key-win2-con-${crypto.randomUUID()}` },
          body: JSON.stringify({
            providerId: 'provider_m06',
            externalTransactionId: win2ExtId,
            playerId,
            walletId: wallet.id,
            roundId: 'round_multi_con',
            gameId: 'slot_ref',
            kind: 'WIN',
            money: { amount: '35.00', currency: 'BRL' },
            referenceExternalTransactionId: betExtId,
          }),
        }),
      ]);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      uow.getEntityManager().clear();

      // Saldo final: 90.00 + 25.00 + 35.00 = 150.00, version = 4
      const walletRow = (await adminPool.query('SELECT * FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      expect(walletRow.balance).toBe('150.00');
      expect(Number(walletRow.version)).toBe(4);

      // Reconciliação
      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('150.00');
    });

    it('10.6: Duas WINs pendentes para a mesma BET → ambas chegam antes da BET e ambas resolvem uma única vez', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const betExtId = `bet-2ooo-${crypto.randomUUID()}`;
      const win1ExtId = `win1-2ooo-${crypto.randomUUID()}`;
      const win2ExtId = `win2-2ooo-${crypto.randomUUID()}`;
      const win1Key = `key-win1-2ooo-${crypto.randomUUID()}`;
      const win2Key = `key-win2-2ooo-${crypto.randomUUID()}`;

      // 1. Submeter WIN 1 antes da BET -> 202 PENDING_REFERENCE
      const win1Res = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': win1Key },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: win1ExtId,
          playerId,
          walletId: wallet.id,
          roundId: 'round_2ooo',
          gameId: 'slot_ref',
          kind: 'WIN',
          money: { amount: '30.00', currency: 'BRL' },
          referenceExternalTransactionId: betExtId,
        }),
      });
      expect(win1Res.status).toBe(202);
      const win1Data = (await win1Res.json()) as any;

      // 2. Submeter WIN 2 antes da BET -> 202 PENDING_REFERENCE
      const win2Res = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': win2Key },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: win2ExtId,
          playerId,
          walletId: wallet.id,
          roundId: 'round_2ooo',
          gameId: 'slot_ref',
          kind: 'WIN',
          money: { amount: '20.00', currency: 'BRL' },
          referenceExternalTransactionId: betExtId,
        }),
      });
      expect(win2Res.status).toBe(202);
      const win2Data = (await win2Res.json()) as any;

      // 3. Submeter BET de 15.00
      await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': `key-bet-2ooo-${crypto.randomUUID()}` },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: betExtId,
          playerId,
          walletId: wallet.id,
          roundId: 'round_2ooo',
          gameId: 'slot_ref',
          kind: 'BET',
          money: { amount: '15.00', currency: 'BRL' },
        }),
      });

      // 4. Executar reprocessador para ambas as pendências
      await makePendingEligible(win1Data.transactionId);
      await makePendingEligible(win2Data.transactionId);

      const reprocessResult = await reprocessWorker.execute(10);
      expect(reprocessResult.processed).toBe(2);

      uow.getEntityManager().clear();

      // Saldo final: 100 - 15 + 30 + 20 = 135.00, version = 4
      const finalWallet = await getWalletUseCase.execute(wallet.id);
      expect(finalWallet.balance.amount).toBe('135.00');
      expect(finalWallet.version).toBe(4);

      // Reconciliação
      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('135.00');

      // Replays de ambas preservam resultados históricos
      const rep1 = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': win1Key },
        body: JSON.stringify({
          providerId: 'provider_m06',
          externalTransactionId: win1ExtId,
          playerId,
          walletId: wallet.id,
          roundId: 'round_2ooo',
          gameId: 'slot_ref',
          kind: 'WIN',
          money: { amount: '30.00', currency: 'BRL' },
          referenceExternalTransactionId: betExtId,
        }),
      });
      expect(rep1.status).toBe(200);
      const rep1Data = (await rep1.json()) as any;
      expect(rep1Data.idempotentReplay).toBe(true);
      expect(rep1Data.status).toBe('PROCESSED');
    });
  });

  // =========================================================================
  // 11. VALIDAÇÃO DA MIGRATION 004 UP/DOWN/UP E RECUSA SEGURA EM BANCO DESCARTÁVEL
  // =========================================================================
  describe('11. Validação da Migration 004 Up/Down/Up e Recusa Segura em Banco Descartável', () => {
    it('deve executar up/down/up com sucesso e recusar down com segurança quando existem dados incompatíveis', async () => {
      // 1. Criar banco isolado dedicado exclusivamente para testes de migration
      const migDb = await createIsolatedTestDatabase('mig004_test_');
      const migPool = new pg.Pool(migDb.adminConfig);
      const migrator = new DatabaseMigrator(migDb.adminConfig);

      try {
        // O banco recém-criado já aplicou as migrações up (001, 002, 003, 004)
        const check004 = await migPool.query<{ version: string }>(
          "SELECT version FROM schema_migrations WHERE version = '004_restrict_reversal_unique_index';"
        );
        expect(check004.rows.length).toBe(1);

        // 2. Testar down da 004 (reverte para 003 sem dados conflitantes)
        const revertedVersion = await migrator.down();
        expect(revertedVersion).toBe('004_restrict_reversal_unique_index');

        const checkAfterDown = await migPool.query<{ version: string }>(
          "SELECT version FROM schema_migrations WHERE version = '004_restrict_reversal_unique_index';"
        );
        expect(checkAfterDown.rows.length).toBe(0);

        // 3. Testar up novamente (reaplica 004 com sucesso)
        const reapplied = await migrator.up();
        expect(reapplied).toContain('004_restrict_reversal_unique_index');

        // 4. Inserir duas transações WIN PROCESSED com o mesmo provider_id e reference_external_transaction_id
        // Primeiro cria uma wallet fictícia
        const dummyWalletId = crypto.randomUUID();
        const dummyPlayerId = crypto.randomUUID();
        await migPool.query(
          `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
           VALUES ($1, $2, 'BRL', '100.00', 1, NOW(), NOW());`,
          [dummyWalletId, dummyPlayerId]
        );

        const refExtId = `bet-for-mig-test-${crypto.randomUUID()}`;
        const tx1Id = crypto.randomUUID();
        const tx2Id = crypto.randomUUID();

        // Primeira WIN
        await migPool.query(
          `INSERT INTO wager_transactions (
             id, wallet_id, player_id, provider_id, external_transaction_id,
             round_id, game_id, kind, amount, currency, status, idempotency_key, payload_hash,
             reference_external_transaction_id, response_snapshot, created_at, updated_at
           ) VALUES (
             $1, $2, $3, 'prv-mig', 'ext-mig-win-1',
             'rnd-mig', 'gm-mig', 'WIN', '10.00', 'BRL', 'PROCESSED', 'key-mig-1', 'hash-1',
             $4, '{}'::jsonb, NOW(), NOW()
           );`,
          [tx1Id, dummyWalletId, dummyPlayerId, refExtId]
        );

        // Segunda WIN com o MESMO reference_external_transaction_id (válido na 004)
        await migPool.query(
          `INSERT INTO wager_transactions (
             id, wallet_id, player_id, provider_id, external_transaction_id,
             round_id, game_id, kind, amount, currency, status, idempotency_key, payload_hash,
             reference_external_transaction_id, response_snapshot, created_at, updated_at
           ) VALUES (
             $1, $2, $3, 'prv-mig', 'ext-mig-win-2',
             'rnd-mig', 'gm-mig', 'WIN', '20.00', 'BRL', 'PROCESSED', 'key-mig-2', 'hash-2',
             $4, '{}'::jsonb, NOW(), NOW()
           );`,
          [tx2Id, dummyWalletId, dummyPlayerId, refExtId]
        );

        // 5. Tentar executar o DOWN da 004
        // A recusa segura deve disparar a exceção customizada (ERRCODE 23505)
        let downFailed = false;
        try {
          await migrator.down();
        } catch (err: any) {
          downFailed = true;
          expect(err.message).toContain('Cannot revert migration 004');
        }
        expect(downFailed).toBe(true);

        // 6. Confirmar que a migração 004 permaneceu intacta e nenhum registro foi apagado
        const remainingTxs = await migPool.query(
          'SELECT id FROM wager_transactions WHERE id IN ($1, $2);',
          [tx1Id, tx2Id]
        );
        expect(remainingTxs.rows.length).toBe(2);

        const checkStill004 = await migPool.query<{ version: string }>(
          "SELECT version FROM schema_migrations WHERE version = '004_restrict_reversal_unique_index';"
        );
        expect(checkStill004.rows.length).toBe(1);
      } finally {
        await migrator.close();
        await migPool.end();
        await migDb.closeAndDrop();
      }
    }, 30000);
  });
});
