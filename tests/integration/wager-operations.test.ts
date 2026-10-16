import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import pg from 'pg';
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
import {
  IdempotencyConflictError,
  InvalidWagerOperationError,
} from '../../src/domain/errors/domain.error';
import { createIsolatedTestDatabase, IsolatedTestDatabase } from '../test-db-helper';

describe('Wager Operations & Reference Invariants (Bloco C: WIN, LOSS, REFUND, ROLLBACK, Out-of-Order)', () => {
  let isolatedDb: IsolatedTestDatabase;
  let testPool: pg.Pool;
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
    isolatedDb = await createIsolatedTestDatabase('ops_test_');

    testPool = new pg.Pool(isolatedDb.adminConfig);

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
    reprocessWorker = new ReprocessPendingReferencesUseCase(walletRepo, wagerRepo, ledgerRepo, outboxRepo, uow, 3);
  });

  afterAll(async () => {
    await uow.close();
    await testPool.end();
    await isolatedDb.closeAndDrop();
  });

  it('WIN: should credit wallet balance, increment version, and record CREDIT in ledger and outbox', async () => {
    const wallet = await createWalletUseCase.execute({
      playerId: crypto.randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const winRes = await processWagerUseCase.execute(`key-win-${crypto.randomUUID()}`, {
      providerId: 'prv-win',
      externalTransactionId: `ext-win-${crypto.randomUUID()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'rnd-win',
      gameId: 'gm-win',
      kind: 'WIN',
      money: { amount: '50.00', currency: 'BRL' },
    });

    expect(winRes.status).toBe('PROCESSED');
    expect(winRes.balance.amount).toBe('150.00');
    expect(winRes.idempotentReplay).toBe(false);

    const updatedWallet = await getWalletUseCase.execute(wallet.id);
    expect(updatedWallet.balance.amount).toBe('150.00');
    expect(updatedWallet.version).toBe(2);

    // Verify ledger has CREDIT entry
    const ledger = await testPool.query(
      "SELECT * FROM wallet_ledger_entries WHERE transaction_id = $1 AND entry_type = 'CREDIT';",
      [winRes.transactionId]
    );
    expect(ledger.rows.length).toBe(1);
    expect(Number(ledger.rows[0].amount)).toBe(50.0);
    expect(Number(ledger.rows[0].balance_before)).toBe(100.0);
    expect(Number(ledger.rows[0].balance_after)).toBe(150.0);

    // Reconcile
    const recon = await reconcileWalletUseCase.execute(wallet.id);
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance.amount).toBe('150.00');
    expect(recon.calculatedBalance.amount).toBe('150.00');
  });

  it('LOSS: should record processed transaction WITHOUT mutating balance or creating ledger entry', async () => {
    const wallet = await createWalletUseCase.execute({
      playerId: crypto.randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const lossRes = await processWagerUseCase.execute(`key-loss-${crypto.randomUUID()}`, {
      providerId: 'prv-loss',
      externalTransactionId: `ext-loss-${crypto.randomUUID()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'rnd-loss',
      gameId: 'gm-loss',
      kind: 'LOSS',
      money: { amount: '20.00', currency: 'BRL' },
    });

    expect(lossRes.status).toBe('PROCESSED');
    expect(lossRes.balance.amount).toBe('100.00');

    // Wallet version and balance MUST NOT change
    const updatedWallet = await getWalletUseCase.execute(wallet.id);
    expect(updatedWallet.balance.amount).toBe('100.00');
    expect(updatedWallet.version).toBe(1);

    // Zero ledger entry for LOSS
    const ledger = await testPool.query(
      'SELECT * FROM wallet_ledger_entries WHERE transaction_id = $1;',
      [lossRes.transactionId]
    );
    expect(ledger.rows.length).toBe(0);

    // Reconcile remains completely consistent
    const recon = await reconcileWalletUseCase.execute(wallet.id);
    expect(recon.consistent).toBe(true);
  });

  it('REFUND: should reverse a processed BET by crediting the wallet with the exact amount', async () => {
    const wallet = await createWalletUseCase.execute({
      playerId: crypto.randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const betExtId = `ext-bet-ref-${crypto.randomUUID()}`;
    const betRes = await processWagerUseCase.execute(`key-bet-${crypto.randomUUID()}`, {
      providerId: 'prv-ref',
      externalTransactionId: betExtId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'rnd-ref',
      gameId: 'gm-ref',
      kind: 'BET',
      money: { amount: '35.00', currency: 'BRL' },
    });
    expect(betRes.balance.amount).toBe('65.00');

    // Now execute REFUND referencing the BET
    const refundRes = await processWagerUseCase.execute(`key-refund-${crypto.randomUUID()}`, {
      providerId: 'prv-ref',
      externalTransactionId: `ext-refund-${crypto.randomUUID()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'rnd-ref',
      gameId: 'gm-ref',
      kind: 'REFUND',
      money: { amount: '35.00', currency: 'BRL' },
      referenceExternalTransactionId: betExtId,
    });

    expect(refundRes.status).toBe('PROCESSED');
    expect(refundRes.balance.amount).toBe('100.00');

    const updatedWallet = await getWalletUseCase.execute(wallet.id);
    expect(updatedWallet.balance.amount).toBe('100.00');
    expect(updatedWallet.version).toBe(3); // 1 opening, 2 bet, 3 refund

    // Reconcile
    const recon = await reconcileWalletUseCase.execute(wallet.id);
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance.amount).toBe('100.00');
    expect(recon.calculatedBalance.amount).toBe('100.00');
  });

  it('REFUND: should reject duplicate refund for the same reference transaction', async () => {
    const wallet = await createWalletUseCase.execute({
      playerId: crypto.randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const betExtId = `ext-dup-ref-${crypto.randomUUID()}`;
    await processWagerUseCase.execute(`key-bet-${crypto.randomUUID()}`, {
      providerId: 'prv-ref',
      externalTransactionId: betExtId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'rnd-dup-ref',
      gameId: 'gm-ref',
      kind: 'BET',
      money: { amount: '20.00', currency: 'BRL' },
    });

    // First refund succeeds
    await processWagerUseCase.execute(`key-ref-1-${crypto.randomUUID()}`, {
      providerId: 'prv-ref',
      externalTransactionId: `ext-ref-1-${crypto.randomUUID()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'rnd-dup-ref',
      gameId: 'gm-ref',
      kind: 'REFUND',
      money: { amount: '20.00', currency: 'BRL' },
      referenceExternalTransactionId: betExtId,
    });

    // Second refund for same reference with different key must be rejected
    await expect(
      processWagerUseCase.execute(`key-ref-2-${crypto.randomUUID()}`, {
        providerId: 'prv-ref',
        externalTransactionId: `ext-ref-2-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-dup-ref',
        gameId: 'gm-ref',
        kind: 'REFUND',
        money: { amount: '20.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      })
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it('ROLLBACK: should reverse BET (credit) and WIN (debit), and reject rollback of WIN when insufficient funds', async () => {
    const wallet = await createWalletUseCase.execute({
      playerId: crypto.randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    // 1. Rollback a BET: inverse is CREDIT
    const betExtId = `ext-rb-bet-${crypto.randomUUID()}`;
    await processWagerUseCase.execute(`key-bet-${crypto.randomUUID()}`, {
      providerId: 'prv-rb',
      externalTransactionId: betExtId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'rnd-rb',
      gameId: 'gm-rb',
      kind: 'BET',
      money: { amount: '40.00', currency: 'BRL' },
    });

    const rbBetRes = await processWagerUseCase.execute(`key-rb-1-${crypto.randomUUID()}`, {
      providerId: 'prv-rb',
      externalTransactionId: `ext-rb-1-${crypto.randomUUID()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'rnd-rb',
      gameId: 'gm-rb',
      kind: 'ROLLBACK',
      money: { amount: '40.00', currency: 'BRL' },
      referenceExternalTransactionId: betExtId,
    });
    expect(rbBetRes.status).toBe('PROCESSED');
    expect(rbBetRes.balance.amount).toBe('100.00');

    // 2. Rollback a WIN: inverse is DEBIT
    const winExtId = `ext-rb-win-${crypto.randomUUID()}`;
    await processWagerUseCase.execute(`key-win-${crypto.randomUUID()}`, {
      providerId: 'prv-rb',
      externalTransactionId: winExtId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'rnd-rb-win',
      gameId: 'gm-rb',
      kind: 'WIN',
      money: { amount: '20.00', currency: 'BRL' },
    }); // Balance is now 120.00

    const rbWinRes = await processWagerUseCase.execute(`key-rb-2-${crypto.randomUUID()}`, {
      providerId: 'prv-rb',
      externalTransactionId: `ext-rb-2-${crypto.randomUUID()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'rnd-rb-win',
      gameId: 'gm-rb',
      kind: 'ROLLBACK',
      money: { amount: '20.00', currency: 'BRL' },
      referenceExternalTransactionId: winExtId,
    });
    expect(rbWinRes.status).toBe('PROCESSED');
    expect(rbWinRes.balance.amount).toBe('100.00');

    // 3. Rollback of WIN when balance is insufficient -> REJECTED with REVERSAL_INSUFFICIENT_FUNDS
    const winLargeExtId = `ext-rb-win-lg-${crypto.randomUUID()}`;
    await processWagerUseCase.execute(`key-win-lg-${crypto.randomUUID()}`, {
      providerId: 'prv-rb',
      externalTransactionId: winLargeExtId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'rnd-rb-win2',
      gameId: 'gm-rb',
      kind: 'WIN',
      money: { amount: '50.00', currency: 'BRL' },
    }); // Balance is now 150.00

    // Drain balance to 20.00 via BET
    await processWagerUseCase.execute(`key-bet-drain-${crypto.randomUUID()}`, {
      providerId: 'prv-rb',
      externalTransactionId: `ext-drain-${crypto.randomUUID()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'rnd-drain',
      gameId: 'gm-rb',
      kind: 'BET',
      money: { amount: '130.00', currency: 'BRL' },
    }); // Balance is now 20.00

    // Attempt to rollback the 50.00 WIN when balance is only 20.00
    const failRbWinRes = await processWagerUseCase.execute(`key-rb-fail-${crypto.randomUUID()}`, {
      providerId: 'prv-rb',
      externalTransactionId: `ext-rb-fail-${crypto.randomUUID()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'rnd-rb-win2',
      gameId: 'gm-rb',
      kind: 'ROLLBACK',
      money: { amount: '50.00', currency: 'BRL' },
      referenceExternalTransactionId: winLargeExtId,
    });

    expect(failRbWinRes.status).toBe('REJECTED');
    expect(failRbWinRes.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    expect(failRbWinRes.balance.amount).toBe('20.00');

    // Wallet balance and version remain unchanged on reversal rejection
    const finalWallet = await getWalletUseCase.execute(wallet.id);
    expect(finalWallet.balance.amount).toBe('20.00');

    const recon = await reconcileWalletUseCase.execute(wallet.id);
    expect(recon.consistent).toBe(true);
  });

  describe('Out-of-Order References and Reprocessing Worker (Requirement 11)', () => {
    it('should persist PENDING_REFERENCE when reference is missing, and process successfully when reference arrives', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const missingBetExtId = `ext-missing-bet-${crypto.randomUUID()}`;

      // 1. REFUND arrives BEFORE the BET
      const oooRefund = await processWagerUseCase.execute(`key-ooo-ref-${crypto.randomUUID()}`, {
        providerId: 'prv-ooo',
        externalTransactionId: `ext-ooo-ref-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-ooo',
        gameId: 'gm-ooo',
        kind: 'REFUND',
        money: { amount: '25.00', currency: 'BRL' },
        referenceExternalTransactionId: missingBetExtId,
      });

      expect(oooRefund.status).toBe('PENDING_REFERENCE');

      // Check wallet was NOT modified yet
      const walletBefore = await getWalletUseCase.execute(wallet.id);
      expect(walletBefore.balance.amount).toBe('100.00');

      // 2. Now the BET arrives and is processed
      await processWagerUseCase.execute(`key-bet-arrives-${crypto.randomUUID()}`, {
        providerId: 'prv-ooo',
        externalTransactionId: missingBetExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-ooo',
        gameId: 'gm-ooo',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      });

      const walletAfterBet = await getWalletUseCase.execute(wallet.id);
      expect(walletAfterBet.balance.amount).toBe('75.00');

      // 3. Trigger reprocessing worker
      // Set nextAttemptAt to past to make it immediately eligible
      await testPool.query(
        "UPDATE wager_transactions SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = $1;",
        [oooRefund.transactionId]
      );

      const reprocessResult = await reprocessWorker.execute(10);
      expect(reprocessResult.processed).toBe(1);

      // Check transaction is now PROCESSED
      const updatedTx = await wagerRepo.findById(oooRefund.transactionId);
      expect(updatedTx?.status).toBe('PROCESSED');

      // Check wallet was credited
      const walletFinal = await getWalletUseCase.execute(wallet.id);
      expect(walletFinal.balance.amount).toBe('100.00');

      // Reconcile
      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('100.00');
    });

    it('should reject reversal when referenced transaction was REJECTED', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '10.00', currency: 'BRL' },
      });

      const rejectedBetExtId = `ext-rej-bet-${crypto.randomUUID()}`;

      // BET is rejected due to insufficient funds (needs 50, has 10)
      await processWagerUseCase.execute(`key-rej-bet-${crypto.randomUUID()}`, {
        providerId: 'prv-rej',
        externalTransactionId: rejectedBetExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-rej',
        gameId: 'gm-rej',
        kind: 'BET',
        money: { amount: '50.00', currency: 'BRL' },
      });

      // Attempt refund of rejected BET -> rejected with REFERENCE_NOT_PROCESSED
      const refundRes = await processWagerUseCase.execute(`key-rej-ref-${crypto.randomUUID()}`, {
        providerId: 'prv-rej',
        externalTransactionId: `ext-rej-ref-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-rej',
        gameId: 'gm-rej',
        kind: 'REFUND',
        money: { amount: '50.00', currency: 'BRL' },
        referenceExternalTransactionId: rejectedBetExtId,
      });

      expect(refundRes.status).toBe('REJECTED');
      expect(refundRes.failureCode).toBe('REFERENCE_NOT_PROCESSED');

      const reloaded = await getWalletUseCase.execute(wallet.id);
      expect(reloaded.balance.amount).toBe('10.00');
    });

    it('should transition to REJECTED with REFERENCE_NOT_FOUND when max retry attempts are exhausted', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const oooRefund = await processWagerUseCase.execute(`key-ghost-${crypto.randomUUID()}`, {
        providerId: 'prv-ghost',
        externalTransactionId: `ext-ghost-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-ghost',
        gameId: 'gm-ghost',
        kind: 'REFUND',
        money: { amount: '20.00', currency: 'BRL' },
        referenceExternalTransactionId: `ext-never-arrives-${crypto.randomUUID()}`,
      });

      expect(oooRefund.status).toBe('PENDING_REFERENCE');

      // Simulate exhausting attempts up to maxAttempts (3)
      await testPool.query(
        "UPDATE wager_transactions SET attempts = 3, next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = $1;",
        [oooRefund.transactionId]
      );

      const workerRes = await reprocessWorker.execute(10);
      expect(workerRes.rejected).toBe(1);

      const expiredTx = await wagerRepo.findById(oooRefund.transactionId);
      expect(expiredTx?.status).toBe('REJECTED');
      expect(expiredTx?.rejectionReason).toBe('REFERENCE_NOT_FOUND');
    });
  });
});
