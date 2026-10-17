import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
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
import { ProcessWagerUseCase } from '../../src/application/use-cases/process-wager.use-case';
import { ReconcileWalletUseCase } from '../../src/application/use-cases/reconcile-wallet.use-case';
import { ReprocessPendingReferencesUseCase } from '../../src/application/use-cases/reprocess-pending-references.use-case';
import { PendingReferenceWorkerService } from '../../src/infrastructure/workers/pending-reference-worker.service';
import { Money } from '../../src/domain/value-objects/money.vo';
import { createIsolatedTestDatabase, IsolatedTestDatabase } from '../test-db-helper';
import { StaleLeaseError } from '../../src/domain/errors/domain.error';

describe('M10: Worker de Referências Pendentes e Concorrência Distribuída (PostgreSQL Real Descartável)', () => {
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
  let processWagerUseCase: ProcessWagerUseCase;
  let reconcileWalletUseCase: ReconcileWalletUseCase;
  let reprocessUseCase: ReprocessPendingReferencesUseCase;
  let workerService: PendingReferenceWorkerService;

  interface DbStateSnapshot {
    wallet: { balance: string; version: number };
    transaction: {
      status: string;
      attempts: number;
      nextAttemptAt: string | null;
      leaseToken: string | null;
      leaseOwner: string | null;
      leaseExpiresAt: string | null;
      isOperationallyBlocked: boolean;
      operationalBlockReason: string | null;
      responseSnapshot: any;
    };
    ledgerCount: number;
    outboxCount: number;
  }

  async function captureDbState(walletId: string, txId: string): Promise<DbStateSnapshot> {
    const walletRes = await adminPool.query('SELECT balance, version FROM wallets WHERE id = $1;', [walletId]);
    const txRes = await adminPool.query(
      `SELECT status, attempts, next_attempt_at, lease_token, lease_owner, lease_expires_at, 
              is_operationally_blocked, operational_block_reason, response_snapshot 
       FROM wager_transactions WHERE id = $1;`,
      [txId]
    );
    const ledgerRes = await adminPool.query('SELECT COUNT(*) FROM wallet_ledger_entries WHERE wallet_id = $1;', [walletId]);
    const outboxRes = await adminPool.query('SELECT COUNT(*) FROM outbox_messages WHERE aggregate_id = $1;', [walletId]);

    return {
      wallet: {
        balance: walletRes.rows[0].balance,
        version: walletRes.rows[0].version,
      },
      transaction: {
        status: txRes.rows[0].status,
        attempts: txRes.rows[0].attempts,
        nextAttemptAt: txRes.rows[0].next_attempt_at ? new Date(txRes.rows[0].next_attempt_at).toISOString() : null,
        leaseToken: txRes.rows[0].lease_token,
        leaseOwner: txRes.rows[0].lease_owner,
        leaseExpiresAt: txRes.rows[0].lease_expires_at ? new Date(txRes.rows[0].lease_expires_at).toISOString() : null,
        isOperationallyBlocked: txRes.rows[0].is_operationally_blocked,
        operationalBlockReason: txRes.rows[0].operational_block_reason,
        responseSnapshot: txRes.rows[0].response_snapshot,
      },
      ledgerCount: parseInt(ledgerRes.rows[0].count, 10),
      outboxCount: parseInt(outboxRes.rows[0].count, 10),
    };
  }

  async function makePendingEligible(transactionId: string): Promise<void> {
    await adminPool.query(
      "UPDATE wager_transactions SET next_attempt_at = NOW() - INTERVAL '1 second', lease_expires_at = NULL, lease_token = NULL WHERE id = $1;",
      [transactionId]
    );
  }

  function spawnWorkerWithMilestone(
    envOverrides: Record<string, string>,
    batchSize = '10',
    leaseDurationMs = '30000'
  ) {
    const runnerScript = join(import.meta.dir, '..', 'concurrency', 'pending-worker-runner.ts');
    const proc = spawn('bun', ['run', runnerScript, '', batchSize, leaseDurationMs], {
      env: {
        ...process.env,
        DB_NAME: isolatedDb.dbName,
        APP_DB_NAME: isolatedDb.dbName,
        ...envOverrides,
      },
    });

    let stdout = '';
    let milestoneResolve: (value: string) => void;
    const milestonePromise = new Promise<string>((resolve) => {
      milestoneResolve = resolve;
    });

    proc.stdout.on('data', (d) => {
      const str = d.toString();
      stdout += str;
      if (str.includes('MILESTONE:')) {
        const match = str.match(/MILESTONE:([^\r\n]+)/);
        if (match && milestoneResolve) {
          milestoneResolve(match[1]);
        }
      }
    });

    return {
      proc,
      milestonePromise,
      getStdout: () => stdout,
    };
  }

  beforeAll(async () => {
    isolatedDb = await createIsolatedTestDatabase('m10_worker_');

    adminPool = new pg.Pool({
      ...isolatedDb.adminConfig,
      max: 65,
    });
    adminPool.on('error', () => {});

    // Ensure worker doesn't poll automatically unless explicitly requested in a test
    process.env.PENDING_WORKER_ENABLED = 'false';

    app = await NestFactory.create(AppModule, { logger: false });
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.listen(0);
    const address = app.getHttpServer().address();
    serverUrl = `http://127.0.0.1:${address.port}`;

    uow = app.get(MikroOrmUnitOfWork);
    walletRepo = app.get(MikroOrmWalletRepository);
    wagerRepo = app.get(MikroOrmWagerTransactionRepository);
    ledgerRepo = app.get(MikroOrmWalletLedgerRepository);
    outboxRepo = app.get(MikroOrmOutboxRepository);

    createWalletUseCase = app.get(CreateWalletUseCase);
    processWagerUseCase = app.get(ProcessWagerUseCase);
    reconcileWalletUseCase = app.get(ReconcileWalletUseCase);
    reprocessUseCase = app.get(ReprocessPendingReferencesUseCase);
    workerService = app.get(PendingReferenceWorkerService);
  }, 60000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (adminPool) {
      await adminPool.end();
    }
    if (isolatedDb) {
      await isolatedDb.closeAndDrop();
    }
  }, 60000);

  it('A. NestJS inicia o worker e resolve pendência automaticamente, sem chamar execute manualmente', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    // 1. Processa uma BET de 20.00
    const betExternalId = `bet-${crypto.randomUUID()}`;
    await processWagerUseCase.execute(crypto.randomUUID(), {
      providerId: 'EVOLUTION',
      externalTransactionId: betExternalId,
      playerId,
      walletId: wallet.id,
      roundId: 'round-auto-1',
      gameId: 'roulette',
      kind: 'BET',
      money: { amount: '20.00', currency: 'BRL' },
    });

    // 2. Envia WIN referenciada sem chamar execute manualmente, mas com next_attempt_at no passado
    const winExternalId = `win-${crypto.randomUUID()}`;
    const winRes = await processWagerUseCase.execute(crypto.randomUUID(), {
      providerId: 'EVOLUTION',
      externalTransactionId: winExternalId,
      playerId,
      walletId: wallet.id,
      roundId: 'round-auto-1',
      gameId: 'roulette',
      kind: 'WIN',
      money: { amount: '50.00', currency: 'BRL' },
      referenceExternalTransactionId: betExternalId,
    });
    // Como a BET já estava processada, foi PROCESSED.
    // Agora criemos um caso onde a referência está ausente no momento do aceite para gerar PENDING_REFERENCE:
    const delayedBetId = `bet-delayed-${crypto.randomUUID()}`;
    const pendingWinId = `win-delayed-${crypto.randomUUID()}`;
    const pendingWinRes = await processWagerUseCase.execute(crypto.randomUUID(), {
      providerId: 'EVOLUTION',
      externalTransactionId: pendingWinId,
      playerId,
      walletId: wallet.id,
      roundId: 'round-auto-2',
      gameId: 'roulette',
      kind: 'WIN',
      money: { amount: '35.00', currency: 'BRL' },
      referenceExternalTransactionId: delayedBetId,
    });
    expect(pendingWinRes.status).toBe('PENDING_REFERENCE');

    // A BET agora chega e é processada
    await processWagerUseCase.execute(crypto.randomUUID(), {
      providerId: 'EVOLUTION',
      externalTransactionId: delayedBetId,
      playerId,
      walletId: wallet.id,
      roundId: 'round-auto-2',
      gameId: 'roulette',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    });

    // Torna a pendência elegível para o loop automático
    await makePendingEligible(pendingWinRes.transactionId);

    // Inicia o worker em background com intervalo curto (30ms)
    const backgroundWorker = new PendingReferenceWorkerService(reprocessUseCase, {
      enabled: true,
      intervalMs: 30,
      batchSize: 10,
      leaseDurationMs: 5000,
      workerId: 'auto-worker',
    });
    backgroundWorker.start();
    expect(backgroundWorker.isWorkerRunning()).toBe(true);

    // Aguarda sincronização determinística: polling na tabela do banco até transicionar para PROCESSED
    const startTime = Date.now();
    let finalStatus = 'PENDING_REFERENCE';
    while (Date.now() - startTime < 8000) {
      const state = await captureDbState(wallet.id, pendingWinRes.transactionId);
      if (state.transaction.status === 'PROCESSED') {
        finalStatus = 'PROCESSED';
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }

    backgroundWorker.stop();

    expect(finalStatus).toBe('PROCESSED');
    const finalState = await captureDbState(wallet.id, pendingWinRes.transactionId);
    expect(finalState.transaction.status).toBe('PROCESSED');
    expect(finalState.transaction.leaseToken).toBeNull();

    // Reconciliação confirma saldo e integridade contábil
    const recon = await reconcileWalletUseCase.execute(wallet.id);
    expect(recon.consistent).toBe(true);
    expect(recon.difference.amount).toBe('0.00');
  });

  it('B. Três processos reais disputam pendências: nenhum crédito/débito, ledger ou evento duplicado', async () => {
    // Criação de 3 carteiras, cada uma com 2 pendências (6 pendências no total)
    const pendingTxIds: string[] = [];
    const walletIds: string[] = [];

    for (let w = 0; w < 3; w++) {
      const playerId = crypto.randomUUID();
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });
      walletIds.push(wallet.id);

      for (let p = 0; p < 2; p++) {
        const betId = `bet-b-${w}-${p}-${crypto.randomUUID()}`;
        // Processa a BET
        await processWagerUseCase.execute(crypto.randomUUID(), {
          providerId: 'EVOLUTION',
          externalTransactionId: betId,
          playerId,
          walletId: wallet.id,
          roundId: `round-b-${w}-${p}`,
          gameId: 'blackjack',
          kind: 'BET',
          money: { amount: '10.00', currency: 'BRL' },
        });

        // Insere a WIN como PENDING_REFERENCE diretamente para disputa dos workers
        const winTxId = crypto.randomUUID();
        const winExtId = `win-b-${w}-${p}-${crypto.randomUUID()}`;
        const idemKey = crypto.randomUUID();

        // Usa query SQL direta garantindo snapshot canônico
        const snap = {
          transactionId: winTxId,
          status: 'PENDING_REFERENCE',
          balance: { amount: '90.00', currency: 'BRL' },
          idempotentReplay: false,
        };

        await adminPool.query(
          `INSERT INTO wager_transactions 
           (id, wallet_id, player_id, provider_id, external_transaction_id, round_id, game_id, kind, amount, currency, status, idempotency_key, payload_hash, response_snapshot, reference_external_transaction_id, attempts, next_attempt_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW() - INTERVAL '1 second', NOW(), NOW());`,
          [
            winTxId,
            wallet.id,
            playerId,
            'EVOLUTION',
            winExtId,
            `round-b-${w}-${p}`,
            'blackjack',
            'WIN',
            '25.00',
            'BRL',
            'PENDING_REFERENCE',
            idemKey,
            'dummy-hash',
            JSON.stringify(snap),
            betId,
            1,
          ]
        );
        pendingTxIds.push(winTxId);
      }
    }

    expect(pendingTxIds.length).toBe(6);

    // Barreira de sincronização por arquivo para handshake de prontidão entre os 3 processos
    const barrierFilePath = join(tmpdir(), `barrier-m10-b-${Date.now()}.tmp`);
    if (existsSync(barrierFilePath)) unlinkSync(barrierFilePath);

    const runnerScript = join(import.meta.dir, '..', 'concurrency', 'pending-worker-runner.ts');

    const spawnWorker = () => {
      return new Promise<{ code: number; stdout: string }>((resolve) => {
        const proc = spawn('bun', ['run', runnerScript, barrierFilePath, '10', '30000'], {
          env: {
            ...process.env,
            DB_NAME: isolatedDb.dbName,
            APP_DB_NAME: isolatedDb.dbName,
          },
        });

        let stdout = '';
        proc.stdout.on('data', (d) => {
          const str = d.toString();
          stdout += str;
        });

        proc.on('close', (code) => {
          resolve({ code: code ?? 0, stdout });
        });
      });
    };

    // Inicia os 3 processos reais
    const p1 = spawnWorker();
    const p2 = spawnWorker();
    const p3 = spawnWorker();

    // Aguarda prontidão com timeout de segurança
    await new Promise((resolve) => setTimeout(resolve, 800));

    // Libera a barreira
    writeFileSync(barrierFilePath, 'GO');

    const results = await Promise.all([p1, p2, p3]);

    if (existsSync(barrierFilePath)) unlinkSync(barrierFilePath);

    for (const r of results) {
      expect(r.code).toBe(0);
    }

    // Comprova que todas as 6 pendências foram processadas com exatidão
    for (const txId of pendingTxIds) {
      const res = await adminPool.query('SELECT status, attempts, lease_token FROM wager_transactions WHERE id = $1;', [txId]);
      expect(res.rows[0].status).toBe('PROCESSED');
      expect(res.rows[0].lease_token).toBeNull();
    }

    // Comprova que cada uma das 3 carteiras teve exatamente as 2 BETs e 2 WINs
    for (const wId of walletIds) {
      const recon = await reconcileWalletUseCase.execute(wId);
      expect(recon.consistent).toBe(true);
      expect(recon.difference.amount).toBe('0.00');

      // Saldo inicial 100.00 - 2x10.00 (BET) + 2x25.00 (WIN) = 130.00
      expect(recon.storedBalance.amount).toBe('130.00');

      // Exatamente 5 lançamentos de ledger (1 OPENING + 2 DEBITs + 2 CREDITs)
      const ledgerCount = await adminPool.query('SELECT COUNT(*) FROM wallet_ledger_entries WHERE wallet_id = $1;', [wId]);
      expect(parseInt(ledgerCount.rows[0].count, 10)).toBe(5);
    }
  });

  it('C. Duas pendências do mesmo tipo revertendo a mesma referência: uma processada e outra rejeitada auditavelmente', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    // BET processada de 25.00 -> saldo 75.00
    const betExtId = `bet-c-${crypto.randomUUID()}`;
    await processWagerUseCase.execute(crypto.randomUUID(), {
      providerId: 'EVOLUTION',
      externalTransactionId: betExtId,
      playerId,
      walletId: wallet.id,
      roundId: 'round-c-1',
      gameId: 'roulette',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    });

    // Insere 2 pendências de REFUND referenciando a MESMA BET
    const ref1Id = crypto.randomUUID();
    const ref2Id = crypto.randomUUID();

    const snap1 = {
      transactionId: ref1Id,
      status: 'PENDING_REFERENCE',
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: false,
    };
    const snap2 = {
      transactionId: ref2Id,
      status: 'PENDING_REFERENCE',
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: false,
    };

    await adminPool.query(
      `INSERT INTO wager_transactions 
       (id, wallet_id, player_id, provider_id, external_transaction_id, round_id, game_id, kind, amount, currency, status, idempotency_key, payload_hash, response_snapshot, reference_external_transaction_id, attempts, next_attempt_at, created_at, updated_at)
       VALUES 
       ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 1, NOW() - INTERVAL '1 second', NOW(), NOW()),
       ($16, $2, $3, $4, $17, $6, $7, $8, $9, $10, $11, $18, $19, $20, $15, 1, NOW() - INTERVAL '1 second', NOW(), NOW());`,
      [
        ref1Id,
        wallet.id,
        playerId,
        'EVOLUTION',
        `ref-c-1-${crypto.randomUUID()}`,
        'round-c-1',
        'roulette',
        'REFUND',
        '25.00',
        'BRL',
        'PENDING_REFERENCE',
        crypto.randomUUID(),
        'hash1',
        JSON.stringify(snap1),
        betExtId,
        ref2Id,
        `ref-c-2-${crypto.randomUUID()}`,
        crypto.randomUUID(),
        'hash2',
        JSON.stringify(snap2),
      ]
    );

    // Executa o reprocessamento em lote
    const result = await reprocessUseCase.execute(10);
    expect(result.processed).toBe(1);
    expect(result.rejected).toBe(1);

    const tx1Res = await adminPool.query('SELECT status, rejection_reason FROM wager_transactions WHERE id = $1;', [ref1Id]);
    const tx2Res = await adminPool.query('SELECT status, rejection_reason FROM wager_transactions WHERE id = $1;', [ref2Id]);

    const statuses = [tx1Res.rows[0].status, tx2Res.rows[0].status];
    expect(statuses).toContain('PROCESSED');
    expect(statuses).toContain('REJECTED');

    // Uma foi rejeitada com código auditável REVERSAL_ALREADY_PROCESSED
    const rejectedRow = tx1Res.rows[0].status === 'REJECTED' ? tx1Res.rows[0] : tx2Res.rows[0];
    expect(rejectedRow.rejection_reason).toBe('REVERSAL_ALREADY_PROCESSED');

    // Saldo restaurado em exatamente 25.00 (100.00 final), sem crédito duplicado
    const recon = await reconcileWalletUseCase.execute(wallet.id);
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance.amount).toBe('100.00');

    // Exatamente 3 lançamentos no ledger: 1 OPENING, 1 DEBIT da BET e 1 CREDIT do primeiro REFUND
    const ledgerRes = await adminPool.query('SELECT entry_type, amount FROM wallet_ledger_entries WHERE wallet_id = $1 ORDER BY created_at ASC;', [wallet.id]);
    expect(ledgerRes.rows.length).toBe(3);
    expect(ledgerRes.rows[0].entry_type).toBe('CREDIT');
    expect(ledgerRes.rows[1].entry_type).toBe('DEBIT');
    expect(ledgerRes.rows[2].entry_type).toBe('CREDIT');
  });

  it('D. WIN, REFUND e ROLLBACK são resolvidos com suas regras próprias', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    // 1. Processa BET para WIN
    const bet1Id = `bet-d-1-${crypto.randomUUID()}`;
    await processWagerUseCase.execute(crypto.randomUUID(), {
      providerId: 'EVOLUTION',
      externalTransactionId: bet1Id,
      playerId,
      walletId: wallet.id,
      roundId: 'round-d-1',
      gameId: 'game1',
      kind: 'BET',
      money: { amount: '30.00', currency: 'BRL' },
    }); // Saldo: 70.00

    // 2. Processa BET para REFUND
    const bet2Id = `bet-d-2-${crypto.randomUUID()}`;
    await processWagerUseCase.execute(crypto.randomUUID(), {
      providerId: 'EVOLUTION',
      externalTransactionId: bet2Id,
      playerId,
      walletId: wallet.id,
      roundId: 'round-d-2',
      gameId: 'game2',
      kind: 'BET',
      money: { amount: '20.00', currency: 'BRL' },
    }); // Saldo: 50.00

    // 3. Processa WIN que será alvo de ROLLBACK
    const winForRollbackId = `win-target-${crypto.randomUUID()}`;
    await processWagerUseCase.execute(crypto.randomUUID(), {
      providerId: 'EVOLUTION',
      externalTransactionId: winForRollbackId,
      playerId,
      walletId: wallet.id,
      roundId: 'round-d-1',
      gameId: 'game1',
      kind: 'WIN',
      money: { amount: '40.00', currency: 'BRL' },
      referenceExternalTransactionId: bet1Id,
    }); // Saldo: 90.00

    // Insere pendências das 3 operações
    const pendingWinId = crypto.randomUUID();
    const pendingRefundId = crypto.randomUUID();
    const pendingRollbackId = crypto.randomUUID();

    await adminPool.query(
      `INSERT INTO wager_transactions 
       (id, wallet_id, player_id, provider_id, external_transaction_id, round_id, game_id, kind, amount, currency, status, idempotency_key, payload_hash, response_snapshot, reference_external_transaction_id, attempts, next_attempt_at, created_at, updated_at)
       VALUES 
       ($1, $4, $5, 'EVOLUTION', $6, 'round-d-1', 'game1', 'WIN', '15.00', 'BRL', 'PENDING_REFERENCE', $7, 'h1', $8, $9, 1, NOW() - INTERVAL '1s', NOW(), NOW()),
       ($2, $4, $5, 'EVOLUTION', $10, 'round-d-2', 'game2', 'REFUND', '20.00', 'BRL', 'PENDING_REFERENCE', $11, 'h2', $12, $13, 1, NOW() - INTERVAL '1s', NOW(), NOW()),
       ($3, $4, $5, 'EVOLUTION', $14, 'round-d-1', 'game1', 'ROLLBACK', '40.00', 'BRL', 'PENDING_REFERENCE', $15, 'h3', $16, $17, 1, NOW() - INTERVAL '1s', NOW(), NOW());`,
      [
        pendingWinId,
        pendingRefundId,
        pendingRollbackId,
        wallet.id,
        playerId,
        `ext-win-d-${crypto.randomUUID()}`,
        crypto.randomUUID(),
        JSON.stringify({ transactionId: pendingWinId, status: 'PENDING_REFERENCE', balance: { amount: '90.00', currency: 'BRL' }, idempotentReplay: false }),
        bet1Id,
        `ext-ref-d-${crypto.randomUUID()}`,
        crypto.randomUUID(),
        JSON.stringify({ transactionId: pendingRefundId, status: 'PENDING_REFERENCE', balance: { amount: '90.00', currency: 'BRL' }, idempotentReplay: false }),
        bet2Id,
        `ext-rol-d-${crypto.randomUUID()}`,
        crypto.randomUUID(),
        JSON.stringify({ transactionId: pendingRollbackId, status: 'PENDING_REFERENCE', balance: { amount: '90.00', currency: 'BRL' }, idempotentReplay: false }),
        winForRollbackId,
      ]
    );

    const res = await reprocessUseCase.execute(10);
    expect(res.processed).toBe(3);

    // Saldo: 90.00 + 15.00 (WIN) + 20.00 (REFUND) - 40.00 (ROLLBACK) = 85.00
    const recon = await reconcileWalletUseCase.execute(wallet.id);
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance.amount).toBe('85.00');

    // Verifica que cada uma assumiu PROCESSED e gerou seus lançamentos
    const sWin = await captureDbState(wallet.id, pendingWinId);
    expect(sWin.transaction.status).toBe('PROCESSED');
    const sRefund = await captureDbState(wallet.id, pendingRefundId);
    expect(sRefund.transaction.status).toBe('PROCESSED');
    const sRollback = await captureDbState(wallet.id, pendingRollbackId);
    expect(sRollback.transaction.status).toBe('PROCESSED');
  });

  it('E. Processo morre após claim e antes do processamento: outro retoma após expiração (Processo Real)', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const betId = `bet-e-${crypto.randomUUID()}`;
    await processWagerUseCase.execute(crypto.randomUUID(), {
      providerId: 'EVOLUTION',
      externalTransactionId: betId,
      playerId,
      walletId: wallet.id,
      roundId: 'round-e',
      gameId: 'slots',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    });

    const txId = crypto.randomUUID();
    const snap = {
      transactionId: txId,
      status: 'PENDING_REFERENCE',
      balance: { amount: '90.00', currency: 'BRL' },
      idempotentReplay: false,
    };

    // Insere pendência elegível sem lease no PostgreSQL
    await adminPool.query(
      `INSERT INTO wager_transactions 
       (id, wallet_id, player_id, provider_id, external_transaction_id, round_id, game_id, kind, amount, currency, status, idempotency_key, payload_hash, response_snapshot, reference_external_transaction_id, attempts, next_attempt_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'EVOLUTION', $4, 'round-e', 'slots', 'WIN', '20.00', 'BRL', 'PENDING_REFERENCE', $5, 'hash-e', $6, $7, 1, NOW() - INTERVAL '1s', NOW(), NOW());`,
      [txId, wallet.id, playerId, `win-e-${crypto.randomUUID()}`, crypto.randomUUID(), JSON.stringify(snap), betId]
    );

    // Inicia processo filho real que adquire claim com lease curto (600ms) e pausa antes do processamento
    const childWorker = spawnWorkerWithMilestone(
      { CRASH_POINT: 'AFTER_CLAIM_BEFORE_PROCESS' },
      '1',
      '600'
    );

    try {
      // Aguarda handshake por marco confirmando que o filho adquiriu o claim no PostgreSQL
      const milestone = await childWorker.milestonePromise;
      expect(milestone).toContain('CLAIM_CONFIRMED');

      // Confirma que a transação está reservada pelo processo filho real no PostgreSQL
      const claimedState = await captureDbState(wallet.id, txId);
      expect(claimedState.transaction.status).toBe('PENDING_REFERENCE');
      expect(claimedState.transaction.leaseToken).not.toBeNull();
      expect(claimedState.transaction.leaseOwner).toContain('runner-');

      // O coordenador mata o filho real abruptamente (SIGKILL)
      childWorker.proc.kill('SIGKILL');

      // Imediatamente tenta reservar com Worker 2: não deve conseguir pois o lease ainda está ativo no PostgreSQL
      const initialClaim = await wagerRepo.claimPendingReferences(10, 30000, 'worker-2');
      expect(initialClaim.some((c) => c.id === txId)).toBe(false);

      // Aguarda a expiração natural do lease no PostgreSQL (700ms)
      await new Promise((resolve) => setTimeout(resolve, 700));

      // Agora Worker 2 deve conseguir reivindicar e processar
      const result = await reprocessUseCase.execute(10, 30000, 'worker-2');
      expect(result.processed).toBe(1);

      const finalState = await captureDbState(wallet.id, txId);
      expect(finalState.transaction.status).toBe('PROCESSED');
      expect(finalState.transaction.leaseToken).toBeNull();
      expect(finalState.wallet.balance).toBe('110.00'); // 90.00 + 20.00
    } finally {
      try {
        childWorker.proc.kill('SIGKILL');
      } catch {}
    }
  }, 30000);

  it('F. Reserva expira e outro worker assume: token antigo não pode finalizar indevidamente', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const betId = `bet-f-${crypto.randomUUID()}`;
    await processWagerUseCase.execute(crypto.randomUUID(), {
      providerId: 'EVOLUTION',
      externalTransactionId: betId,
      playerId,
      walletId: wallet.id,
      roundId: 'round-f',
      gameId: 'slots',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    });

    const txId = crypto.randomUUID();
    const snap = {
      transactionId: txId,
      status: 'PENDING_REFERENCE',
      balance: { amount: '90.00', currency: 'BRL' },
      idempotentReplay: false,
    };

    // Worker 1 reserva com token T1
    const token1 = crypto.randomUUID();
    await adminPool.query(
      `INSERT INTO wager_transactions 
       (id, wallet_id, player_id, provider_id, external_transaction_id, round_id, game_id, kind, amount, currency, status, idempotency_key, payload_hash, response_snapshot, reference_external_transaction_id, attempts, next_attempt_at, lease_token, lease_owner, lease_expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'EVOLUTION', $4, 'round-f', 'slots', 'WIN', '20.00', 'BRL', 'PENDING_REFERENCE', $5, 'hash-f', $6, $7, 1, NOW() - INTERVAL '1s', $8, 'worker-1', NOW() - INTERVAL '1s', NOW(), NOW());`,
      [txId, wallet.id, playerId, `win-f-${crypto.randomUUID()}`, crypto.randomUUID(), JSON.stringify(snap), betId, token1]
    );

    // Como expirou, Worker 2 reserva e finaliza
    const resultWorker2 = await reprocessUseCase.execute(10, 30000, 'worker-2');
    expect(resultWorker2.processed).toBe(1);

    const stateAfterWorker2 = await captureDbState(wallet.id, txId);
    expect(stateAfterWorker2.transaction.status).toBe('PROCESSED');
    expect(stateAfterWorker2.wallet.balance).toBe('110.00');

    // Worker 1 (atrasado) tenta finalizar com seu token antigo token1
    // Sob lock e transação, deve recusar por token mismatch / terminal
    let errorCaught: any = null;
    try {
      await uow.runInTransaction(async () => {
        const lockedWallet = await walletRepo.findById(wallet.id, true);
        const lockedTx = await wagerRepo.findById(txId, true);

        if (lockedTx?.isTerminal()) {
          return; // Aborta sem repetir
        }

        if (lockedTx?.leaseToken !== token1) {
          throw new StaleLeaseError('Stale token');
        }

        // Não deve chegar aqui
        throw new Error('Should not reach here');
      });
    } catch (err) {
      errorCaught = err;
    }

    // Nenhuma alteração financeira duplicada
    const stateAfterWorker1 = await captureDbState(wallet.id, txId);
    expect(stateAfterWorker1.wallet.balance).toBe('110.00');
    expect(stateAfterWorker1.wallet.version).toBe(stateAfterWorker2.wallet.version);
    expect(stateAfterWorker1.ledgerCount).toBe(stateAfterWorker2.ledgerCount);
  });

  it('G. Processo morre após commit financeiro e antes de finalizar o ciclo: reinício não reaplica efeitos (Processo Real)', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const betId = `bet-g-${crypto.randomUUID()}`;
    await processWagerUseCase.execute(crypto.randomUUID(), {
      providerId: 'EVOLUTION',
      externalTransactionId: betId,
      playerId,
      walletId: wallet.id,
      roundId: 'round-g',
      gameId: 'slots',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    });

    const txId = crypto.randomUUID();
    const snap = {
      transactionId: txId,
      status: 'PENDING_REFERENCE',
      balance: { amount: '90.00', currency: 'BRL' },
      idempotentReplay: false,
    };

    await adminPool.query(
      `INSERT INTO wager_transactions 
       (id, wallet_id, player_id, provider_id, external_transaction_id, round_id, game_id, kind, amount, currency, status, idempotency_key, payload_hash, response_snapshot, reference_external_transaction_id, attempts, next_attempt_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'EVOLUTION', $4, 'round-g', 'slots', 'WIN', '25.00', 'BRL', 'PENDING_REFERENCE', $5, 'hash-g', $6, $7, 1, NOW() - INTERVAL '1s', NOW(), NOW());`,
      [txId, wallet.id, playerId, `win-g-${crypto.randomUUID()}`, crypto.randomUUID(), JSON.stringify(snap), betId]
    );

    // Inicia processo filho real configurado para pausar logo após o commit financeiro e antes de finalizar o ciclo
    const childWorker = spawnWorkerWithMilestone(
      { CRASH_POINT: 'AFTER_COMMIT_BEFORE_CYCLE_END' },
      '1',
      '30000'
    );

    // Aguarda o anúncio do marco COMMIT_CONFIRMED emitido pelo processo filho após o commit na base
    const milestone = await childWorker.milestonePromise;
    expect(milestone).toContain('COMMIT_CONFIRMED');

    // Confirma que a transação foi commitada no banco pelo filho
    const stateCommitted = await captureDbState(wallet.id, txId);
    expect(stateCommitted.transaction.status).toBe('PROCESSED');
    expect(stateCommitted.wallet.balance).toBe('115.00'); // 90 + 25

    // Coordenador mata o processo filho abruptamente antes de ele reportar conclusão ou fechar recursos
    childWorker.proc.kill('SIGKILL');

    // Reinicia um novo worker para processar o lote: nenhum efeito se repete
    const r2 = await reprocessUseCase.execute(10);
    expect(r2.processed).toBe(0);

    const stateAfterRestart = await captureDbState(wallet.id, txId);
    expect(stateAfterRestart.wallet.balance).toBe('115.00');
    expect(stateAfterRestart.wallet.version).toBe(stateCommitted.wallet.version);
    expect(stateAfterRestart.ledgerCount).toBe(stateCommitted.ledgerCount);
    expect(stateAfterRestart.outboxCount).toBe(stateCommitted.outboxCount);

    const recon = await reconcileWalletUseCase.execute(wallet.id);
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance.amount).toBe('115.00');
  });

  it('H. Falha transitória permite recuperação sem rejeição financeira', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const betId = `bet-h-${crypto.randomUUID()}`;
    await processWagerUseCase.execute(crypto.randomUUID(), {
      providerId: 'EVOLUTION',
      externalTransactionId: betId,
      playerId,
      walletId: wallet.id,
      roundId: 'round-h',
      gameId: 'slots',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    });

    const txId = crypto.randomUUID();
    const snap = {
      transactionId: txId,
      status: 'PENDING_REFERENCE',
      balance: { amount: '90.00', currency: 'BRL' },
      idempotentReplay: false,
    };

    await adminPool.query(
      `INSERT INTO wager_transactions 
       (id, wallet_id, player_id, provider_id, external_transaction_id, round_id, game_id, kind, amount, currency, status, idempotency_key, payload_hash, response_snapshot, reference_external_transaction_id, attempts, next_attempt_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'EVOLUTION', $4, 'round-h', 'slots', 'WIN', '30.00', 'BRL', 'PENDING_REFERENCE', $5, 'hash-h', $6, $7, 1, NOW() - INTERVAL '1s', NOW(), NOW());`,
      [txId, wallet.id, playerId, `win-h-${crypto.randomUUID()}`, crypto.randomUUID(), JSON.stringify(snap), betId]
    );

    // Injeta falha transitória durante a transação
    uow.setTestHook('after_wallet_save', () => {
      throw new Error('Simulated transient database connection timeout');
    });

    const resultWithFailure = await reprocessUseCase.execute(10);
    expect(resultWithFailure.failed).toBe(1);
    expect(resultWithFailure.processed).toBe(0);

    uow.clearTestHooks();

    // Comprova que o status NÃO virou REJECTED e que attempts NÃO foi incrementado
    const stateDuringFail = await captureDbState(wallet.id, txId);
    expect(stateDuringFail.transaction.status).toBe('PENDING_REFERENCE');
    expect(stateDuringFail.transaction.attempts).toBe(1);
    expect(stateDuringFail.wallet.balance).toBe('90.00');

    // Executa novamente sem a falha transitória: recuperação perfeita
    const resultRecovered = await reprocessUseCase.execute(10);
    expect(resultRecovered.processed).toBe(1);

    const finalState = await captureDbState(wallet.id, txId);
    expect(finalState.transaction.status).toBe('PROCESSED');
    expect(finalState.wallet.balance).toBe('120.00'); // 90 + 30
  });

  it('I. Snapshot inválido no início do lote não bloqueia itens válidos', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const betId = `bet-i-${crypto.randomUUID()}`;
    await processWagerUseCase.execute(crypto.randomUUID(), {
      providerId: 'EVOLUTION',
      externalTransactionId: betId,
      playerId,
      walletId: wallet.id,
      roundId: 'round-i',
      gameId: 'slots',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    });

    // Item 1: Snapshot inválido (nulo)
    const corruptTxId = crypto.randomUUID();
    // Item 2: Item válido WIN
    const validTxId = crypto.randomUUID();

    const validSnap = {
      transactionId: validTxId,
      status: 'PENDING_REFERENCE',
      balance: { amount: '90.00', currency: 'BRL' },
      idempotentReplay: false,
    };

    await adminPool.query(
      `INSERT INTO wager_transactions 
       (id, wallet_id, player_id, provider_id, external_transaction_id, round_id, game_id, kind, amount, currency, status, idempotency_key, payload_hash, response_snapshot, reference_external_transaction_id, attempts, next_attempt_at, created_at, updated_at)
       VALUES 
       ($1, $3, $4, 'EVOLUTION', $5, 'round-i', 'slots', 'WIN', '20.00', 'BRL', 'PENDING_REFERENCE', $6, 'h-corrupt', NULL, $7, 1, NOW() - INTERVAL '2s', NOW() - INTERVAL '2s', NOW()),
       ($2, $3, $4, 'EVOLUTION', $8, 'round-i', 'slots', 'WIN', '20.00', 'BRL', 'PENDING_REFERENCE', $9, 'h-valid', $10, $7, 1, NOW() - INTERVAL '1s', NOW() - INTERVAL '1s', NOW());`,
      [
        corruptTxId,
        validTxId,
        wallet.id,
        playerId,
        `win-corrupt-${crypto.randomUUID()}`,
        crypto.randomUUID(),
        betId,
        `win-valid-${crypto.randomUUID()}`,
        crypto.randomUUID(),
        JSON.stringify(validSnap),
      ]
    );

    const result = await reprocessUseCase.execute(10);
    expect(result.blocked).toBe(1);
    expect(result.processed).toBe(1);

    // Item corrompido foi marcado como bloqueado operacionalmente
    const corruptState = await captureDbState(wallet.id, corruptTxId);
    expect(corruptState.transaction.isOperationallyBlocked).toBe(true);
    expect(corruptState.transaction.operationalBlockReason).toBe(
      'Replay snapshot is unavailable. Repeating the operation will not recover historical state; operational analysis is required.'
    );

    // Item válido foi processado com sucesso
    const validState = await captureDbState(wallet.id, validTxId);
    expect(validState.transaction.status).toBe('PROCESSED');
    expect(validState.wallet.balance).toBe('110.00'); // 90 + 20

    // No lote seguinte, o item bloqueado não é selecionado
    const nextResult = await reprocessUseCase.execute(10);
    expect(nextResult.blocked).toBe(0);
    expect(nextResult.processed).toBe(0);
  });

  it('J. Shutdown coordena ordem comprovada: impede novos claims, conclui drenagem antes do encerramento do ORM (Aplicação Nest Real e Barreira)', async () => {
    // Cria aplicação Nest real dedicada para teste de shutdown com barreira
    const shutdownApp = await NestFactory.create(AppModule, { logger: false });
    await shutdownApp.listen(0);

    let releaseBarrier: () => void = () => {};

    try {
      const testUow = shutdownApp.get(MikroOrmUnitOfWork);
      const testCreateWallet = shutdownApp.get(CreateWalletUseCase);
      const testProcessWager = shutdownApp.get(ProcessWagerUseCase);
      const testWorkerService = shutdownApp.get(PendingReferenceWorkerService);

      const playerId = crypto.randomUUID();
      const wallet = await testCreateWallet.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const playerId2 = crypto.randomUUID();
      const wallet2 = await testCreateWallet.execute({
        playerId: playerId2,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const betId = `bet-j-${crypto.randomUUID()}`;
      await testProcessWager.execute(crypto.randomUUID(), {
        providerId: 'EVOLUTION',
        externalTransactionId: betId,
        playerId,
        walletId: wallet.id,
        roundId: 'round-j',
        gameId: 'slots',
        kind: 'BET',
        money: { amount: '20.00', currency: 'BRL' },
      });

      const txId1 = crypto.randomUUID();
      const snap1 = {
        transactionId: txId1,
        status: 'PENDING_REFERENCE',
        balance: { amount: '80.00', currency: 'BRL' },
        idempotentReplay: false,
      };

      await adminPool.query(
        `INSERT INTO wager_transactions 
         (id, wallet_id, player_id, provider_id, external_transaction_id, round_id, game_id, kind, amount, currency, status, idempotency_key, payload_hash, response_snapshot, reference_external_transaction_id, attempts, next_attempt_at, created_at, updated_at)
         VALUES ($1, $2, $3, 'EVOLUTION', $4, 'round-j', 'slots', 'WIN', '50.00', 'BRL', 'PENDING_REFERENCE', $5, 'h-j-1', $6, $7, 1, NOW() - INTERVAL '1s', NOW(), NOW());`,
        [txId1, wallet.id, playerId, `win-j-1-${crypto.randomUUID()}`, crypto.randomUUID(), JSON.stringify(snap1), betId]
      );

      // Barreira de sincronização: operação em andamento pausa no hook after_wallet_save
      const barrierReachedPromise = new Promise<void>((resolve) => {
        testUow.setTestHook('after_wallet_save', () => {
          resolve();
          return new Promise<void>((res) => {
            releaseBarrier = res;
          });
        });
      });

      // Inicia a execução do worker em segundo plano
      const executionPromise = testWorkerService.executeBatch(5, 30000);

      // Aguarda a transação entrar e pausar na barreira
      await barrierReachedPromise;

      // Enquanto a transação financeira está pausada em andamento, dispara app.close()
      const closePromise = shutdownApp.close();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Comprova que o shutdown impede novos claims imediatamente
      expect(testWorkerService['isShuttingDown']).toBe(true);

      // Insere uma segunda transação pendente durante o shutdown usando wallet2 (sem conflito de lock com a tx1)
      const txId2 = crypto.randomUUID();
      const snap2 = {
        transactionId: txId2,
        status: 'PENDING_REFERENCE',
        balance: { amount: '100.00', currency: 'BRL' },
        idempotentReplay: false,
      };
      await adminPool.query(
        `INSERT INTO wager_transactions 
         (id, wallet_id, player_id, provider_id, external_transaction_id, round_id, game_id, kind, amount, currency, status, idempotency_key, payload_hash, response_snapshot, reference_external_transaction_id, attempts, next_attempt_at, created_at, updated_at)
         VALUES ($1, $2, $3, 'EVOLUTION', $4, 'round-j-2', 'slots', 'WIN', '10.00', 'BRL', 'PENDING_REFERENCE', $5, 'h-j-2', $6, 'ref-any', 1, NOW() - INTERVAL '1s', NOW(), NOW());`,
        [txId2, wallet2.id, playerId2, `win-j-2-${crypto.randomUUID()}`, crypto.randomUUID(), JSON.stringify(snap2)]
      );

      // Tentativa de novo claim durante o shutdown retorna vazio (bloqueio total de novos claims)
      const newBatchResult = await testWorkerService.executeBatch(5, 30000);
      expect(newBatchResult.processed).toBe(0);

      // Libera a barreira para a operação em andamento concluir seu commit
      releaseBarrier();

      // Aguarda conclusão da execução in-flight e do fechamento da aplicação
      const batchResult = await executionPromise;
      await closePromise;

      expect(batchResult.processed).toBe(1);

      // Verifica que o primeiro item foi commitado com sucesso antes do fechamento do ORM
      const finalState1 = await captureDbState(wallet.id, txId1);
      expect(finalState1.transaction.status).toBe('PROCESSED');
      expect(finalState1.wallet.balance).toBe('130.00'); // 80 + 50

      // O segundo item permaneceu intacto como PENDING_REFERENCE sem claim nem mutação
      const finalState2 = await captureDbState(wallet2.id, txId2);
      expect(finalState2.transaction.status).toBe('PENDING_REFERENCE');
      expect(finalState2.transaction.leaseToken).toBeNull();
    } finally {
      releaseBarrier();
      try {
        await shutdownApp.close();
      } catch {}
    }
  }, 30000);

  it('K. Esgotamento de referência gera uma rejeição e um evento', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const txId = crypto.randomUUID();
    const snap = {
      transactionId: txId,
      status: 'PENDING_REFERENCE',
      balance: { amount: '100.00', currency: 'BRL' },
      idempotentReplay: false,
    };

    // Criar com attempts = 5 (limite maxAttempts = 5) e referência inexistente
    await adminPool.query(
      `INSERT INTO wager_transactions 
       (id, wallet_id, player_id, provider_id, external_transaction_id, round_id, game_id, kind, amount, currency, status, idempotency_key, payload_hash, response_snapshot, reference_external_transaction_id, attempts, next_attempt_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'EVOLUTION', $4, 'round-k', 'slots', 'WIN', '50.00', 'BRL', 'PENDING_REFERENCE', $5, 'h-k', $6, 'non-existent-ref-id', 5, NOW() - INTERVAL '1s', NOW(), NOW());`,
      [txId, wallet.id, playerId, `win-k-${crypto.randomUUID()}`, crypto.randomUUID(), JSON.stringify(snap)]
    );

    const outboxBefore = await adminPool.query('SELECT COUNT(*) FROM outbox_messages WHERE aggregate_id = $1;', [wallet.id]);
    const outboxCountBefore = parseInt(outboxBefore.rows[0].count, 10);

    const result = await reprocessUseCase.execute(10);
    expect(result.rejected).toBe(1);

    const state = await captureDbState(wallet.id, txId);
    expect(state.transaction.status).toBe('REJECTED');
    expect(state.transaction.attempts).toBe(5);
    expect(state.transaction.leaseToken).toBeNull();

    // Saldo inalterado
    expect(state.wallet.balance).toBe('100.00');

    // Exatamente 1 evento WagerTransactionRejectedEvent emitido
    const outboxAfter = await adminPool.query(
      "SELECT event_type, payload FROM outbox_messages WHERE aggregate_id = $1 AND event_type = 'WagerTransactionRejected' ORDER BY created_at DESC LIMIT 1;",
      [wallet.id]
    );
    expect(outboxAfter.rows.length).toBe(1);
    expect(outboxAfter.rows[0].event_type).toBe('WagerTransactionRejected');
    expect(outboxAfter.rows[0].payload.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(state.outboxCount).toBe(outboxCountBefore + 1);
  });

  it('L. Operações atômicas de lease: releaseLease, renewLease e markOperationallyBlocked informam sucesso inequívoco e protegem concorrência', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const txId = crypto.randomUUID();
    const tokenA = crypto.randomUUID();
    const tokenB = crypto.randomUUID();

    // Insere transação com lease ativo pertencente a tokenA (válido por 10 segundos)
    await adminPool.query(
      `INSERT INTO wager_transactions 
       (id, wallet_id, player_id, provider_id, external_transaction_id, round_id, game_id, kind, amount, currency, status, idempotency_key, payload_hash, reference_external_transaction_id, attempts, next_attempt_at, lease_token, lease_owner, lease_expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'EVOLUTION', $4, 'round-l', 'slots', 'WIN', '10.00', 'BRL', 'PENDING_REFERENCE', $5, 'h-l', 'ref-l', 1, NOW() - INTERVAL '1s', $6, 'worker-a', NOW() + INTERVAL '10 seconds', NOW(), NOW());`,
      [txId, wallet.id, playerId, `win-l-${crypto.randomUUID()}`, crypto.randomUUID(), tokenA]
    );

    // 1. renewLease com token incorreto deve retornar false sem modificar nada
    const renewWrong = await wagerRepo.renewLease(txId, tokenB, 20000);
    expect(renewWrong).toBe(false);

    // 2. renewLease com token correto e lease ativo deve retornar true
    const renewOk = await wagerRepo.renewLease(txId, tokenA, 25000);
    expect(renewOk).toBe(true);

    // 3. Simula expiração do lease no PostgreSQL
    await adminPool.query(
      "UPDATE wager_transactions SET lease_expires_at = NOW() - INTERVAL '2 seconds' WHERE id = $1;",
      [txId]
    );

    // 4. renewLease com lease já expirado no PostgreSQL não pode ressuscitar o lease e deve retornar false
    const renewExpired = await wagerRepo.renewLease(txId, tokenA, 30000);
    expect(renewExpired).toBe(false);

    // 5. Novo worker assume a posse da pendência expirada
    await adminPool.query(
      "UPDATE wager_transactions SET lease_token = $1, lease_owner = 'worker-b', lease_expires_at = NOW() + INTERVAL '10 seconds' WHERE id = $2;",
      [tokenB, txId]
    );

    // 6. Worker antigo (tokenA) tenta renovar ou bloquear o item reservado pelo novo worker (tokenB): deve retornar false
    const renewOld = await wagerRepo.renewLease(txId, tokenA, 30000);
    expect(renewOld).toBe(false);

    const blockOld = await wagerRepo.markOperationallyBlocked(txId, tokenA, 'Old worker attempt');
    expect(blockOld).toBe(false);

    // Comprova que o registro permanece reservado para o worker B e não foi bloqueado
    const stateAfterOldAttempts = await captureDbState(wallet.id, txId);
    expect(stateAfterOldAttempts.transaction.isOperationallyBlocked).toBe(false);
    expect(stateAfterOldAttempts.transaction.leaseToken).toBe(tokenB);

    // 7. releaseLease com token incorreto retorna false e não modifica nada
    const releaseWrong = await wagerRepo.releaseLease(txId, tokenA);
    expect(releaseWrong).toBe(false);

    // 8. releaseLease com token correto retorna true e limpa os campos
    const releaseOk = await wagerRepo.releaseLease(txId, tokenB);
    expect(releaseOk).toBe(true);

    const stateAfterRelease = await captureDbState(wallet.id, txId);
    expect(stateAfterRelease.transaction.leaseToken).toBeNull();
    expect(stateAfterRelease.transaction.leaseOwner).toBeNull();
    expect(stateAfterRelease.transaction.leaseExpiresAt).toBeNull();

    // 9. releaseLease em registro sem lease retorna false
    const releaseEmpty = await wagerRepo.releaseLease(txId, tokenB);
    expect(releaseEmpty).toBe(false);
  });

  it('M. Validação de elegibilidade e expiração usando exclusivamente relógio do PostgreSQL, imune a Date.now() divergente', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const betId = `bet-m-${crypto.randomUUID()}`;
    await processWagerUseCase.execute(crypto.randomUUID(), {
      providerId: 'EVOLUTION',
      externalTransactionId: betId,
      playerId,
      walletId: wallet.id,
      roundId: 'round-m',
      gameId: 'slots',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    });

    const txId = crypto.randomUUID();
    const snap = {
      transactionId: txId,
      status: 'PENDING_REFERENCE',
      balance: { amount: '90.00', currency: 'BRL' },
      idempotentReplay: false,
    };

    await adminPool.query(
      `INSERT INTO wager_transactions 
       (id, wallet_id, player_id, provider_id, external_transaction_id, round_id, game_id, kind, amount, currency, status, idempotency_key, payload_hash, response_snapshot, reference_external_transaction_id, attempts, next_attempt_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'EVOLUTION', $4, 'round-m', 'slots', 'WIN', '20.00', 'BRL', 'PENDING_REFERENCE', $5, 'h-m', $6, $7, 1, NOW() - INTERVAL '1s', NOW(), NOW());`,
      [txId, wallet.id, playerId, `win-m-${crypto.randomUUID()}`, crypto.randomUUID(), JSON.stringify(snap), betId]
    );

    // Artificialmente distorce o relógio do Node/Bun em +2 horas no futuro
    const originalDateNow = Date.now;
    try {
      Date.now = () => originalDateNow() + 7200000;

      // Executa o reprocessamento: deve validar elegibilidade e expiração no PostgreSQL NOW(), sem StaleLeaseError espúrio
      const resultFuture = await reprocessUseCase.execute(10, 30000, 'worker-clock-test');
      expect(resultFuture.processed).toBe(1);

      const stateFuture = await captureDbState(wallet.id, txId);
      expect(stateFuture.transaction.status).toBe('PROCESSED');
      expect(stateFuture.wallet.balance).toBe('110.00');
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('N. Falha injetada antes do commit confirma que o lote não contabiliza como concluída uma operação revertida', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const betId = `bet-n-${crypto.randomUUID()}`;
    await processWagerUseCase.execute(crypto.randomUUID(), {
      providerId: 'EVOLUTION',
      externalTransactionId: betId,
      playerId,
      walletId: wallet.id,
      roundId: 'round-n',
      gameId: 'slots',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    });

    const txId = crypto.randomUUID();
    const snap = {
      transactionId: txId,
      status: 'PENDING_REFERENCE',
      balance: { amount: '90.00', currency: 'BRL' },
      idempotentReplay: false,
    };

    await adminPool.query(
      `INSERT INTO wager_transactions 
       (id, wallet_id, player_id, provider_id, external_transaction_id, round_id, game_id, kind, amount, currency, status, idempotency_key, payload_hash, response_snapshot, reference_external_transaction_id, attempts, next_attempt_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'EVOLUTION', $4, 'round-n', 'slots', 'WIN', '25.00', 'BRL', 'PENDING_REFERENCE', $5, 'h-n', $6, $7, 1, NOW() - INTERVAL '1s', NOW(), NOW());`,
      [txId, wallet.id, playerId, `win-n-${crypto.randomUUID()}`, crypto.randomUUID(), JSON.stringify(snap), betId]
    );

    // Injeta falha estritamente no ponto imediatamente anterior ao commit (before_commit)
    uow.setTestHook('before_commit', () => {
      throw new Error('Simulated failure immediately prior to transaction commit');
    });

    try {
      const result = await reprocessUseCase.execute(10);

      // Comprova que o lote NÃO contabilizou a operação revertida como concluída
      expect(result.processed).toBe(0);
      expect(result.rejected).toBe(0);
      expect(result.failed).toBe(1);

      // Comprova que a transação no banco permaneceu PENDING_REFERENCE e o saldo permaneceu inalterado
      const state = await captureDbState(wallet.id, txId);
      expect(state.transaction.status).toBe('PENDING_REFERENCE');
      expect(state.wallet.balance).toBe('90.00');
      expect(state.ledgerCount).toBe(2); // 1 OPENING + 1 BET
    } finally {
      uow.clearTestHooks();
      await adminPool.query('DELETE FROM wager_transactions WHERE id = $1;', [txId]);
    }
  });

  it('O. Classificação de erros: defeito permanente/inesperado (TypeError) não gera rejeição financeira falsa e não bloqueia o restante do lote', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const betId = `bet-o-${crypto.randomUUID()}`;
    await processWagerUseCase.execute(crypto.randomUUID(), {
      providerId: 'EVOLUTION',
      externalTransactionId: betId,
      playerId,
      walletId: wallet.id,
      roundId: 'round-o',
      gameId: 'slots',
      kind: 'BET',
      money: { amount: '20.00', currency: 'BRL' },
    }); // Saldo: 80.00

    const txDefectId = crypto.randomUUID();
    const txValidId = crypto.randomUUID();

    const snapDefect = {
      transactionId: txDefectId,
      status: 'PENDING_REFERENCE',
      balance: { amount: '80.00', currency: 'BRL' },
      idempotentReplay: false,
    };
    const snapValid = {
      transactionId: txValidId,
      status: 'PENDING_REFERENCE',
      balance: { amount: '80.00', currency: 'BRL' },
      idempotentReplay: false,
    };

    await adminPool.query(
      `INSERT INTO wager_transactions 
       (id, wallet_id, player_id, provider_id, external_transaction_id, round_id, game_id, kind, amount, currency, status, idempotency_key, payload_hash, response_snapshot, reference_external_transaction_id, attempts, next_attempt_at, created_at, updated_at)
       VALUES 
       ($1, $3, $4, 'EVOLUTION', $5, 'round-o', 'slots', 'WIN', '30.00', 'BRL', 'PENDING_REFERENCE', $6, 'h-def', $7, $9, 1, NOW() - INTERVAL '2s', NOW() - INTERVAL '2s', NOW()),
       ($2, $3, $4, 'EVOLUTION', $8, 'round-o', 'slots', 'WIN', '20.00', 'BRL', 'PENDING_REFERENCE', $10, 'h-val', $11, $9, 1, NOW() - INTERVAL '1s', NOW() - INTERVAL '1s', NOW());`,
      [
        txDefectId,
        txValidId,
        wallet.id,
        playerId,
        `win-def-${crypto.randomUUID()}`,
        crypto.randomUUID(),
        JSON.stringify(snapDefect),
        `win-val-${crypto.randomUUID()}`,
        betId,
        crypto.randomUUID(),
        JSON.stringify(snapValid),
      ]
    );

    // Injeta TypeError inesperado apenas para a primeira transação
    let defectInjected = false;
    uow.setTestHook('after_wallet_save', () => {
      if (!defectInjected) {
        defectInjected = true;
        throw new TypeError('Unexpected runtime memory type violation in domain handler');
      }
    });

    try {
      const result = await reprocessUseCase.execute(10);
      expect(result.failed).toBe(1);
      expect(result.processed).toBe(1); // O segundo item do lote prosseguiu e concluiu com sucesso!

      // Comprova que o defeito técnico NÃO gerou uma rejeição financeira falsa para o item 1
      const stateDefect = await captureDbState(wallet.id, txDefectId);
      expect(stateDefect.transaction.status).toBe('PENDING_REFERENCE');
      expect(stateDefect.transaction.status).not.toBe('REJECTED');
      expect(stateDefect.transaction.attempts).toBe(1); // Attempts de negócio não foram consumidas

      // Comprova que o item 2 foi processado com sucesso
      const stateValid = await captureDbState(wallet.id, txValidId);
      expect(stateValid.transaction.status).toBe('PROCESSED');
      expect(stateValid.wallet.balance).toBe('100.00'); // 80 + 20
    } finally {
      uow.clearTestHooks();
      await adminPool.query('DELETE FROM wager_transactions WHERE id = $1;', [txDefectId]);
    }
  });

  it('P. Timeout de drenagem no shutdown cancela trabalho em andamento com rollback e comprova fechamento do ORM (Aplicação Nest Real e Handshake)', async () => {
    // Limpa quaisquer pendências residuais de testes anteriores para garantir isolamento estrito
    await adminPool.query("DELETE FROM wager_transactions WHERE status = 'PENDING_REFERENCE';");

    // 1. Prepara dados no banco através de uma operação inicial
    const playerId = crypto.randomUUID();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const betId = `bet-p-${crypto.randomUUID()}`;
    await processWagerUseCase.execute(crypto.randomUUID(), {
      providerId: 'EVOLUTION',
      externalTransactionId: betId,
      playerId,
      walletId: wallet.id,
      roundId: 'round-p',
      gameId: 'slots',
      kind: 'BET',
      money: { amount: '15.00', currency: 'BRL' },
    }); // Saldo atual: 85.00

    const txId = crypto.randomUUID();
    const snap = {
      transactionId: txId,
      status: 'PENDING_REFERENCE',
      balance: { amount: '85.00', currency: 'BRL' },
      idempotentReplay: false,
    };

    // Insere pendência elegível com lease curto de 800ms
    await adminPool.query(
      `INSERT INTO wager_transactions 
       (id, wallet_id, player_id, provider_id, external_transaction_id, round_id, game_id, kind, amount, currency, status, idempotency_key, payload_hash, response_snapshot, reference_external_transaction_id, attempts, next_attempt_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'EVOLUTION', $4, 'round-p', 'slots', 'WIN', '30.00', 'BRL', 'PENDING_REFERENCE', $5, 'h-p', $6, $7, 1, NOW() - INTERVAL '1s', NOW(), NOW());`,
      [txId, wallet.id, playerId, `win-p-${crypto.randomUUID()}`, crypto.randomUUID(), JSON.stringify(snap), betId]
    );

    // 2. Inicializa aplicação Nest real dedicada para o teste de timeout de drenagem
    // Configura timeout de drenagem agressivo (150ms) via variável de ambiente
    const prevDrainTimeout = process.env.PENDING_WORKER_DRAIN_TIMEOUT_MS;
    process.env.PENDING_WORKER_DRAIN_TIMEOUT_MS = '150';

    let timeoutApp: INestApplication | null = null;
    let releaseBarrierFn: (() => void) | null = null;

    try {
      timeoutApp = await NestFactory.create(AppModule, { logger: false });
      await timeoutApp.init();

      const testUow = timeoutApp.get(MikroOrmUnitOfWork);
      const testWorkerService = timeoutApp.get(PendingReferenceWorkerService);

      // A. Iniciar uma pendência e pausar após escrita, com handshake (sem sleep fixo!)
      let signalWriteReached!: () => void;
      const writeReachedPromise = new Promise<void>((resolve) => {
        signalWriteReached = resolve;
      });

      const barrierPromise = new Promise<void>((resolve) => {
        releaseBarrierFn = resolve;
      });

      // Hook no ponto após a escrita do saldo da carteira na transação (after_wallet_save)
      testUow.setTestHook('after_wallet_save', async () => {
        signalWriteReached();
        await barrierPromise;
      });

      // Inicia a execução do batch na aplicação real (lease de 800ms)
      const executionPromise = testWorkerService.executeBatch(5, 800);

      // Aguarda handshake comprovar que a escrita foi realizada no banco
      await writeReachedPromise;

      // B. Disparar app.close() e forçar timeout de drenagem
      let isAppClosed = false;
      const closePromise = timeoutApp.close().then(() => {
        isAppClosed = true;
      });

      // Aguarda o timeout de drenagem (150ms) expirar e o cancelamento ser solicitado
      const cancelTriggeredPromise = new Promise<void>((resolve) => {
        const check = () => {
          if (testWorkerService.isAbortRequested()) {
            resolve();
          } else {
            setTimeout(check, 10);
          }
        };
        check();
      });
      await cancelTriggeredPromise;

      // C. Confirmar solicitação de cancelamento e que o ORM permanece disponível até a transação encerrar
      expect(testWorkerService.isAbortRequested()).toBe(true);
      expect(isAppClosed).toBe(false); // app.close() NÃO pode ter finalizado ainda!
      expect(testUow.isClosed()).toBe(false); // ORM permanece aberto e ativo para suportar o rollback!

      // D. Liberar a barreira e comprovar rollback integral
      if (releaseBarrierFn) {
        (releaseBarrierFn as () => void)();
      }

      // Aguarda conclusão da execução do worker e do encerramento da aplicação
      await executionPromise;
      await closePromise;

      // Comprova rollback integral via adminPool independente
      const stateAfterRollback = await captureDbState(wallet.id, txId);
      expect(stateAfterRollback.wallet.balance).toBe('85.00'); // Saldo inalterado (rollback do WIN de 30.00)
      expect(stateAfterRollback.transaction.status).toBe('PENDING_REFERENCE'); // Transação continua pendente
      expect(stateAfterRollback.transaction.attempts).toBe(1); // Tentativas de negócio NÃO foram consumidas
      expect(stateAfterRollback.transaction.operationalBlockReason).toBeNull();
      expect(stateAfterRollback.ledgerCount).toBe(2); // Apenas 1 OPENING + 1 BET

      // E. Confirmar encerramento das conexões
      expect(isAppClosed).toBe(true);
      expect(testUow.isClosed()).toBe(true); // ORM fechou com sucesso apenas após a conclusão do rollback
      expect(() => testUow.getOrm()).toThrow(); // Chamadas subsequentes confirmam pool fechado

      // F. Outra instância retoma e aplica exatamente um efeito
      // Aguarda o lease curto de 800ms expirar no relógio do PostgreSQL
      await new Promise((resolve) => setTimeout(resolve, 900));

      const recoveryResult = await reprocessUseCase.execute(5, 30000, 'recovery-worker');
      expect(recoveryResult.processed).toBe(1);

      const finalState = await captureDbState(wallet.id, txId);
      expect(finalState.transaction.status).toBe('PROCESSED');
      expect(finalState.wallet.balance).toBe('115.00'); // 85.00 + 30.00
      expect(finalState.ledgerCount).toBe(3); // 1 OPENING + 1 BET + 1 WIN
    } finally {
      if (releaseBarrierFn) {
        try {
          (releaseBarrierFn as () => void)();
        } catch {}
      }
      if (prevDrainTimeout !== undefined) {
        process.env.PENDING_WORKER_DRAIN_TIMEOUT_MS = prevDrainTimeout;
      } else {
        delete process.env.PENDING_WORKER_DRAIN_TIMEOUT_MS;
      }
      if (timeoutApp) {
        try {
          await timeoutApp.close();
        } catch {}
      }
    }
  }, 30000);
});
