import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  MikroOrmOutboxRepository,
  MikroOrmUnitOfWork,
  MikroOrmWagerTransactionRepository,
  MikroOrmWalletLedgerRepository,
  MikroOrmWalletRepository,
} from '../../src/infrastructure/persistence/mikro-orm/mikro-orm-adapter';
import { Wallet } from '../../src/domain/entities/wallet.entity';
import { WagerTransaction } from '../../src/domain/entities/wager-transaction.entity';
import { WalletLedgerEntry } from '../../src/domain/entities/wallet-ledger-entry.entity';
import { Money } from '../../src/domain/value-objects/money.vo';
import { IntegrationEvent, ReconstructedIntegrationEvent } from '../../src/domain/events/events';
import {
  TransactionRequiredError,
  TransactionRollbackOnlyError,
} from '../../src/domain/errors/domain.error';
import { createIsolatedTestDatabase, IsolatedTestDatabase } from '../test-db-helper';

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createTestWallet(id = uuidv4(), playerId = uuidv4(), initialBalance = '100.00', currency = 'BRL'): Wallet {
  const result = Wallet.create({
    id,
    playerId,
    currency,
    initialBalance: Money.create(initialBalance, currency),
  });
  return result.wallet;
}

function createTestTransaction(id = uuidv4(), walletId = uuidv4(), playerId = uuidv4()): WagerTransaction {
  return WagerTransaction.createBet({
    id,
    walletId,
    playerId,
    providerId: 'provider_m05',
    externalTransactionId: `ext_${id}`,
    roundId: `round_${id}`,
    gameId: 'game_m05',
    money: Money.create('10.00', 'BRL'),
    idempotencyKey: `idemp_${id}`,
    payloadHash: `hash_${id}`,
    status: 'PROCESSED',
  });
}

function createTestLedger(id = uuidv4(), walletId = uuidv4(), transactionId = uuidv4()): WalletLedgerEntry {
  return WalletLedgerEntry.create({
    id,
    walletId,
    transactionId,
    entryType: 'DEBIT',
    amount: Money.create('10.00', 'BRL'),
    currency: 'BRL',
    balanceBefore: Money.create('100.00', 'BRL'),
    balanceAfter: Money.create('90.00', 'BRL'),
  });
}

function createTestOutboxEvent(id = uuidv4(), walletId = uuidv4()): IntegrationEvent<unknown> {
  return new ReconstructedIntegrationEvent({
    eventId: id,
    eventType: 'wager.test.event',
    aggregateId: walletId,
    version: 1,
    occurredAt: new Date().toISOString(),
    correlationId: uuidv4(),
    data: { walletId, test: true },
  });
}


