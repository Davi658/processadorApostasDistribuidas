import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import pg from 'pg';
import crypto from 'node:crypto';
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
import { createIsolatedTestDatabase, IsolatedTestDatabase } from '../test-db-helper';

describe('M08: Validações Financeiras de Reversões Fora de Ordem e Imediatas', () => {
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
  let reprocessWorker: ReprocessPendingReferencesUseCase;

  beforeAll(async () => {
    isolatedDb = await createIsolatedTestDatabase('m08_reversals_');

    adminPool = new pg.Pool({
      ...isolatedDb.adminConfig,
      max: 20,
    });
    adminPool.on('error', () => {});

    uow = new MikroOrmUnitOfWork();
    await uow.init();
    walletRepo = new MikroOrmWalletRepository(uow);
    wagerRepo = new MikroOrmWagerTransactionRepository(uow);
    ledgerRepo = new MikroOrmWalletLedgerRepository(uow);
    outboxRepo = new MikroOrmOutboxRepository(uow);

    createWalletUseCase = new CreateWalletUseCase(walletRepo, wagerRepo, ledgerRepo, outboxRepo, uow);
    getWalletUseCase = new GetWalletUseCase(walletRepo);
    processWagerUseCase = new ProcessWagerUseCase(walletRepo, wagerRepo, ledgerRepo, outboxRepo, uow);
    reconcileWalletUseCase = new ReconcileWalletUseCase(walletRepo, ledgerRepo, uow);
    reprocessWorker = new ReprocessPendingReferencesUseCase(walletRepo, wagerRepo, ledgerRepo, outboxRepo, uow, 5);
  }, 30000);

  afterAll(async () => {
    if (uow) await uow.close();
    if (adminPool) await adminPool.end();
    if (isolatedDb) await isolatedDb.closeAndDrop();
  }, 30000);

  // Helper para tornar pendências imediatamente elegíveis para reprocessamento
  async function makePendingEligible(transactionId: string): Promise<void> {
    await adminPool.query(
      "UPDATE wager_transactions SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = $1;",
      [transactionId]
    );
  }

  // Helper de auditoria estrita de rejeição:
  // - exatamente um evento WagerTransactionRejected com failureCode correto
  // - nenhum WalletBalanceChanged emitido para a reversão
  // - nenhum WagerTransactionProcessed emitido para a reversão
  // - nenhum lançamento no ledger para a reversão
  // - saldo e version da carteira preservados
  // - snapshot terminal completo e coerente
  async function assertRejectionAudit(params: {
    reversalTxId: string;
    walletId: string;
    expectedFailureCode: string;
    expectedBalance: string;
    expectedVersion: number;
  }): Promise<void> {
    // 1. Snapshot terminal na tabela wager_transactions
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

    // 2. Nenhum lançamento no ledger para a reversão
    const ledgerRows = (
      await adminPool.query('SELECT * FROM wallet_ledger_entries WHERE transaction_id = $1;', [
        params.reversalTxId,
      ])
    ).rows;
    expect(ledgerRows.length).toBe(0);

    // 3. Saldo e versão da carteira preservados
    const wallet = await getWalletUseCase.execute(params.walletId);
    expect(wallet.balance.amount).toBe(params.expectedBalance);
    expect(wallet.version).toBe(params.expectedVersion);

    // 4. Outbox: exatamente um WagerTransactionRejected com failureCode correto
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

    // 5. Outbox: nenhum WagerTransactionProcessed para a reversão
    const processedEvents = outboxRows.filter((r: any) => {
      const payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
      return r.event_type === 'WagerTransactionProcessed' && payload?.transactionId === params.reversalTxId;
    });
    expect(processedEvents.length).toBe(0);

    // 6. Outbox: nenhum WalletBalanceChanged disparado pela reversão
    const balanceChangedEvents = outboxRows.filter((r: any) => {
      const payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
      return r.event_type === 'WalletBalanceChanged' && payload?.triggerTransactionId === params.reversalTxId;
    });
    expect(balanceChangedEvents.length).toBe(0);
  }

  // Helper para criar fixture contabilmente consistente em USD:
  // Carteira USD + transação OPENING + crédito ledger + transação BET + débito ledger
  async function createAccountingConsistentUsdFixture(params: {
    playerId?: string;
    walletId?: string;
    initialBalance?: string;
    betAmount?: string;
    betExtId: string;
    providerId?: string;
    roundId?: string;
    gameId?: string;
  }) {
    const playerId = params.playerId ?? crypto.randomUUID();
    const walletId = params.walletId ?? crypto.randomUUID();
    const providerId = params.providerId ?? 'prv-curr';
    const roundId = params.roundId ?? 'rnd-curr';
    const gameId = params.gameId ?? 'gm-curr';
    const initialBalance = params.initialBalance ?? '100.00';
    const betAmount = params.betAmount ?? '20.00';
    const finalBalance = (Number(initialBalance) - Number(betAmount)).toFixed(2);

    // 1. Wallets table (version = 2: 1 abertura + 1 bet)
    await adminPool.query(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES ($1, $2, 'USD', $3, 2, NOW(), NOW());`,
      [walletId, playerId, finalBalance]
    );

    // 2. OPENING transaction
    const openingTxId = crypto.randomUUID();
    const openingKey = `OPENING_${walletId}`;
    const openingSnapshot = JSON.stringify({
      transactionId: openingTxId,
      status: 'PROCESSED',
      balance: { amount: initialBalance, currency: 'USD' },
      idempotentReplay: false,
    });
    await adminPool.query(
      `INSERT INTO wager_transactions (
         id, wallet_id, player_id, provider_id, external_transaction_id,
         round_id, game_id, kind, amount, currency, status, idempotency_key, payload_hash,
         response_snapshot, created_at, updated_at
       ) VALUES (
         $1, $2, $3, 'SYSTEM', $4,
         'ROUND-OPENING', 'SYSTEM', 'OPENING', $5, 'USD', 'PROCESSED', $6, NULL,
         $7::jsonb, NOW(), NOW()
       );`,
      [openingTxId, walletId, playerId, `OPENING-${walletId}`, initialBalance, openingKey, openingSnapshot]
    );

    // 3. OPENING ledger entry (CREDIT)
    const openingLedgerId = crypto.randomUUID();
    await adminPool.query(
      `INSERT INTO wallet_ledger_entries (
         id, wallet_id, transaction_id, entry_type, amount, currency,
         balance_before, balance_after, created_at
       ) VALUES (
         $1, $2, $3, 'CREDIT', $4, 'USD',
         0.00, $4, NOW()
       );`,
      [openingLedgerId, walletId, openingTxId, initialBalance]
    );

    // 4. BET transaction (PROCESSED)
    const betTxId = crypto.randomUUID();
    const betKey = `key-usd-${crypto.randomUUID()}`;
    const dummyHash = crypto.createHash('sha256').update(params.betExtId).digest('hex');
    const betSnapshot = JSON.stringify({
      transactionId: betTxId,
      status: 'PROCESSED',
      balance: { amount: finalBalance, currency: 'USD' },
      idempotentReplay: false,
    });
    await adminPool.query(
      `INSERT INTO wager_transactions (
         id, wallet_id, player_id, provider_id, external_transaction_id,
         round_id, game_id, kind, amount, currency, status, idempotency_key, payload_hash,
         response_snapshot, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, 'BET', $8, 'USD', 'PROCESSED', $9, $10,
         $11::jsonb, NOW(), NOW()
       );`,
      [
        betTxId,
        walletId,
        playerId,
        providerId,
        params.betExtId,
        roundId,
        gameId,
        betAmount,
        betKey,
        dummyHash,
        betSnapshot,
      ]
    );

    // 5. BET ledger entry (DEBIT)
    const betLedgerId = crypto.randomUUID();
    await adminPool.query(
      `INSERT INTO wallet_ledger_entries (
         id, wallet_id, transaction_id, entry_type, amount, currency,
         balance_before, balance_after, created_at
       ) VALUES (
         $1, $2, $3, 'DEBIT', $4, 'USD',
         $5, $6, NOW()
       );`,
      [betLedgerId, walletId, betTxId, betAmount, initialBalance, finalBalance]
    );

    return {
      walletId,
      playerId,
      betTxId,
      betExtId: params.betExtId,
      balance: finalBalance,
    };
  }

  // Helper para criar fixture de BET em status FAILED (sem desativar triggers)
  async function createFailedBetFixture(params: {
    walletId: string;
    playerId: string;
    betExtId: string;
    amount?: string;
    currency?: string;
    providerId?: string;
    roundId?: string;
    gameId?: string;
  }) {
    const betTxId = crypto.randomUUID();
    const providerId = params.providerId ?? 'prv-failed';
    const roundId = params.roundId ?? 'rnd-failed';
    const gameId = params.gameId ?? 'gm-failed';
    const amount = params.amount ?? '25.00';
    const currency = params.currency ?? 'BRL';
    const idempotencyKey = `key-failed-${crypto.randomUUID()}`;
    const payloadHash = crypto.createHash('sha256').update(params.betExtId).digest('hex');
    const failureReason = 'SYSTEM_ERROR_FAILED';
    const responseSnapshot = JSON.stringify({
      transactionId: betTxId,
      status: 'FAILED',
      failureCode: failureReason,
      balance: { amount: '100.00', currency },
      idempotentReplay: false,
    });

    await adminPool.query(
      `INSERT INTO wager_transactions (
         id, wallet_id, player_id, provider_id, external_transaction_id,
         round_id, game_id, kind, amount, currency, status, idempotency_key, payload_hash,
         rejection_reason, response_snapshot, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, 'BET', $8, $9, 'FAILED', $10, $11,
         $12, $13::jsonb, NOW(), NOW()
       );`,
      [
        betTxId,
        params.walletId,
        params.playerId,
        providerId,
        params.betExtId,
        roundId,
        gameId,
        amount,
        currency,
        idempotencyKey,
        payloadHash,
        failureReason,
        responseSnapshot,
      ]
    );

    return { betTxId, betExtId: params.betExtId };
  }

  // --------------------------------------------------------------------------
  // Cenário 1: REFUND chega antes de BET válida → um crédito correto
  // --------------------------------------------------------------------------
  describe('Cenário 1: REFUND chega antes de BET válida → um crédito correto', () => {
    it('Caminho A (Referência já existente): BET processada primeiro, REFUND depois', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const betExtId = `bet-c1-imm-${crypto.randomUUID()}`;
      const betRes = await processWagerUseCase.execute(`key-bet-c1-imm-${crypto.randomUUID()}`, {
        providerId: 'prv-c1',
        externalTransactionId: betExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-c1-imm',
        gameId: 'gm-c1',
        kind: 'BET',
        money: { amount: '30.00', currency: 'BRL' },
      });
      expect(betRes.status).toBe('PROCESSED');
      expect(betRes.balance.amount).toBe('70.00');

      const refundRes = await processWagerUseCase.execute(`key-ref-c1-imm-${crypto.randomUUID()}`, {
        providerId: 'prv-c1',
        externalTransactionId: `ref-c1-imm-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-c1-imm',
        gameId: 'gm-c1',
        kind: 'REFUND',
        money: { amount: '30.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      });
      expect(refundRes.status).toBe('PROCESSED');
      expect(refundRes.balance.amount).toBe('100.00');

      const finalWallet = await getWalletUseCase.execute(wallet.id);
      expect(finalWallet.balance.amount).toBe('100.00');
      expect(finalWallet.version).toBe(3); // 1 (opening) + 1 (bet debit) + 1 (refund credit)

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('100.00');
    });

    it('Caminho B (Referência recebida posteriormente): REFUND chega primeiro, BET depois, reprocessamento manual', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const betExtId = `bet-c1-ooo-${crypto.randomUUID()}`;
      const oooRefund = await processWagerUseCase.execute(`key-ref-c1-ooo-${crypto.randomUUID()}`, {
        providerId: 'prv-c1',
        externalTransactionId: `ref-c1-ooo-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-c1-ooo',
        gameId: 'gm-c1',
        kind: 'REFUND',
        money: { amount: '30.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      });
      expect(oooRefund.status).toBe('PENDING_REFERENCE');

      // Saldo e versão continuam intactos
      const walletMid = await getWalletUseCase.execute(wallet.id);
      expect(walletMid.balance.amount).toBe('100.00');
      expect(walletMid.version).toBe(1);

      // BET chega depois
      const betRes = await processWagerUseCase.execute(`key-bet-c1-ooo-${crypto.randomUUID()}`, {
        providerId: 'prv-c1',
        externalTransactionId: betExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-c1-ooo',
        gameId: 'gm-c1',
        kind: 'BET',
        money: { amount: '30.00', currency: 'BRL' },
      });
      expect(betRes.status).toBe('PROCESSED');
      expect(betRes.balance.amount).toBe('70.00');

      // Execução manual do reprocessador
      await makePendingEligible(oooRefund.transactionId);
      const reprocessResult = await reprocessWorker.execute(10);
      expect(reprocessResult.processed).toBe(1);

      const updatedRefundTx = await wagerRepo.findById(oooRefund.transactionId);
      expect(updatedRefundTx?.status).toBe('PROCESSED');

      const finalWallet = await getWalletUseCase.execute(wallet.id);
      expect(finalWallet.balance.amount).toBe('100.00');
      expect(finalWallet.version).toBe(3);

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('100.00');
    });
  });

  // --------------------------------------------------------------------------
  // Cenário 2: ROLLBACK chega antes de WIN válida → um débito correto
  // --------------------------------------------------------------------------
  describe('Cenário 2: ROLLBACK chega antes de WIN válida → um débito correto', () => {
    it('Caminho A (Referência já existente): WIN processada primeiro, ROLLBACK depois', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '50.00', currency: 'BRL' },
      });

      const winExtId = `win-c2-imm-${crypto.randomUUID()}`;
      const winRes = await processWagerUseCase.execute(`key-win-c2-imm-${crypto.randomUUID()}`, {
        providerId: 'prv-c2',
        externalTransactionId: winExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-c2-imm',
        gameId: 'gm-c2',
        kind: 'WIN',
        money: { amount: '40.00', currency: 'BRL' },
      });
      expect(winRes.status).toBe('PROCESSED');
      expect(winRes.balance.amount).toBe('90.00');

      // Rollback da WIN é um DÉBITO de 40.00
      const rbRes = await processWagerUseCase.execute(`key-rb-c2-imm-${crypto.randomUUID()}`, {
        providerId: 'prv-c2',
        externalTransactionId: `rb-c2-imm-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-c2-imm',
        gameId: 'gm-c2',
        kind: 'ROLLBACK',
        money: { amount: '40.00', currency: 'BRL' },
        referenceExternalTransactionId: winExtId,
      });
      expect(rbRes.status).toBe('PROCESSED');
      expect(rbRes.balance.amount).toBe('50.00');

      const finalWallet = await getWalletUseCase.execute(wallet.id);
      expect(finalWallet.balance.amount).toBe('50.00');
      expect(finalWallet.version).toBe(3); // opening(1) + win credit(2) + rollback debit(3)

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('50.00');
    });

    it('Caminho B (Referência recebida posteriormente): ROLLBACK chega primeiro, WIN depois, reprocessamento manual', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '50.00', currency: 'BRL' },
      });

      const winExtId = `win-c2-ooo-${crypto.randomUUID()}`;
      const oooRollback = await processWagerUseCase.execute(`key-rb-c2-ooo-${crypto.randomUUID()}`, {
        providerId: 'prv-c2',
        externalTransactionId: `rb-c2-ooo-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-c2-ooo',
        gameId: 'gm-c2',
        kind: 'ROLLBACK',
        money: { amount: '40.00', currency: 'BRL' },
        referenceExternalTransactionId: winExtId,
      });
      expect(oooRollback.status).toBe('PENDING_REFERENCE');

      // Saldo inalterado
      const walletMid = await getWalletUseCase.execute(wallet.id);
      expect(walletMid.balance.amount).toBe('50.00');
      expect(walletMid.version).toBe(1);

      // WIN chega depois
      const winRes = await processWagerUseCase.execute(`key-win-c2-ooo-${crypto.randomUUID()}`, {
        providerId: 'prv-c2',
        externalTransactionId: winExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-c2-ooo',
        gameId: 'gm-c2',
        kind: 'WIN',
        money: { amount: '40.00', currency: 'BRL' },
      });
      expect(winRes.status).toBe('PROCESSED');
      expect(winRes.balance.amount).toBe('90.00');

      // Execução manual do reprocessador
      await makePendingEligible(oooRollback.transactionId);
      const reprocessResult = await reprocessWorker.execute(10);
      expect(reprocessResult.processed).toBe(1);

      const updatedRbTx = await wagerRepo.findById(oooRollback.transactionId);
      expect(updatedRbTx?.status).toBe('PROCESSED');

      const finalWallet = await getWalletUseCase.execute(wallet.id);
      expect(finalWallet.balance.amount).toBe('50.00');
      expect(finalWallet.version).toBe(3);

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('50.00');
    });
  });

  // --------------------------------------------------------------------------
  // Cenário 3: Valor divergente → rejeição sem movimento
  // --------------------------------------------------------------------------
  describe('Cenário 3: Valor divergente → rejeição sem movimento', () => {
    it('Caminho A (Referência já existente): BET de 25.00, REFUND submetido com 30.00', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const betExtId = `bet-c3-imm-${crypto.randomUUID()}`;
      await processWagerUseCase.execute(`key-bet-c3-imm-${crypto.randomUUID()}`, {
        providerId: 'prv-c3',
        externalTransactionId: betExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-c3-imm',
        gameId: 'gm-c3',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      });

      const diffRefund = await processWagerUseCase.execute(`key-ref-c3-imm-${crypto.randomUUID()}`, {
        providerId: 'prv-c3',
        externalTransactionId: `ref-c3-imm-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-c3-imm',
        gameId: 'gm-c3',
        kind: 'REFUND',
        money: { amount: '30.00', currency: 'BRL' }, // 30.00 != 25.00
        referenceExternalTransactionId: betExtId,
      });

      expect(diffRefund.status).toBe('REJECTED');
      expect(diffRefund.failureCode).toBe('REFERENCE_INCOMPATIBLE');
      expect(diffRefund.balance.amount).toBe('75.00');

      await assertRejectionAudit({
        reversalTxId: diffRefund.transactionId,
        walletId: wallet.id,
        expectedFailureCode: 'REFERENCE_INCOMPATIBLE',
        expectedBalance: '75.00',
        expectedVersion: 2,
      });

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('75.00');
    });

    it('Caminho B (Referência recebida posteriormente): REFUND de 30.00 chega primeiro, BET de 25.00 chega depois', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const betExtId = `bet-c3-ooo-${crypto.randomUUID()}`;
      const oooRefund = await processWagerUseCase.execute(`key-ref-c3-ooo-${crypto.randomUUID()}`, {
        providerId: 'prv-c3',
        externalTransactionId: `ref-c3-ooo-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-c3-ooo',
        gameId: 'gm-c3',
        kind: 'REFUND',
        money: { amount: '30.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      });
      expect(oooRefund.status).toBe('PENDING_REFERENCE');

      // BET de 25.00 é processada
      await processWagerUseCase.execute(`key-bet-c3-ooo-${crypto.randomUUID()}`, {
        providerId: 'prv-c3',
        externalTransactionId: betExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-c3-ooo',
        gameId: 'gm-c3',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      });

      await makePendingEligible(oooRefund.transactionId);
      const reprocessResult = await reprocessWorker.execute(10);
      expect(reprocessResult.rejected).toBe(1);

      await assertRejectionAudit({
        reversalTxId: oooRefund.transactionId,
        walletId: wallet.id,
        expectedFailureCode: 'REFERENCE_INCOMPATIBLE',
        expectedBalance: '75.00',
        expectedVersion: 2,
      });

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('75.00');
    });
  });

  // --------------------------------------------------------------------------
  // Cenário 4: REFUND referenciando WIN → rejeição sem movimento
  // --------------------------------------------------------------------------
  describe('Cenário 4: REFUND referenciando WIN → rejeição sem movimento', () => {
    it('Caminho A (Referência já existente): WIN processada, REFUND referenciando WIN', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '50.00', currency: 'BRL' },
      });

      const winExtId = `win-c4-imm-${crypto.randomUUID()}`;
      await processWagerUseCase.execute(`key-win-c4-imm-${crypto.randomUUID()}`, {
        providerId: 'prv-c4',
        externalTransactionId: winExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-c4-imm',
        gameId: 'gm-c4',
        kind: 'WIN',
        money: { amount: '20.00', currency: 'BRL' },
      });

      const invalidRefund = await processWagerUseCase.execute(`key-ref-c4-imm-${crypto.randomUUID()}`, {
        providerId: 'prv-c4',
        externalTransactionId: `ref-c4-imm-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-c4-imm',
        gameId: 'gm-c4',
        kind: 'REFUND',
        money: { amount: '20.00', currency: 'BRL' },
        referenceExternalTransactionId: winExtId,
      });

      expect(invalidRefund.status).toBe('REJECTED');
      expect(invalidRefund.failureCode).toBe('REFERENCE_INCOMPATIBLE');
      expect(invalidRefund.balance.amount).toBe('70.00');

      await assertRejectionAudit({
        reversalTxId: invalidRefund.transactionId,
        walletId: wallet.id,
        expectedFailureCode: 'REFERENCE_INCOMPATIBLE',
        expectedBalance: '70.00',
        expectedVersion: 2,
      });

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('70.00');
    });

    it('Caminho B (Referência recebida posteriormente): REFUND chega primeiro referenciando WIN futura', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '50.00', currency: 'BRL' },
      });

      const winExtId = `win-c4-ooo-${crypto.randomUUID()}`;
      const oooRefund = await processWagerUseCase.execute(`key-ref-c4-ooo-${crypto.randomUUID()}`, {
        providerId: 'prv-c4',
        externalTransactionId: `ref-c4-ooo-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-c4-ooo',
        gameId: 'gm-c4',
        kind: 'REFUND',
        money: { amount: '20.00', currency: 'BRL' },
        referenceExternalTransactionId: winExtId,
      });
      expect(oooRefund.status).toBe('PENDING_REFERENCE');

      // WIN chega depois
      await processWagerUseCase.execute(`key-win-c4-ooo-${crypto.randomUUID()}`, {
        providerId: 'prv-c4',
        externalTransactionId: winExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-c4-ooo',
        gameId: 'gm-c4',
        kind: 'WIN',
        money: { amount: '20.00', currency: 'BRL' },
      });

      await makePendingEligible(oooRefund.transactionId);
      const reprocessResult = await reprocessWorker.execute(10);
      expect(reprocessResult.rejected).toBe(1);

      await assertRejectionAudit({
        reversalTxId: oooRefund.transactionId,
        walletId: wallet.id,
        expectedFailureCode: 'REFERENCE_INCOMPATIBLE',
        expectedBalance: '70.00',
        expectedVersion: 2,
      });

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('70.00');
    });
  });

  // --------------------------------------------------------------------------
  // Cenário 5: Referência de outra carteira/player/rodada → rejeição
  // --------------------------------------------------------------------------
  describe('Cenário 5: Referência de outra carteira/player/rodada → rejeição', () => {
    it('5a (Rodada divergente): Caminho imediato e reprocessado', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const betExtId = `bet-c5a-${crypto.randomUUID()}`;
      await processWagerUseCase.execute(`key-bet-c5a-${crypto.randomUUID()}`, {
        providerId: 'prv-c5',
        externalTransactionId: betExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-original',
        gameId: 'gm-c5',
        kind: 'BET',
        money: { amount: '15.00', currency: 'BRL' },
      });

      // Imediato com rodada divergente
      const diffRoundRes = await processWagerUseCase.execute(`key-ref-c5a-imm-${crypto.randomUUID()}`, {
        providerId: 'prv-c5',
        externalTransactionId: `ref-c5a-imm-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-divergent',
        gameId: 'gm-c5',
        kind: 'REFUND',
        money: { amount: '15.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      });
      expect(diffRoundRes.status).toBe('REJECTED');
      expect(diffRoundRes.failureCode).toBe('REFERENCE_INCOMPATIBLE');

      await assertRejectionAudit({
        reversalTxId: diffRoundRes.transactionId,
        walletId: wallet.id,
        expectedFailureCode: 'REFERENCE_INCOMPATIBLE',
        expectedBalance: '85.00',
        expectedVersion: 2,
      });

      // Fora de ordem com rodada divergente
      const betExtId2 = `bet-c5a-2-${crypto.randomUUID()}`;
      const oooRefund = await processWagerUseCase.execute(`key-ref-c5a-ooo-${crypto.randomUUID()}`, {
        providerId: 'prv-c5',
        externalTransactionId: `ref-c5a-ooo-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-divergent-2',
        gameId: 'gm-c5',
        kind: 'REFUND',
        money: { amount: '15.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId2,
      });
      expect(oooRefund.status).toBe('PENDING_REFERENCE');

      // BET chega com round original
      await processWagerUseCase.execute(`key-bet-c5a-2-${crypto.randomUUID()}`, {
        providerId: 'prv-c5',
        externalTransactionId: betExtId2,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-original-2',
        gameId: 'gm-c5',
        kind: 'BET',
        money: { amount: '15.00', currency: 'BRL' },
      });

      await makePendingEligible(oooRefund.transactionId);
      const reprocessResult = await reprocessWorker.execute(10);
      expect(reprocessResult.rejected).toBe(1);

      await assertRejectionAudit({
        reversalTxId: oooRefund.transactionId,
        walletId: wallet.id,
        expectedFailureCode: 'REFERENCE_INCOMPATIBLE',
        expectedBalance: '70.00',
        expectedVersion: 3,
      });

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('70.00');
    });

    describe('5b (Outra carteira / player): Caminho imediato e fora de ordem', () => {
      it('5b - Caminho Imediato: Reversão na Wallet 2 de BET pertencente à Wallet 1 é rejeitada imediatamente', async () => {
        // Wallet 1 (Player 1)
        const wallet1 = await createWalletUseCase.execute({
          playerId: crypto.randomUUID(),
          initialBalance: { amount: '100.00', currency: 'BRL' },
        });
        // Wallet 2 (Player 2)
        const wallet2 = await createWalletUseCase.execute({
          playerId: crypto.randomUUID(),
          initialBalance: { amount: '100.00', currency: 'BRL' },
        });

        const betExtIdWallet1 = `bet-w1-${crypto.randomUUID()}`;
        await processWagerUseCase.execute(`key-bet-w1-${crypto.randomUUID()}`, {
          providerId: 'prv-cross',
          externalTransactionId: betExtIdWallet1,
          playerId: wallet1.playerId,
          walletId: wallet1.id,
          roundId: 'rnd-cross',
          gameId: 'gm-cross',
          kind: 'BET',
          money: { amount: '20.00', currency: 'BRL' },
        });

        // Wallet 2 tenta estornar a aposta de Wallet 1 (no fluxo imediato)
        const crossRefund = await processWagerUseCase.execute(`key-cross-imm-${crypto.randomUUID()}`, {
          providerId: 'prv-cross',
          externalTransactionId: `ref-cross-imm-${crypto.randomUUID()}`,
          playerId: wallet2.playerId,
          walletId: wallet2.id,
          roundId: 'rnd-cross',
          gameId: 'gm-cross',
          kind: 'REFUND',
          money: { amount: '20.00', currency: 'BRL' },
          referenceExternalTransactionId: betExtIdWallet1,
        });
        expect(crossRefund.status).toBe('REJECTED');
        expect(crossRefund.failureCode).toBe('REFERENCE_INCOMPATIBLE');

        // Auditoria estrita da rejeição na Wallet 2
        await assertRejectionAudit({
          reversalTxId: crossRefund.transactionId,
          walletId: wallet2.id,
          expectedFailureCode: 'REFERENCE_INCOMPATIBLE',
          expectedBalance: '100.00',
          expectedVersion: 1,
        });

        // Reconciliação de ambas as carteiras
        const recon1 = await reconcileWalletUseCase.execute(wallet1.id);
        expect(recon1.consistent).toBe(true);
        expect(recon1.storedBalance.amount).toBe('80.00');

        const recon2 = await reconcileWalletUseCase.execute(wallet2.id);
        expect(recon2.consistent).toBe(true);
        expect(recon2.storedBalance.amount).toBe('100.00');
      });

      it('5b - Caminho Fora de Ordem: Reversão chega na Wallet 2 antes da BET na Wallet 1, reprocessamento rejeita com REFERENCE_INCOMPATIBLE', async () => {
        // Wallet 1 (Player 1)
        const wallet1 = await createWalletUseCase.execute({
          playerId: crypto.randomUUID(),
          initialBalance: { amount: '100.00', currency: 'BRL' },
        });
        // Wallet 2 (Player 2)
        const wallet2 = await createWalletUseCase.execute({
          playerId: crypto.randomUUID(),
          initialBalance: { amount: '100.00', currency: 'BRL' },
        });

        const betExtIdCrossOoo = `bet-cross-ooo-${crypto.randomUUID()}`;

        // Reversão chega na Wallet 2 referenciando betExtIdCrossOoo que ainda NÃO existe
        const oooCrossRefund = await processWagerUseCase.execute(`key-cross-ooo-${crypto.randomUUID()}`, {
          providerId: 'prv-cross',
          externalTransactionId: `ref-cross-ooo-${crypto.randomUUID()}`,
          playerId: wallet2.playerId,
          walletId: wallet2.id,
          roundId: 'rnd-cross',
          gameId: 'gm-cross',
          kind: 'REFUND',
          money: { amount: '20.00', currency: 'BRL' },
          referenceExternalTransactionId: betExtIdCrossOoo,
        });
        expect(oooCrossRefund.status).toBe('PENDING_REFERENCE');

        // Saldo e versão da Wallet 2 permanecem intactos na chegada da pendência
        const midWallet2 = await getWalletUseCase.execute(wallet2.id);
        expect(midWallet2.balance.amount).toBe('100.00');
        expect(midWallet2.version).toBe(1);

        // A referência chega depois, mas na OUTRA carteira / jogador (Wallet 1 / Player 1)
        const betWallet1 = await processWagerUseCase.execute(`key-bet-w1-late-${crypto.randomUUID()}`, {
          providerId: 'prv-cross',
          externalTransactionId: betExtIdCrossOoo,
          playerId: wallet1.playerId,
          walletId: wallet1.id,
          roundId: 'rnd-cross',
          gameId: 'gm-cross',
          kind: 'BET',
          money: { amount: '20.00', currency: 'BRL' },
        });
        expect(betWallet1.status).toBe('PROCESSED');
        expect(betWallet1.balance.amount).toBe('80.00');

        // Execução manual do reprocessador
        await makePendingEligible(oooCrossRefund.transactionId);
        const reprocessResult = await reprocessWorker.execute(10);
        expect(reprocessResult.rejected).toBe(1);

        // Auditoria estrita da rejeição na Wallet 2
        await assertRejectionAudit({
          reversalTxId: oooCrossRefund.transactionId,
          walletId: wallet2.id,
          expectedFailureCode: 'REFERENCE_INCOMPATIBLE',
          expectedBalance: '100.00',
          expectedVersion: 1,
        });

        // Reconciliação de ambas as carteiras
        const recon1 = await reconcileWalletUseCase.execute(wallet1.id);
        expect(recon1.consistent).toBe(true);
        expect(recon1.storedBalance.amount).toBe('80.00');

        const recon2 = await reconcileWalletUseCase.execute(wallet2.id);
        expect(recon2.consistent).toBe(true);
        expect(recon2.storedBalance.amount).toBe('100.00');
      });
    });
  });

  // --------------------------------------------------------------------------
  // Cenário 6: Conflito de moeda → rejeição, usando fixture adequada
  // --------------------------------------------------------------------------
  describe('Cenário 6: Conflito de moeda → rejeição, usando fixture adequada', () => {
    it('Caminho A (Imediato): Referência em USD existente não pode ser revertida por reversão em BRL', async () => {
      const walletBrl = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const usdBetImmExtId = `bet-usd-imm-${crypto.randomUUID()}`;
      const usdFixture = await createAccountingConsistentUsdFixture({
        betExtId: usdBetImmExtId,
        initialBalance: '100.00',
        betAmount: '20.00',
      });

      // Validação prévia de reconciliação da fixture USD
      const reconUsd = await reconcileWalletUseCase.execute(usdFixture.walletId);
      expect(reconUsd.consistent).toBe(true);
      expect(reconUsd.storedBalance.amount).toBe('80.00');

      // Reversão em BRL referenciando a BET em USD (Caminho A: Imediato)
      const currConflictRes = await processWagerUseCase.execute(`key-curr-imm-${crypto.randomUUID()}`, {
        providerId: 'prv-curr',
        externalTransactionId: `ref-curr-imm-${crypto.randomUUID()}`,
        playerId: walletBrl.playerId,
        walletId: walletBrl.id,
        roundId: 'rnd-curr',
        gameId: 'gm-curr',
        kind: 'REFUND',
        money: { amount: '20.00', currency: 'BRL' },
        referenceExternalTransactionId: usdBetImmExtId,
      });

      expect(currConflictRes.status).toBe('REJECTED');
      expect(currConflictRes.failureCode).toBe('REFERENCE_INCOMPATIBLE');

      await assertRejectionAudit({
        reversalTxId: currConflictRes.transactionId,
        walletId: walletBrl.id,
        expectedFailureCode: 'REFERENCE_INCOMPATIBLE',
        expectedBalance: '100.00',
        expectedVersion: 1,
      });

      const reconBrl = await reconcileWalletUseCase.execute(walletBrl.id);
      expect(reconBrl.consistent).toBe(true);
      expect(reconBrl.storedBalance.amount).toBe('100.00');

      const reconUsdPost = await reconcileWalletUseCase.execute(usdFixture.walletId);
      expect(reconUsdPost.consistent).toBe(true);
      expect(reconUsdPost.storedBalance.amount).toBe('80.00');
    });

    it('Caminho B (Fora de ordem): Reversão em BRL cria pendência antes da inserção da referência USD, reprocessador rejeita sem movimento', async () => {
      const walletBrl = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const usdBetOooExtId = `bet-usd-ooo-${crypto.randomUUID()}`;

      // 1. Reversão em BRL chega ANTES de existir qualquer registro USD -> PENDING_REFERENCE
      const oooRefundCurr = await processWagerUseCase.execute(`key-curr-ooo-${crypto.randomUUID()}`, {
        providerId: 'prv-curr',
        externalTransactionId: `ref-curr-ooo-${crypto.randomUUID()}`,
        playerId: walletBrl.playerId,
        walletId: walletBrl.id,
        roundId: 'rnd-curr',
        gameId: 'gm-curr',
        kind: 'REFUND',
        money: { amount: '20.00', currency: 'BRL' },
        referenceExternalTransactionId: usdBetOooExtId,
      });
      expect(oooRefundCurr.status).toBe('PENDING_REFERENCE');

      // Carteira BRL intacta
      const midWalletBrl = await getWalletUseCase.execute(walletBrl.id);
      expect(midWalletBrl.balance.amount).toBe('100.00');
      expect(midWalletBrl.version).toBe(1);

      // 2. Cria a referência USD contabilmente consistente depois que a pendência já foi registrada
      const usdFixture = await createAccountingConsistentUsdFixture({
        betExtId: usdBetOooExtId,
        initialBalance: '100.00',
        betAmount: '20.00',
      });

      const reconUsd = await reconcileWalletUseCase.execute(usdFixture.walletId);
      expect(reconUsd.consistent).toBe(true);
      expect(reconUsd.storedBalance.amount).toBe('80.00');

      // 3. Execução manual do reprocessador
      await makePendingEligible(oooRefundCurr.transactionId);
      const reprocessResult = await reprocessWorker.execute(10);
      expect(reprocessResult.rejected).toBe(1);

      // 4. Auditoria estrita da rejeição sem movimento
      await assertRejectionAudit({
        reversalTxId: oooRefundCurr.transactionId,
        walletId: walletBrl.id,
        expectedFailureCode: 'REFERENCE_INCOMPATIBLE',
        expectedBalance: '100.00',
        expectedVersion: 1,
      });

      // 5. Reconciliação das carteiras envolvidas
      const reconBrl = await reconcileWalletUseCase.execute(walletBrl.id);
      expect(reconBrl.consistent).toBe(true);
      expect(reconBrl.storedBalance.amount).toBe('100.00');

      const reconUsdPost = await reconcileWalletUseCase.execute(usdFixture.walletId);
      expect(reconUsdPost.consistent).toBe(true);
      expect(reconUsdPost.storedBalance.amount).toBe('80.00');
    });
  });

  // --------------------------------------------------------------------------
  // Cenário 7: Referência REJECTED/FAILED → rejeição auditável
  // --------------------------------------------------------------------------
  describe('Cenário 7: Referência REJECTED/FAILED → rejeição auditável', () => {
    it('Caminho A1 (Imediato - Referência REJECTED): Reversão de BET previamente rejeitada resulta em REFERENCE_NOT_PROCESSED', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '10.00', currency: 'BRL' },
      });

      const rejectedBetExtId = `bet-rej-c7-imm-${crypto.randomUUID()}`;
      // BET de 50.00 rejeitada por saldo insuficiente
      const betRes = await processWagerUseCase.execute(`key-bet-c7-imm-${crypto.randomUUID()}`, {
        providerId: 'prv-c7',
        externalTransactionId: rejectedBetExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-c7-imm',
        gameId: 'gm-c7',
        kind: 'BET',
        money: { amount: '50.00', currency: 'BRL' },
      });
      expect(betRes.status).toBe('REJECTED');
      expect(betRes.failureCode).toBe('INSUFFICIENT_FUNDS');

      // REFUND da BET rejeitada
      const refundRes = await processWagerUseCase.execute(`key-ref-c7-imm-${crypto.randomUUID()}`, {
        providerId: 'prv-c7',
        externalTransactionId: `ref-c7-imm-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-c7-imm',
        gameId: 'gm-c7',
        kind: 'REFUND',
        money: { amount: '50.00', currency: 'BRL' },
        referenceExternalTransactionId: rejectedBetExtId,
      });

      expect(refundRes.status).toBe('REJECTED');
      expect(refundRes.failureCode).toBe('REFERENCE_NOT_PROCESSED');

      await assertRejectionAudit({
        reversalTxId: refundRes.transactionId,
        walletId: wallet.id,
        expectedFailureCode: 'REFERENCE_NOT_PROCESSED',
        expectedBalance: '10.00',
        expectedVersion: 1,
      });

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('10.00');
    });

    it('Caminho B1 (Fora de ordem - Referência REJECTED): REFUND chega primeiro, BET é rejeitada depois, reprocessamento marca auditável', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '10.00', currency: 'BRL' },
      });

      const betExtId = `bet-rej-c7-ooo-${crypto.randomUUID()}`;
      const oooRefund = await processWagerUseCase.execute(`key-ref-c7-ooo-${crypto.randomUUID()}`, {
        providerId: 'prv-c7',
        externalTransactionId: `ref-c7-ooo-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-c7-ooo',
        gameId: 'gm-c7',
        kind: 'REFUND',
        money: { amount: '50.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      });
      expect(oooRefund.status).toBe('PENDING_REFERENCE');

      // BET chega depois e é rejeitada por saldo insuficiente
      await processWagerUseCase.execute(`key-bet-c7-ooo-${crypto.randomUUID()}`, {
        providerId: 'prv-c7',
        externalTransactionId: betExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-c7-ooo',
        gameId: 'gm-c7',
        kind: 'BET',
        money: { amount: '50.00', currency: 'BRL' },
      });

      await makePendingEligible(oooRefund.transactionId);
      const reprocessResult = await reprocessWorker.execute(10);
      expect(reprocessResult.rejected).toBe(1);

      await assertRejectionAudit({
        reversalTxId: oooRefund.transactionId,
        walletId: wallet.id,
        expectedFailureCode: 'REFERENCE_NOT_PROCESSED',
        expectedBalance: '10.00',
        expectedVersion: 1,
      });

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('10.00');
    });

    it('Caminho A2 (Imediato - Referência FAILED): Reversão de BET em status FAILED resulta em REFERENCE_NOT_PROCESSED', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const failedBetExtId = `bet-failed-imm-${crypto.randomUUID()}`;
      await createFailedBetFixture({
        walletId: wallet.id,
        playerId: wallet.playerId,
        betExtId: failedBetExtId,
        amount: '25.00',
        currency: 'BRL',
      });

      // REFUND da BET que falhou terminalmente
      const refundRes = await processWagerUseCase.execute(`key-ref-failed-imm-${crypto.randomUUID()}`, {
        providerId: 'prv-failed',
        externalTransactionId: `ref-failed-imm-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-failed',
        gameId: 'gm-failed',
        kind: 'REFUND',
        money: { amount: '25.00', currency: 'BRL' },
        referenceExternalTransactionId: failedBetExtId,
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

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('100.00');
    });

    it('Caminho B2 (Fora de ordem - Referência FAILED): REFUND chega primeiro, BET falha depois, reprocessamento marca auditável', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const failedBetOooExtId = `bet-failed-ooo-${crypto.randomUUID()}`;

      // 1. REFUND chega antes da BET
      const oooRefund = await processWagerUseCase.execute(`key-ref-failed-ooo-${crypto.randomUUID()}`, {
        providerId: 'prv-failed',
        externalTransactionId: `ref-failed-ooo-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-failed',
        gameId: 'gm-failed',
        kind: 'REFUND',
        money: { amount: '25.00', currency: 'BRL' },
        referenceExternalTransactionId: failedBetOooExtId,
      });
      expect(oooRefund.status).toBe('PENDING_REFERENCE');

      // Carteira inalterada
      const midWallet = await getWalletUseCase.execute(wallet.id);
      expect(midWallet.balance.amount).toBe('100.00');
      expect(midWallet.version).toBe(1);

      // 2. BET chega depois e encerra no estado terminal FAILED (sem desativar triggers)
      await createFailedBetFixture({
        walletId: wallet.id,
        playerId: wallet.playerId,
        betExtId: failedBetOooExtId,
        amount: '25.00',
        currency: 'BRL',
      });

      // 3. Execução manual do reprocessador
      await makePendingEligible(oooRefund.transactionId);
      const reprocessResult = await reprocessWorker.execute(10);
      expect(reprocessResult.rejected).toBe(1);

      await assertRejectionAudit({
        reversalTxId: oooRefund.transactionId,
        walletId: wallet.id,
        expectedFailureCode: 'REFERENCE_NOT_PROCESSED',
        expectedBalance: '100.00',
        expectedVersion: 1,
      });

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('100.00');
    });
  });

  // --------------------------------------------------------------------------
  // Cenário 8: Reversão do mesmo tipo já processada → nenhum efeito adicional
  // --------------------------------------------------------------------------
  describe('Cenário 8: Reversão do mesmo tipo já processada → nenhum efeito adicional', () => {
    it('Caminho A (Imediato): Segundo REFUND para mesma BET é rejeitado sem efeito financeiro adicional', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const betExtId = `bet-c8-imm-${crypto.randomUUID()}`;
      await processWagerUseCase.execute(`key-bet-c8-imm-${crypto.randomUUID()}`, {
        providerId: 'prv-c8',
        externalTransactionId: betExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-c8-imm',
        gameId: 'gm-c8',
        kind: 'BET',
        money: { amount: '40.00', currency: 'BRL' },
      });

      // Primeiro refund é bem-sucedido
      const ref1 = await processWagerUseCase.execute(`key-ref-c8-1-${crypto.randomUUID()}`, {
        providerId: 'prv-c8',
        externalTransactionId: `ref-c8-1-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-c8-imm',
        gameId: 'gm-c8',
        kind: 'REFUND',
        money: { amount: '40.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      });
      expect(ref1.status).toBe('PROCESSED');
      expect(ref1.balance.amount).toBe('100.00');

      // Segundo refund para a MESMA BET
      const ref2 = await processWagerUseCase.execute(`key-ref-c8-2-${crypto.randomUUID()}`, {
        providerId: 'prv-c8',
        externalTransactionId: `ref-c8-2-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-c8-imm',
        gameId: 'gm-c8',
        kind: 'REFUND',
        money: { amount: '40.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      });

      expect(ref2.status).toBe('REJECTED');
      expect(ref2.failureCode).toBe('REVERSAL_ALREADY_PROCESSED');

      await assertRejectionAudit({
        reversalTxId: ref2.transactionId,
        walletId: wallet.id,
        expectedFailureCode: 'REVERSAL_ALREADY_PROCESSED',
        expectedBalance: '100.00',
        expectedVersion: 3,
      });

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('100.00');
    });

    it('Caminho B (Fora de ordem): Dois REFUNDs chegam antes da BET, apenas o primeiro é processado', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const betExtId = `bet-c8-ooo-${crypto.randomUUID()}`;

      // Refund 1 chega antes
      const oooRef1 = await processWagerUseCase.execute(`key-ref-c8-ooo-1-${crypto.randomUUID()}`, {
        providerId: 'prv-c8',
        externalTransactionId: `ref-c8-ooo-1-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-c8-ooo',
        gameId: 'gm-c8',
        kind: 'REFUND',
        money: { amount: '40.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      });
      expect(oooRef1.status).toBe('PENDING_REFERENCE');

      // Refund 2 chega antes
      const oooRef2 = await processWagerUseCase.execute(`key-ref-c8-ooo-2-${crypto.randomUUID()}`, {
        providerId: 'prv-c8',
        externalTransactionId: `ref-c8-ooo-2-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-c8-ooo',
        gameId: 'gm-c8',
        kind: 'REFUND',
        money: { amount: '40.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      });
      expect(oooRef2.status).toBe('PENDING_REFERENCE');

      // BET chega depois
      await processWagerUseCase.execute(`key-bet-c8-ooo-${crypto.randomUUID()}`, {
        providerId: 'prv-c8',
        externalTransactionId: betExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-c8-ooo',
        gameId: 'gm-c8',
        kind: 'BET',
        money: { amount: '40.00', currency: 'BRL' },
      });

      // Reprocessar
      await makePendingEligible(oooRef1.transactionId);
      await makePendingEligible(oooRef2.transactionId);

      const reprocessResult = await reprocessWorker.execute(10);
      expect(reprocessResult.processed).toBe(1);
      expect(reprocessResult.rejected).toBe(1);

      const tx1 = await wagerRepo.findById(oooRef1.transactionId);
      const tx2 = await wagerRepo.findById(oooRef2.transactionId);

      // Exatamente um processado e um rejeitado
      const processedCount = (tx1?.status === 'PROCESSED' ? 1 : 0) + (tx2?.status === 'PROCESSED' ? 1 : 0);
      const rejectedCount = (tx1?.status === 'REJECTED' ? 1 : 0) + (tx2?.status === 'REJECTED' ? 1 : 0);
      expect(processedCount).toBe(1);
      expect(rejectedCount).toBe(1);

      const rejectedTx = tx1?.status === 'REJECTED' ? tx1 : tx2;
      expect(rejectedTx?.rejectionReason).toBe('REVERSAL_ALREADY_PROCESSED');

      if (rejectedTx) {
        await assertRejectionAudit({
          reversalTxId: rejectedTx.id,
          walletId: wallet.id,
          expectedFailureCode: 'REVERSAL_ALREADY_PROCESSED',
          expectedBalance: '100.00',
          expectedVersion: 3,
        });
      }

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('100.00');
    });

    it('Não impõe exclusividade global entre REFUND e ROLLBACK: BET pode ter um REFUND e um ROLLBACK se documentado', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const betExtId = `bet-both-${crypto.randomUUID()}`;
      await processWagerUseCase.execute(`key-bet-both-${crypto.randomUUID()}`, {
        providerId: 'prv-both',
        externalTransactionId: betExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-both',
        gameId: 'gm-both',
        kind: 'BET',
        money: { amount: '50.00', currency: 'BRL' },
      });

      // Processa um REFUND
      const refRes = await processWagerUseCase.execute(`key-ref-both-${crypto.randomUUID()}`, {
        providerId: 'prv-both',
        externalTransactionId: `ref-both-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-both',
        gameId: 'gm-both',
        kind: 'REFUND',
        money: { amount: '50.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      });
      expect(refRes.status).toBe('PROCESSED');

      // Processa um ROLLBACK para a mesma BET (tipo diferente)
      // Como a política é única por referência E tipo, o ROLLBACK é permitido
      const rbRes = await processWagerUseCase.execute(`key-rb-both-${crypto.randomUUID()}`, {
        providerId: 'prv-both',
        externalTransactionId: `rb-both-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-both',
        gameId: 'gm-both',
        kind: 'ROLLBACK',
        money: { amount: '50.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      });
      expect(rbRes.status).toBe('PROCESSED');

      // Um segundo ROLLBACK deve ser rejeitado
      const dupRbRes = await processWagerUseCase.execute(`key-rb-dup-${crypto.randomUUID()}`, {
        providerId: 'prv-both',
        externalTransactionId: `rb-dup-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-both',
        gameId: 'gm-both',
        kind: 'ROLLBACK',
        money: { amount: '50.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      });
      expect(dupRbRes.status).toBe('REJECTED');
      expect(dupRbRes.failureCode).toBe('REVERSAL_ALREADY_PROCESSED');

      await assertRejectionAudit({
        reversalTxId: dupRbRes.transactionId,
        walletId: wallet.id,
        expectedFailureCode: 'REVERSAL_ALREADY_PROCESSED',
        expectedBalance: '150.00',
        expectedVersion: 4,
      });

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('150.00');
    });
  });

  // --------------------------------------------------------------------------
  // Cenário 9: ROLLBACK sem saldo → código específico, sem ledger
  // --------------------------------------------------------------------------
  describe('Cenário 9: ROLLBACK sem saldo → código específico, sem ledger', () => {
    it('Caminho A (Imediato): ROLLBACK de WIN quando saldo insuficiente resulta em REVERSAL_INSUFFICIENT_FUNDS', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '10.00', currency: 'BRL' },
      });

      const winExtId = `win-c9-imm-${crypto.randomUUID()}`;
      await processWagerUseCase.execute(`key-win-c9-imm-${crypto.randomUUID()}`, {
        providerId: 'prv-c9',
        externalTransactionId: winExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-c9-imm',
        gameId: 'gm-c9',
        kind: 'WIN',
        money: { amount: '50.00', currency: 'BRL' },
      }); // Saldo = 60.00

      // Drenar saldo para 10.00 via BET de 50.00
      await processWagerUseCase.execute(`key-bet-drain-imm-${crypto.randomUUID()}`, {
        providerId: 'prv-c9',
        externalTransactionId: `ext-drain-imm-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-c9-drain',
        gameId: 'gm-c9',
        kind: 'BET',
        money: { amount: '50.00', currency: 'BRL' },
      }); // Saldo = 10.00

      // Tenta rollback da WIN de 50.00 com saldo de apenas 10.00
      const rbRes = await processWagerUseCase.execute(`key-rb-c9-imm-${crypto.randomUUID()}`, {
        providerId: 'prv-c9',
        externalTransactionId: `rb-c9-imm-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-c9-imm',
        gameId: 'gm-c9',
        kind: 'ROLLBACK',
        money: { amount: '50.00', currency: 'BRL' },
        referenceExternalTransactionId: winExtId,
      });

      expect(rbRes.status).toBe('REJECTED');
      expect(rbRes.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
      expect(rbRes.balance.amount).toBe('10.00');

      await assertRejectionAudit({
        reversalTxId: rbRes.transactionId,
        walletId: wallet.id,
        expectedFailureCode: 'REVERSAL_INSUFFICIENT_FUNDS',
        expectedBalance: '10.00',
        expectedVersion: 3,
      });

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('10.00');
    });

    it('Caminho B (Fora de ordem): ROLLBACK chega primeiro, WIN e drenagem chegam depois, reprocessador rejeita com REVERSAL_INSUFFICIENT_FUNDS', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '10.00', currency: 'BRL' },
      });

      const winExtId = `win-c9-ooo-${crypto.randomUUID()}`;

      // ROLLBACK chega antes da WIN
      const oooRb = await processWagerUseCase.execute(`key-rb-c9-ooo-${crypto.randomUUID()}`, {
        providerId: 'prv-c9',
        externalTransactionId: `rb-c9-ooo-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-c9-ooo',
        gameId: 'gm-c9',
        kind: 'ROLLBACK',
        money: { amount: '50.00', currency: 'BRL' },
        referenceExternalTransactionId: winExtId,
      });
      expect(oooRb.status).toBe('PENDING_REFERENCE');

      // WIN chega e é processada
      await processWagerUseCase.execute(`key-win-c9-ooo-${crypto.randomUUID()}`, {
        providerId: 'prv-c9',
        externalTransactionId: winExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-c9-ooo',
        gameId: 'gm-c9',
        kind: 'WIN',
        money: { amount: '50.00', currency: 'BRL' },
      }); // Saldo = 60.00

      // Drenar saldo para 10.00
      await processWagerUseCase.execute(`key-bet-drain-ooo-${crypto.randomUUID()}`, {
        providerId: 'prv-c9',
        externalTransactionId: `ext-drain-ooo-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-c9-drain-ooo',
        gameId: 'gm-c9',
        kind: 'BET',
        money: { amount: '50.00', currency: 'BRL' },
      }); // Saldo = 10.00

      // Reprocessar o ROLLBACK pendente
      await makePendingEligible(oooRb.transactionId);
      const reprocessResult = await reprocessWorker.execute(10);
      expect(reprocessResult.rejected).toBe(1);

      await assertRejectionAudit({
        reversalTxId: oooRb.transactionId,
        walletId: wallet.id,
        expectedFailureCode: 'REVERSAL_INSUFFICIENT_FUNDS',
        expectedBalance: '10.00',
        expectedVersion: 3,
      });

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('10.00');
    });
  });

  // --------------------------------------------------------------------------
  // Prova de Sensibilidade dos Seletores da Outbox
  // --------------------------------------------------------------------------
  describe('Sensibilidade dos Seletores da Outbox (Discriminação de Ausência vs Presença)', () => {
    it('comprova que seletores encontram eventos reais (payload.triggerTransactionId / payload.transactionId) e discriminam ausência', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      // 1. Processar uma BET válida
      const betExtIdSens = `bet-sens-${crypto.randomUUID()}`;
      const validBet = await processWagerUseCase.execute(`key-valid-bet-${crypto.randomUUID()}`, {
        providerId: 'prv-sens',
        externalTransactionId: betExtIdSens,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-sens',
        gameId: 'gm-sens',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      });
      expect(validBet.status).toBe('PROCESSED');

      // Consultar outbox da carteira
      const outboxRows1 = (
        await adminPool.query('SELECT * FROM outbox_messages WHERE aggregate_id = $1;', [wallet.id])
      ).rows;

      // Demonstrar que para a transação válida, o seletor com payload.transactionId e payload.triggerTransactionId RETORNA 1
      const processedMatchesForBet = outboxRows1.filter((r: any) => {
        const payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
        return r.event_type === 'WagerTransactionProcessed' && payload?.transactionId === validBet.transactionId;
      });
      expect(processedMatchesForBet.length).toBe(1);

      const balanceChangedMatchesForBet = outboxRows1.filter((r: any) => {
        const payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
        return r.event_type === 'WalletBalanceChanged' && payload?.triggerTransactionId === validBet.transactionId;
      });
      expect(balanceChangedMatchesForBet.length).toBe(1);

      // E para a transação válida, WagerTransactionRejected retorna 0
      const rejectedMatchesForBet = outboxRows1.filter((r: any) => {
        const payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
        return r.event_type === 'WagerTransactionRejected' && payload?.transactionId === validBet.transactionId;
      });
      expect(rejectedMatchesForBet.length).toBe(0);

      // 2. Submeter uma reversão inválida imediata (valor divergente da BET existente)
      const invalidRefundImmediate = await processWagerUseCase.execute(`key-inv-ref-imm-${crypto.randomUUID()}`, {
        providerId: 'prv-sens',
        externalTransactionId: `ref-sens-imm-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-sens',
        gameId: 'gm-sens',
        kind: 'REFUND',
        money: { amount: '35.00', currency: 'BRL' }, // divergente de 25.00
        referenceExternalTransactionId: betExtIdSens,
      });
      expect(invalidRefundImmediate.status).toBe('REJECTED');

      const outboxRows2 = (
        await adminPool.query('SELECT * FROM outbox_messages WHERE aggregate_id = $1;', [wallet.id])
      ).rows;

      // Demonstrar que para a reversão rejeitada, o seletor com payload.transactionId RETORNA 1 em Rejected
      const rejectedMatchesForRefund = outboxRows2.filter((r: any) => {
        const payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
        return (
          r.event_type === 'WagerTransactionRejected' &&
          payload?.transactionId === invalidRefundImmediate.transactionId
        );
      });
      expect(rejectedMatchesForRefund.length).toBe(1);

      // E RETORNA 0 para Processed e BalanceChanged
      const processedMatchesForRefund = outboxRows2.filter((r: any) => {
        const payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
        return (
          r.event_type === 'WagerTransactionProcessed' &&
          payload?.transactionId === invalidRefundImmediate.transactionId
        );
      });
      expect(processedMatchesForRefund.length).toBe(0);

      const balanceChangedMatchesForRefund = outboxRows2.filter((r: any) => {
        const payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
        return (
          r.event_type === 'WalletBalanceChanged' &&
          payload?.triggerTransactionId === invalidRefundImmediate.transactionId
        );
      });
      expect(balanceChangedMatchesForRefund.length).toBe(0);

      // Prova de discriminação: se um payload sintético contivesse o triggerTransactionId da rejeição,
      // a mesma expressão de filtro acusaria > 0 (comprovando que não é um no-op por undefined)
      const syntheticRow = {
        event_type: 'WalletBalanceChanged',
        payload: { triggerTransactionId: invalidRefundImmediate.transactionId },
      };
      const testFilter = (r: any) => {
        const payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
        return (
          r.event_type === 'WalletBalanceChanged' &&
          payload?.triggerTransactionId === invalidRefundImmediate.transactionId
        );
      };
      expect(testFilter(syntheticRow)).toBe(true);

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
    });
  });
});
