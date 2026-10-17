import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
import { ProcessBetUseCase } from '../../src/application/use-cases/process-bet.use-case';
import { ReconcileWalletUseCase } from '../../src/application/use-cases/reconcile-wallet.use-case';
import { ProcessBetDto, ProcessWagerDto } from '../../src/application/dto/wager.dto';
import {
  CurrencyMismatchError,
  IdempotencyConflictError,
  InvalidWagerOperationError,
  WalletNotFoundError,
} from '../../src/domain/errors/domain.error';
import { createIsolatedTestDatabase, IsolatedTestDatabase } from '../test-db-helper';

describe('M04: BET e Replay Terminal — Testes HTTP e PostgreSQL Real em Banco Descartável', () => {
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
  let processBetUseCase: ProcessBetUseCase;
  let reconcileWalletUseCase: ReconcileWalletUseCase;

  beforeAll(async () => {
    // 1. Criar banco de dados PostgreSQL isolado e descartável
    isolatedDb = await createIsolatedTestDatabase('bet_replay_');

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
    processBetUseCase = new ProcessBetUseCase(walletRepo, wagerRepo, ledgerRepo, outboxRepo, uow);
    reconcileWalletUseCase = app.get(ReconcileWalletUseCase);
  });

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
  });

  describe('1. BET Válida: Saldo 100.00, BET 25.00 -> Saldo 75.00, Versão Incrementada, um DEBIT e Eventos Corretos', () => {
    it('deve debitar exatamente uma vez, persistir PROCESSED, registrar 1 DEBIT e emitir eventos de outbox', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const idempotencyKey = `idemp-bet-valid-${crypto.randomUUID()}`;
      const extTxId = `ext-bet-valid-${crypto.randomUUID()}`;
      const payload: ProcessBetDto = {
        providerId: 'provider-test',
        externalTransactionId: extTxId,
        playerId,
        walletId: wallet.id,
        roundId: 'round-101',
        gameId: 'game-slot',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      };

      // Executar via HTTP POST /wagering/transactions
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
      expect(resData.balance).toEqual({ amount: '75.00', currency: 'BRL' });
      expect(resData.idempotentReplay).toBe(false);
      expect(typeof resData.transactionId).toBe('string');

      uow.getEntityManager().clear();

      // Conferir saldo e version da carteira no PostgreSQL
      const walletRow = (await adminPool.query('SELECT * FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      expect(walletRow.balance).toBe('75.00');
      expect(Number(walletRow.version)).toBe(2);

      // Conferir transações: diferenciar OPENING de BET
      const txRows = (
        await adminPool.query(
          'SELECT * FROM wager_transactions WHERE wallet_id = $1 ORDER BY created_at ASC',
          [wallet.id]
        )
      ).rows;
      expect(txRows.length).toBe(2);

      const openingTx = txRows.find((t) => t.kind === 'OPENING')!;
      expect(openingTx).toBeDefined();
      expect(openingTx.provider_id).toBe('SYSTEM');
      expect(openingTx.amount).toBe('100.00');

      const betTx = txRows.find((t) => t.kind === 'BET')!;
      expect(betTx).toBeDefined();
      expect(betTx.id).toBe(resData.transactionId);
      expect(betTx.provider_id).toBe('provider-test');
      expect(betTx.external_transaction_id).toBe(extTxId);
      expect(betTx.idempotency_key).toBe(idempotencyKey);
      expect(betTx.status).toBe('PROCESSED');
      expect(betTx.amount).toBe('25.00');
      expect(betTx.currency).toBe('BRL');

      // Conferir ledger: exatamente 1 CREDIT (OPENING) e 1 DEBIT (BET)
      const ledgerRows = (
        await adminPool.query(
          'SELECT * FROM wallet_ledger_entries WHERE wallet_id = $1 ORDER BY created_at ASC, id ASC',
          [wallet.id]
        )
      ).rows;
      expect(ledgerRows.length).toBe(2);

      const openingLedger = ledgerRows.find((l) => l.entry_type === 'CREDIT')!;
      expect(openingLedger).toBeDefined();
      expect(openingLedger.transaction_id).toBe(openingTx.id);
      expect(openingLedger.amount).toBe('100.00');

      const betLedger = ledgerRows.find((l) => l.entry_type === 'DEBIT')!;
      expect(betLedger).toBeDefined();
      expect(betLedger.transaction_id).toBe(betTx.id);
      expect(betLedger.amount).toBe('25.00');
      expect(betLedger.balance_before).toBe('100.00');
      expect(betLedger.balance_after).toBe('75.00');

      // Conferir outbox: 2 eventos de abertura + 2 eventos da BET
      const outboxRows = (
        await adminPool.query(
          'SELECT * FROM outbox_messages WHERE aggregate_id = $1 ORDER BY created_at ASC',
          [wallet.id]
        )
      ).rows;
      expect(outboxRows.length).toBe(4);

      const betProcessedEvent = outboxRows.find(
        (o) => o.event_type === 'WagerTransactionProcessed' && o.payload.kind === 'BET'
      )!;
      expect(betProcessedEvent).toBeDefined();
      expect(betProcessedEvent.payload.transactionId).toBe(betTx.id);
      expect(betProcessedEvent.payload.amount).toEqual({ amount: '25.00', currency: 'BRL' });
      expect(betProcessedEvent.payload.balance).toEqual({ amount: '75.00', currency: 'BRL' });

      const betBalanceChangedEvent = outboxRows.find(
        (o) => o.event_type === 'WalletBalanceChanged' && o.payload.triggerTransactionId === betTx.id
      )!;
      expect(betBalanceChangedEvent).toBeDefined();
      expect(betBalanceChangedEvent.payload.previousBalance).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(betBalanceChangedEvent.payload.currentBalance).toEqual({ amount: '75.00', currency: 'BRL' });
      expect(betBalanceChangedEvent.payload.version).toBe(2);

      // Reconciliação
      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('75.00');
      expect(recon.calculatedBalance.amount).toBe('75.00');
      expect(recon.difference.amount).toBe('0.00');
      expect(recon.checkedEntries).toBe(2);
    });
  });

  describe('2. Replay Após Mudança de Saldo: Retorno do Saldo Original da Primeira e Preservação do Saldo Atual', () => {
    it('deve retornar saldo original da primeira BET no replay e não alterar o saldo atual da carteira', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const keyBet1 = `idemp-replay-diff-1-${crypto.randomUUID()}`;
      const payloadBet1: ProcessBetDto = {
        providerId: 'provider-test',
        externalTransactionId: `ext-rep-1-${crypto.randomUUID()}`,
        playerId,
        walletId: wallet.id,
        roundId: 'round-rep-1',
        gameId: 'game-rep',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      };

      // 1. Processar BET 1 -> saldo vai para 75.00
      const res1 = await processBetUseCase.execute(keyBet1, payloadBet1);
      expect(res1.status).toBe('PROCESSED');
      expect(res1.balance.amount).toBe('75.00');
      expect(res1.idempotentReplay).toBe(false);

      // 2. Processar BET 2 antes de repetir a primeira -> saldo vai para 60.00
      const keyBet2 = `idemp-replay-diff-2-${crypto.randomUUID()}`;
      const payloadBet2: ProcessBetDto = {
        providerId: 'provider-test',
        externalTransactionId: `ext-rep-2-${crypto.randomUUID()}`,
        playerId,
        walletId: wallet.id,
        roundId: 'round-rep-2',
        gameId: 'game-rep',
        kind: 'BET',
        money: { amount: '15.00', currency: 'BRL' },
      };

      const res2 = await processBetUseCase.execute(keyBet2, payloadBet2);
      expect(res2.status).toBe('PROCESSED');
      expect(res2.balance.amount).toBe('60.00');
      expect(res2.idempotentReplay).toBe(false);

      // Saldo no banco deve ser 60.00 e version 3
      uow.getEntityManager().clear();
      const midWallet = await getWalletUseCase.execute(wallet.id);
      expect(midWallet.balance.amount).toBe('60.00');
      expect(midWallet.version).toBe(3);

      const midOutboxCount = Number(
        (await adminPool.query('SELECT count(*) FROM outbox_messages WHERE aggregate_id = $1', [wallet.id])).rows[0].count
      );
      const midLedgerCount = Number(
        (await adminPool.query('SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = $1', [wallet.id])).rows[0].count
      );

      // 3. Replay da BET 1 via HTTP
      const replayRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'idempotency-key': keyBet1,
        },
        body: JSON.stringify(payloadBet1),
      });

      expect(replayRes.status).toBe(200);
      const replayData = (await replayRes.json()) as any;

      // Invariante essencial: O replay DEVE retornar o saldo original da primeira (75.00)
      expect(replayData.transactionId).toBe(res1.transactionId);
      expect(replayData.status).toBe('PROCESSED');
      expect(replayData.balance).toEqual({ amount: '75.00', currency: 'BRL' });
      expect(replayData.idempotentReplay).toBe(true);

      // Invariante essencial: O banco de dados preserva o saldo atual (60.00) e versão (3)
      uow.getEntityManager().clear();
      const finalWallet = await getWalletUseCase.execute(wallet.id);
      expect(finalWallet.balance.amount).toBe('60.00');
      expect(finalWallet.version).toBe(3);

      // Replay não altera registros contábeis nem gera novos eventos na outbox
      const finalOutboxCount = Number(
        (await adminPool.query('SELECT count(*) FROM outbox_messages WHERE aggregate_id = $1', [wallet.id])).rows[0].count
      );
      const finalLedgerCount = Number(
        (await adminPool.query('SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = $1', [wallet.id])).rows[0].count
      );
      expect(finalOutboxCount).toBe(midOutboxCount);
      expect(finalLedgerCount).toBe(midLedgerCount);

      // Reconciliação permanece consistente em 60.00
      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('60.00');
      expect(recon.calculatedBalance.amount).toBe('60.00');
      expect(recon.checkedEntries).toBe(3);
    });
  });

  describe('3. Replay de Rejeição: Saldo Insuficiente, Crédito Posterior via WIN e Repetição da BET Rejeitada', () => {
    it('deve continuar rejeitada com resultado e saldo originais mesmo após a carteira receber créditos', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '10.00', currency: 'BRL' },
      });

      const keyRejected = `idemp-rej-${crypto.randomUUID()}`;
      const payloadRejected: ProcessBetDto = {
        providerId: 'provider-test',
        externalTransactionId: `ext-rej-${crypto.randomUUID()}`,
        playerId,
        walletId: wallet.id,
        roundId: 'round-rej',
        gameId: 'game-rej',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      };

      // 1. Executar BET com saldo insuficiente via HTTP
      const rejHttpRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'idempotency-key': keyRejected,
        },
        body: JSON.stringify(payloadRejected),
      });

      expect(rejHttpRes.status).toBe(422);
      const rejData = (await rejHttpRes.json()) as any;
      expect(rejData.status).toBe('REJECTED');
      expect(rejData.failureCode).toBe('INSUFFICIENT_FUNDS');
      expect(rejData.balance).toEqual({ amount: '10.00', currency: 'BRL' });
      expect(rejData.idempotentReplay).toBe(false);

      // Invariantes da rejeição no PostgreSQL:
      // Saldo e version NÃO mudam
      uow.getEntityManager().clear();
      const walletAfterRej = (await adminPool.query('SELECT * FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      expect(walletAfterRej.balance).toBe('10.00');
      expect(Number(walletAfterRej.version)).toBe(1);

      // Transação é persistida como REJECTED
      const rejTxRow = (
        await adminPool.query('SELECT * FROM wager_transactions WHERE id = $1', [rejData.transactionId])
      ).rows[0];
      expect(rejTxRow.status).toBe('REJECTED');
      expect(rejTxRow.rejection_reason).toBe('INSUFFICIENT_FUNDS');
      expect(rejTxRow.amount).toBe('25.00');

      // Nenhum ledger DEBIT é criado para transação rejeitada
      const ledgerDebitsAfterRej = (
        await adminPool.query(
          "SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = $1 AND entry_type = 'DEBIT'",
          [wallet.id]
        )
      ).rows[0].count;
      expect(Number(ledgerDebitsAfterRej)).toBe(0);

      // 2. Creditar a carteira usando o fluxo WIN existente
      const winKey = `idemp-win-credit-${crypto.randomUUID()}`;
      const winPayload: ProcessWagerDto = {
        providerId: 'provider-test',
        externalTransactionId: `ext-win-credit-${crypto.randomUUID()}`,
        playerId,
        walletId: wallet.id,
        roundId: 'round-win-credit',
        gameId: 'game-win-credit',
        kind: 'WIN',
        money: { amount: '100.00', currency: 'BRL' },
      };

      const winRes = await processWagerUseCase.execute(winKey, winPayload);
      expect(winRes.status).toBe('PROCESSED');
      expect(winRes.balance.amount).toBe('110.00');

      // Validar saldo atual da carteira: 110.00 e version 2
      const walletAfterWin = await getWalletUseCase.execute(wallet.id);
      expect(walletAfterWin.balance.amount).toBe('110.00');
      expect(walletAfterWin.version).toBe(2);

      const beforeReplayLedgers = (
        await adminPool.query('SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = $1', [wallet.id])
      ).rows[0].count;
      const beforeReplayOutbox = (
        await adminPool.query('SELECT count(*) FROM outbox_messages WHERE aggregate_id = $1', [wallet.id])
      ).rows[0].count;

      // 3. Repetir a BET rejeitada via HTTP
      const repeatHttpRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'idempotency-key': keyRejected,
        },
        body: JSON.stringify(payloadRejected),
      });

      expect(repeatHttpRes.status).toBe(422);
      const repeatData = (await repeatHttpRes.json()) as any;

      // Invariante: Continua rejeitada com o snapshot original (saldo original 10.00 e failureCode INSUFFICIENT_FUNDS)
      expect(repeatData.transactionId).toBe(rejData.transactionId);
      expect(repeatData.status).toBe('REJECTED');
      expect(repeatData.failureCode).toBe('INSUFFICIENT_FUNDS');
      expect(repeatData.balance).toEqual({ amount: '10.00', currency: 'BRL' });
      expect(repeatData.idempotentReplay).toBe(true);

      // Saldo atual no banco permanece 110.00 e versão permanece 2
      uow.getEntityManager().clear();
      const finalWallet = await getWalletUseCase.execute(wallet.id);
      expect(finalWallet.balance.amount).toBe('110.00');
      expect(finalWallet.version).toBe(2);

      // Replay não altera ledger nem gera eventos
      const afterReplayLedgers = (
        await adminPool.query('SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = $1', [wallet.id])
      ).rows[0].count;
      const afterReplayOutbox = (
        await adminPool.query('SELECT count(*) FROM outbox_messages WHERE aggregate_id = $1', [wallet.id])
      ).rows[0].count;
      expect(afterReplayLedgers).toBe(beforeReplayLedgers);
      expect(afterReplayOutbox).toBe(beforeReplayOutbox);

      // Reconciliação consistente
      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('110.00');
      expect(recon.calculatedBalance.amount).toBe('110.00');
    });
  });

  describe('4. Conflito: Mesma Chave com Valor Diferente Retorna 409 sem Efeito Adicional', () => {
    it('deve retornar 409 Conflict quando a mesma chave for reenviada com amount diferente e não alterar banco', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const idempotencyKey = `idemp-conflict-${crypto.randomUUID()}`;
      const extTxId = `ext-conflict-${crypto.randomUUID()}`;

      const initialPayload: ProcessBetDto = {
        providerId: 'provider-test',
        externalTransactionId: extTxId,
        playerId,
        walletId: wallet.id,
        roundId: 'round-cnf',
        gameId: 'game-cnf',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      };

      // Primeira submissão com sucesso
      const res1 = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(initialPayload),
      });
      expect(res1.status).toBe(200);

      const midWallet = await getWalletUseCase.execute(wallet.id);
      expect(midWallet.balance.amount).toBe('75.00');
      expect(midWallet.version).toBe(2);

      // Segunda submissão com MESMA chave e valor diferente (30.00)
      const divergentPayload = {
        ...initialPayload,
        money: { amount: '30.00', currency: 'BRL' },
      };

      const res2 = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(divergentPayload),
      });

      expect(res2.status).toBe(409);
      const conflictData = (await res2.json()) as any;
      expect(conflictData.statusCode).toBe(409);
      expect(conflictData.code).toBe('IDEMPOTENCY_CONFLICT');

      // Sem qualquer efeito adicional no PostgreSQL
      uow.getEntityManager().clear();
      const finalWallet = await getWalletUseCase.execute(wallet.id);
      expect(finalWallet.balance.amount).toBe('75.00');
      expect(finalWallet.version).toBe(2);

      const betTxCount = (
        await adminPool.query("SELECT count(*) FROM wager_transactions WHERE wallet_id = $1 AND kind = 'BET'", [
          wallet.id,
        ])
      ).rows[0].count;
      expect(Number(betTxCount)).toBe(1);

      const debitLedgerCount = (
        await adminPool.query(
          "SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = $1 AND entry_type = 'DEBIT'",
          [wallet.id]
        )
      ).rows[0].count;
      expect(Number(debitLedgerCount)).toBe(1);

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('75.00');
    });
  });

  describe('5. Concorrência: 50 Duplicatas, Disputa de Saldo, Chave Disputada por Wallets Diferentes, Provider+External Reutilizado e 3 Processos com Handshake', () => {
    it('5.1: 50 duplicatas simultâneas produzem exatamente UMA transação financeira e UM débito', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const idempotencyKey = `idemp-concurr-50-${crypto.randomUUID()}`;
      const payload: ProcessBetDto = {
        providerId: 'provider-concurr',
        externalTransactionId: `ext-concurr-50-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-50',
        gameId: 'game-50',
        kind: 'BET',
        money: { amount: '30.00', currency: 'BRL' },
      };

      const promises = Array.from({ length: 50 }, () =>
        processBetUseCase.execute(idempotencyKey, payload)
      );

      const results = await Promise.all(promises);
      expect(results.length).toBe(50);

      const processed = results.filter((r) => !r.idempotentReplay);
      const replays = results.filter((r) => r.idempotentReplay);

      expect(processed.length).toBe(1);
      expect(replays.length).toBe(49);

      for (const r of results) {
        expect(r.status).toBe('PROCESSED');
        expect(r.balance.amount).toBe('70.00');
      }

      uow.getEntityManager().clear();
      const updatedWallet = await getWalletUseCase.execute(wallet.id);
      expect(updatedWallet.balance.amount).toBe('70.00');
      expect(updatedWallet.version).toBe(2);

      const txCount = (
        await adminPool.query("SELECT count(*) FROM wager_transactions WHERE wallet_id = $1 AND kind = 'BET'", [
          wallet.id,
        ])
      ).rows[0].count;
      expect(Number(txCount)).toBe(1);

      const debitCount = (
        await adminPool.query(
          "SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = $1 AND entry_type = 'DEBIT'",
          [wallet.id]
        )
      ).rows[0].count;
      expect(Number(debitCount)).toBe(1);

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('70.00');
      expect(recon.difference.amount).toBe('0.00');
    });

    it('5.2: Duas BET de 80.00 sobre saldo 100.00: uma processada, uma rejeitada e saldo final 20.00', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const bet1: ProcessBetDto = {
        providerId: 'provider-race',
        externalTransactionId: `ext-race-80-1-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-race-1',
        gameId: 'game-race',
        kind: 'BET',
        money: { amount: '80.00', currency: 'BRL' },
      };

      const bet2: ProcessBetDto = {
        providerId: 'provider-race',
        externalTransactionId: `ext-race-80-2-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-race-2',
        gameId: 'game-race',
        kind: 'BET',
        money: { amount: '80.00', currency: 'BRL' },
      };

      const [res1, res2] = await Promise.all([
        processBetUseCase.execute(`key-race-80-1-${crypto.randomUUID()}`, bet1),
        processBetUseCase.execute(`key-race-80-2-${crypto.randomUUID()}`, bet2),
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual(['PROCESSED', 'REJECTED']);

      const rejectedRes = res1.status === 'REJECTED' ? res1 : res2;
      expect(rejectedRes.failureCode).toBe('INSUFFICIENT_FUNDS');
      expect(rejectedRes.balance.amount).toBe('20.00');

      uow.getEntityManager().clear();
      const finalWallet = await getWalletUseCase.execute(wallet.id);
      expect(finalWallet.balance.amount).toBe('20.00');
      expect(finalWallet.version).toBe(2);

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('20.00');
      expect(recon.calculatedBalance.amount).toBe('20.00');
      expect(recon.difference.amount).toBe('0.00');
    });

    it('5.3: Mesma chave disputada por wallets diferentes: um vencedor, conflito na outra e nenhum efeito parcial', async () => {
      const wallet1 = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });
      const wallet2 = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const sharedKey = `shared-key-wallets-${crypto.randomUUID()}`;

      const p1 = processBetUseCase.execute(sharedKey, {
        providerId: 'prv-race-wallets',
        externalTransactionId: `ext-w1-${crypto.randomUUID()}`,
        playerId: wallet1.playerId,
        walletId: wallet1.id,
        roundId: 'rnd-w',
        gameId: 'gm-w',
        kind: 'BET',
        money: { amount: '30.00', currency: 'BRL' },
      });

      const p2 = processBetUseCase.execute(sharedKey, {
        providerId: 'prv-race-wallets',
        externalTransactionId: `ext-w2-${crypto.randomUUID()}`,
        playerId: wallet2.playerId,
        walletId: wallet2.id,
        roundId: 'rnd-w',
        gameId: 'gm-w',
        kind: 'BET',
        money: { amount: '30.00', currency: 'BRL' },
      });

      const [settled1, settled2] = await Promise.allSettled([p1, p2]);

      const fulfilled = [settled1, settled2].filter((s) => s.status === 'fulfilled') as PromiseFulfilledResult<any>[];
      const rejected = [settled1, settled2].filter((s) => s.status === 'rejected') as PromiseRejectedResult[];

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      expect(rejected[0].reason).toBeInstanceOf(IdempotencyConflictError);

      const winnerWalletId = settled1.status === 'fulfilled' ? wallet1.id : wallet2.id;
      const loserWalletId = winnerWalletId === wallet1.id ? wallet2.id : wallet1.id;

      uow.getEntityManager().clear();
      // Carteira vencedora teve o débito aplicado
      const winnerWallet = await getWalletUseCase.execute(winnerWalletId);
      expect(winnerWallet.balance.amount).toBe('70.00');
      expect(winnerWallet.version).toBe(2);

      // Carteira perdedora NÃO sofreu qualquer alteração
      const loserWallet = await getWalletUseCase.execute(loserWalletId);
      expect(loserWallet.balance.amount).toBe('100.00');
      expect(loserWallet.version).toBe(1);

      // Nenhum ledger DEBIT na perdedora
      const loserDebits = (
        await adminPool.query(
          "SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = $1 AND entry_type = 'DEBIT'",
          [loserWalletId]
        )
      ).rows[0].count;
      expect(Number(loserDebits)).toBe(0);

      // Reconciliação consistente em ambas as carteiras
      expect((await reconcileWalletUseCase.execute(winnerWalletId)).consistent).toBe(true);
      expect((await reconcileWalletUseCase.execute(loserWalletId)).consistent).toBe(true);
    });

    it('5.4: Mesmo identificador externo com chaves distintas não produz efeito duplicado', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const sharedProviderId = 'provider-dedup';
      const sharedExternalId = `ext-dedup-${crypto.randomUUID()}`;

      const keyA = `key-dedup-a-${crypto.randomUUID()}`;
      const keyB = `key-dedup-b-${crypto.randomUUID()}`;

      const payloadA: ProcessBetDto = {
        providerId: sharedProviderId,
        externalTransactionId: sharedExternalId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-d',
        gameId: 'game-d',
        kind: 'BET',
        money: { amount: '40.00', currency: 'BRL' },
      };

      const payloadB: ProcessBetDto = {
        providerId: sharedProviderId,
        externalTransactionId: sharedExternalId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-d',
        gameId: 'game-d',
        kind: 'BET',
        money: { amount: '40.00', currency: 'BRL' },
      };

      // 1. Primeira submissão com sucesso
      const resA = await processBetUseCase.execute(keyA, payloadA);
      expect(resA.status).toBe('PROCESSED');
      expect(resA.balance.amount).toBe('60.00');

      // 2. Segunda submissão com CHAVE DISTINTA mas MESMO providerId+externalTransactionId
      await expect(processBetUseCase.execute(keyB, payloadB)).rejects.toThrow(IdempotencyConflictError);

      uow.getEntityManager().clear();
      const updatedWallet = await getWalletUseCase.execute(wallet.id);
      expect(updatedWallet.balance.amount).toBe('60.00');
      expect(updatedWallet.version).toBe(2);

      const txCount = (
        await adminPool.query("SELECT count(*) FROM wager_transactions WHERE wallet_id = $1 AND kind = 'BET'", [
          wallet.id,
        ])
      ).rows[0].count;
      expect(Number(txCount)).toBe(1);

      const debitCount = (
        await adminPool.query(
          "SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = $1 AND entry_type = 'DEBIT'",
          [wallet.id]
        )
      ).rows[0].count;
      expect(Number(debitCount)).toBe(1);

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('60.00');
    });

    it('5.5a: Concorrência entre TRÊS processos reais com handshake: Disputa de saldo (80.00 cada em 100.00)', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const bunBin = process.execPath;
      const workerScript = join(import.meta.dir, '../concurrency/worker.ts');
      const barrierPath = join(tmpdir(), `barrier_disp_${Date.now()}_${Math.random().toString(36).substring(7)}.tmp`);

      const spawnWorker = (idempKey: string, payload: ProcessBetDto) => {
        let markReady: () => void;
        const readyPromise = new Promise<void>((resolve) => {
          markReady = resolve;
        });

        const resultPromise = new Promise<any>((resolve, reject) => {
          let child: any;
          try {
            child = spawn(bunBin, ['run', workerScript, idempKey, JSON.stringify(payload), barrierPath], {
              env: {
                ...process.env,
                DB_NAME: isolatedDb.dbName,
              },
            });
          } catch (err) {
            return reject(err);
          }

          child.on('error', (err: any) => reject(err));

          let stdout = '';
          let stderr = '';
          let signaledReady = false;

          child.stdout.on('data', (d: any) => {
            stdout += d.toString();
            if (!signaledReady && stdout.includes('READY')) {
              signaledReady = true;
              markReady();
            }
          });

          child.stderr.on('data', (d: any) => (stderr += d.toString()));

          const timer = setTimeout(() => {
            try { child.kill(); } catch {}
            reject(new Error(`Worker timed out: stdout="${stdout}" stderr="${stderr}"`));
          }, 20000);

          child.on('close', (code: any) => {
            clearTimeout(timer);
            if (code !== 0) {
              reject(new Error(`Worker exited with code ${code}: ${stderr}`));
              return;
            }
            try {
              const jsonLine = stdout.split('\n').filter((l) => l.trim().startsWith('{')).pop();
              if (!jsonLine) throw new Error('No JSON output found');
              resolve(JSON.parse(jsonLine.trim()));
            } catch {
              reject(new Error(`Worker invalid JSON: "${stdout}"`));
            }
          });
        });

        return { readyPromise, resultPromise };
      };

      const payloads: ProcessBetDto[] = [1, 2, 3].map((i) => ({
        providerId: 'provider-multi-disp',
        externalTransactionId: `ext-proc-disp-${i}-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: `round-disp-${i}`,
        gameId: 'game-disp',
        kind: 'BET',
        money: { amount: '80.00', currency: 'BRL' },
      }));

      const w1 = spawnWorker(`idemp-disp-1-${crypto.randomUUID()}`, payloads[0]);
      const w2 = spawnWorker(`idemp-disp-2-${crypto.randomUUID()}`, payloads[1]);
      const w3 = spawnWorker(`idemp-disp-3-${crypto.randomUUID()}`, payloads[2]);

      // Handshake de prontidão: aguardar os 3 workers confirmarem READY
      await Promise.all([w1.readyPromise, w2.readyPromise, w3.readyPromise]);

      // Liberar barreira simultaneamente
      writeFileSync(barrierPath, 'RELEASE');

      try {
        const results = await Promise.all([w1.resultPromise, w2.resultPromise, w3.resultPromise]);
        expect(results.length).toBe(3);
        for (const r of results) {
          expect(r.ok).toBe(true);
        }

        const statuses = results.map((r) => r.data.status);
        const processedCount = statuses.filter((s) => s === 'PROCESSED').length;
        const rejectedCount = statuses.filter((s) => s === 'REJECTED').length;

        expect(processedCount).toBe(1);
        expect(rejectedCount).toBe(2);

        uow.getEntityManager().clear();
        const finalWallet = await getWalletUseCase.execute(wallet.id);
        expect(finalWallet.balance.amount).toBe('20.00');
        expect(finalWallet.version).toBe(2);

        const recon = await reconcileWalletUseCase.execute(wallet.id);
        expect(recon.consistent).toBe(true);
        expect(recon.storedBalance.amount).toBe('20.00');
        expect(recon.calculatedBalance.amount).toBe('20.00');
        expect(recon.checkedEntries).toBe(2);
      } finally {
        if (existsSync(barrierPath)) {
          unlinkSync(barrierPath);
        }
      }
    }, 30000);

    it('5.5b: Concorrência entre TRÊS processos reais com handshake: Duplicatas da mesma BET', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const bunBin = process.execPath;
      const workerScript = join(import.meta.dir, '../concurrency/worker.ts');
      const barrierPath = join(tmpdir(), `barrier_dup3_${Date.now()}_${Math.random().toString(36).substring(7)}.tmp`);

      const spawnWorker = (idempKey: string, payload: ProcessBetDto) => {
        let markReady: () => void;
        const readyPromise = new Promise<void>((resolve) => {
          markReady = resolve;
        });

        const resultPromise = new Promise<any>((resolve, reject) => {
          let child: any;
          try {
            child = spawn(bunBin, ['run', workerScript, idempKey, JSON.stringify(payload), barrierPath], {
              env: {
                ...process.env,
                DB_NAME: isolatedDb.dbName,
              },
            });
          } catch (err) {
            return reject(err);
          }

          child.on('error', (err: any) => reject(err));

          let stdout = '';
          let stderr = '';
          let signaledReady = false;

          child.stdout.on('data', (d: any) => {
            stdout += d.toString();
            if (!signaledReady && stdout.includes('READY')) {
              signaledReady = true;
              markReady();
            }
          });

          child.stderr.on('data', (d: any) => (stderr += d.toString()));

          const timer = setTimeout(() => {
            try { child.kill(); } catch {}
            reject(new Error(`Worker timed out: stdout="${stdout}" stderr="${stderr}"`));
          }, 20000);

          child.on('close', (code: any) => {
            clearTimeout(timer);
            if (code !== 0) {
              reject(new Error(`Worker exited with code ${code}: ${stderr}`));
              return;
            }
            try {
              const jsonLine = stdout.split('\n').filter((l) => l.trim().startsWith('{')).pop();
              if (!jsonLine) throw new Error('No JSON output found');
              resolve(JSON.parse(jsonLine.trim()));
            } catch {
              reject(new Error(`Worker invalid JSON: "${stdout}"`));
            }
          });
        });

        return { readyPromise, resultPromise };
      };

      const sharedKey = `idemp-3p-dup-${crypto.randomUUID()}`;
      const sharedPayload: ProcessBetDto = {
        providerId: 'provider-dup-3p',
        externalTransactionId: `ext-3p-dup-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-dup-3p',
        gameId: 'game-dup-3p',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      };

      const w1 = spawnWorker(sharedKey, sharedPayload);
      const w2 = spawnWorker(sharedKey, sharedPayload);
      const w3 = spawnWorker(sharedKey, sharedPayload);

      await Promise.all([w1.readyPromise, w2.readyPromise, w3.readyPromise]);

      writeFileSync(barrierPath, 'RELEASE');

      try {
        const results = await Promise.all([w1.resultPromise, w2.resultPromise, w3.resultPromise]);
        expect(results.length).toBe(3);
        for (const r of results) {
          expect(r.ok).toBe(true);
        }

        for (const r of results) {
          expect(r.data.status).toBe('PROCESSED');
          expect(r.data.balance.amount).toBe('75.00');
        }

        const firstProcessed = results.filter((r) => !r.data.idempotentReplay);
        const replays = results.filter((r) => r.data.idempotentReplay);

        expect(firstProcessed.length).toBe(1);
        expect(replays.length).toBe(2);

        uow.getEntityManager().clear();
        const finalWallet = await getWalletUseCase.execute(wallet.id);
        expect(finalWallet.balance.amount).toBe('75.00');
        expect(finalWallet.version).toBe(2);

        const txRows = await adminPool.query(
          "SELECT count(*) FROM wager_transactions WHERE wallet_id = $1 AND kind = 'BET'",
          [wallet.id]
        );
        expect(Number(txRows.rows[0].count)).toBe(1);

        const debitRows = await adminPool.query(
          "SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = $1 AND entry_type = 'DEBIT'",
          [wallet.id]
        );
        expect(Number(debitRows.rows[0].count)).toBe(1);

        const recon = await reconcileWalletUseCase.execute(wallet.id);
        expect(recon.consistent).toBe(true);
        expect(recon.storedBalance.amount).toBe('75.00');
        expect(recon.calculatedBalance.amount).toBe('75.00');
      } finally {
        if (existsSync(barrierPath)) {
          unlinkSync(barrierPath);
        }
      }
    }, 30000);
  });

  describe('6. Falhas Injetadas: Rollback Integral pelos Identificadores da Tentativa e Reenvio Único', () => {
    it('deve fazer rollback integral após wallet_save, conferir ausência por identificador e permitir reenvio único', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const key = `key-fail-w-${crypto.randomUUID()}`;
      const payload: ProcessBetDto = {
        providerId: 'provider-test',
        externalTransactionId: `ext-fail-w-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-fail',
        gameId: 'game-fail',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      };

      try {
        uow.setTestHook('after_wallet_save', () => {
          throw new Error('SIMULATED_FAIL_AFTER_WALLET_SAVE');
        });

        await expect(processBetUseCase.execute(key, payload)).rejects.toThrow('SIMULATED_FAIL_AFTER_WALLET_SAVE');
      } finally {
        uow.clearTestHooks();
      }

      uow.getEntityManager().clear();

      // Carteira deve ter o saldo e versão originais preservados
      const wRow = (await adminPool.query('SELECT * FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      expect(wRow.balance).toBe('100.00');
      expect(Number(wRow.version)).toBe(1);

      // Nenhuma transação BET criada
      const txCount = (
        await adminPool.query("SELECT count(*) FROM wager_transactions WHERE wallet_id = $1 AND kind = 'BET'", [
          wallet.id,
        ])
      ).rows[0].count;
      expect(Number(txCount)).toBe(0);

      // Reenvio da mesma BET
      const successRes = await processBetUseCase.execute(key, payload);
      expect(successRes.status).toBe('PROCESSED');
      expect(successRes.balance.amount).toBe('75.00');

      uow.getEntityManager().clear();
      const updatedWallet = await getWalletUseCase.execute(wallet.id);
      expect(updatedWallet.balance.amount).toBe('75.00');
      expect(updatedWallet.version).toBe(2);

      const finalTxCount = (
        await adminPool.query("SELECT count(*) FROM wager_transactions WHERE wallet_id = $1 AND kind = 'BET'", [
          wallet.id,
        ])
      ).rows[0].count;
      expect(Number(finalTxCount)).toBe(1);
    });

    it('deve fazer rollback integral após tx_save, conferir ausência por identificador e permitir reenvio único', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const key = `key-fail-tx-${crypto.randomUUID()}`;
      const payload: ProcessBetDto = {
        providerId: 'provider-test',
        externalTransactionId: `ext-fail-tx-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-fail',
        gameId: 'game-fail',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      };

      let capturedTxId: string | null = null;

      try {
        uow.setTestHook('after_tx_save', (entity) => {
          capturedTxId = entity.id;
          throw new Error('SIMULATED_FAIL_AFTER_TX_SAVE');
        });

        await expect(processBetUseCase.execute(key, payload)).rejects.toThrow('SIMULATED_FAIL_AFTER_TX_SAVE');
      } finally {
        uow.clearTestHooks();
      }

      uow.getEntityManager().clear();
      expect(capturedTxId).not.toBeNull();

      // Transação da tentativa DEVE ter sido completamente revertida (órfão zero)
      const txCheck = (await adminPool.query('SELECT count(*) FROM wager_transactions WHERE id = $1', [capturedTxId]))
        .rows[0].count;
      expect(Number(txCheck)).toBe(0);

      // Saldo da carteira intacto
      const wRow = (await adminPool.query('SELECT * FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      expect(wRow.balance).toBe('100.00');
      expect(Number(wRow.version)).toBe(1);

      // Reenvio da mesma BET
      const successRes = await processBetUseCase.execute(key, payload);
      expect(successRes.status).toBe('PROCESSED');
      expect(successRes.balance.amount).toBe('75.00');

      uow.getEntityManager().clear();
      const updatedWallet = await getWalletUseCase.execute(wallet.id);
      expect(updatedWallet.balance.amount).toBe('75.00');
      expect(updatedWallet.version).toBe(2);
    });

    it('deve fazer rollback integral após ledger_save, conferir ausência por identificador e permitir reenvio único', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const key = `key-fail-ledger-${crypto.randomUUID()}`;
      const payload: ProcessBetDto = {
        providerId: 'provider-test',
        externalTransactionId: `ext-fail-ledger-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-fail',
        gameId: 'game-fail',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      };

      let capturedTxId: string | null = null;
      let capturedLedgerId: string | null = null;

      try {
        uow.setTestHook('after_tx_save', (entity) => {
          capturedTxId = entity.id;
        });
        uow.setTestHook('after_ledger_save', (entity) => {
          capturedLedgerId = entity.id;
          throw new Error('SIMULATED_FAIL_AFTER_LEDGER_SAVE');
        });

        await expect(processBetUseCase.execute(key, payload)).rejects.toThrow('SIMULATED_FAIL_AFTER_LEDGER_SAVE');
      } finally {
        uow.clearTestHooks();
      }

      uow.getEntityManager().clear();
      expect(capturedTxId).not.toBeNull();
      expect(capturedLedgerId).not.toBeNull();

      // Lançamento contábil e transação devem ter sofrido rollback integral
      const lCheck = (
        await adminPool.query('SELECT count(*) FROM wallet_ledger_entries WHERE id = $1', [capturedLedgerId])
      ).rows[0].count;
      expect(Number(lCheck)).toBe(0);

      const txCheck = (await adminPool.query('SELECT count(*) FROM wager_transactions WHERE id = $1', [capturedTxId]))
        .rows[0].count;
      expect(Number(txCheck)).toBe(0);

      // Saldo intacto
      const wRow = (await adminPool.query('SELECT * FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      expect(wRow.balance).toBe('100.00');
      expect(Number(wRow.version)).toBe(1);

      // Reenvio da mesma BET
      const successRes = await processBetUseCase.execute(key, payload);
      expect(successRes.status).toBe('PROCESSED');
      expect(successRes.balance.amount).toBe('75.00');

      uow.getEntityManager().clear();
      const updatedWallet = await getWalletUseCase.execute(wallet.id);
      expect(updatedWallet.balance.amount).toBe('75.00');
      expect(updatedWallet.version).toBe(2);

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('75.00');
    });

    it('deve fazer rollback integral após outbox_save, conferir ausência por identificador e permitir reenvio único', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const key = `key-fail-outbox-${crypto.randomUUID()}`;
      const payload: ProcessBetDto = {
        providerId: 'provider-test',
        externalTransactionId: `ext-fail-outbox-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-fail',
        gameId: 'game-fail',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      };

      let capturedTxId: string | null = null;
      let capturedLedgerId: string | null = null;
      let capturedOutboxId: string | null = null;

      try {
        uow.setTestHook('after_tx_save', (entity) => {
          capturedTxId = entity.id;
        });
        uow.setTestHook('after_ledger_save', (entity) => {
          capturedLedgerId = entity.id;
        });
        uow.setTestHook('after_outbox_save', (entity) => {
          capturedOutboxId = entity.id;
          throw new Error('SIMULATED_FAIL_AFTER_FIRST_OUTBOX');
        });

        await expect(processBetUseCase.execute(key, payload)).rejects.toThrow('SIMULATED_FAIL_AFTER_FIRST_OUTBOX');
      } finally {
        uow.clearTestHooks();
      }

      uow.getEntityManager().clear();
      expect(capturedTxId).not.toBeNull();
      expect(capturedLedgerId).not.toBeNull();
      expect(capturedOutboxId).not.toBeNull();

      // Mensagem da outbox não deve ter sido persistida
      const oCheck = (await adminPool.query('SELECT count(*) FROM outbox_messages WHERE id = $1', [capturedOutboxId]))
        .rows[0].count;
      expect(Number(oCheck)).toBe(0);

      const lCheck = (
        await adminPool.query('SELECT count(*) FROM wallet_ledger_entries WHERE id = $1', [capturedLedgerId])
      ).rows[0].count;
      expect(Number(lCheck)).toBe(0);

      const txCheck = (await adminPool.query('SELECT count(*) FROM wager_transactions WHERE id = $1', [capturedTxId]))
        .rows[0].count;
      expect(Number(txCheck)).toBe(0);

      const wRow = (await adminPool.query('SELECT * FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      expect(wRow.balance).toBe('100.00');
      expect(Number(wRow.version)).toBe(1);

      // Reenvio da mesma BET
      const successRes = await processBetUseCase.execute(key, payload);
      expect(successRes.status).toBe('PROCESSED');
      expect(successRes.balance.amount).toBe('75.00');

      uow.getEntityManager().clear();
      const updatedWallet = await getWalletUseCase.execute(wallet.id);
      expect(updatedWallet.balance.amount).toBe('75.00');
      expect(updatedWallet.version).toBe(2);

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('75.00');
    });
  });

  describe('7. Tratamento Rigoroso de Erros de Unicidade 23505 e Rejeição de Contratos Inválidos', () => {
    it('não deve converter qualquer erro 23505 em IdempotencyConflictError se a constraint for outra', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const key = `key-unrelated-23505-${crypto.randomUUID()}`;
      const payload: ProcessBetDto = {
        providerId: 'provider-test',
        externalTransactionId: `ext-unrelated-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-unrelated',
        gameId: 'game-unrelated',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      };

      try {
        uow.setTestHook('after_wallet_save', () => {
          const fakeError: any = new Error('duplicate key value violates unique constraint "uq_other_table"');
          fakeError.code = '23505';
          fakeError.constraint = 'uq_other_table';
          throw fakeError;
        });

        let caughtError: any;
        try {
          await processBetUseCase.execute(key, payload);
        } catch (e) {
          caughtError = e;
        }

        // NÃO deve ser convertido em IdempotencyConflictError
        expect(caughtError).toBeDefined();
        expect(caughtError instanceof IdempotencyConflictError).toBe(false);
        expect(caughtError?.code).toBe('23505');
        expect(caughtError?.constraint).toBe('uq_other_table');
      } finally {
        uow.clearTestHooks();
      }
    });

    it('rejeição de contrato inválido não deixa alterações parciais', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      // 1. BET com valor zero
      const zeroPayload = {
        providerId: 'provider-test',
        externalTransactionId: `ext-zero-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-zero',
        gameId: 'game-zero',
        kind: 'BET',
        money: { amount: '0.00', currency: 'BRL' },
      };

      const resZero = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'idempotency-key': `key-zero-${crypto.randomUUID()}`,
        },
        body: JSON.stringify(zeroPayload),
      });
      expect(resZero.status).toBe(400);

      // 2. BET com valor negativo
      const negPayload = {
        ...zeroPayload,
        money: { amount: '-10.00', currency: 'BRL' },
      };
      const resNeg = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'idempotency-key': `key-neg-${crypto.randomUUID()}`,
        },
        body: JSON.stringify(negPayload),
      });
      expect(resNeg.status).toBe(400);

      // 3. BET com playerId mismatch
      const mismatchPlayerPayload = {
        ...zeroPayload,
        playerId: crypto.randomUUID(),
        money: { amount: '20.00', currency: 'BRL' },
      };
      const resMismatch = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'idempotency-key': `key-mismatch-${crypto.randomUUID()}`,
        },
        body: JSON.stringify(mismatchPlayerPayload),
      });
      expect(resMismatch.status).toBe(400);

      // 4. Conferir que nenhum registro financeiro, ledger ou transação foi criado
      uow.getEntityManager().clear();
      const finalWallet = await getWalletUseCase.execute(wallet.id);
      expect(finalWallet.balance.amount).toBe('100.00');
      expect(finalWallet.version).toBe(1);

      const betTxCount = (
        await adminPool.query("SELECT count(*) FROM wager_transactions WHERE wallet_id = $1 AND kind = 'BET'", [
          wallet.id,
        ])
      ).rows[0].count;
      expect(Number(betTxCount)).toBe(0);

      const debitLedgerCount = (
        await adminPool.query(
          "SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = $1 AND entry_type = 'DEBIT'",
          [wallet.id]
        )
      ).rows[0].count;
      expect(Number(debitLedgerCount)).toBe(0);

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('100.00');
      expect(recon.checkedEntries).toBe(1);
    });
  });
});
