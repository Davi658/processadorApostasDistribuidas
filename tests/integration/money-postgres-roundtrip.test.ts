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
import { ProcessWagerUseCase } from '../../src/application/use-cases/process-wager.use-case';
import { Money } from '../../src/domain/value-objects/money.vo';
import { InvalidMoneyError, MoneyOverflowError } from '../../src/domain/errors/domain.error';
import { createIsolatedTestDatabase, IsolatedTestDatabase } from '../test-db-helper';
import { WalletOrmEntity } from '../../src/infrastructure/persistence/mikro-orm/entities/orm-entities';

describe('PostgreSQL Real Integration: Money Round-Trip & Boundary Overflow Invariants', () => {
  let isolatedDb: IsolatedTestDatabase;
  let testPool: pg.Pool;
  let uow: MikroOrmUnitOfWork;
  let walletRepo: MikroOrmWalletRepository;
  let wagerRepo: MikroOrmWagerTransactionRepository;
  let ledgerRepo: MikroOrmWalletLedgerRepository;
  let outboxRepo: MikroOrmOutboxRepository;

  let createWalletUseCase: CreateWalletUseCase;
  let processWagerUseCase: ProcessWagerUseCase;

  beforeAll(async () => {
    // 1. Create a dedicated disposable PostgreSQL database for Money round-trip testing
    isolatedDb = await createIsolatedTestDatabase('money_roundtrip_');

    testPool = new pg.Pool(isolatedDb.adminConfig);

    uow = new MikroOrmUnitOfWork();
    await uow.init();

    walletRepo = new MikroOrmWalletRepository(uow);
    wagerRepo = new MikroOrmWagerTransactionRepository(uow);
    ledgerRepo = new MikroOrmWalletLedgerRepository(uow);
    outboxRepo = new MikroOrmOutboxRepository(uow);

    createWalletUseCase = new CreateWalletUseCase(walletRepo, wagerRepo, ledgerRepo, outboxRepo, uow);
    processWagerUseCase = new ProcessWagerUseCase(walletRepo, wagerRepo, ledgerRepo, outboxRepo, uow);
  });

  afterAll(async () => {
    if (uow) {
      await uow.close();
    }
    if (testPool) {
      await testPool.end();
    }
    if (isolatedDb) {
      await isolatedDb.closeAndDrop();
    }
  });

  describe('4.1 Money → ORM → NUMERIC(18,2) → ORM → Money Round-Trip', () => {
    const roundTripValues = [
      { label: 'zero boundary', amount: '0.00', expectedCents: 0n },
      { label: 'one cent boundary', amount: '0.01', expectedCents: 1n },
      { label: 'regular decimal', amount: '100.50', expectedCents: 10050n },
      { label: 'near standard safe integer cents', amount: '90071992547409.91', expectedCents: 9007199254740991n },
      { label: 'above Number.MAX_SAFE_INTEGER cents', amount: '9007199254740991.00', expectedCents: 900719925474099100n },
      { label: 'one cent below NUMERIC(18,2) max limit', amount: '9999999999999999.98', expectedCents: 999999999999999998n },
      { label: 'exact maximum NUMERIC(18,2) limit (16 integer + 2 dec)', amount: '9999999999999999.99', expectedCents: 999999999999999999n },
    ];

    for (const testCase of roundTripValues) {
      it(`should preserve exact value through round-trip for ${testCase.label}: "${testCase.amount}"`, async () => {
        const playerId = crypto.randomUUID();
        const currency = 'BRL';

        // 1. Domain creates wallet with initial balance as Money
        const wallet = await createWalletUseCase.execute({
          playerId,
          initialBalance: { amount: testCase.amount, currency },
        });

        // Clear MikroORM Identity Map so the next read MUST hit real PostgreSQL
        uow.getEntityManager().clear();

        // 2. Query PostgreSQL directly to verify column type and exact string storage
        const rawRes = await testPool.query(
          'SELECT balance, currency FROM wallets WHERE id = $1',
          [wallet.id]
        );
        expect(rawRes.rows.length).toBe(1);
        const rawRow = rawRes.rows[0];

        // Ensure database driver returned string, never a JavaScript number
        expect(typeof rawRow.balance).toBe('string');
        expect(rawRow.balance).toBe(testCase.amount);
        expect(rawRow.currency).toBe(currency);

        // 3. Read back through MikroORM repository into Domain Money
        const rehydratedWallet = await walletRepo.findById(wallet.id);
        expect(rehydratedWallet).not.toBeNull();
        expect(rehydratedWallet!.balance instanceof Money).toBe(true);

        // 4. Validate exact match of string and bigint cents without any precision loss
        expect(rehydratedWallet!.balance.getAmount()).toBe(testCase.amount);
        expect(rehydratedWallet!.balance.getCents()).toBe(testCase.expectedCents);
        expect(rehydratedWallet!.balance.getCurrency()).toBe(currency);

        // 5. If this was an amount > 0, verify the opening ledger entry also preserved exact value
        if (testCase.expectedCents > 0n) {
          const rawLedgerRes = await testPool.query(
            'SELECT amount, balance_before, balance_after FROM wallet_ledger_entries WHERE wallet_id = $1',
            [wallet.id]
          );
          expect(rawLedgerRes.rows.length).toBe(1);
          const rawLedger = rawLedgerRes.rows[0];
          expect(typeof rawLedger.amount).toBe('string');
          expect(rawLedger.amount).toBe(testCase.amount);
          expect(rawLedger.balance_before).toBe('0.00');
          expect(rawLedger.balance_after).toBe(testCase.amount);
        }
      });
    }
  });

  describe('4.2 Operation Refused by Limit Invariants: No Partial Mutations', () => {
    it('should refuse WIN credit that causes overflow and leave zero partial mutations (balance, version, tx, ledger, outbox)', async () => {
      const playerId = crypto.randomUUID();
      const currency = 'BRL';

      // 1. Create a wallet with balance near maximum limit
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '9999999999999999.00', currency },
      });

      // Clear Identity Map
      uow.getEntityManager().clear();

      // Snapshot initial state in real PostgreSQL
      const initialWallet = (await testPool.query('SELECT balance, version FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      const initialTxCount = Number((await testPool.query('SELECT count(*) FROM wager_transactions WHERE wallet_id = $1', [wallet.id])).rows[0].count);
      const initialLedgerCount = Number((await testPool.query('SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = $1', [wallet.id])).rows[0].count);
      const initialOutboxCount = Number((await testPool.query('SELECT count(*) FROM outbox_messages WHERE aggregate_id = $1', [wallet.id])).rows[0].count);

      expect(initialWallet.balance).toBe('9999999999999999.00');
      expect(Number(initialWallet.version)).toBe(1);

      // 2. Attempt a WIN of "1.00" which would push balance to "10000000000000000.00" (exceeds NUMERIC(18,2))
      const idempotencyKey = `overflow-win-${Date.now()}`;
      let capturedError: any = null;

      try {
        await processWagerUseCase.execute(idempotencyKey, {
          walletId: wallet.id,
          playerId,
          providerId: 'provider_overflow',
          externalTransactionId: `tx-overflow-${Date.now()}`,
          roundId: 'round_overflow_1',
          gameId: 'game_overflow_1',
          kind: 'WIN',
          money: {
            amount: '1.00',
            currency: 'BRL',
          },
        });
      } catch (err: any) {
        capturedError = err;
      }

      // 3. Confirm domain error is thrown and is a MoneyOverflowError/InvalidMoneyError, not a SQL error
      expect(capturedError).not.toBeNull();
      expect(capturedError instanceof InvalidMoneyError).toBe(true);
      expect(capturedError instanceof MoneyOverflowError).toBe(true);
      expect(capturedError.code).toBe('MONEY_OVERFLOW');

      // Clear Identity Map
      uow.getEntityManager().clear();

      // 4. Verify ZERO partial mutations in real PostgreSQL database
      const postWallet = (await testPool.query('SELECT balance, version FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      const postTxCount = Number((await testPool.query('SELECT count(*) FROM wager_transactions WHERE wallet_id = $1', [wallet.id])).rows[0].count);
      const postLedgerCount = Number((await testPool.query('SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = $1', [wallet.id])).rows[0].count);
      const postOutboxCount = Number((await testPool.query('SELECT count(*) FROM outbox_messages WHERE aggregate_id = $1', [wallet.id])).rows[0].count);

      // Invariants:
      expect(postWallet.balance).toBe('9999999999999999.00'); // Saldo inalterado
      expect(Number(postWallet.version)).toBe(1); // Version inalterado
      expect(postTxCount).toBe(initialTxCount); // Nenhuma transacao parcial persistida
      expect(postLedgerCount).toBe(initialLedgerCount); // Nenhum ledger parcial persistido
      expect(postOutboxCount).toBe(initialOutboxCount); // Nenhum evento de outbox gerado
    });

    it('should reject wager input with amount exceeding NUMERIC(18,2) limit at domain entry without touching DB', async () => {
      const playerId = crypto.randomUUID();
      const currency = 'BRL';

      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency },
      });

      const initialWallet = (await testPool.query('SELECT balance, version FROM wallets WHERE id = $1', [wallet.id])).rows[0];

      // Attempt BET with amount above limit: "10000000000000000.00"
      let capturedError: any = null;
      try {
        await processWagerUseCase.execute(`key-above-limit-${Date.now()}`, {
          walletId: wallet.id,
          playerId,
          providerId: 'provider_test',
          externalTransactionId: `tx-above-limit-${Date.now()}`,
          roundId: 'round_1',
          gameId: 'game_1',
          kind: 'BET',
          money: {
            amount: '10000000000000000.00',
            currency: 'BRL',
          },
        });
      } catch (err: any) {
        capturedError = err;
      }

      expect(capturedError).not.toBeNull();
      expect(capturedError instanceof MoneyOverflowError).toBe(true);

      // Verify wallet remains pristine
      const postWallet = (await testPool.query('SELECT balance, version FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      expect(postWallet.balance).toBe(initialWallet.balance);
      expect(Number(postWallet.version)).toBe(Number(initialWallet.version));
    });
  });
});