describe('M05: MikroORM & Unit of Work Stabilization Suite (Real Disposable PostgreSQL)', () => {
  let isolatedDb: IsolatedTestDatabase;
  let adminPool: pg.Pool;
  let uow: MikroOrmUnitOfWork;
  let walletRepo: MikroOrmWalletRepository;
  let wagerRepo: MikroOrmWagerTransactionRepository;
  let ledgerRepo: MikroOrmWalletLedgerRepository;
  let outboxRepo: MikroOrmOutboxRepository;

  beforeAll(async () => {
    isolatedDb = await createIsolatedTestDatabase('m05_uow_');
    adminPool = new pg.Pool({
      ...isolatedDb.adminConfig,
      application_name: 'admin_pool',
    });

    uow = new MikroOrmUnitOfWork();
    await uow.init();

    walletRepo = new MikroOrmWalletRepository(uow);
    wagerRepo = new MikroOrmWagerTransactionRepository(uow);
    ledgerRepo = new MikroOrmWalletLedgerRepository(uow);
    outboxRepo = new MikroOrmOutboxRepository(uow);
  }, 30000);

  afterAll(async () => {
    uow?.clearTestHooks();
    await uow?.close();
    await adminPool?.end();
    await isolatedDb?.closeAndDrop();
  }, 30000);


  beforeEach(() => {
    uow.clearTestHooks();
  });

  // =========================================================================
  // A. Identidade transacional:
  //    confirmar EntityManager compartilhado dentro da operação e
  //    mesma conexão PostgreSQL nas gravações dos quatro repositórios.
  // =========================================================================
  describe('A. Identidade Transacional', () => {
    it('deve compartilhar o mesmo EntityManager e a mesma conexão/transação PostgreSQL entre todos os repositórios', async () => {
      const playerId = uuidv4();
      const walletId = uuidv4();
      const txId = uuidv4();
      const ledgerId = uuidv4();
      const eventId = uuidv4();

      let sharedEm!: EntityManager;
      let pidAtWallet: number = 0;

      let txidAtWallet: string = '';
      let pidAtWager: number = 0;
      let txidAtWager: string = '';
      let pidAtLedger: number = 0;
      let txidAtLedger: string = '';
      let pidAtOutbox: number = 0;
      let txidAtOutbox: string = '';

      await uow.runInTransaction(async () => {
        const em = uow.getEntityManager();
        sharedEm = em;

        // Repositório 1: Wallet
        const wallet = createTestWallet(walletId, playerId, '100.00', 'BRL');
        await walletRepo.save(wallet);

        const resWallet = await em.execute<{ pid: number; txid: string }[]>(
          'SELECT pg_backend_pid() AS pid, txid_current()::text AS txid'
        );
        pidAtWallet = resWallet[0].pid;
        txidAtWallet = resWallet[0].txid;

        // Repositório 2: WagerTransaction
        const wagerTx = createTestTransaction(txId, walletId, playerId);
        await wagerRepo.save(wagerTx);

        const resWager = await em.execute<{ pid: number; txid: string }[]>(
          'SELECT pg_backend_pid() AS pid, txid_current()::text AS txid'
        );
        pidAtWager = resWager[0].pid;
        txidAtWager = resWager[0].txid;

        // Repositório 3: WalletLedgerEntry
        const ledgerEntry = createTestLedger(ledgerId, walletId, txId);
        await ledgerRepo.save(ledgerEntry);

        const resLedger = await em.execute<{ pid: number; txid: string }[]>(
          'SELECT pg_backend_pid() AS pid, txid_current()::text AS txid'
        );
        pidAtLedger = resLedger[0].pid;
        txidAtLedger = resLedger[0].txid;

        // Repositório 4: OutboxRepository
        const event = createTestOutboxEvent(eventId, walletId);
        await outboxRepo.save(event);

        const resOutbox = await em.execute<{ pid: number; txid: string }[]>(
          'SELECT pg_backend_pid() AS pid, txid_current()::text AS txid'
        );
        pidAtOutbox = resOutbox[0].pid;
        txidAtOutbox = resOutbox[0].txid;


        // Verificar que uow.getEntityManager() é a mesma instância durante toda a execução
        expect(uow.getEntityManager()).toBe(sharedEm);
      });

      // 1. Prova do PostgreSQL: Todos usaram o mesmo PID (mesma conexão física)
      expect(pidAtWallet).toBeGreaterThan(0);
      expect(pidAtWallet).toBe(pidAtWager);
      expect(pidAtWager).toBe(pidAtLedger);
      expect(pidAtLedger).toBe(pidAtOutbox);

      // 2. Prova do PostgreSQL: Todos usaram o mesmo txid_current() (mesma transação física)
      expect(txidAtWallet).toBeDefined();
      expect(txidAtWallet).toBe(txidAtWager);
      expect(txidAtWager).toBe(txidAtLedger);
      expect(txidAtLedger).toBe(txidAtOutbox);

      // 3. Prova no banco via conexão externa: registros foram gravados com sucesso
      const checkWallet = await adminPool.query('SELECT count(*) FROM wallets WHERE id = $1', [walletId]);
      const checkTx = await adminPool.query('SELECT count(*) FROM wager_transactions WHERE id = $1', [txId]);
      const checkLedger = await adminPool.query('SELECT count(*) FROM wallet_ledger_entries WHERE id = $1', [ledgerId]);
      const checkOutbox = await adminPool.query('SELECT count(*) FROM outbox_messages WHERE id = $1', [eventId]);

      expect(Number(checkWallet.rows[0].count)).toBe(1);
      expect(Number(checkTx.rows[0].count)).toBe(1);
      expect(Number(checkLedger.rows[0].count)).toBe(1);
      expect(Number(checkOutbox.rows[0].count)).toBe(1);
    });
  });

  // =========================================================================
  // B. Isolamento:
  //    duas execuções concorrentes possuem contextos distintos.
  //    Provas de visibilidade não commitada devem usar outra conexão, com
  //    sincronização explícita (sem esperas arbitrárias).
  // =========================================================================
  describe('B. Isolamento e MVCC com Sincronização Explícita', () => {
    it('deve manter duas execuções concorrentes em conexões/transações distintas e não vazar visibilidade não commitada', async () => {
      const wallet1Id = uuidv4();
      const wallet2Id = uuidv4();
      const player1Id = uuidv4();
      const player2Id = uuidv4();

      const t1Saved = createDeferred<void>();
      const t1CanCommit = createDeferred<void>();

      const t2Saved = createDeferred<void>();
      const t2CanCommit = createDeferred<void>();

      let em1!: EntityManager;
      let em2!: EntityManager;
      let pid1: number = 0;
      let pid2: number = 0;
      let txid1: string = '';
      let txid2: string = '';


      // Execução 1 concorrente
      const promise1 = uow.runInTransaction(async () => {
        em1 = uow.getEntityManager();
        const res = await em1.execute<{ pid: number; txid: string }[]>(
          'SELECT pg_backend_pid() AS pid, txid_current()::text AS txid'
        );
        pid1 = res[0].pid;
        txid1 = res[0].txid;

        const w1 = createTestWallet(wallet1Id, player1Id, '100.00', 'BRL');
        await walletRepo.save(w1);

        // Notificar que T1 salvou mas AINDA NÃO commitou
        t1Saved.resolve();

        // Aguardar autorização para commitar
        await t1CanCommit.promise;
      });

      // Execução 2 concorrente
      const promise2 = uow.runInTransaction(async () => {
        em2 = uow.getEntityManager();
        const res = await em2.execute<{ pid: number; txid: string }[]>(
          'SELECT pg_backend_pid() AS pid, txid_current()::text AS txid'
        );
        pid2 = res[0].pid;
        txid2 = res[0].txid;

        const w2 = createTestWallet(wallet2Id, player2Id, '200.00', 'BRL');
        await walletRepo.save(w2);

        // Notificar que T2 salvou mas AINDA NÃO commitou
        t2Saved.resolve();

        // Aguardar autorização para commitar
        await t2CanCommit.promise;
      });


      // Aguardar ambas as gravações acontecerem nos seus respectivos EntityManagers
      await t1Saved.promise;
      await t2Saved.promise;

      // PROVA 1: EntityManagers são instâncias separadas
      expect(em1).not.toBe(em2);

      // PROVA 2: Conexões PostgreSQL físicas e transações são distintas
      expect(pid1).toBeGreaterThan(0);
      expect(pid2).toBeGreaterThan(0);
      expect(pid1).not.toBe(pid2);
      expect(txid1).not.toBe('');
      expect(txid2).not.toBe('');
      expect(txid1).not.toBe(txid2);

      // PROVA 3: Conexão externa (adminPool) NÃO enxerga dados antes do commit (PostgreSQL MVCC)
      const visibleW1BeforeCommit = await adminPool.query(
        'SELECT count(*) FROM wallets WHERE id = $1',
        [wallet1Id]
      );
      const visibleW2BeforeCommit = await adminPool.query(
        'SELECT count(*) FROM wallets WHERE id = $1',
        [wallet2Id]
      );
      expect(Number(visibleW1BeforeCommit.rows[0].count)).toBe(0);
      expect(Number(visibleW2BeforeCommit.rows[0].count)).toBe(0);

      // Liberar commit de ambas
      t1CanCommit.resolve();
      t2CanCommit.resolve();

      await Promise.all([promise1, promise2]);

      // PROVA 4: Após o commit de ambas, os dados tornam-se visíveis na conexão externa
      const visibleAfterCommit = await adminPool.query(
        'SELECT count(*) FROM wallets WHERE id IN ($1, $2)',
        [wallet1Id, wallet2Id]
      );
      expect(Number(visibleAfterCommit.rows[0].count)).toBe(2);
    });
  });

  // =========================================================================
  // C. Rollback:
  //    falha após cada gravação desfaz todos os efeitos da tentativa.
  // =========================================================================
  describe('C. Rollback Integral após Cada Gravação', () => {
    it('deve reverter integralmente quando a falha ocorre após wallet_save', async () => {
      const walletId = uuidv4();
      const playerId = uuidv4();

      uow.setTestFailurePoint('after_wallet_save', () => {
        throw new Error('Falha simulada pós-wallet_save');
      });

      let caught = false;
      try {
        await uow.runInTransaction(async () => {
          const wallet = createTestWallet(walletId, playerId, '100.00', 'BRL');
          await walletRepo.save(wallet);
        });
      } catch (e: any) {
        caught = true;
        expect(e.message).toContain('Falha simulada pós-wallet_save');
      }

      expect(caught).toBe(true);

      const checkWallet = await adminPool.query('SELECT count(*) FROM wallets WHERE id = $1', [walletId]);
      expect(Number(checkWallet.rows[0].count)).toBe(0);
    });

    it('deve reverter integralmente quando a falha ocorre após tx_save', async () => {
      const walletId = uuidv4();
      const playerId = uuidv4();
      const txId = uuidv4();

      uow.setTestFailurePoint('after_tx_save', () => {
        throw new Error('Falha simulada pós-tx_save');
      });

      let caught = false;
      try {
        await uow.runInTransaction(async () => {
          const wallet = createTestWallet(walletId, playerId, '100.00', 'BRL');
          await walletRepo.save(wallet);

          const tx = createTestTransaction(txId, walletId, playerId);
          await wagerRepo.save(tx);
        });
      } catch (e: any) {
        caught = true;
        expect(e.message).toContain('Falha simulada pós-tx_save');
      }

      expect(caught).toBe(true);

      const checkWallet = await adminPool.query('SELECT count(*) FROM wallets WHERE id = $1', [walletId]);
      const checkTx = await adminPool.query('SELECT count(*) FROM wager_transactions WHERE id = $1', [txId]);
      expect(Number(checkWallet.rows[0].count)).toBe(0);
      expect(Number(checkTx.rows[0].count)).toBe(0);
    });

    it('deve reverter integralmente quando a falha ocorre após ledger_save', async () => {
      const walletId = uuidv4();
      const playerId = uuidv4();
      const txId = uuidv4();
      const ledgerId = uuidv4();

      uow.setTestFailurePoint('after_ledger_save', () => {
        throw new Error('Falha simulada pós-ledger_save');
      });

      let caught = false;
      try {
        await uow.runInTransaction(async () => {
          const wallet = createTestWallet(walletId, playerId, '100.00', 'BRL');
          await walletRepo.save(wallet);

          const tx = createTestTransaction(txId, walletId, playerId);
          await wagerRepo.save(tx);

          const ledger = createTestLedger(ledgerId, walletId, txId);
          await ledgerRepo.save(ledger);
        });
      } catch (e: any) {
        caught = true;
        expect(e.message).toContain('Falha simulada pós-ledger_save');
      }

      expect(caught).toBe(true);

      const checkWallet = await adminPool.query('SELECT count(*) FROM wallets WHERE id = $1', [walletId]);
      const checkTx = await adminPool.query('SELECT count(*) FROM wager_transactions WHERE id = $1', [txId]);
      const checkLedger = await adminPool.query('SELECT count(*) FROM wallet_ledger_entries WHERE id = $1', [ledgerId]);
      expect(Number(checkWallet.rows[0].count)).toBe(0);
      expect(Number(checkTx.rows[0].count)).toBe(0);
      expect(Number(checkLedger.rows[0].count)).toBe(0);
    });

    it('deve reverter integralmente quando a falha ocorre após outbox_save', async () => {
      const walletId = uuidv4();
      const playerId = uuidv4();
      const eventId = uuidv4();

      uow.setTestFailurePoint('after_outbox_save', () => {
        throw new Error('Falha simulada pós-outbox_save');
      });

      let caught = false;
      try {
        await uow.runInTransaction(async () => {
          const wallet = createTestWallet(walletId, playerId, '100.00', 'BRL');
          await walletRepo.save(wallet);

          const event = createTestOutboxEvent(eventId, walletId);
          await outboxRepo.save(event);
        });
      } catch (e: any) {
        caught = true;
        expect(e.message).toContain('Falha simulada pós-outbox_save');
      }

      expect(caught).toBe(true);

      const checkWallet = await adminPool.query('SELECT count(*) FROM wallets WHERE id = $1', [walletId]);
      const checkOutbox = await adminPool.query('SELECT count(*) FROM outbox_messages WHERE id = $1', [eventId]);
      expect(Number(checkWallet.rows[0].count)).toBe(0);
      expect(Number(checkOutbox.rows[0].count)).toBe(0);
    });
  });

  // =========================================================================
  // D. Aninhamento:
  //    chamada interna não confirma antes da externa;
  //    falha externa desfaz trabalho interno;
  //    falha interna capturada não deixa commit parcial (rollback-only).
  // =========================================================================
  describe('D. Semântica de Aninhamento & Rollback-Only', () => {
    it('D.1: chamada interna não confirma independentemente antes da externa', async () => {
      const walletId = uuidv4();
      const playerId = uuidv4();
      const eventId = uuidv4();

      const innerCompleted = createDeferred<void>();
      const outerCanCommit = createDeferred<void>();

      const txPromise = uow.runInTransaction(async () => {
        const wallet = createTestWallet(walletId, playerId, '100.00', 'BRL');
        await walletRepo.save(wallet);

        // Chamada aninhada
        await uow.runInTransaction(async () => {
          const event = createTestOutboxEvent(eventId, walletId);
          await outboxRepo.save(event);
        });

        // Notificar que a chamada aninhada encerrou sua execução de código
        innerCompleted.resolve();

        // Aguardar sinal antes de commitar a transação externa
        await outerCanCommit.promise;
      });

      // Aguardar encerramento do bloco aninhado
      await innerCompleted.promise;

      // PROVA: A gravação feita na chamada aninhada NÃO está commitada no PostgreSQL
      const checkInnerBeforeOuterCommit = await adminPool.query(
        'SELECT count(*) FROM outbox_messages WHERE id = $1',
        [eventId]
      );
      expect(Number(checkInnerBeforeOuterCommit.rows[0].count)).toBe(0);

      // Liberar o commit da transação externa
      outerCanCommit.resolve();
      await txPromise;

      // PROVA: Agora que a externa commitou, ambos os registros existem
      const checkAfter = await adminPool.query(
        'SELECT count(*) FROM outbox_messages WHERE id = $1',
        [eventId]
      );
      expect(Number(checkAfter.rows[0].count)).toBe(1);
    });

    it('D.2: falha externa desfaz integralmente o trabalho feito pela chamada interna', async () => {
      const walletId = uuidv4();
      const playerId = uuidv4();
      const txId = uuidv4();
      const eventId = uuidv4();

      let caught = false;
      try {
        await uow.runInTransaction(async () => {
          const wallet = createTestWallet(walletId, playerId, '100.00', 'BRL');
          await walletRepo.save(wallet);

          // Chamada aninhada bem-sucedida
          await uow.runInTransaction(async () => {
            const tx = createTestTransaction(txId, walletId, playerId);
            await wagerRepo.save(tx);

            const event = createTestOutboxEvent(eventId, walletId);
            await outboxRepo.save(event);
          });

          // Falha posterior provocada na camada externa
          throw new Error('Falha intencional na camada externa pós-aninhamento');
        });
      } catch (e: any) {
        caught = true;
        expect(e.message).toContain('Falha intencional na camada externa pós-aninhamento');
      }

      expect(caught).toBe(true);

      // PROVA: Nada foi persistido, inclusive o trabalho do bloco interno
      const checkWallet = await adminPool.query('SELECT count(*) FROM wallets WHERE id = $1', [walletId]);
      const checkTx = await adminPool.query('SELECT count(*) FROM wager_transactions WHERE id = $1', [txId]);
      const checkOutbox = await adminPool.query('SELECT count(*) FROM outbox_messages WHERE id = $1', [eventId]);

      expect(Number(checkWallet.rows[0].count)).toBe(0);
      expect(Number(checkTx.rows[0].count)).toBe(0);
      expect(Number(checkOutbox.rows[0].count)).toBe(0);
    });

    it('D.3: falha interna capturada pela camada externa não permite commit parcial (Rollback-Only)', async () => {
      const walletId = uuidv4();
      const playerId = uuidv4();
      const eventId = uuidv4();

      let caught = false;

      try {
        await uow.runInTransaction(async () => {
          const wallet = createTestWallet(walletId, playerId, '100.00', 'BRL');
          await walletRepo.save(wallet);

          try {
            // Chamada aninhada que falha
            await uow.runInTransaction(async () => {
              const event = createTestOutboxEvent(eventId, walletId);
              await outboxRepo.save(event);

              throw new Error('Erro interno que será capturado pela camada externa');
            });
          } catch (innerErr) {
            // A camada externa tenta engolir a falha interna e continuar
          }

          // A camada externa tenta finalizar normalmente como se nada tivesse acontecido
          return { success: true };
        });
      } catch (err: any) {
        caught = true;
        // Exige que o UoW rejeite o commit com rollback-only ou a causa do erro interno
        expect(
          err instanceof TransactionRollbackOnlyError ||
          err.message.includes('rollback-only') ||
          err.message.includes('Erro interno que será capturado')
        ).toBe(true);
      }

      expect(caught).toBe(true);

      // PROVA NO POSTGRESQL: Absolutamente NADA foi commitado (nem a wallet externa, nem a outbox interna)
      const checkWallet = await adminPool.query('SELECT count(*) FROM wallets WHERE id = $1', [walletId]);
      const checkOutbox = await adminPool.query('SELECT count(*) FROM outbox_messages WHERE id = $1', [eventId]);

      expect(Number(checkWallet.rows[0].count)).toBe(0);
      expect(Number(checkOutbox.rows[0].count)).toBe(0);
    });
  });

  // =========================================================================
  // E. Limpeza:
  //    após erro, nova execução usa contexto válido e funciona.
  // =========================================================================
  describe('E. Limpeza e Ausência de Vazamento de Contexto', () => {
    it('deve limpar contexto após erro e permitir nova execução bem-sucedida sem resquícios', async () => {
      // 1. Execução falha
      try {
        await uow.runInTransaction(async () => {
          const wallet = createTestWallet(uuidv4(), uuidv4(), '50.00', 'BRL');
          await walletRepo.save(wallet);
          throw new Error('Falha proposital para abortar');
        });
      } catch {
        // Ignorar
      }

      // Contexto transacional deve estar inativo fora de runInTransaction
      expect(uow.isTransactionActive()).toBe(false);
      expect(uow.getTransactionContext()).toBeUndefined();

      // 2. Nova execução válida
      const validWalletId = uuidv4();
      const validPlayerId = uuidv4();

      await uow.runInTransaction(async () => {
        expect(uow.isTransactionActive()).toBe(true);
        expect(uow.getTransactionContext()?.rollbackOnly).toBe(false);

        const wallet = createTestWallet(validWalletId, validPlayerId, '250.00', 'BRL');
        await walletRepo.save(wallet);
      });

      expect(uow.isTransactionActive()).toBe(false);

      // 3. Prova no banco: a nova operação foi persistida com sucesso
      const check = await adminPool.query(
        'SELECT balance, version FROM wallets WHERE id = $1',
        [validWalletId]
      );
      expect(check.rows.length).toBe(1);
      expect(check.rows[0].balance).toBe('250.00');
      expect(Number(check.rows[0].version)).toBe(1);
    });
  });

  // =========================================================================
  // F. Escrita sem UoW:
  //    rejeitada sem persistência. Consultas simples podem funcionar fora.
  // =========================================================================
  describe('F. Escrita sem UoW Rejeitada & Consultas Fora da Transação', () => {
    it('deve rejeitar gravação em WalletRepository fora da transação sem persistir no PostgreSQL', async () => {
      const wallet = createTestWallet(uuidv4(), uuidv4(), '10.00', 'BRL');

      expect(uow.isTransactionActive()).toBe(false);

      await expect(walletRepo.save(wallet)).rejects.toThrow(TransactionRequiredError);

      const check = await adminPool.query('SELECT count(*) FROM wallets WHERE id = $1', [wallet.id]);
      expect(Number(check.rows[0].count)).toBe(0);
    });

    it('deve rejeitar gravação em WagerTransactionRepository fora da transação', async () => {
      const tx = createTestTransaction();

      await expect(wagerRepo.save(tx)).rejects.toThrow(TransactionRequiredError);

      const check = await adminPool.query('SELECT count(*) FROM wager_transactions WHERE id = $1', [tx.id]);
      expect(Number(check.rows[0].count)).toBe(0);
    });

    it('deve rejeitar gravação em WalletLedgerRepository fora da transação', async () => {
      const entry = createTestLedger();

      await expect(ledgerRepo.save(entry)).rejects.toThrow(TransactionRequiredError);

      const check = await adminPool.query('SELECT count(*) FROM wallet_ledger_entries WHERE id = $1', [entry.id]);
      expect(Number(check.rows[0].count)).toBe(0);
    });

    it('deve rejeitar gravação em OutboxRepository fora da transação', async () => {
      const event = createTestOutboxEvent();

      await expect(outboxRepo.save(event)).rejects.toThrow(TransactionRequiredError);

      const check = await adminPool.query('SELECT count(*) FROM outbox_messages WHERE id = $1', [event.eventId]);
      expect(Number(check.rows[0].count)).toBe(0);
    });

    it('deve rejeitar lock pessimista fora da transação', async () => {
      await expect(walletRepo.findById(uuidv4(), true)).rejects.toThrow(TransactionRequiredError);
    });

    it('deve permitir consultas simples fora da transação sem erros', async () => {
      // 1. Criar dados de teste dentro de uma transação válida
      const walletId = uuidv4();
      const playerId = uuidv4();
      const txId = uuidv4();

      await uow.runInTransaction(async () => {
        const w = createTestWallet(walletId, playerId, '50.00', 'BRL');
        await walletRepo.save(w);

        const tx = createTestTransaction(txId, walletId, playerId);
        await wagerRepo.save(tx);
      });

      // 2. Executar consultas simples FORA de qualquer transação
      expect(uow.isTransactionActive()).toBe(false);

      const foundWallet = await walletRepo.findById(walletId, false);
      expect(foundWallet).not.toBeNull();
      expect(foundWallet?.id).toBe(walletId);

      const foundByPlayer = await walletRepo.findByPlayerIdAndCurrency(playerId, 'BRL');
      expect(foundByPlayer).not.toBeNull();
      expect(foundByPlayer?.playerId).toBe(playerId);

      const foundTx = await wagerRepo.findById(txId);
      expect(foundTx).not.toBeNull();
      expect(foundTx?.id).toBe(txId);

      const pendingRefs = await wagerRepo.listPendingReferences();
      expect(Array.isArray(pendingRefs)).toBe(true);

      const ledgerEntries = await ledgerRepo.listByWalletId(walletId);
      expect(Array.isArray(ledgerEntries)).toBe(true);

      const unpublished = await outboxRepo.listUnpublished();
      expect(Array.isArray(unpublished)).toBe(true);
    });
  });

  // =========================================================================
  // G. Ciclo da Aplicação NestJS:
  //    iniciar, executar operação e encerrar sem conexões penduradas.
  // =========================================================================
  describe('G. Ciclo da Aplicação NestJS e Liberação de Recursos', () => {
    it('deve inicializar, executar operações e encerrar liberando todas as conexões do pool', async () => {
      const lifecycleDb = await createIsolatedTestDatabase('lifecycle_');
      const lifecycleAdminPool = new pg.Pool({
        ...lifecycleDb.adminConfig,
        application_name: 'admin_pool',
      });

      const lifecycleUow = new MikroOrmUnitOfWork();
      await lifecycleUow.onModuleInit();

      const testWalletRepo = new MikroOrmWalletRepository(lifecycleUow);

      // Executar uma operação com sucesso
      const walletId = uuidv4();
      await lifecycleUow.runInTransaction(async () => {
        const wallet = createTestWallet(walletId, uuidv4(), '100.00', 'BRL');
        await testWalletRepo.save(wallet);
      });

      // Confirmar que a gravação ocorreu
      const checkRecord = await lifecycleAdminPool.query('SELECT count(*) FROM wallets WHERE id = $1', [walletId]);
      expect(Number(checkRecord.rows[0].count)).toBe(1);

      // Simula encerramento do ciclo NestJS
      await lifecycleUow.onModuleDestroy();

      // Prova de ausência de conexões penduradas via pg_stat_activity
      const activeConnectionsResult = await lifecycleAdminPool.query(`
        SELECT count(*) as count 
        FROM pg_stat_activity 
        WHERE datname = $1 
          AND application_name != 'admin_pool' 
          AND pid != pg_backend_pid();
      `, [lifecycleDb.dbName]);

      expect(Number(activeConnectionsResult.rows[0].count)).toBe(0);

      await lifecycleAdminPool.end();
      await lifecycleDb.closeAndDrop();
    }, 30000);
  });


});
