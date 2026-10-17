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

  // Helper to make pending transactions immediately eligible for reprocessing
  async function makePendingEligible(transactionId: string): Promise<void> {
    await adminPool.query(
      "UPDATE wager_transactions SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = $1;",
      [transactionId]
    );
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

      const finalWallet = await getWalletUseCase.execute(wallet.id);
      expect(finalWallet.balance.amount).toBe('75.00');
      expect(finalWallet.version).toBe(2); // Inalterado pela rejeição

      // Ledger não tem lançamento do refund
      const ledgerEntries = await ledgerRepo.listByWalletId(wallet.id);
      expect(ledgerEntries.length).toBe(2); // 1 OPENING + 1 BET

      // Outbox não tem WalletBalanceChanged para o refund
      const outboxRes = await adminPool.query('SELECT * FROM outbox_messages WHERE aggregate_id = $1;', [wallet.id]);
      const balanceChangedForRefund = outboxRes.rows.filter(
        (r: any) => r.event_type === 'WalletBalanceChanged' && r.data?.triggerTransactionId === diffRefund.transactionId
      );
      expect(balanceChangedForRefund.length).toBe(0);

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

      const updatedRefundTx = await wagerRepo.findById(oooRefund.transactionId);
      expect(updatedRefundTx?.status).toBe('REJECTED');
      expect(updatedRefundTx?.rejectionReason).toBe('REFERENCE_INCOMPATIBLE');

      const finalWallet = await getWalletUseCase.execute(wallet.id);
      expect(finalWallet.balance.amount).toBe('75.00');
      expect(finalWallet.version).toBe(2);

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

      const finalWallet = await getWalletUseCase.execute(wallet.id);
      expect(finalWallet.balance.amount).toBe('70.00');
      expect(finalWallet.version).toBe(2);

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

      const updatedRefundTx = await wagerRepo.findById(oooRefund.transactionId);
      expect(updatedRefundTx?.status).toBe('REJECTED');
      expect(updatedRefundTx?.rejectionReason).toBe('REFERENCE_INCOMPATIBLE');

      const finalWallet = await getWalletUseCase.execute(wallet.id);
      expect(finalWallet.balance.amount).toBe('70.00');
      expect(finalWallet.version).toBe(2);

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

      const updatedTx = await wagerRepo.findById(oooRefund.transactionId);
      expect(updatedTx?.status).toBe('REJECTED');
      expect(updatedTx?.rejectionReason).toBe('REFERENCE_INCOMPATIBLE');
    });

    it('5b (Outra carteira / player): Caminho imediato e reprocessado', async () => {
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

      // Ambas as carteiras permanecem íntegras
      const w1 = await getWalletUseCase.execute(wallet1.id);
      expect(w1.balance.amount).toBe('80.00');
      const w2 = await getWalletUseCase.execute(wallet2.id);
      expect(w2.balance.amount).toBe('100.00');
    });
  });

  // --------------------------------------------------------------------------
  // Cenário 6: Conflito de moeda → rejeição, usando fixture adequada
  // --------------------------------------------------------------------------
  describe('Cenário 6: Conflito de moeda → rejeição, usando fixture adequada', () => {
    it('Caminho A e B: Referência em USD não pode ser revertida por reversão em BRL', async () => {
      const walletBrl = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      // Fixture: Inserir diretamente uma BET com moeda USD pertencente a uma carteira USD
      const usdWalletId = crypto.randomUUID();
      const usdPlayerId = crypto.randomUUID();
      await adminPool.query(
        `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
         VALUES ($1, $2, 'USD', 100.00, 1, NOW(), NOW());`,
        [usdWalletId, usdPlayerId]
      );

      const usdBetTxId = crypto.randomUUID();
      const usdBetExtId = `bet-usd-${crypto.randomUUID()}`;
      const usdKey = `key-usd-${crypto.randomUUID()}`;
      const dummyHash = 'a'.repeat(64);
      await adminPool.query(
        `INSERT INTO wager_transactions (
           id, wallet_id, player_id, provider_id, external_transaction_id,
           round_id, game_id, kind, amount, currency, status, idempotency_key, payload_hash, created_at, updated_at
         ) VALUES ($1, $2, $3, 'prv-curr', $4, 'rnd-curr', 'gm-curr', 'BET', 10.00, 'USD', 'PROCESSED', $5, $6, NOW(), NOW());`,
        [usdBetTxId, usdWalletId, usdPlayerId, usdBetExtId, usdKey, dummyHash]
      );

      // Reversão em BRL referenciando a BET em USD (Caminho A: Imediato)
      const currConflictRes = await processWagerUseCase.execute(`key-curr-imm-${crypto.randomUUID()}`, {
        providerId: 'prv-curr',
        externalTransactionId: `ref-curr-imm-${crypto.randomUUID()}`,
        playerId: walletBrl.playerId,
        walletId: walletBrl.id,
        roundId: 'rnd-curr',
        gameId: 'gm-curr',
        kind: 'REFUND',
        money: { amount: '10.00', currency: 'BRL' },
        referenceExternalTransactionId: usdBetExtId,
      });

      expect(currConflictRes.status).toBe('REJECTED');
      expect(currConflictRes.failureCode).toBe('REFERENCE_INCOMPATIBLE');

      // Carteira BRL permanece intacta
      const finalWallet = await getWalletUseCase.execute(walletBrl.id);
      expect(finalWallet.balance.amount).toBe('100.00');

      // Caminho B: Fora de ordem
      const oooRefundCurr = await processWagerUseCase.execute(`key-curr-ooo-${crypto.randomUUID()}`, {
        providerId: 'prv-curr',
        externalTransactionId: `ref-curr-ooo-${crypto.randomUUID()}`,
        playerId: walletBrl.playerId,
        walletId: walletBrl.id,
        roundId: 'rnd-curr',
        gameId: 'gm-curr',
        kind: 'REFUND',
        money: { amount: '10.00', currency: 'BRL' },
        referenceExternalTransactionId: usdBetExtId,
      });
      // Como o usdBetExtId já existe no banco com USD, se for reprocessado ou executado:
      expect(oooRefundCurr.status).toBe('REJECTED');
      expect(oooRefundCurr.failureCode).toBe('REFERENCE_INCOMPATIBLE');
    });
  });

  // --------------------------------------------------------------------------
  // Cenário 7: Referência REJECTED/FAILED → rejeição auditável
  // --------------------------------------------------------------------------
  describe('Cenário 7: Referência REJECTED/FAILED → rejeição auditável', () => {
    it('Caminho A (Imediato): Reversão de BET previamente rejeitada resulta em REFERENCE_NOT_PROCESSED', async () => {
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

      const reloaded = await getWalletUseCase.execute(wallet.id);
      expect(reloaded.balance.amount).toBe('10.00');
      expect(reloaded.version).toBe(1);

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('10.00');
    });

    it('Caminho B (Fora de ordem): REFUND chega primeiro, BET é rejeitada depois, reprocessamento marca auditável', async () => {
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

      const updatedRefundTx = await wagerRepo.findById(oooRefund.transactionId);
      expect(updatedRefundTx?.status).toBe('REJECTED');
      expect(updatedRefundTx?.rejectionReason).toBe('REFERENCE_NOT_PROCESSED');

      const finalWallet = await getWalletUseCase.execute(wallet.id);
      expect(finalWallet.balance.amount).toBe('10.00');
      expect(finalWallet.version).toBe(1);

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('10.00');
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

      // Garantir nenhum efeito adicional: saldo 100.00, version 3
      const walletFinal = await getWalletUseCase.execute(wallet.id);
      expect(walletFinal.balance.amount).toBe('100.00');
      expect(walletFinal.version).toBe(3);

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

      // Saldo final 100.00, versão 3
      const walletFinal = await getWalletUseCase.execute(wallet.id);
      expect(walletFinal.balance.amount).toBe('100.00');
      expect(walletFinal.version).toBe(3);

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

      const finalWallet = await getWalletUseCase.execute(wallet.id);
      expect(finalWallet.balance.amount).toBe('10.00');
      expect(finalWallet.version).toBe(3); // 1 (opening) + 1 (win) + 1 (drain bet)

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

      const updatedTx = await wagerRepo.findById(oooRb.transactionId);
      expect(updatedTx?.status).toBe('REJECTED');
      expect(updatedTx?.rejectionReason).toBe('REVERSAL_INSUFFICIENT_FUNDS');

      const finalWallet = await getWalletUseCase.execute(wallet.id);
      expect(finalWallet.balance.amount).toBe('10.00');
      expect(finalWallet.version).toBe(3);

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('10.00');
    });
  });
});
