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
import {
  DuplicateWalletError,
  InvalidMoneyError,
  InvalidWagerOperationError,
  MoneyOverflowError,
} from '../../src/domain/errors/domain.error';
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
    // 1. Criar banco PostgreSQL real descartável e isolado
    isolatedDb = await createIsolatedTestDatabase('wallet_opening_');

    adminPool = new pg.Pool(isolatedDb.adminConfig);
    adminPool.on('error', () => {});

    // 2. Subir aplicação NestJS conectada ao banco descartável
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

      // Validar lançamento contábil no ledger (CREDIT)
      const ledgerRows = (await adminPool.query('SELECT * FROM wallet_ledger_entries WHERE wallet_id = $1', [wallet.id])).rows;
      expect(ledgerRows.length).toBe(1);
      const entry = ledgerRows[0];
      expect(entry.entry_type).toBe('CREDIT');
      expect(entry.transaction_id).toBe(openingTx.id);
      expect(entry.amount).toBe(initialAmount);
      expect(entry.currency).toBe(currency);
      expect(entry.balance_before).toBe('0.00');
      expect(entry.balance_after).toBe(initialAmount);

      // Validar mensagens geradas na outbox (WagerTransactionProcessed e WalletBalanceChanged)
      const outboxRows = (
        await adminPool.query('SELECT * FROM outbox_messages WHERE aggregate_id = $1', [wallet.id])
      ).rows;
      expect(outboxRows.length).toBe(2);

      const msg1 = outboxRows.find((o) => o.event_type === 'WagerTransactionProcessed')!;
      const msg2 = outboxRows.find((o) => o.event_type === 'WalletBalanceChanged')!;
      expect(msg1).toBeDefined();
      expect(msg2).toBeDefined();

      expect(msg1.event_type).toBe('WagerTransactionProcessed');
      expect(msg1.correlation_id).toBe(openingTx.id);
      expect(msg1.payload.kind).toBe('OPENING');
      expect(msg1.payload.amount).toEqual({ amount: initialAmount, currency });
      expect(msg1.payload.balance).toEqual({ amount: initialAmount, currency });

      expect(msg2.event_type).toBe('WalletBalanceChanged');
      expect(msg2.correlation_id).toBe(openingTx.id);
      expect(msg2.payload.previousBalance).toEqual({ amount: '0.00', currency });
      expect(msg2.payload.currentBalance).toEqual({ amount: initialAmount, currency });
      expect(msg2.payload.version).toBe(1);
      expect(msg2.payload.triggerTransactionId).toBe(openingTx.id);
    });
  });

  describe('2. Abertura Zero: Ausência dos Movimentos e Eventos Indevidos', () => {
    it('deve abrir com saldo zero explícito sem OPENING, ledger ou outbox de balance change', async () => {
      const playerId = crypto.randomUUID();
      const currency = 'BRL';

      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '0.00', currency },
      });

      expect(wallet.id).toBeDefined();
      expect(wallet.playerId).toBe(playerId);
      expect(wallet.balance).toEqual({ amount: '0.00', currency });
      expect(wallet.version).toBe(1);

      uow.getEntityManager().clear();

      const walletRow = (await adminPool.query('SELECT * FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      expect(walletRow.balance).toBe('0.00');
      expect(Number(walletRow.version)).toBe(1);

      const txCount = Number(
        (await adminPool.query('SELECT count(*) FROM wager_transactions WHERE wallet_id = $1', [wallet.id])).rows[0].count
      );
      expect(txCount).toBe(0);

      const ledgerCount = Number(
        (await adminPool.query('SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = $1', [wallet.id])).rows[0].count
      );
      expect(ledgerCount).toBe(0);

      const outboxCount = Number(
        (await adminPool.query('SELECT count(*) FROM outbox_messages WHERE aggregate_id = $1', [wallet.id])).rows[0].count
      );
      expect(outboxCount).toBe(0);
    });

    it('deve abrir com initialBalance ausente (undefined) como saldo zero sem movimentos', async () => {
      const playerId = crypto.randomUUID();

      const wallet = await createWalletUseCase.execute({
        playerId,
      });

      expect(wallet.balance).toEqual({ amount: '0.00', currency: 'BRL' });
      expect(wallet.version).toBe(1);

      uow.getEntityManager().clear();

      const txCount = Number(
        (await adminPool.query('SELECT count(*) FROM wager_transactions WHERE wallet_id = $1', [wallet.id])).rows[0].count
      );
      expect(txCount).toBe(0);

      const ledgerCount = Number(
        (await adminPool.query('SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = $1', [wallet.id])).rows[0].count
      );
      expect(ledgerCount).toBe(0);

      const outboxCount = Number(
        (await adminPool.query('SELECT count(*) FROM outbox_messages WHERE aggregate_id = $1', [wallet.id])).rows[0].count
      );
      expect(outboxCount).toBe(0);
    });
  });

  describe('3. Concorrência HTTP: 20 POST /wallets Simultâneos para o Mesmo PlayerId + Currency', () => {
    it('deve retornar exatamente 1 resposta 201 e 19 respostas 409 com code DUPLICATE_WALLET e conferir o banco', async () => {
      const playerId = crypto.randomUUID();
      const currency = 'BRL';
      const initialAmount = '50.00';
      const attempts = 20;

      const promises = Array.from({ length: attempts }, () =>
        fetch(`${serverUrl}/wallets`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            playerId,
            initialBalance: { amount: initialAmount, currency },
          }),
        }).then(async (res) => ({
          status: res.status,
          body: (await res.json()) as any,
        }))
      );

      const results = await Promise.all(promises);

      const status201 = results.filter((r) => r.status === 201);
      const status409 = results.filter((r) => r.status === 409);

      // Exatamente 1 resposta 201 e 19 respostas 409
      expect(status201.length).toBe(1);
      expect(status409.length).toBe(19);

      for (const conflict of status409) {
        expect(conflict.body.statusCode).toBe(409);
        expect(conflict.body.code).toBe('DUPLICATE_WALLET');
        expect(conflict.body.error).toBe('Conflict');
      }

      const winningWallet = status201[0].body;
      expect(winningWallet.id).toBeDefined();
      expect(winningWallet.playerId).toBe(playerId);
      expect(winningWallet.balance).toEqual({ amount: initialAmount, currency });
      expect(winningWallet.version).toBe(1);

      uow.getEntityManager().clear();

      // No PostgreSQL: confirme uma wallet
      const walletRows = (await adminPool.query('SELECT * FROM wallets WHERE player_id = $1', [playerId])).rows;
      expect(walletRows.length).toBe(1);
      expect(walletRows[0].id).toBe(winningWallet.id);
      expect(walletRows[0].balance).toBe(initialAmount);
      expect(Number(walletRows[0].version)).toBe(1);

      // No PostgreSQL: confirme uma transação OPENING
      const txRows = (await adminPool.query('SELECT * FROM wager_transactions WHERE wallet_id = $1', [winningWallet.id])).rows;
      expect(txRows.length).toBe(1);
      expect(txRows[0].kind).toBe('OPENING');
      expect(txRows[0].status).toBe('PROCESSED');
      expect(txRows[0].amount).toBe(initialAmount);

      // No PostgreSQL: confirme um lançamento CREDIT
      const ledgerRows = (await adminPool.query('SELECT * FROM wallet_ledger_entries WHERE wallet_id = $1', [winningWallet.id])).rows;
      expect(ledgerRows.length).toBe(1);
      expect(ledgerRows[0].entry_type).toBe('CREDIT');
      expect(ledgerRows[0].amount).toBe(initialAmount);
      expect(ledgerRows[0].balance_after).toBe(initialAmount);

      // No PostgreSQL: confirme dois eventos na outbox
      const outboxRows = (
        await adminPool.query('SELECT * FROM outbox_messages WHERE aggregate_id = $1', [winningWallet.id])
      ).rows;
      expect(outboxRows.length).toBe(2);
      expect(outboxRows.map((o) => o.event_type).sort()).toEqual(
        ['WagerTransactionProcessed', 'WalletBalanceChanged'].sort()
      );

      // No PostgreSQL: reconciliação consistente
      const rec = await reconcileWalletUseCase.execute(winningWallet.id);
      expect(rec.consistent).toBe(true);
      expect(rec.difference).toEqual({ amount: '0.00', currency: 'BRL' });
      expect(rec.checkedEntries).toBe(1);
    });
  });

  describe('4. Rollback Completo com Falhas Injetadas e Reenvio Válido', () => {
    it('deve fazer rollback integral após wallet_save, conferir ausência por identificador e permitir reenvio único', async () => {
      const playerId = crypto.randomUUID();
      let capturedWalletId: string | null = null;

      try {
        uow.setTestHook('after_wallet_save', (entity) => {
          capturedWalletId = entity.id;
          throw new Error('SIMULATED_FAIL_AFTER_WALLET_SAVE');
        });

        await expect(
          createWalletUseCase.execute({
            playerId,
            initialBalance: { amount: '100.00', currency: 'BRL' },
          })
        ).rejects.toThrow('SIMULATED_FAIL_AFTER_WALLET_SAVE');
      } finally {
        uow.clearTestHooks();
      }

      uow.getEntityManager().clear();

      // Conferir explicitamente por ID capturado e por playerId
      expect(capturedWalletId).not.toBeNull();
      const wById = await adminPool.query('SELECT count(*) FROM wallets WHERE id = $1', [capturedWalletId]);
      expect(Number(wById.rows[0].count)).toBe(0);

      const wByPlayer = await adminPool.query('SELECT count(*) FROM wallets WHERE player_id = $1', [playerId]);
      expect(Number(wByPlayer.rows[0].count)).toBe(0);

      const txByPlayer = await adminPool.query('SELECT count(*) FROM wager_transactions WHERE player_id = $1', [playerId]);
      expect(Number(txByPlayer.rows[0].count)).toBe(0);

      const lByWallet = await adminPool.query('SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = $1', [capturedWalletId]);
      expect(Number(lByWallet.rows[0].count)).toBe(0);

      const oByWallet = await adminPool.query('SELECT count(*) FROM outbox_messages WHERE aggregate_id = $1', [capturedWalletId]);
      expect(Number(oByWallet.rows[0].count)).toBe(0);

      // Reenvio após rollback: criação única e válida
      const created = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });
      expect(created.id).toBeDefined();
      expect(created.version).toBe(1);

      uow.getEntityManager().clear();
      const finalW = (await adminPool.query('SELECT * FROM wallets WHERE player_id = $1', [playerId])).rows;
      expect(finalW.length).toBe(1);
    });

    it('deve fazer rollback integral após tx_save (OPENING), conferir ausência por identificador e permitir reenvio único', async () => {
      const playerId = crypto.randomUUID();
      let capturedWalletId: string | null = null;
      let capturedTxId: string | null = null;

      try {
        uow.setTestHook('after_wallet_save', (entity) => {
          capturedWalletId = entity.id;
        });
        uow.setTestHook('after_tx_save', (entity) => {
          capturedTxId = entity.id;
          throw new Error('SIMULATED_FAIL_AFTER_TX_SAVE');
        });

        await expect(
          createWalletUseCase.execute({
            playerId,
            initialBalance: { amount: '100.00', currency: 'BRL' },
          })
        ).rejects.toThrow('SIMULATED_FAIL_AFTER_TX_SAVE');
      } finally {
        uow.clearTestHooks();
      }

      uow.getEntityManager().clear();

      expect(capturedWalletId).not.toBeNull();
      expect(capturedTxId).not.toBeNull();

      const wById = await adminPool.query('SELECT count(*) FROM wallets WHERE id = $1', [capturedWalletId]);
      expect(Number(wById.rows[0].count)).toBe(0);

      const txById = await adminPool.query('SELECT count(*) FROM wager_transactions WHERE id = $1', [capturedTxId]);
      expect(Number(txById.rows[0].count)).toBe(0);

      const lByWallet = await adminPool.query('SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = $1', [capturedWalletId]);
      expect(Number(lByWallet.rows[0].count)).toBe(0);

      const oByWallet = await adminPool.query('SELECT count(*) FROM outbox_messages WHERE aggregate_id = $1', [capturedWalletId]);
      expect(Number(oByWallet.rows[0].count)).toBe(0);

      // Reenvio após rollback
      const created = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });
      expect(created.id).toBeDefined();

      uow.getEntityManager().clear();
      const finalTxs = (await adminPool.query('SELECT * FROM wager_transactions WHERE wallet_id = $1', [created.id])).rows;
      expect(finalTxs.length).toBe(1);
    });

    it('deve fazer rollback integral após ledger_save, conferir ausência por identificador e permitir reenvio único', async () => {
      const playerId = crypto.randomUUID();
      let capturedWalletId: string | null = null;
      let capturedTxId: string | null = null;
      let capturedLedgerId: string | null = null;

      try {
        uow.setTestHook('after_wallet_save', (entity) => {
          capturedWalletId = entity.id;
        });
        uow.setTestHook('after_tx_save', (entity) => {
          capturedTxId = entity.id;
        });
        uow.setTestHook('after_ledger_save', (entity) => {
          capturedLedgerId = entity.id;
          throw new Error('SIMULATED_FAIL_AFTER_LEDGER_SAVE');
        });

        await expect(
          createWalletUseCase.execute({
            playerId,
            initialBalance: { amount: '100.00', currency: 'BRL' },
          })
        ).rejects.toThrow('SIMULATED_FAIL_AFTER_LEDGER_SAVE');
      } finally {
        uow.clearTestHooks();
      }

      uow.getEntityManager().clear();

      expect(capturedWalletId).not.toBeNull();
      expect(capturedTxId).not.toBeNull();
      expect(capturedLedgerId).not.toBeNull();

      const wById = await adminPool.query('SELECT count(*) FROM wallets WHERE id = $1', [capturedWalletId]);
      expect(Number(wById.rows[0].count)).toBe(0);

      const txById = await adminPool.query('SELECT count(*) FROM wager_transactions WHERE id = $1', [capturedTxId]);
      expect(Number(txById.rows[0].count)).toBe(0);

      const lById = await adminPool.query('SELECT count(*) FROM wallet_ledger_entries WHERE id = $1', [capturedLedgerId]);
      expect(Number(lById.rows[0].count)).toBe(0);

      const oByWallet = await adminPool.query('SELECT count(*) FROM outbox_messages WHERE aggregate_id = $1', [capturedWalletId]);
      expect(Number(oByWallet.rows[0].count)).toBe(0);

      // Reenvio após rollback
      const created = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });
      expect(created.id).toBeDefined();

      uow.getEntityManager().clear();
      const finalLedgers = (await adminPool.query('SELECT * FROM wallet_ledger_entries WHERE wallet_id = $1', [created.id])).rows;
      expect(finalLedgers.length).toBe(1);
    });

    it('deve fazer rollback integral após outbox_save, conferir ausência por identificador e permitir reenvio único', async () => {
      const playerId = crypto.randomUUID();
      let capturedWalletId: string | null = null;
      let capturedTxId: string | null = null;
      let capturedLedgerId: string | null = null;
      let capturedOutboxId: string | null = null;

      try {
        uow.setTestHook('after_wallet_save', (entity) => {
          capturedWalletId = entity.id;
        });
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

        await expect(
          createWalletUseCase.execute({
            playerId,
            initialBalance: { amount: '100.00', currency: 'BRL' },
          })
        ).rejects.toThrow('SIMULATED_FAIL_AFTER_FIRST_OUTBOX');
      } finally {
        uow.clearTestHooks();
      }

      uow.getEntityManager().clear();

      expect(capturedWalletId).not.toBeNull();
      expect(capturedTxId).not.toBeNull();
      expect(capturedLedgerId).not.toBeNull();
      expect(capturedOutboxId).not.toBeNull();

      const wById = await adminPool.query('SELECT count(*) FROM wallets WHERE id = $1', [capturedWalletId]);
      expect(Number(wById.rows[0].count)).toBe(0);

      const txById = await adminPool.query('SELECT count(*) FROM wager_transactions WHERE id = $1', [capturedTxId]);
      expect(Number(txById.rows[0].count)).toBe(0);

      const lById = await adminPool.query('SELECT count(*) FROM wallet_ledger_entries WHERE id = $1', [capturedLedgerId]);
      expect(Number(lById.rows[0].count)).toBe(0);

      const oById = await adminPool.query('SELECT count(*) FROM outbox_messages WHERE id = $1', [capturedOutboxId]);
      expect(Number(oById.rows[0].count)).toBe(0);

      // Reenvio após rollback
      const created = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });
      expect(created.id).toBeDefined();

      uow.getEntityManager().clear();
      const finalOutboxes = (await adminPool.query('SELECT * FROM outbox_messages WHERE aggregate_id = $1', [created.id])).rows;
      expect(finalOutboxes.length).toBe(2);
    });
  });

  describe('5. Conflitos Específicos e Não-Malclassificação de Outras Constraints', () => {
    it('deve converter somente violação de uq_wallets_player_currency em DuplicateWalletError', async () => {
      const playerId = crypto.randomUUID();

      // Primeira criação com sucesso
      await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '10.00', currency: 'BRL' },
      });

      // Segunda criação sequencial: dispara DuplicateWalletError
      await expect(
        createWalletUseCase.execute({
          playerId,
          initialBalance: { amount: '10.00', currency: 'BRL' },
        })
      ).rejects.toThrow(DuplicateWalletError);
    });

    it('não deve converter qualquer 23505 em DuplicateWalletError quando a constraint for outra', async () => {
      const playerId = crypto.randomUUID();

      try {
        uow.setTestHook('after_wallet_save', () => {
          const fakeUniqueError: any = new Error('duplicate key value violates unique constraint "other_constraint"');
          fakeUniqueError.code = '23505';
          fakeUniqueError.constraint = 'other_constraint';
          throw fakeUniqueError;
        });

        let caughtError: any;
        try {
          await createWalletUseCase.execute({
            playerId,
            initialBalance: { amount: '10.00', currency: 'BRL' },
          });
        } catch (e) {
          caughtError = e;
        }

        // NÃO deve ser convertido em DuplicateWalletError
        expect(caughtError).toBeDefined();
        expect(caughtError instanceof DuplicateWalletError).toBe(false);
        expect(caughtError?.code).not.toBe('DUPLICATE_WALLET');
        expect(String(caughtError?.message ?? '')).toContain('other_constraint');
      } finally {
        uow.clearTestHooks();
      }
    });
  });

  describe('6. Validação Defensiva do Caso de Uso (CreateWalletUseCase)', () => {
    it('1. UUID em maiúsculas é persistido em minúsculas', async () => {
      const rawUuid = crypto.randomUUID();
      const upperUuid = rawUuid.toUpperCase();

      const wallet = await createWalletUseCase.execute({
        playerId: upperUuid,
        initialBalance: { amount: '10.00', currency: 'BRL' },
      });

      expect(wallet.playerId).toBe(rawUuid.toLowerCase());

      uow.getEntityManager().clear();
      const row = (await adminPool.query('SELECT player_id FROM wallets WHERE id = $1', [wallet.id])).rows[0];
      expect(row.player_id).toBe(rawUuid.toLowerCase());
    });

    it('2. Mesmo UUID com variações de caixa/espaços representa o mesmo jogador e gera DuplicateWalletError na segunda abertura', async () => {
      const rawUuid = crypto.randomUUID();
      const upperUuid = rawUuid.toUpperCase();
      const spacedLowerUuid = `   ${rawUuid.toLowerCase()}   `;

      // Primeira abertura com UUID maiúsculo
      const first = await createWalletUseCase.execute({
        playerId: upperUuid,
        initialBalance: { amount: '20.00', currency: 'BRL' },
      });
      expect(first.playerId).toBe(rawUuid.toLowerCase());

      // Segunda abertura com espaços e minúsculo
      await expect(
        createWalletUseCase.execute({
          playerId: spacedLowerUuid,
          initialBalance: { amount: '20.00', currency: 'BRL' },
        })
      ).rejects.toThrow(DuplicateWalletError);
    });

    it('3. UUID inválido é rejeitado antes da persistência', async () => {
      const invalidPlayerIds = [
        '',
        '   ',
        'invalid-uuid',
        '12345',
        '123e4567-e89b-12d3-a456-42661417400', // incompleto
        'g23e4567-e89b-12d3-a456-426614174000', // hex inválido 'g'
      ];

      for (const invalidId of invalidPlayerIds) {
        await expect(
          createWalletUseCase.execute({ playerId: invalidId })
        ).rejects.toThrow(InvalidWagerOperationError);
      }

      uow.getEntityManager().clear();
      const count = Number(
        (await adminPool.query('SELECT count(*) FROM wallets WHERE player_id = $1', ['invalid-uuid'])).rows[0].count
      );
      expect(count).toBe(0);
    });

    it('4. Amount " 10.00" ou "10.00 " é rejeitado sem efeitos no banco', async () => {
      const spacedAmounts = [' 10.00', '10.00 ', '  10.00  '];

      for (const spacedAmount of spacedAmounts) {
        const testPlayerId = crypto.randomUUID();

        await expect(
          createWalletUseCase.execute({
            playerId: testPlayerId,
            initialBalance: { amount: spacedAmount, currency: 'BRL' },
          })
        ).rejects.toThrow(InvalidMoneyError);

        uow.getEntityManager().clear();
        const count = Number(
          (await adminPool.query('SELECT count(*) FROM wallets WHERE player_id = $1', [testPlayerId])).rows[0].count
        );
        expect(count).toBe(0);
      }
    });

    it('5. Amount "10.00" e abertura zero continuam funcionando', async () => {
      // Amount "10.00"
      const p1 = crypto.randomUUID();
      const w1 = await createWalletUseCase.execute({
        playerId: p1,
        initialBalance: { amount: '10.00', currency: 'BRL' },
      });
      expect(w1.balance).toEqual({ amount: '10.00', currency: 'BRL' });
      expect(w1.version).toBe(1);

      // Abertura zero omitida
      const p2 = crypto.randomUUID();
      const w2 = await createWalletUseCase.execute({
        playerId: p2,
      });
      expect(w2.balance).toEqual({ amount: '0.00', currency: 'BRL' });
      expect(w2.version).toBe(1);

      // Abertura zero explícita
      const p3 = crypto.randomUUID();
      const w3 = await createWalletUseCase.execute({
        playerId: p3,
        initialBalance: { amount: '0.00', currency: 'BRL' },
      });
      expect(w3.balance).toEqual({ amount: '0.00', currency: 'BRL' });
      expect(w3.version).toBe(1);
    });

    it('deve rejeitar null, false, 0, "", arrays, números e objetos incompletos no caso de uso sem efeitos colaterais', async () => {
      const invalidInputs: any[] = [
        null,
        false,
        0,
        '',
        '100.00',
        100,
        [],
        {},
        { amount: '100.00' },
        { currency: 'BRL' },
        { amount: 100, currency: 'BRL' },
        { amount: '100.00', currency: 123 },
      ];

      for (const invalid of invalidInputs) {
        const testPlayerId = crypto.randomUUID();

        await expect(
          createWalletUseCase.execute({
            playerId: testPlayerId,
            initialBalance: invalid,
          })
        ).rejects.toThrow(InvalidWagerOperationError);

        uow.getEntityManager().clear();

        const count = Number(
          (await adminPool.query('SELECT count(*) FROM wallets WHERE player_id = $1', [testPlayerId])).rows[0].count
        );
        expect(count).toBe(0);
      }
    });

    it('deve rejeitar moedas diferentes de BRL pela restrição operacional', async () => {
      const testPlayerId = crypto.randomUUID();

      await expect(
        createWalletUseCase.execute({
          playerId: testPlayerId,
          initialBalance: { amount: '50.00', currency: 'USD' },
        })
      ).rejects.toThrow('Only BRL currency is supported operationally');

      uow.getEntityManager().clear();
      const count = Number(
        (await adminPool.query('SELECT count(*) FROM wallets WHERE player_id = $1', [testPlayerId])).rows[0].count
      );
      expect(count).toBe(0);
    });
  });

  describe('7. Reconciliação das Carteiras Abertas: Saldo Igual ao Ledger', () => {
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

  describe('8. Abertura no Limite Money e Rejeição Acima Dele', () => {
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

      const rawLedger = (
        await adminPool.query('SELECT amount, balance_after FROM wallet_ledger_entries WHERE wallet_id = $1', [wallet.id])
      ).rows[0];
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

      const count = Number(
        (await adminPool.query('SELECT count(*) FROM wallets WHERE player_id = $1', [playerId])).rows[0].count
      );
      expect(count).toBe(0);
    });
  });

  describe('9. Testes HTTP do Contrato, Entradas Inválidas e Tentativa de OPENING Externa', () => {
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
        const body = (await res.json()) as any;
        expect(body.statusCode).toBe(400);
        expect(body.error).toBe('Bad Request');
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
      expect(body.statusCode).toBe(400);
      expect(body.error).toBe('Bad Request');
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
      expect(body.statusCode).toBe(400);
      expect(body.error).toBe('Bad Request');
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
        const body = (await res.json()) as any;
        expect(body.statusCode).toBe(400);
        expect(body.error).toBe('Bad Request');
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
        const body = (await res.json()) as any;
        expect(body.statusCode).toBe(400);
        expect(body.error).toBe('Bad Request');
      }
    });

    it('POST /wallets deve retornar 409 Conflict na duplicação sequencial com code DUPLICATE_WALLET', async () => {
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
      expect(body.statusCode).toBe(409);
      expect(body.code).toBe('DUPLICATE_WALLET');
      expect(body.error).toBe('Conflict');
    });

    it('POST /wagering/transactions deve rejeitar tentativa externa de submissão com kind="OPENING" com 400 Bad Request', async () => {
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
      expect(body.statusCode).toBe(400);
      expect(body.error).toBe('Bad Request');
      expect(body.message).toContain('Unsupported kind: "OPENING"');

      uow.getEntityManager().clear();

      // Checar que a carteira permaneceu com saldo 0.00 e sem transações
      const checkWallet = await getWalletUseCase.execute(wallet.id);
      expect(checkWallet.balance.amount).toBe('0.00');

      const txCount = Number(
        (await adminPool.query('SELECT count(*) FROM wager_transactions WHERE wallet_id = $1', [wallet.id])).rows[0].count
      );
      expect(txCount).toBe(0);
    });
  });
});
