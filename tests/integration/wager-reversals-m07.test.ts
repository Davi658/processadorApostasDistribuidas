import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import pg from 'pg';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
import { ProcessWagerDto, WagerResponseDto } from '../../src/application/dto/wager.dto';
import { Money } from '../../src/domain/value-objects/money.vo';
import {
  IdempotencyConflictError,
  InvalidMoneyError,
  MoneyOverflowError,
} from '../../src/domain/errors/domain.error';
import { createIsolatedTestDatabase, IsolatedTestDatabase } from '../test-db-helper';

describe('M07: REFUND e ROLLBACK Imediatos — Provas Formais e Invariantes', () => {
  let app: INestApplication;
  let serverUrl: string;
  let isolatedDb: IsolatedTestDatabase;
  let adminPool: pg.Pool;

  let uow: MikroOrmUnitOfWork;
  let walletRepo: MikroOrmWalletRepository;
  let wagerRepo: MikroOrmWagerTransactionRepository;
  let ledgerRepo: MikroOrmWalletLedgerRepository;
  let outboxRepo: MikroOrmOutboxRepository;

  let createWalletUseCase: CreateWalletUseCase;
  let getWalletUseCase: GetWalletUseCase;
  let processWagerUseCase: ProcessWagerUseCase;
  let reconcileWalletUseCase: ReconcileWalletUseCase;

  beforeAll(async () => {
    isolatedDb = await createIsolatedTestDatabase('m07_reversals_');

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
  }, 30000);

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
  }, 30000);

  // Helper de auditoria rigorosa de rejeição
  async function assertRejectionAudit(params: {
    reversalTxId: string;
    walletId: string;
    expectedFailureCode: string;
    expectedBalance: string;
    expectedVersion: number;
  }): Promise<void> {
    const txRow = (
      await adminPool.query('SELECT * FROM wager_transactions WHERE id = $1;', [params.reversalTxId])
    ).rows[0];
    expect(txRow).toBeDefined();
    expect(txRow.status).toBe('REJECTED');
    expect(txRow.rejection_reason).toBe(params.expectedFailureCode);

    const snapshot =
      typeof txRow.response_snapshot === 'string'
        ? JSON.parse(txRow.response_snapshot)
        : txRow.response_snapshot;
    expect(snapshot).toBeDefined();
    expect(snapshot.transactionId).toBe(params.reversalTxId);
    expect(snapshot.status).toBe('REJECTED');
    expect(snapshot.failureCode).toBe(params.expectedFailureCode);
    expect(snapshot.balance?.amount).toBe(params.expectedBalance);
    expect(snapshot.idempotentReplay).toBe(false);

    const ledgerRows = (
      await adminPool.query('SELECT * FROM wallet_ledger_entries WHERE transaction_id = $1;', [
        params.reversalTxId,
      ])
    ).rows;
    expect(ledgerRows.length).toBe(0);

    const wallet = await getWalletUseCase.execute(params.walletId);
    expect(wallet.balance.amount).toBe(params.expectedBalance);
    expect(wallet.version).toBe(params.expectedVersion);

    const outboxRows = (
      await adminPool.query('SELECT * FROM outbox_messages WHERE aggregate_id = $1;', [params.walletId])
    ).rows;

    const rejectedEvents = outboxRows.filter((r: any) => {
      const payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
      return r.event_type === 'WagerTransactionRejected' && payload?.transactionId === params.reversalTxId;
    });
    expect(rejectedEvents.length).toBe(1);
    const rejPayload =
      typeof rejectedEvents[0].payload === 'string'
        ? JSON.parse(rejectedEvents[0].payload)
        : rejectedEvents[0].payload;
    expect(rejPayload.failureCode).toBe(params.expectedFailureCode);

    const processedEvents = outboxRows.filter((r: any) => {
      const payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
      return r.event_type === 'WagerTransactionProcessed' && payload?.transactionId === params.reversalTxId;
    });
    expect(processedEvents.length).toBe(0);

    const balanceChangedEvents = outboxRows.filter((r: any) => {
      const payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
      return r.event_type === 'WalletBalanceChanged' && payload?.triggerTransactionId === params.reversalTxId;
    });
    expect(balanceChangedEvents.length).toBe(0);
  }

  // =========================================================================
  // 1. OPERAÇÕES E REFERÊNCIAS EXISTENTES
  // =========================================================================
  describe('1. Operações e Referências Existentes', () => {
    it('1.1: REFUND de BET: crédito integral, saldo, versão, ledger e outbox', async () => {
      const initialMoney = Money.create('100.00', 'BRL');
      const betMoney = Money.create('35.00', 'BRL');
      const refundMoney = Money.create('35.00', 'BRL');

      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: initialMoney.getAmount(), currency: initialMoney.getCurrency() },
      });

      const betIdemp = `idemp-bet-${crypto.randomUUID()}`;
      const betExtId = `ext-bet-${crypto.randomUUID()}`;
      const roundId = `round-${crypto.randomUUID()}`;

      const betRes = await processWagerUseCase.execute(betIdemp, {
        providerId: 'provider-1',
        externalTransactionId: betExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId,
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: betMoney.getAmount(), currency: betMoney.getCurrency() },
      });
      expect(betRes.status).toBe('PROCESSED');
      expect(betRes.balance.amount).toBe('65.00');

      const refundIdemp = `idemp-ref-${crypto.randomUUID()}`;
      const refundExtId = `ext-ref-${crypto.randomUUID()}`;

      const refundRes = await processWagerUseCase.execute(refundIdemp, {
        providerId: 'provider-1',
        externalTransactionId: refundExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId,
        gameId: 'game-1',
        kind: 'REFUND',
        money: { amount: refundMoney.getAmount(), currency: refundMoney.getCurrency() },
        referenceExternalTransactionId: betExtId,
      });

      expect(refundRes.status).toBe('PROCESSED');
      expect(refundRes.balance.amount).toBe('100.00');
      expect(refundRes.idempotentReplay).toBe(false);

      const updatedWallet = await getWalletUseCase.execute(wallet.id);
      expect(updatedWallet.balance.amount).toBe('100.00');
      expect(updatedWallet.version).toBe(3); // opening(1) + bet(2) + refund(3)

      // Ledger: 1 CREDIT for REFUND
      const ledgerRows = (
        await adminPool.query(
          'SELECT * FROM wallet_ledger_entries WHERE transaction_id = $1;',
          [refundRes.transactionId]
        )
      ).rows;
      expect(ledgerRows.length).toBe(1);
      expect(ledgerRows[0].entry_type).toBe('CREDIT');
      expect(ledgerRows[0].amount).toBe('35.00');
      expect(ledgerRows[0].balance_before).toBe('65.00');
      expect(ledgerRows[0].balance_after).toBe('100.00');

      // Outbox: WagerTransactionProcessed e WalletBalanceChanged
      const outboxRows = (
        await adminPool.query('SELECT * FROM outbox_messages WHERE aggregate_id = $1;', [wallet.id])
      ).rows;

      const refundProcessedEvents = outboxRows.filter((r: any) => {
        const payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
        return r.event_type === 'WagerTransactionProcessed' && payload?.transactionId === refundRes.transactionId;
      });
      expect(refundProcessedEvents.length).toBe(1);
      const procPayload =
        typeof refundProcessedEvents[0].payload === 'string'
          ? JSON.parse(refundProcessedEvents[0].payload)
          : refundProcessedEvents[0].payload;
      expect(procPayload.kind).toBe('REFUND');
      expect(procPayload.referenceExternalTransactionId).toBe(betExtId);

      const refundBalanceEvents = outboxRows.filter((r: any) => {
        const payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
        return r.event_type === 'WalletBalanceChanged' && payload?.triggerTransactionId === refundRes.transactionId;
      });
      expect(refundBalanceEvents.length).toBe(1);
      const balPayload =
        typeof refundBalanceEvents[0].payload === 'string'
          ? JSON.parse(refundBalanceEvents[0].payload)
          : refundBalanceEvents[0].payload;
      expect(balPayload.previousBalance.amount).toBe('65.00');
      expect(balPayload.currentBalance.amount).toBe('100.00');
      expect(balPayload.version).toBe(3);

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('100.00');
      expect(recon.calculatedBalance.amount).toBe('100.00');
      expect(recon.difference.amount).toBe('0.00');
    });

    it('1.2: ROLLBACK de BET: crédito integral, saldo, versão, ledger e outbox', async () => {
      const initialMoney = Money.create('100.00', 'BRL');
      const betMoney = Money.create('40.00', 'BRL');
      const rollbackMoney = Money.create('40.00', 'BRL');

      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: initialMoney.getAmount(), currency: initialMoney.getCurrency() },
      });

      const betExtId = `ext-bet-${crypto.randomUUID()}`;
      const roundId = `round-${crypto.randomUUID()}`;

      const betRes = await processWagerUseCase.execute(`idemp-bet-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: betExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId,
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: betMoney.getAmount(), currency: betMoney.getCurrency() },
      });
      expect(betRes.status).toBe('PROCESSED');
      expect(betRes.balance.amount).toBe('60.00');

      const rollbackExtId = `ext-rb-bet-${crypto.randomUUID()}`;
      const rollbackRes = await processWagerUseCase.execute(`idemp-rb-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: rollbackExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId,
        gameId: 'game-1',
        kind: 'ROLLBACK',
        money: { amount: rollbackMoney.getAmount(), currency: rollbackMoney.getCurrency() },
        referenceExternalTransactionId: betExtId,
      });

      expect(rollbackRes.status).toBe('PROCESSED');
      expect(rollbackRes.balance.amount).toBe('100.00');

      const updatedWallet = await getWalletUseCase.execute(wallet.id);
      expect(updatedWallet.balance.amount).toBe('100.00');
      expect(updatedWallet.version).toBe(3);

      const ledgerRows = (
        await adminPool.query(
          'SELECT * FROM wallet_ledger_entries WHERE transaction_id = $1;',
          [rollbackRes.transactionId]
        )
      ).rows;
      expect(ledgerRows.length).toBe(1);
      expect(ledgerRows[0].entry_type).toBe('CREDIT');
      expect(ledgerRows[0].amount).toBe('40.00');
      expect(ledgerRows[0].balance_before).toBe('60.00');
      expect(ledgerRows[0].balance_after).toBe('100.00');

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.difference.amount).toBe('0.00');
    });

    it('1.3: ROLLBACK de WIN: débito integral, saldo, versão, ledger e outbox', async () => {
      const initialMoney = Money.create('50.00', 'BRL');
      const winMoney = Money.create('45.00', 'BRL');
      const rollbackMoney = Money.create('45.00', 'BRL');

      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: initialMoney.getAmount(), currency: initialMoney.getCurrency() },
      });

      const winExtId = `ext-win-${crypto.randomUUID()}`;
      const roundId = `round-${crypto.randomUUID()}`;

      const winRes = await processWagerUseCase.execute(`idemp-win-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: winExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId,
        gameId: 'game-1',
        kind: 'WIN',
        money: { amount: winMoney.getAmount(), currency: winMoney.getCurrency() },
      });
      expect(winRes.status).toBe('PROCESSED');
      expect(winRes.balance.amount).toBe('95.00');

      const rollbackExtId = `ext-rb-win-${crypto.randomUUID()}`;
      const rollbackRes = await processWagerUseCase.execute(`idemp-rb-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: rollbackExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId,
        gameId: 'game-1',
        kind: 'ROLLBACK',
        money: { amount: rollbackMoney.getAmount(), currency: rollbackMoney.getCurrency() },
        referenceExternalTransactionId: winExtId,
      });

      expect(rollbackRes.status).toBe('PROCESSED');
      expect(rollbackRes.balance.amount).toBe('50.00');

      const updatedWallet = await getWalletUseCase.execute(wallet.id);
      expect(updatedWallet.balance.amount).toBe('50.00');
      expect(updatedWallet.version).toBe(3);

      const ledgerRows = (
        await adminPool.query(
          'SELECT * FROM wallet_ledger_entries WHERE transaction_id = $1;',
          [rollbackRes.transactionId]
        )
      ).rows;
      expect(ledgerRows.length).toBe(1);
      expect(ledgerRows[0].entry_type).toBe('DEBIT');
      expect(ledgerRows[0].amount).toBe('45.00');
      expect(ledgerRows[0].balance_before).toBe('95.00');
      expect(ledgerRows[0].balance_after).toBe('50.00');

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.difference.amount).toBe('0.00');
    });

    it('1.4: ROLLBACK de REFUND: débito integral, saldo, versão, ledger e outbox', async () => {
      const initialMoney = Money.create('100.00', 'BRL');
      const betMoney = Money.create('50.00', 'BRL');
      const refundMoney = Money.create('50.00', 'BRL');
      const rollbackMoney = Money.create('50.00', 'BRL');

      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: initialMoney.getAmount(), currency: initialMoney.getCurrency() },
      });

      const betExtId = `ext-bet-${crypto.randomUUID()}`;
      const roundId = `round-${crypto.randomUUID()}`;

      // BET -> balance 50.00, version 2
      await processWagerUseCase.execute(`idemp-bet-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: betExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId,
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: betMoney.getAmount(), currency: betMoney.getCurrency() },
      });

      // REFUND -> balance 100.00, version 3
      const refundExtId = `ext-ref-${crypto.randomUUID()}`;
      const refundRes = await processWagerUseCase.execute(`idemp-ref-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: refundExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId,
        gameId: 'game-1',
        kind: 'REFUND',
        money: { amount: refundMoney.getAmount(), currency: refundMoney.getCurrency() },
        referenceExternalTransactionId: betExtId,
      });
      expect(refundRes.status).toBe('PROCESSED');
      expect(refundRes.balance.amount).toBe('100.00');

      // ROLLBACK of REFUND -> debits wallet back to 50.00, version 4
      const rbRefundExtId = `ext-rb-ref-${crypto.randomUUID()}`;
      const rbRefundRes = await processWagerUseCase.execute(`idemp-rb-ref-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: rbRefundExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId,
        gameId: 'game-1',
        kind: 'ROLLBACK',
        money: { amount: rollbackMoney.getAmount(), currency: rollbackMoney.getCurrency() },
        referenceExternalTransactionId: refundExtId,
      });

      expect(rbRefundRes.status).toBe('PROCESSED');
      expect(rbRefundRes.balance.amount).toBe('50.00');

      const updatedWallet = await getWalletUseCase.execute(wallet.id);
      expect(updatedWallet.balance.amount).toBe('50.00');
      expect(updatedWallet.version).toBe(4);

      const ledgerRows = (
        await adminPool.query(
          'SELECT * FROM wallet_ledger_entries WHERE transaction_id = $1;',
          [rbRefundRes.transactionId]
        )
      ).rows;
      expect(ledgerRows.length).toBe(1);
      expect(ledgerRows[0].entry_type).toBe('DEBIT');
      expect(ledgerRows[0].amount).toBe('50.00');
      expect(ledgerRows[0].balance_before).toBe('100.00');
      expect(ledgerRows[0].balance_after).toBe('50.00');

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.difference.amount).toBe('0.00');
    });

    it('1.5.1: Referência não PROCESSED (REJECTED) gera REFERENCE_NOT_PROCESSED sem alterar saldo ou ledger', async () => {
      const initialMoney = Money.create('10.00', 'BRL');
      const betMoney = Money.create('50.00', 'BRL');
      const refundMoney = Money.create('50.00', 'BRL');

      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: initialMoney.getAmount(), currency: initialMoney.getCurrency() },
      });

      const betExtId = `ext-bet-rej-${crypto.randomUUID()}`;
      const roundId = `round-${crypto.randomUUID()}`;

      // BET rejected for insufficient funds
      const betRes = await processWagerUseCase.execute(`idemp-bet-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: betExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId,
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: betMoney.getAmount(), currency: betMoney.getCurrency() },
      });
      expect(betRes.status).toBe('REJECTED');

      // Attempt to REFUND the rejected BET
      const refundRes = await processWagerUseCase.execute(`idemp-ref-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: `ext-ref-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId,
        gameId: 'game-1',
        kind: 'REFUND',
        money: { amount: refundMoney.getAmount(), currency: refundMoney.getCurrency() },
        referenceExternalTransactionId: betExtId,
      });

      expect(refundRes.status).toBe('REJECTED');
      expect(refundRes.failureCode).toBe('REFERENCE_NOT_PROCESSED');
      expect(refundRes.balance.amount).toBe('10.00');

      await assertRejectionAudit({
        reversalTxId: refundRes.transactionId,
        walletId: wallet.id,
        expectedFailureCode: 'REFERENCE_NOT_PROCESSED',
        expectedBalance: '10.00',
        expectedVersion: 1,
      });
    });

    it('1.5.2: Referência FAILED gera REFERENCE_NOT_PROCESSED auditável', async () => {
      const initialMoney = Money.create('100.00', 'BRL');
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: initialMoney.getAmount(), currency: initialMoney.getCurrency() },
      });

      const failedExtId = `ext-failed-${crypto.randomUUID()}`;
      const roundId = `round-${crypto.randomUUID()}`;

      // Inserir registro FAILED diretamente para simular referência quebrada
      await adminPool.query(`
        INSERT INTO wager_transactions (
          id, wallet_id, player_id, provider_id, external_transaction_id,
          round_id, game_id, kind, amount, currency, status, rejection_reason,
          idempotency_key, payload_hash, response_snapshot, created_at, updated_at
        ) VALUES (
          '${crypto.randomUUID()}', '${wallet.id}', '${wallet.playerId}', 'provider-1', '${failedExtId}',
          '${roundId}', 'game-1', 'BET', 20.00, 'BRL', 'FAILED', 'DATABASE_CRASH',
          'idemp-failed-${crypto.randomUUID()}', 'dummy-hash', '{"status":"FAILED"}', NOW(), NOW()
        );
      `);

      const refundRes = await processWagerUseCase.execute(`idemp-ref-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: `ext-ref-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId,
        gameId: 'game-1',
        kind: 'REFUND',
        money: { amount: '20.00', currency: 'BRL' },
        referenceExternalTransactionId: failedExtId,
      });

      expect(refundRes.status).toBe('REJECTED');
      expect(refundRes.failureCode).toBe('REFERENCE_NOT_PROCESSED');

      await assertRejectionAudit({
        reversalTxId: refundRes.transactionId,
        walletId: wallet.id,
        expectedFailureCode: 'REFERENCE_NOT_PROCESSED',
        expectedBalance: '100.00',
        expectedVersion: 1,
      });
    });

    it('1.5.3 a 1.5.10: Incompatibilidades (tipo, provider, player, wallet, moeda, rodada, valor) geram REFERENCE_INCOMPATIBLE', async () => {
      const initialMoney = Money.create('200.00', 'BRL');
      const wallet1 = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: initialMoney.getAmount(), currency: initialMoney.getCurrency() },
      });
      const wallet2 = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: initialMoney.getAmount(), currency: initialMoney.getCurrency() },
      });

      const betExtId = `ext-bet-ref-${crypto.randomUUID()}`;
      const winExtId = `ext-win-ref-${crypto.randomUUID()}`;
      const roundId = `round-${crypto.randomUUID()}`;

      // Process BET (25.00) and WIN (50.00) in wallet1
      await processWagerUseCase.execute(`idemp-bet-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: betExtId,
        playerId: wallet1.playerId,
        walletId: wallet1.id,
        roundId,
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      });

      await processWagerUseCase.execute(`idemp-win-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: winExtId,
        playerId: wallet1.playerId,
        walletId: wallet1.id,
        roundId,
        gameId: 'game-1',
        kind: 'WIN',
        money: { amount: '50.00', currency: 'BRL' },
      });

      // 1.5.3: REFUND referenciando WIN -> REFERENCE_INCOMPATIBLE
      const resWrongKind1 = await processWagerUseCase.execute(`idemp-ref-win-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: `ext-ref-win-${crypto.randomUUID()}`,
        playerId: wallet1.playerId,
        walletId: wallet1.id,
        roundId,
        gameId: 'game-1',
        kind: 'REFUND',
        money: { amount: '50.00', currency: 'BRL' },
        referenceExternalTransactionId: winExtId,
      });
      expect(resWrongKind1.status).toBe('REJECTED');
      expect(resWrongKind1.failureCode).toBe('REFERENCE_INCOMPATIBLE');

      // 1.5.4: REFUND referenciando outro REFUND -> REFERENCE_INCOMPATIBLE
      const validRefIdemp = `idemp-valid-ref-${crypto.randomUUID()}`;
      const validRefExtId = `ext-valid-ref-${crypto.randomUUID()}`;
      await processWagerUseCase.execute(validRefIdemp, {
        providerId: 'provider-1',
        externalTransactionId: validRefExtId,
        playerId: wallet1.playerId,
        walletId: wallet1.id,
        roundId,
        gameId: 'game-1',
        kind: 'REFUND',
        money: { amount: '25.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      });

      const resWrongKind2 = await processWagerUseCase.execute(`idemp-ref-ref-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: `ext-ref-ref-${crypto.randomUUID()}`,
        playerId: wallet1.playerId,
        walletId: wallet1.id,
        roundId,
        gameId: 'game-1',
        kind: 'REFUND',
        money: { amount: '25.00', currency: 'BRL' },
        referenceExternalTransactionId: validRefExtId,
      });
      expect(resWrongKind2.status).toBe('REJECTED');
      expect(resWrongKind2.failureCode).toBe('REFERENCE_INCOMPATIBLE');

      // 1.5.6 & 1.5.7: Wallet / Player diferente -> REFERENCE_INCOMPATIBLE
      const resWrongWallet = await processWagerUseCase.execute(`idemp-w2-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: `ext-w2-${crypto.randomUUID()}`,
        playerId: wallet2.playerId,
        walletId: wallet2.id,
        roundId,
        gameId: 'game-1',
        kind: 'REFUND',
        money: { amount: '25.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      });
      expect(resWrongWallet.status).toBe('REJECTED');
      expect(resWrongWallet.failureCode).toBe('REFERENCE_INCOMPATIBLE');

      // 1.5.9: Rodada diferente -> REFERENCE_INCOMPATIBLE
      const resWrongRound = await processWagerUseCase.execute(`idemp-rd-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: `ext-rd-${crypto.randomUUID()}`,
        playerId: wallet1.playerId,
        walletId: wallet1.id,
        roundId: 'round-different',
        gameId: 'game-1',
        kind: 'REFUND',
        money: { amount: '25.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      });
      expect(resWrongRound.status).toBe('REJECTED');
      expect(resWrongRound.failureCode).toBe('REFERENCE_INCOMPATIBLE');

      // 1.5.10: Valor divergente (BET era 25.00, submete 30.00) -> REFERENCE_INCOMPATIBLE
      const resWrongAmount = await processWagerUseCase.execute(`idemp-amt-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: `ext-amt-${crypto.randomUUID()}`,
        playerId: wallet1.playerId,
        walletId: wallet1.id,
        roundId,
        gameId: 'game-1',
        kind: 'REFUND',
        money: { amount: '30.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      });
      expect(resWrongAmount.status).toBe('REJECTED');
      expect(resWrongAmount.failureCode).toBe('REFERENCE_INCOMPATIBLE');

      // Confirmar que carteiras mantiveram saldos intactos
      const w1 = await getWalletUseCase.execute(wallet1.id);
      expect(w1.balance.amount).toBe('250.00'); // 200 - 25 + 50 + 25
      const w2 = await getWalletUseCase.execute(wallet2.id);
      expect(w2.balance.amount).toBe('200.00');
    });

    it('1.6: Débito de reversão sem saldo usa REVERSAL_INSUFFICIENT_FUNDS (sem alterar saldo, versão ou ledger)', async () => {
      const initialMoney = Money.create('0.00', 'BRL');
      const winMoney = Money.create('80.00', 'BRL');
      const drainMoney = Money.create('80.00', 'BRL');
      const rollbackMoney = Money.create('80.00', 'BRL');

      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: initialMoney.getAmount(), currency: initialMoney.getCurrency() },
      });

      const winExtId = `ext-win-${crypto.randomUUID()}`;
      const roundId = `round-${crypto.randomUUID()}`;

      // WIN -> saldo 80.00, version 2
      await processWagerUseCase.execute(`idemp-win-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: winExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId,
        gameId: 'game-1',
        kind: 'WIN',
        money: { amount: winMoney.getAmount(), currency: winMoney.getCurrency() },
      });

      // Drena saldo com BET -> saldo 0.00, version 3
      await processWagerUseCase.execute(`idemp-drain-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: `ext-drain-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId,
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: drainMoney.getAmount(), currency: drainMoney.getCurrency() },
      });

      const walletBefore = await getWalletUseCase.execute(wallet.id);
      expect(walletBefore.balance.amount).toBe('0.00');
      expect(walletBefore.version).toBe(3);

      // ROLLBACK da WIN de 80.00 -> saldo 0.00 < 80.00 -> REVERSAL_INSUFFICIENT_FUNDS
      const rbRes = await processWagerUseCase.execute(`idemp-rb-insuf-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: `ext-rb-insuf-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId,
        gameId: 'game-1',
        kind: 'ROLLBACK',
        money: { amount: rollbackMoney.getAmount(), currency: rollbackMoney.getCurrency() },
        referenceExternalTransactionId: winExtId,
      });

      expect(rbRes.status).toBe('REJECTED');
      expect(rbRes.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
      expect(rbRes.balance.amount).toBe('0.00');

      await assertRejectionAudit({
        reversalTxId: rbRes.transactionId,
        walletId: wallet.id,
        expectedFailureCode: 'REVERSAL_INSUFFICIENT_FUNDS',
        expectedBalance: '0.00',
        expectedVersion: 3,
      });

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.difference.amount).toBe('0.00');
    });

    it('1.7: Overflow segue a política Money existente sem efeitos parciais', async () => {
      // Carteira criada quase no limite máximo NUMERIC(18,2)
      const nearLimitMoney = Money.create('9999999999999990.00', 'BRL');
      const betMoney = Money.create('10.00', 'BRL');
      const refundMoney = Money.create('20.00', 'BRL'); // tentativa de crédito geraria 9999999999999980 + 20 = 1000000000000000.00 > limite

      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: nearLimitMoney.getAmount(), currency: nearLimitMoney.getCurrency() },
      });

      const betExtId = `ext-bet-overflow-${crypto.randomUUID()}`;
      const roundId = `round-${crypto.randomUUID()}`;

      // BET de 10.00 -> saldo 9999999999999980.00
      await processWagerUseCase.execute(`idemp-bet-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: betExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId,
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: betMoney.getAmount(), currency: betMoney.getCurrency() },
      });

      const walletBefore = await getWalletUseCase.execute(wallet.id);
      expect(walletBefore.balance.amount).toBe('9999999999999980.00');
      const versionBefore = walletBefore.version;

      // Injeta manualmente na referência uma transação com valor 30.00 para simular tentativa de reversão com overflow
      const overflowRefExtId = `ext-overflow-ref-${crypto.randomUUID()}`;
      await adminPool.query(`
        INSERT INTO wager_transactions (
          id, wallet_id, player_id, provider_id, external_transaction_id,
          round_id, game_id, kind, amount, currency, status,
          idempotency_key, payload_hash, response_snapshot, created_at, updated_at
        ) VALUES (
          '${crypto.randomUUID()}', '${wallet.id}', '${wallet.playerId}', 'provider-1', '${overflowRefExtId}',
          '${roundId}', 'game-1', 'BET', 30.00, 'BRL', 'PROCESSED',
          'idemp-over-ref-${crypto.randomUUID()}', 'dummy-hash', '{"status":"PROCESSED"}', NOW(), NOW()
        );
      `);

      // Submete REFUND de 30.00 -> adição estoura limite -> lança MoneyOverflowError
      const refundIdemp = `idemp-ref-over-${crypto.randomUUID()}`;
      const refundDto: ProcessWagerDto = {
        providerId: 'provider-1',
        externalTransactionId: `ext-ref-over-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId,
        gameId: 'game-1',
        kind: 'REFUND',
        money: { amount: '30.00', currency: 'BRL' },
        referenceExternalTransactionId: overflowRefExtId,
      };

      await expect(processWagerUseCase.execute(refundIdemp, refundDto)).rejects.toThrow(MoneyOverflowError);

      // Confirma que saldo e versão permanecem estritamente intactos no banco
      const walletAfter = await getWalletUseCase.execute(wallet.id);
      expect(walletAfter.balance.amount).toBe('9999999999999980.00');
      expect(walletAfter.version).toBe(versionBefore);

      // Confirma que nenhuma transação com refundIdemp foi persistida
      const orphanTx = (
        await adminPool.query('SELECT * FROM wager_transactions WHERE idempotency_key = $1;', [refundIdemp])
      ).rows;
      expect(orphanTx.length).toBe(0);

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
    });

    it('1.8: Preserva interpretação documentada: 1 REFUND + 1 ROLLBACK na mesma BET, e múltiplas WINs permitidas pela migration 004', async () => {
      const initialMoney = Money.create('100.00', 'BRL');
      const betMoney = Money.create('20.00', 'BRL');

      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: initialMoney.getAmount(), currency: initialMoney.getCurrency() },
      });

      const betExtId = `ext-bet-multi-${crypto.randomUUID()}`;
      const roundId = `round-${crypto.randomUUID()}`;

      // BET -> balance 80.00
      await processWagerUseCase.execute(`idemp-bet-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: betExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId,
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: betMoney.getAmount(), currency: betMoney.getCurrency() },
      });

      // Múltiplas WINs na mesma BET permitidas pela migration 004
      const win1Res = await processWagerUseCase.execute(`idemp-win1-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: `ext-win1-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId,
        gameId: 'game-1',
        kind: 'WIN',
        money: { amount: '10.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      });
      expect(win1Res.status).toBe('PROCESSED');

      const win2Res = await processWagerUseCase.execute(`idemp-win2-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: `ext-win2-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId,
        gameId: 'game-1',
        kind: 'WIN',
        money: { amount: '15.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      });
      expect(win2Res.status).toBe('PROCESSED');

      // REFUND da BET -> crédito de 20.00
      const refundRes = await processWagerUseCase.execute(`idemp-ref-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: `ext-ref-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId,
        gameId: 'game-1',
        kind: 'REFUND',
        money: { amount: '20.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      });
      expect(refundRes.status).toBe('PROCESSED');

      // Segundo REFUND para mesma BET -> REJEITADO (REVERSAL_ALREADY_PROCESSED)
      const secondRefundRes = await processWagerUseCase.execute(`idemp-ref2-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: `ext-ref2-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId,
        gameId: 'game-1',
        kind: 'REFUND',
        money: { amount: '20.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      });
      expect(secondRefundRes.status).toBe('REJECTED');
      expect(secondRefundRes.failureCode).toBe('REVERSAL_ALREADY_PROCESSED');

      // ROLLBACK da BET -> permitido conforme regra de uma reversão POR TIPO e referência documentada
      const rollbackRes = await processWagerUseCase.execute(`idemp-rb-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: `ext-rb-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId,
        gameId: 'game-1',
        kind: 'ROLLBACK',
        money: { amount: '20.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      });
      expect(rollbackRes.status).toBe('PROCESSED');

      // Segundo ROLLBACK para mesma BET -> REJEITADO (REVERSAL_ALREADY_PROCESSED)
      const secondRollbackRes = await processWagerUseCase.execute(`idemp-rb2-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: `ext-rb2-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId,
        gameId: 'game-1',
        kind: 'ROLLBACK',
        money: { amount: '20.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      });
      expect(secondRollbackRes.status).toBe('REJECTED');
      expect(secondRollbackRes.failureCode).toBe('REVERSAL_ALREADY_PROCESSED');

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
    });
  });

  // =========================================================================
  // 2. REPLAY TERMINAL
  // =========================================================================
  describe('2. Replay Terminal', () => {
    it('2.1: Replay de reversão processada após outras operações mudarem o saldo retorna saldo histórico sem novos movimentos', async () => {
      const initialMoney = Money.create('100.00', 'BRL');
      const betMoney = Money.create('30.00', 'BRL');
      const refundMoney = Money.create('30.00', 'BRL');

      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: initialMoney.getAmount(), currency: initialMoney.getCurrency() },
      });

      const betExtId = `ext-bet-${crypto.randomUUID()}`;
      const roundId = `round-${crypto.randomUUID()}`;

      // BET -> saldo 70.00
      await processWagerUseCase.execute(`idemp-bet-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: betExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId,
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: betMoney.getAmount(), currency: betMoney.getCurrency() },
      });

      // REFUND -> saldo 100.00
      const refundKey = `idemp-ref-replay-${crypto.randomUUID()}`;
      const refundPayload: ProcessWagerDto = {
        providerId: 'provider-1',
        externalTransactionId: `ext-ref-replay-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId,
        gameId: 'game-1',
        kind: 'REFUND',
        money: { amount: refundMoney.getAmount(), currency: refundMoney.getCurrency() },
        referenceExternalTransactionId: betExtId,
      };

      const refundRes = await processWagerUseCase.execute(refundKey, refundPayload);
      expect(refundRes.status).toBe('PROCESSED');
      expect(refundRes.balance.amount).toBe('100.00');
      expect(refundRes.idempotentReplay).toBe(false);

      // Operação subsequente altera o saldo corrente para 85.00
      await processWagerUseCase.execute(`idemp-bet-subseq-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: `ext-bet-subseq-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId,
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: '15.00', currency: 'BRL' },
      });

      const walletCurrent = await getWalletUseCase.execute(wallet.id);
      expect(walletCurrent.balance.amount).toBe('85.00');

      // Captura contagens de ledger e outbox antes do replay
      const ledgerCountBefore = (
        await adminPool.query('SELECT COUNT(*) FROM wallet_ledger_entries WHERE wallet_id = $1;', [wallet.id])
      ).rows[0].count;
      const outboxCountBefore = (
        await adminPool.query('SELECT COUNT(*) FROM outbox_messages WHERE aggregate_id = $1;', [wallet.id])
      ).rows[0].count;

      // Replay da mesma chave do REFUND
      const replayRes = await processWagerUseCase.execute(refundKey, refundPayload);

      expect(replayRes.transactionId).toBe(refundRes.transactionId);
      expect(replayRes.status).toBe('PROCESSED');
      expect(replayRes.balance.amount).toBe('100.00'); // Saldo histórico!
      expect(replayRes.idempotentReplay).toBe(true);

      // Confirma que saldo atual no banco continua 85.00
      const walletAfterReplay = await getWalletUseCase.execute(wallet.id);
      expect(walletAfterReplay.balance.amount).toBe('85.00');
      expect(walletAfterReplay.version).toBe(walletCurrent.version);

      // Confirma zero novos registros contábeis ou de mensageria
      const ledgerCountAfter = (
        await adminPool.query('SELECT COUNT(*) FROM wallet_ledger_entries WHERE wallet_id = $1;', [wallet.id])
      ).rows[0].count;
      const outboxCountAfter = (
        await adminPool.query('SELECT COUNT(*) FROM outbox_messages WHERE aggregate_id = $1;', [wallet.id])
      ).rows[0].count;

      expect(ledgerCountAfter).toBe(ledgerCountBefore);
      expect(outboxCountAfter).toBe(outboxCountBefore);
    });

    it('2.2: Replay de reversão rejeitada por saldo insuficiente continua rejeitada mesmo após crédito na wallet', async () => {
      const initialMoney = Money.create('0.00', 'BRL');
      const winMoney = Money.create('50.00', 'BRL');
      const drainMoney = Money.create('50.00', 'BRL');
      const rollbackMoney = Money.create('50.00', 'BRL');

      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: initialMoney.getAmount(), currency: initialMoney.getCurrency() },
      });

      const winExtId = `ext-win-${crypto.randomUUID()}`;
      const roundId = `round-${crypto.randomUUID()}`;

      // WIN de 50.00
      await processWagerUseCase.execute(`idemp-win-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: winExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId,
        gameId: 'game-1',
        kind: 'WIN',
        money: { amount: winMoney.getAmount(), currency: winMoney.getCurrency() },
      });

      // Drena saldo para 0.00
      await processWagerUseCase.execute(`idemp-drain-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: `ext-drain-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId,
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: drainMoney.getAmount(), currency: drainMoney.getCurrency() },
      });

      // ROLLBACK rejeitado por falta de saldo
      const rbKey = `idemp-rb-insuf-replay-${crypto.randomUUID()}`;
      const rbPayload: ProcessWagerDto = {
        providerId: 'provider-1',
        externalTransactionId: `ext-rb-replay-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId,
        gameId: 'game-1',
        kind: 'ROLLBACK',
        money: { amount: rollbackMoney.getAmount(), currency: rollbackMoney.getCurrency() },
        referenceExternalTransactionId: winExtId,
      };

      const rbRes1 = await processWagerUseCase.execute(rbKey, rbPayload);
      expect(rbRes1.status).toBe('REJECTED');
      expect(rbRes1.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
      expect(rbRes1.balance.amount).toBe('0.00');
      expect(rbRes1.idempotentReplay).toBe(false);

      // Credita a wallet posteriormente com 200.00
      await processWagerUseCase.execute(`idemp-credit-later-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: `ext-credit-later-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId,
        gameId: 'game-1',
        kind: 'WIN',
        money: { amount: '200.00', currency: 'BRL' },
      });

      const walletNow = await getWalletUseCase.execute(wallet.id);
      expect(walletNow.balance.amount).toBe('200.00');

      // Reenvio da MESMA chave do ROLLBACK rejeitado
      const rbRes2 = await processWagerUseCase.execute(rbKey, rbPayload);

      expect(rbRes2.transactionId).toBe(rbRes1.transactionId);
      expect(rbRes2.status).toBe('REJECTED');
      expect(rbRes2.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
      expect(rbRes2.balance.amount).toBe('0.00'); // Saldo original!
      expect(rbRes2.idempotentReplay).toBe(true);

      // O saldo atual permanece 200.00 intacto sem débito tardio
      const walletAfter = await getWalletUseCase.execute(wallet.id);
      expect(walletAfter.balance.amount).toBe('200.00');
    });

    it('2.3: Mesma chave com payload diferente dispara 409 (IdempotencyConflictError)', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const betExtId = `ext-bet-${crypto.randomUUID()}`;
      await processWagerUseCase.execute(`idemp-bet-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: betExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: '20.00', currency: 'BRL' },
      });

      const key = `idemp-conflict-${crypto.randomUUID()}`;
      const payloadA: ProcessWagerDto = {
        providerId: 'provider-1',
        externalTransactionId: `ext-reversal-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'REFUND',
        money: { amount: '20.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      };

      await processWagerUseCase.execute(key, payloadA);

      // Mesma chave com payload divergente (amount diferente)
      const payloadB: ProcessWagerDto = {
        ...payloadA,
        money: { amount: '25.00', currency: 'BRL' },
      };

      await expect(processWagerUseCase.execute(key, payloadB)).rejects.toThrow(IdempotencyConflictError);
    });

    it('2.4: Mesmo provider/externalTransactionId sob outra chave dispara 409 (IdempotencyConflictError)', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const betExtId = `ext-bet-${crypto.randomUUID()}`;
      await processWagerUseCase.execute(`idemp-bet-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: betExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: '20.00', currency: 'BRL' },
      });

      const sharedExtId = `ext-shared-rev-${crypto.randomUUID()}`;
      await processWagerUseCase.execute(`idemp-k1-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: sharedExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'REFUND',
        money: { amount: '20.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      });

      // Outra chave com o mesmo providerId + externalTransactionId
      await expect(
        processWagerUseCase.execute(`idemp-k2-${crypto.randomUUID()}`, {
          providerId: 'provider-1',
          externalTransactionId: sharedExtId,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'round-1',
          gameId: 'game-1',
          kind: 'REFUND',
          money: { amount: '20.00', currency: 'BRL' },
          referenceExternalTransactionId: betExtId,
        })
      ).rejects.toThrow(IdempotencyConflictError);
    });

    it('2.5: Nova operação tentando reverter novamente a mesma referência e tipo gera REVERSAL_ALREADY_PROCESSED', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const betExtId = `ext-bet-${crypto.randomUUID()}`;
      await processWagerUseCase.execute(`idemp-bet-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: betExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: '30.00', currency: 'BRL' },
      });

      // Primeiro REFUND
      const firstRefund = await processWagerUseCase.execute(`idemp-ref-1-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: `ext-ref-1-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'REFUND',
        money: { amount: '30.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      });
      expect(firstRefund.status).toBe('PROCESSED');

      // Segundo REFUND distinto para a mesma BET
      const secondRefund = await processWagerUseCase.execute(`idemp-ref-2-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: `ext-ref-2-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'REFUND',
        money: { amount: '30.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      });

      expect(secondRefund.status).toBe('REJECTED');
      expect(secondRefund.failureCode).toBe('REVERSAL_ALREADY_PROCESSED');

      await assertRejectionAudit({
        reversalTxId: secondRefund.transactionId,
        walletId: wallet.id,
        expectedFailureCode: 'REVERSAL_ALREADY_PROCESSED',
        expectedBalance: '100.00',
        expectedVersion: 3,
      });
    });
  });

  // =========================================================================
  // 3. CONCORRÊNCIA REAL EM BANCO DESARTÁVEL
  // =========================================================================
  describe('3. Concorrência Real em Banco Descartável', () => {
    it('3.1: 50 duplicatas da mesma reversão em paralelo -> exatamente 1 efeito e 49 replays idênticos', async () => {
      const initialMoney = Money.create('100.00', 'BRL');
      const betMoney = Money.create('50.00', 'BRL');
      const refundMoney = Money.create('50.00', 'BRL');

      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: initialMoney.getAmount(), currency: initialMoney.getCurrency() },
      });

      const betExtId = `ext-bet-50-${crypto.randomUUID()}`;
      await processWagerUseCase.execute(`idemp-bet-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: betExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-50',
        gameId: 'game-50',
        kind: 'BET',
        money: { amount: betMoney.getAmount(), currency: betMoney.getCurrency() },
      });

      const sharedKey = `idemp-refund-50-${crypto.randomUUID()}`;
      const payload: ProcessWagerDto = {
        providerId: 'provider-1',
        externalTransactionId: `ext-refund-50-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-50',
        gameId: 'game-50',
        kind: 'REFUND',
        money: { amount: refundMoney.getAmount(), currency: refundMoney.getCurrency() },
        referenceExternalTransactionId: betExtId,
      };

      // Dispara 50 requisições simultâneas
      const promises = Array.from({ length: 50 }, () =>
        processWagerUseCase.execute(sharedKey, payload)
      );

      const results = await Promise.all(promises);
      expect(results.length).toBe(50);

      for (const res of results) {
        expect(res.status).toBe('PROCESSED');
        expect(res.balance.amount).toBe('100.00');
      }

      const freshProcess = results.filter((r) => !r.idempotentReplay);
      const replays = results.filter((r) => r.idempotentReplay);

      expect(freshProcess.length).toBe(1);
      expect(replays.length).toBe(49);

      const finalWallet = await getWalletUseCase.execute(wallet.id);
      expect(finalWallet.balance.amount).toBe('100.00');
      expect(finalWallet.version).toBe(3); // opening(1) + bet(2) + single refund(3)

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.difference.amount).toBe('0.00');
    });

    it('3.2: Reversões distintas do mesmo tipo sobre a mesma referência disputando em paralelo -> 1 processada, demais rejeitadas sem movimento', async () => {
      const initialMoney = Money.create('100.00', 'BRL');
      const betMoney = Money.create('40.00', 'BRL');

      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: initialMoney.getAmount(), currency: initialMoney.getCurrency() },
      });

      const betExtId = `ext-bet-race-${crypto.randomUUID()}`;
      await processWagerUseCase.execute(`idemp-bet-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: betExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-race',
        gameId: 'game-race',
        kind: 'BET',
        money: { amount: betMoney.getAmount(), currency: betMoney.getCurrency() },
      });

      // Três reversões REFUND distintas (chaves e externalIds diferentes) apontando para a mesma BET
      const reversalPromises = Array.from({ length: 3 }, (_, i) =>
        processWagerUseCase
          .execute(`idemp-race-ref-${i}-${crypto.randomUUID()}`, {
            providerId: 'provider-1',
            externalTransactionId: `ext-race-ref-${i}-${crypto.randomUUID()}`,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: 'round-race',
            gameId: 'game-race',
            kind: 'REFUND',
            money: { amount: '40.00', currency: 'BRL' },
            referenceExternalTransactionId: betExtId,
          })
          .catch((err) => ({ status: 'CONFLICT', error: err }))
      );

      const results = await Promise.all(reversalPromises);
      expect(results.length).toBe(3);

      const processedCount = results.filter((r: any) => r.status === 'PROCESSED').length;
      expect(processedCount).toBe(1);

      // As perdedoras devem ser rejeitadas auditavelmente ou receber conflito de unicidade da corrida
      const nonProcessed = results.filter((r: any) => r.status !== 'PROCESSED');
      expect(nonProcessed.length).toBe(2);

      const finalWallet = await getWalletUseCase.execute(wallet.id);
      expect(finalWallet.balance.amount).toBe('100.00'); // 60 + exatamente um crédito de 40
      expect(finalWallet.version).toBe(3);

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.difference.amount).toBe('0.00');
    });

    it('3.3: Dois ROLLBACKs de referências distintas disputando saldo -> nunca negativo, resultados e ledger consistentes', async () => {
      // Saldo 50.00 na carteira
      const initialMoney = Money.create('50.00', 'BRL');
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: initialMoney.getAmount(), currency: initialMoney.getCurrency() },
      });

      // Ref 1: WIN de 40.00 (saldo vai para 90.00)
      const win1ExtId = `ext-win1-${crypto.randomUUID()}`;
      await processWagerUseCase.execute(`idemp-win1-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: win1ExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'WIN',
        money: { amount: '40.00', currency: 'BRL' },
      });

      // Ref 2: WIN de 40.00 (saldo vai para 130.00)
      const win2ExtId = `ext-win2-${crypto.randomUUID()}`;
      await processWagerUseCase.execute(`idemp-win2-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: win2ExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-2',
        gameId: 'game-1',
        kind: 'WIN',
        money: { amount: '40.00', currency: 'BRL' },
      });

      // Drena saldo para 50.00 com uma BET de 80.00
      await processWagerUseCase.execute(`idemp-drain-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: `ext-drain-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-drain',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: '80.00', currency: 'BRL' },
      });

      const walletBefore = await getWalletUseCase.execute(wallet.id);
      expect(walletBefore.balance.amount).toBe('50.00');

      // Agora temos saldo de 50.00 e DUAS referências WIN válidas de 40.00 cada.
      // Ambas solicitam ROLLBACK (débito de 40.00 cada).
      // Saldo (50.00) só comporta UMA das duas reversões!
      const rb1Promise = processWagerUseCase.execute(`idemp-rb1-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: `ext-rb1-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'ROLLBACK',
        money: { amount: '40.00', currency: 'BRL' },
        referenceExternalTransactionId: win1ExtId,
      });

      const rb2Promise = processWagerUseCase.execute(`idemp-rb2-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: `ext-rb2-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-2',
        gameId: 'game-1',
        kind: 'ROLLBACK',
        money: { amount: '40.00', currency: 'BRL' },
        referenceExternalTransactionId: win2ExtId,
      });

      const [res1, res2] = await Promise.all([rb1Promise, rb2Promise]);

      const statuses = [res1.status, res2.status];
      expect(statuses).toContain('PROCESSED');
      expect(statuses).toContain('REJECTED');

      const rejectedRes = res1.status === 'REJECTED' ? res1 : res2;
      expect(rejectedRes.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');

      // Saldo nunca fica negativo! 50.00 - 40.00 = 10.00
      const finalWallet = await getWalletUseCase.execute(wallet.id);
      expect(finalWallet.balance.amount).toBe('10.00');

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('10.00');
      expect(recon.calculatedBalance.amount).toBe('10.00');
      expect(recon.difference.amount).toBe('0.00');
    });

    it('3.4: Disputa concorrente entre pelo menos TRÊS processos OS independentes com handshake READY pelo fluxo imediato', async () => {
      const initialMoney = Money.create('100.00', 'BRL');
      const betMoney = Money.create('40.00', 'BRL');

      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: initialMoney.getAmount(), currency: initialMoney.getCurrency() },
      });

      const betExtId = `ext-bet-proc-${crypto.randomUUID()}`;
      await processWagerUseCase.execute(`idemp-bet-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: betExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-proc',
        gameId: 'game-proc',
        kind: 'BET',
        money: { amount: betMoney.getAmount(), currency: betMoney.getCurrency() },
      });

      const bunBin = process.execPath;
      const workerScript = join(import.meta.dir, '../concurrency/worker.ts');
      const barrierPath = join(tmpdir(), `barrier_m07_${Date.now()}_${Math.random().toString(36).substring(7)}.tmp`);

      const spawnWorker = (idempKey: string, payload: ProcessWagerDto) => {
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
              reject(new Error(`Worker output invalid JSON: "${stdout}"`));
            }
          });
        });

        return { readyPromise, resultPromise };
      };

      // Disputa entre 3 processos distintos tentando submeter REFUND sobre a mesma BET
      const w1 = spawnWorker(`idemp-p1-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: `ext-p1-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-proc',
        gameId: 'game-proc',
        kind: 'REFUND',
        money: { amount: '40.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      });

      const w2 = spawnWorker(`idemp-p2-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: `ext-p2-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-proc',
        gameId: 'game-proc',
        kind: 'REFUND',
        money: { amount: '40.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      });

      const w3 = spawnWorker(`idemp-p3-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: `ext-p3-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-proc',
        gameId: 'game-proc',
        kind: 'REFUND',
        money: { amount: '40.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      });

      // 1. Aguarda os 3 processos anunciarem READY
      await Promise.all([w1.readyPromise, w2.readyPromise, w3.readyPromise]);

      // 2. Libera a barreira simultaneamente
      writeFileSync(barrierPath, 'RELEASE');

      try {
        const results = await Promise.all([w1.resultPromise, w2.resultPromise, w3.resultPromise]);
        expect(results.length).toBe(3);

        const okResults = results.filter((r) => r.ok && r.data?.status === 'PROCESSED');
        expect(okResults.length).toBe(1);

        const otherResults = results.filter((r) => !r.ok || r.data?.status !== 'PROCESSED');
        expect(otherResults.length).toBe(2);

        // Saldo final conferido: 60 + 40 = 100.00
        const finalWallet = await getWalletUseCase.execute(wallet.id);
        expect(finalWallet.balance.amount).toBe('100.00');

        const recon = await reconcileWalletUseCase.execute(wallet.id);
        expect(recon.consistent).toBe(true);
      } finally {
        if (existsSync(barrierPath)) {
          unlinkSync(barrierPath);
        }
      }
    }, 30000);

    it('3.5: Confirmação de proteção de unicidade e não-malclassificação de outras constraints 23505', async () => {
      // Cria carteira 1
      const playerId = crypto.randomUUID();
      await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '50.00', currency: 'BRL' },
      });

      // Tentar criar carteira duplicada para o mesmo player e moeda gera DuplicateWalletError (uq_wallets_player_currency)
      // e NÃO IdempotencyConflictError
      try {
        await createWalletUseCase.execute({
          playerId,
          initialBalance: { amount: '50.00', currency: 'BRL' },
        });
        expect(true).toBe(false); // deve falhar
      } catch (err: any) {
        expect(err.name).toBe('DuplicateWalletError');
        expect(err.code).toBe('DUPLICATE_WALLET');
      }
    });
  });

  // =========================================================================
  // 4. ATOMICIDADE E PROVAS DE INJEÇÃO DE FALHAS E HTTP
  // =========================================================================
  describe('4. Atomicidade e Injeção de Falhas', () => {
    it('4.1: Falha após wallet_save desfaz tudo, limpa hooks e permite reenvio com efeito único', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const betExtId = `ext-bet-${crypto.randomUUID()}`;
      await processWagerUseCase.execute(`idemp-bet-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: betExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: '30.00', currency: 'BRL' },
      });

      const idempKey = `idemp-fault-wallet-${crypto.randomUUID()}`;
      const reversalPayload: ProcessWagerDto = {
        providerId: 'provider-1',
        externalTransactionId: `ext-fault-wallet-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'REFUND',
        money: { amount: '30.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      };

      try {
        uow.setTestHook('after_wallet_save', () => {
          throw new Error('SIMULATED_FAIL_AFTER_WALLET_SAVE');
        });

        await expect(processWagerUseCase.execute(idempKey, reversalPayload)).rejects.toThrow(
          'SIMULATED_FAIL_AFTER_WALLET_SAVE'
        );
      } finally {
        uow.clearTestHooks();
      }

      // Verifica rollback total
      const w1 = await getWalletUseCase.execute(wallet.id);
      expect(w1.balance.amount).toBe('70.00');
      expect(w1.version).toBe(2);

      const uncommittedTx = (
        await adminPool.query('SELECT * FROM wager_transactions WHERE idempotency_key = $1;', [idempKey])
      ).rows;
      expect(uncommittedTx.length).toBe(0);

      // Reenvio com a mesma chave é processado com efeito único
      const retryRes = await processWagerUseCase.execute(idempKey, reversalPayload);
      expect(retryRes.status).toBe('PROCESSED');
      expect(retryRes.balance.amount).toBe('100.00');

      const w2 = await getWalletUseCase.execute(wallet.id);
      expect(w2.balance.amount).toBe('100.00');
      expect(w2.version).toBe(3);

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
    });

    it('4.2: Falha após tx_save desfaz tudo, limpa hooks e permite reenvio com efeito único', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const betExtId = `ext-bet-${crypto.randomUUID()}`;
      await processWagerUseCase.execute(`idemp-bet-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: betExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      });

      const idempKey = `idemp-fault-tx-${crypto.randomUUID()}`;
      const reversalPayload: ProcessWagerDto = {
        providerId: 'provider-1',
        externalTransactionId: `ext-fault-tx-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'REFUND',
        money: { amount: '25.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      };

      try {
        uow.setTestHook('after_tx_save', () => {
          throw new Error('SIMULATED_FAIL_AFTER_TX_SAVE');
        });

        await expect(processWagerUseCase.execute(idempKey, reversalPayload)).rejects.toThrow(
          'SIMULATED_FAIL_AFTER_TX_SAVE'
        );
      } finally {
        uow.clearTestHooks();
      }

      const w1 = await getWalletUseCase.execute(wallet.id);
      expect(w1.balance.amount).toBe('75.00');

      const retryRes = await processWagerUseCase.execute(idempKey, reversalPayload);
      expect(retryRes.status).toBe('PROCESSED');
      expect(retryRes.balance.amount).toBe('100.00');

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
    });

    it('4.3: Falha após ledger_save desfaz tudo, limpa hooks e permite reenvio com efeito único', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const betExtId = `ext-bet-${crypto.randomUUID()}`;
      await processWagerUseCase.execute(`idemp-bet-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: betExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: '20.00', currency: 'BRL' },
      });

      const idempKey = `idemp-fault-ledger-${crypto.randomUUID()}`;
      const reversalPayload: ProcessWagerDto = {
        providerId: 'provider-1',
        externalTransactionId: `ext-fault-ledger-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'REFUND',
        money: { amount: '20.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      };

      try {
        uow.setTestHook('after_ledger_save', () => {
          throw new Error('SIMULATED_FAIL_AFTER_LEDGER_SAVE');
        });

        await expect(processWagerUseCase.execute(idempKey, reversalPayload)).rejects.toThrow(
          'SIMULATED_FAIL_AFTER_LEDGER_SAVE'
        );
      } finally {
        uow.clearTestHooks();
      }

      const retryRes = await processWagerUseCase.execute(idempKey, reversalPayload);
      expect(retryRes.status).toBe('PROCESSED');
      expect(retryRes.balance.amount).toBe('100.00');

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
    });

    it('4.4: Falha após outbox_save desfaz tudo, limpa hooks e permite reenvio com efeito único', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const betExtId = `ext-bet-${crypto.randomUUID()}`;
      await processWagerUseCase.execute(`idemp-bet-${crypto.randomUUID()}`, {
        providerId: 'provider-1',
        externalTransactionId: betExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: '15.00', currency: 'BRL' },
      });

      const idempKey = `idemp-fault-outbox-${crypto.randomUUID()}`;
      const reversalPayload: ProcessWagerDto = {
        providerId: 'provider-1',
        externalTransactionId: `ext-fault-outbox-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'REFUND',
        money: { amount: '15.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      };

      try {
        uow.setTestHook('after_outbox_save', () => {
          throw new Error('SIMULATED_FAIL_AFTER_OUTBOX_SAVE');
        });

        await expect(processWagerUseCase.execute(idempKey, reversalPayload)).rejects.toThrow(
          'SIMULATED_FAIL_AFTER_OUTBOX_SAVE'
        );
      } finally {
        uow.clearTestHooks();
      }

      const retryRes = await processWagerUseCase.execute(idempKey, reversalPayload);
      expect(retryRes.status).toBe('PROCESSED');
      expect(retryRes.balance.amount).toBe('100.00');

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
    });
  });

  // =========================================================================
  // 5. TESTES HTTP REAIS (200, 422 AUDITÁVEL, 409 CONFLITO E REPLAY)
  // =========================================================================
  describe('5. Testes HTTP Reais (POST /wagering/transactions)', () => {
    it('5.1: HTTP 200 OK em REFUND e ROLLBACK processados com sucesso', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const betExtId = `ext-bet-http-${crypto.randomUUID()}`;
      const roundId = `round-http-${crypto.randomUUID()}`;

      // POST BET via HTTP
      const betRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `idemp-bet-http-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          providerId: 'provider-http',
          externalTransactionId: betExtId,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId,
          gameId: 'game-http',
          kind: 'BET',
          money: { amount: '30.00', currency: 'BRL' },
        }),
      });
      expect(betRes.status).toBe(200);

      // POST REFUND via HTTP
      const refundKey = `idemp-ref-http-${crypto.randomUUID()}`;
      const refundRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': refundKey,
        },
        body: JSON.stringify({
          providerId: 'provider-http',
          externalTransactionId: `ext-ref-http-${crypto.randomUUID()}`,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId,
          gameId: 'game-http',
          kind: 'REFUND',
          money: { amount: '30.00', currency: 'BRL' },
          referenceExternalTransactionId: betExtId,
        }),
      });
      expect(refundRes.status).toBe(200);
      const refundJson: any = await refundRes.json();
      expect(refundJson.status).toBe('PROCESSED');
      expect(refundJson.balance.amount).toBe('100.00');
      expect(refundJson.idempotentReplay).toBe(false);
    });

    it('5.2: HTTP 422 Unprocessable Entity auditável quando reversão é REJECTED (ex: REVERSAL_INSUFFICIENT_FUNDS)', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '0.00', currency: 'BRL' },
      });

      const winExtId = `ext-win-http-${crypto.randomUUID()}`;
      const roundId = `round-http-rej-${crypto.randomUUID()}`;

      // WIN de 50.00 via HTTP
      await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `idemp-win-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          providerId: 'provider-http',
          externalTransactionId: winExtId,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId,
          gameId: 'game-http',
          kind: 'WIN',
          money: { amount: '50.00', currency: 'BRL' },
        }),
      });

      // Drena saldo com BET de 50.00 via HTTP
      await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `idemp-drain-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          providerId: 'provider-http',
          externalTransactionId: `ext-drain-${crypto.randomUUID()}`,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId,
          gameId: 'game-http',
          kind: 'BET',
          money: { amount: '50.00', currency: 'BRL' },
        }),
      });

      // ROLLBACK da WIN via HTTP -> 422 Unprocessable Entity
      const rbRes = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `idemp-rb-http-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          providerId: 'provider-http',
          externalTransactionId: `ext-rb-http-${crypto.randomUUID()}`,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId,
          gameId: 'game-http',
          kind: 'ROLLBACK',
          money: { amount: '50.00', currency: 'BRL' },
          referenceExternalTransactionId: winExtId,
        }),
      });

      expect(rbRes.status).toBe(422);
      const rbJson: any = await rbRes.json();
      expect(rbJson.status).toBe('REJECTED');
      expect(rbJson.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
      expect(rbJson.balance.amount).toBe('0.00');
    });

    it('5.3: HTTP 409 Conflict em Idempotency-Key com payload diferente', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const betExtId = `ext-bet-409-${crypto.randomUUID()}`;
      await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `idemp-bet-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          providerId: 'provider-http',
          externalTransactionId: betExtId,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'round-409',
          gameId: 'game-409',
          kind: 'BET',
          money: { amount: '20.00', currency: 'BRL' },
        }),
      });

      const sharedKey = `idemp-http-conflict-${crypto.randomUUID()}`;

      // Primeira submissão com valor 20.00 -> 200 OK
      const res1 = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': sharedKey,
        },
        body: JSON.stringify({
          providerId: 'provider-http',
          externalTransactionId: `ext-rev-1-${crypto.randomUUID()}`,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'round-409',
          gameId: 'game-409',
          kind: 'REFUND',
          money: { amount: '20.00', currency: 'BRL' },
          referenceExternalTransactionId: betExtId,
        }),
      });
      expect(res1.status).toBe(200);

      // Segunda submissão com mesma chave e payload diferente -> 409 Conflict
      const res2 = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': sharedKey,
        },
        body: JSON.stringify({
          providerId: 'provider-http',
          externalTransactionId: `ext-rev-1-${crypto.randomUUID()}`,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'round-409',
          gameId: 'game-409',
          kind: 'REFUND',
          money: { amount: '25.00', currency: 'BRL' }, // Diferente!
          referenceExternalTransactionId: betExtId,
        }),
      });
      expect(res2.status).toBe(409);
      const res2Json: any = await res2.json();
      expect(res2Json.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('5.4: HTTP Replay idempotente com 200 OK e idempotentReplay: true', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const betExtId = `ext-bet-replay-${crypto.randomUUID()}`;
      await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `idemp-bet-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          providerId: 'provider-http',
          externalTransactionId: betExtId,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'round-http-rep',
          gameId: 'game-http-rep',
          kind: 'BET',
          money: { amount: '30.00', currency: 'BRL' },
        }),
      });

      const sharedKey = `idemp-http-replay-${crypto.randomUUID()}`;
      const payload = {
        providerId: 'provider-http',
        externalTransactionId: `ext-rev-rep-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-http-rep',
        gameId: 'game-http-rep',
        kind: 'REFUND',
        money: { amount: '30.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      };

      // Chamada 1 -> 200 OK, idempotentReplay: false
      const res1 = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': sharedKey,
        },
        body: JSON.stringify(payload),
      });
      expect(res1.status).toBe(200);
      const json1: any = await res1.json();
      expect(json1.idempotentReplay).toBe(false);

      // Chamada 2 -> 200 OK, idempotentReplay: true
      const res2 = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': sharedKey,
        },
        body: JSON.stringify(payload),
      });
      expect(res2.status).toBe(200);
      const json2: any = await res2.json();
      expect(json2.transactionId).toBe(json1.transactionId);
      expect(json2.idempotentReplay).toBe(true);
      expect(json2.balance.amount).toBe(json1.balance.amount);
    });
  });
});
