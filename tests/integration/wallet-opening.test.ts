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
import { ReconcileWalletUseCase } from '../../src/application/use-cases/reconcile-wallet.use-case';
import { ProcessWagerUseCase } from '../../src/application/use-cases/process-wager.use-case';
import { DuplicateWalletError, InvalidMoneyError, MoneyOverflowError } from '../../src/domain/errors/domain.error';
import { createIsolatedTestDatabase, IsolatedTestDatabase } from '../test-db-helper';

describe('M03: Wallet Opening Stabilization & Real PostgreSQL Invariants Tests', () => {
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
  let reconcileWalletUseCase: ReconcileWalletUseCase;
  let processWagerUseCase: ProcessWagerUseCase;

  beforeAll(async () => {
    // 1. Create a dedicated disposable PostgreSQL database
    isolatedDb = await createIsolatedTestDatabase('wallet_opening_');

    adminPool = new pg.Pool(isolatedDb.adminConfig);
    adminPool.on('error', () => {});

    // 2. Start NestJS application against the isolated database
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
    reconcileWalletUseCase = app.get(ReconcileWalletUseCase);
    processWagerUseCase = app.get(ProcessWagerUseCase);
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

  describe('1. Abertura Positiva: Saldo, Versão, OPENING, CREDIT e Eventos na Mesma Transação SQL', () => {
    it('deve criar wallet, transação interna OPENING, lançamento CREDIT e eventos na outbox na mesma transação', async () => {
      const playerId = crypto.randomUUID();
      const currency = 'BRL';
      const initialAmount = '250.75';

      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: initialAmount, currency },
      });

      // Validar contrato de retorno
      expect(wallet.id).toBeDefined();
      expect(wallet.playerId).toBe(playerId);
      expect(wallet.balance).toEqual({ amount: initialAmount, currency });
      expect(wallet.version).toBe(1);

      // Limpar identity map
      uow.getEntityManager().clear();

      // Validar persistência física no PostgreSQL
      const walletRow = (await adminPool.query('SELECT * FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      expect(walletRow).toBeDefined();
      expect(walletRow.player_id).toBe(playerId);
      expect(walletRow.currency).toBe(currency);
      expect(walletRow.balance).toBe(initialAmount);
      expect(Number(walletRow.version)).toBe(1);

      // Validar transação OPENING interna
      const txRows = (await adminPool.query('SELECT * FROM wager_transactions WHERE wallet_id = $1', [wallet.id])).rows;
      expect(txRows.length).toBe(1);
      const openingTx = txRows[0];
      expect(openingTx.kind).toBe('OPENING');
      expect(openingTx.provider_id).toBe('SYSTEM');
      expect(openingTx.external_transaction_id).toBe(`OPENING_${wallet.id}`);
      expect(openingTx.idempotency_key).toBe(`OPENING_${wallet.id}`);
      expect(openingTx.status).toBe('PROCESSED');
      expect(openingTx.amount).toBe(initialAmount);
      expect(openingTx.currency).toBe(currency);

      // Validar lançamento no ledger
      const ledgerRows = (await adminPool.query('SELECT * FROM wallet_ledger_entries WHERE wallet_id = $1', [wallet.id])).rows;
      expect(ledgerRows.length).toBe(1);
      const ledgerEntry = ledgerRows[0];
      expect(ledgerEntry.entry_type).toBe('CREDIT');
      expect(ledgerEntry.amount).toBe(initialAmount);
      expect(ledgerEntry.currency).toBe(currency);
      expect(ledgerEntry.balance_before).toBe('0.00');
      expect(ledgerEntry.balance_after).toBe(initialAmount);
      expect(ledgerEntry.transaction_id).toBe(openingTx.id);

      // Validar eventos gravados na outbox transacional
      const outboxRows = (await adminPool.query(
        'SELECT * FROM outbox_messages WHERE aggregate_id = $1 ORDER BY created_at ASC',
        [wallet.id]
      )).rows;
      expect(outboxRows.length).toBe(2);

      const [openingProcessedEvent, balanceChangedEvent] = outboxRows;
      expect(openingProcessedEvent.event_type).toBe('WagerTransactionProcessed');
      expect(openingProcessedEvent.payload.kind).toBe('OPENING');
      expect(openingProcessedEvent.payload.amount).toEqual({ amount: initialAmount, currency });
      expect(openingProcessedEvent.payload.balance).toEqual({ amount: initialAmount, currency });

      expect(balanceChangedEvent.event_type).toBe('WalletBalanceChanged');
      expect(balanceChangedEvent.payload.previousBalance).toEqual({ amount: '0.00', currency });
      expect(balanceChangedEvent.payload.currentBalance).toEqual({ amount: initialAmount, currency });
      expect(balanceChangedEvent.payload.version).toBe(1);
      expect(balanceChangedEvent.payload.triggerTransactionId).toBe(openingTx.id);
    });
  });

  describe('2. Abertura Zero: Ausência dos Movimentos e Eventos Indevidos', () => {
    it('deve abrir com saldo zero explícito sem OPENING, ledger ou outbox de balance change', async () => {
      const playerId = crypto.randomUUID();

      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '0.00', currency: 'BRL' },
      });

      expect(wallet.balance).toEqual({ amount: '0.00', currency: 'BRL' });
      expect(wallet.version).toBe(1);

      uow.getEntityManager().clear();

      // Checar que nenhuma transação OPENING foi gerada
      const txCount = Number((await adminPool.query('SELECT count(*) FROM wager_transactions WHERE wallet_id = $1', [wallet.id])).rows[0].count);
      expect(txCount).toBe(0);

      // Checar que nenhum ledger foi gerado
      const ledgerCount = Number((await adminPool.query('SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = $1', [wallet.id])).rows[0].count);
      expect(ledgerCount).toBe(0);

      // Checar que nenhum evento na outbox foi gerado
      const outboxCount = Number((await adminPool.query('SELECT count(*) FROM outbox_messages WHERE aggregate_id = $1', [wallet.id])).rows[0].count);
      expect(outboxCount).toBe(0);
    });

    it('deve abrir com initialBalance ausente (undefined) como saldo zero sem movimentos', async () => {
      const playerId = crypto.randomUUID();

      // Chamada sem initialBalance
      const wallet = await createWalletUseCase.execute({
        playerId,
      });

      expect(wallet.balance).toEqual({ amount: '0.00', currency: 'BRL' });
      expect(wallet.version).toBe(1);

      uow.getEntityManager().clear();

      const txCount = Number((await adminPool.query('SELECT count(*) FROM wager_transactions WHERE wallet_id = $1', [wallet.id])).rows[0].count);
      expect(txCount).toBe(0);

      const ledgerCount = Number((await adminPool.query('SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = $1', [wallet.id])).rows[0].count);
      expect(ledgerCount).toBe(0);

      const outboxCount = Number((await adminPool.query('SELECT count(*) FROM outbox_messages WHERE aggregate_id = $1', [wallet.id])).rows[0].count);
      expect(outboxCount).toBe(0);
    });
  });

  describe('3. 20 Aberturas Simultâneas para o Mesmo PlayerId + Currency', () => {
    it('exatamente uma deve ser criada; demais em conflito 409; nenhum efeito duplicado', async () => {
      const playerId = crypto.randomUUID();
      const currency = 'BRL';
      const initialAmount = '50.00';

      const attempts = 20;
      const promises = Array.from({ length: attempts }, () =>
        createWalletUseCase.execute({
          playerId,
          initialBalance: { amount: initialAmount, currency },
        })
      );

      const results = await Promise.allSettled(promises);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      // Exatamente uma criada com sucesso
      expect(fulfilled.length).toBe(1);
      // Demais em conflito (DuplicateWalletError)
      expect(rejected.length).toBe(attempts - 1);

      for (const rej of rejected) {
        const reason = (rej as PromiseRejectedResult).reason;
        expect(reason instanceof DuplicateWalletError).toBe(true);
        expect(reason.code).toBe('DUPLICATE_WALLET');
      }

      uow.getEntityManager().clear();

      // Verificar banco real de dados
      const walletRows = (await adminPool.query('SELECT * FROM wallets WHERE player_id = $1', [playerId])).rows;
      expect(walletRows.length).toBe(1);
      const createdWallet = walletRows[0];
      expect(createdWallet.balance).toBe(initialAmount);
      expect(Number(createdWallet.version)).toBe(1);

      // Verificar que não há transações ou ledgers duplicados
      const txRows = (await adminPool.query('SELECT * FROM wager_transactions WHERE player_id = $1', [playerId])).rows;
      expect(txRows.length).toBe(1);

      const ledgerRows = (await adminPool.query('SELECT * FROM wallet_ledger_entries WHERE wallet_id = $1', [createdWallet.id])).rows;
      expect(ledgerRows.length).toBe(1);

      const outboxRows = (await adminPool.query('SELECT * FROM outbox_messages WHERE aggregate_id = $1', [createdWallet.id])).rows;
      expect(outboxRows.length).toBe(2);
    });
  });

  describe('4. Falhas Injetadas Após Wallet, OPENING, Ledger e Primeira Outbox (Rollback Integral)', () => {
    it('deve fazer rollback integral quando falha é injetada após wallet_save', async () => {
      const playerId = crypto.randomUUID();

      uow.setTestHook('after_wallet_save', () => {
        throw new Error('SIMULATED_FAIL_AFTER_WALLET_SAVE');
      });

      await expect(
        createWalletUseCase.execute({
          playerId,
          initialBalance: { amount: '100.00', currency: 'BRL' },
        })
      ).rejects.toThrow('SIMULATED_FAIL_AFTER_WALLET_SAVE');

      uow.clearTestHooks();
      uow.getEntityManager().clear();

      // Zero registros no banco
      const wCount = Number((await adminPool.query('SELECT count(*) FROM wallets WHERE player_id = $1', [playerId])).rows[0].count);
      const txCount = Number((await adminPool.query('SELECT count(*) FROM wager_transactions WHERE player_id = $1', [playerId])).rows[0].count);
      expect(wCount).toBe(0);
      expect(txCount).toBe(0);
    });

    it('deve fazer rollback integral quando falha é injetada após tx_save (OPENING)', async () => {
      const playerId = crypto.randomUUID();

      uow.setTestHook('after_tx_save', () => {
        throw new Error('SIMULATED_FAIL_AFTER_TX_SAVE');
      });

      await expect(
        createWalletUseCase.execute({
          playerId,
          initialBalance: { amount: '100.00', currency: 'BRL' },
        })
      ).rejects.toThrow('SIMULATED_FAIL_AFTER_TX_SAVE');

      uow.clearTestHooks();
      uow.getEntityManager().clear();

      const wCount = Number((await adminPool.query('SELECT count(*) FROM wallets WHERE player_id = $1', [playerId])).rows[0].count);
      const txCount = Number((await adminPool.query('SELECT count(*) FROM wager_transactions WHERE player_id = $1', [playerId])).rows[0].count);
      expect(wCount).toBe(0);
      expect(txCount).toBe(0);
    });

    it('deve fazer rollback integral quando falha é injetada após ledger_save', async () => {
      const playerId = crypto.randomUUID();

      uow.setTestHook('after_ledger_save', () => {
        throw new Error('SIMULATED_FAIL_AFTER_LEDGER_SAVE');
      });

      await expect(
        createWalletUseCase.execute({
          playerId,
          initialBalance: { amount: '100.00', currency: 'BRL' },
        })
      ).rejects.toThrow('SIMULATED_FAIL_AFTER_LEDGER_SAVE');

      uow.clearTestHooks();
      uow.getEntityManager().clear();

      const wCount = Number((await adminPool.query('SELECT count(*) FROM wallets WHERE player_id = $1', [playerId])).rows[0].count);
      const lCount = Number((await adminPool.query('SELECT count(*) FROM wallet_ledger_entries WHERE currency = $1', ['BRL'])).rows[0].count);
      expect(wCount).toBe(0);
    });

    it('deve fazer rollback integral quando falha é injetada após outbox_save (primeira mensagem)', async () => {
      const playerId = crypto.randomUUID();

      uow.setTestHook('after_outbox_save', () => {
        throw new Error('SIMULATED_FAIL_AFTER_FIRST_OUTBOX');
      });

      await expect(
        createWalletUseCase.execute({
          playerId,
          initialBalance: { amount: '100.00', currency: 'BRL' },
        })
      ).rejects.toThrow('SIMULATED_FAIL_AFTER_FIRST_OUTBOX');

      uow.clearTestHooks();
      uow.getEntityManager().clear();

      const wCount = Number((await adminPool.query('SELECT count(*) FROM wallets WHERE player_id = $1', [playerId])).rows[0].count);
      const txCount = Number((await adminPool.query('SELECT count(*) FROM wager_transactions WHERE player_id = $1', [playerId])).rows[0].count);
      const oCount = Number((await adminPool.query('SELECT count(*) FROM outbox_messages WHERE payload->>\'playerId\' = $1', [playerId])).rows[0].count);
      expect(wCount).toBe(0);
      expect(txCount).toBe(0);
      expect(oCount).toBe(0);
    });
  });

  describe('5. Reenvio Após Rollback: Criação Válida uma Única Vez', () => {
    it('deve permitir reenvio e criar com sucesso após rollback de falha injetada', async () => {
      const playerId = crypto.randomUUID();

      // 1. Falha injetada
      uow.setTestHook('after_wallet_save', () => {
        throw new Error('TRANSIENT_FAULT_FOR_RETRY_TEST');
      });

      await expect(
        createWalletUseCase.execute({
          playerId,
          initialBalance: { amount: '150.00', currency: 'BRL' },
        })
      ).rejects.toThrow('TRANSIENT_FAULT_FOR_RETRY_TEST');

      // 2. Limpar hook e reexecutar
      uow.clearTestHooks();
      uow.getEntityManager().clear();

      const retryWallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '150.00', currency: 'BRL' },
      });

      expect(retryWallet.id).toBeDefined();
      expect(retryWallet.balance).toEqual({ amount: '150.00', currency: 'BRL' });
      expect(retryWallet.version).toBe(1);

      // Verificar que foi criado exatamente uma vez
      uow.getEntityManager().clear();
      const count = Number((await adminPool.query('SELECT count(*) FROM wallets WHERE player_id = $1', [playerId])).rows[0].count);
      expect(count).toBe(1);
    });
  });

  describe('6. Reconciliação das Carteiras Abertas: Saldo Igual ao Ledger', () => {
    it('deve reconciliar carteira aberta com saldo positivo: consistente com 1 lançamento', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '300.00', currency: 'BRL' },
      });

      const reconciliation = await reconcileWalletUseCase.execute(wallet.id);

      expect(reconciliation.consistent).toBe(true);
      expect(reconciliation.storedBalance).toEqual({ amount: '300.00', currency: 'BRL' });
      expect(reconciliation.calculatedBalance).toEqual({ amount: '300.00', currency: 'BRL' });
      expect(reconciliation.difference).toEqual({ amount: '0.00', currency: 'BRL' });
      expect(reconciliation.checkedEntries).toBe(1);
    });

    it('deve reconciliar carteira aberta com saldo zero: consistente com 0 lançamentos', async () => {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '0.00', currency: 'BRL' },
      });

      const reconciliation = await reconcileWalletUseCase.execute(wallet.id);

      expect(reconciliation.consistent).toBe(true);
      expect(reconciliation.storedBalance).toEqual({ amount: '0.00', currency: 'BRL' });
      expect(reconciliation.calculatedBalance).toEqual({ amount: '0.00', currency: 'BRL' });
      expect(reconciliation.difference).toEqual({ amount: '0.00', currency: 'BRL' });
      expect(reconciliation.checkedEntries).toBe(0);
    });
  });

  describe('7. Abertura no Limite Money e Rejeição Acima Dele', () => {
    it('deve criar com sucesso no limite máximo NUMERIC(18,2) ("9999999999999999.99")', async () => {
      const playerId = crypto.randomUUID();
      const maxLimit = '9999999999999999.99';

      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: maxLimit, currency: 'BRL' },
      });

      expect(wallet.balance.amount).toBe(maxLimit);
      expect(wallet.version).toBe(1);

      uow.getEntityManager().clear();

      const rawWallet = (await adminPool.query('SELECT balance FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      expect(rawWallet.balance).toBe(maxLimit);

      const rawLedger = (await adminPool.query('SELECT amount, balance_after FROM wallet_ledger_entries WHERE wallet_id = $1', [wallet.id])).rows[0];
      expect(rawLedger.amount).toBe(maxLimit);
      expect(rawLedger.balance_after).toBe(maxLimit);
    });

    it('deve rejeitar abertura com valor acima do limite ("10000000000000000.00") sem criar registros parciais', async () => {
      const playerId = crypto.randomUUID();

      await expect(
        createWalletUseCase.execute({
          playerId,
          initialBalance: { amount: '10000000000000000.00', currency: 'BRL' },
        })
      ).rejects.toThrow(MoneyOverflowError);

      uow.getEntityManager().clear();

      const count = Number((await adminPool.query('SELECT count(*) FROM wallets WHERE player_id = $1', [playerId])).rows[0].count);
      expect(count).toBe(0);
    });
  });

  describe('8. Testes HTTP do Contrato, Entradas Inválidas e Tentativa de OPENING Externa', () => {
    it('POST /wallets com contrato válido deve retornar 201 Created', async () => {
      const playerId = crypto.randomUUID();
      const res = await fetch(`${serverUrl}/wallets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerId,
          initialBalance: { amount: '100.00', currency: 'BRL' },
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.id).toBeDefined();
      expect(body.playerId).toBe(playerId);
      expect(body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(body.version).toBe(1);
    });

    it('POST /wallets com initialBalance ausente deve criar com saldo "0.00"', async () => {
      const playerId = crypto.randomUUID();
      const res = await fetch(`${serverUrl}/wallets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.balance).toEqual({ amount: '0.00', currency: 'BRL' });
      expect(body.version).toBe(1);
    });

    it('POST /wallets deve rejeitar initialBalance null, false, 0 e "" com 400 Bad Request', async () => {
      const invalidValues = [null, false, 0, ''];
      for (const val of invalidValues) {
        const res = await fetch(`${serverUrl}/wallets`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            playerId: crypto.randomUUID(),
            initialBalance: val,
          }),
        });
        expect(res.status).toBe(400);
      }
    });

    it('POST /wallets deve rejeitar string direta em initialBalance ("100.00") com 400 Bad Request', async () => {
      const res = await fetch(`${serverUrl}/wallets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerId: crypto.randomUUID(),
          initialBalance: '100.00',
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.message).toContain('initialBalance must be an object');
    });

    it('POST /wallets deve rejeitar initialBalance com amount como number com 400 Bad Request', async () => {
      const res = await fetch(`${serverUrl}/wallets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerId: crypto.randomUUID(),
          initialBalance: { amount: 100.5, currency: 'BRL' },
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.message).toContain('must be a decimal string');
    });

    it('POST /wallets deve rejeitar negative e formatos não canônicos com 400 Bad Request', async () => {
      const nonCanonicalAmounts = ['-10.00', '-0.00', '00.00', '01.50', '10', '10.5', '10.555', 'NaN'];
      for (const amount of nonCanonicalAmounts) {
        const res = await fetch(`${serverUrl}/wallets`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            playerId: crypto.randomUUID(),
            initialBalance: { amount, currency: 'BRL' },
          }),
        });
        expect(res.status).toBe(400);
      }
    });

    it('POST /wallets deve rejeitar playerId inválido (não UUID) com 400 Bad Request', async () => {
      const invalidPlayerIds = ['', 'not-a-uuid', 12345, null];
      for (const playerId of invalidPlayerIds) {
        const res = await fetch(`${serverUrl}/wallets`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ playerId }),
        });
        expect(res.status).toBe(400);
      }
    });

    it('POST /wallets deve retornar 409 Conflict na duplicação sequencial', async () => {
      const playerId = crypto.randomUUID();
      const res1 = await fetch(`${serverUrl}/wallets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId }),
      });
      expect(res1.status).toBe(201);

      const res2 = await fetch(`${serverUrl}/wallets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId }),
      });
      expect(res2.status).toBe(409);
      const body = (await res2.json()) as any;
      expect(body.code).toBe('DUPLICATE_WALLET');
    });

    it('POST /wagering/transactions deve rejeitar tentativa externa de submissão com kind="OPENING"', async () => {
      // 1. Criar uma carteira válida
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({ playerId });

      // 2. Tentar submeter transação externa com kind="OPENING"
      const res = await fetch(`${serverUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `client-opening-attempt-${Date.now()}`,
        },
        body: JSON.stringify({
          providerId: 'malicious_client',
          externalTransactionId: `tx-cheat-${Date.now()}`,
          playerId,
          walletId: wallet.id,
          roundId: 'round_cheat',
          gameId: 'game_cheat',
          kind: 'OPENING',
          money: { amount: '1000.00', currency: 'BRL' },
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.message).toContain('Unsupported kind: "OPENING"');

      uow.getEntityManager().clear();

      // Checar que a carteira permaneceu com saldo 0.00 e sem transações
      const checkWallet = await getWalletUseCase.execute(wallet.id);
      expect(checkWallet.balance.amount).toBe('0.00');

      const txCount = Number((await adminPool.query('SELECT count(*) FROM wager_transactions WHERE wallet_id = $1', [wallet.id])).rows[0].count);
      expect(txCount).toBe(0);
    });
  });
});
