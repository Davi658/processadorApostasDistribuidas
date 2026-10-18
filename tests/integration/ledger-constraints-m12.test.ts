import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import pg from 'pg';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from '../test-db-helper';
import { MikroOrmUnitOfWork, MikroOrmWalletRepository, MikroOrmWagerTransactionRepository,
  MikroOrmWalletLedgerRepository, MikroOrmOutboxRepository } from '../../src/infrastructure/persistence/mikro-orm/mikro-orm-adapter';
import { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet.use-case';
import { ProcessWagerUseCase } from '../../src/application/use-cases/process-wager.use-case';
import { ReconcileWalletUseCase } from '../../src/application/use-cases/reconcile-wallet.use-case';
import type { ProcessWagerDto } from '../../src/application/dto/wager.dto';
import { DatabaseMigrator } from '../../src/infrastructure/persistence/migrator';

let db: IsolatedTestDatabase, admin: pg.Pool, app: pg.Pool, uow: MikroOrmUnitOfWork;
let create: CreateWalletUseCase, processWager: ProcessWagerUseCase, reconcile: ReconcileWalletUseCase;
async function snapshot(pool = admin) {
  const result = [];
  for (const table of ['wallets', 'wager_transactions', 'wallet_ledger_entries', 'outbox_messages']) {
    result.push((await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY id`)).rows);
  }
  return result;
}
async function wallet(currency = 'BRL', pool = admin) {
  const id = crypto.randomUUID();
  await pool.query('INSERT INTO wallets VALUES ($1::uuid,$1::text,$2,10,1,now(),now())', [id, currency]);
  return id;
}
async function transaction(walletId: string, currency = 'BRL', pool = admin) {
  const id = crypto.randomUUID();
  await pool.query(`INSERT INTO wager_transactions
    (id,wallet_id,player_id,provider_id,external_transaction_id,round_id,game_id,kind,amount,currency,status,created_at,updated_at)
    VALUES ($1::uuid,$2,'p','m12',$1::text,'r','g','OPENING',1,$3,'PROCESSED',now(),now())`, [id,walletId,currency]);
  return id;
}
const insert = `INSERT INTO wallet_ledger_entries
  (id,wallet_id,transaction_id,entry_type,amount,currency,balance_before,balance_after)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`;
async function refusal(pool: pg.Pool, walletId: string, sql: string, values: unknown[], code: string,
  constraint?: string, message?: string) {
  const before = await snapshot();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // A preceding real write must also roll back after the rejected statement.
    await client.query('UPDATE wallets SET balance=balance+1 WHERE id=$1', [walletId]);
    let error: pg.DatabaseError | undefined;
    try { await client.query(sql, values); } catch (e) { error = e as pg.DatabaseError; }
    expect(error?.code).toBe(code);
    if (constraint) expect(error?.constraint).toBe(constraint);
    if (message) expect(error?.message).toContain(message);
    let aborted: pg.DatabaseError | undefined;
    try { await client.query('SELECT 1'); } catch (e) { aborted = e as pg.DatabaseError; }
    expect(aborted?.code).toBe('25P02');
  } finally { await client.query('ROLLBACK'); client.release(); }
  expect(await snapshot()).toEqual(before);
}

describe('M12 ledger constraints and exact reconciliation on disposable PostgreSQL', () => {
  beforeAll(async () => {
    db = await createIsolatedTestDatabase('m12_');
    admin = new pg.Pool(db.adminConfig); app = new pg.Pool(db.appConfig);
    uow = new MikroOrmUnitOfWork(); await uow.init();
    const wallets = new MikroOrmWalletRepository(uow), wagers = new MikroOrmWagerTransactionRepository(uow);
    const ledger = new MikroOrmWalletLedgerRepository(uow), outbox = new MikroOrmOutboxRepository(uow);
    create = new CreateWalletUseCase(wallets,wagers,ledger,outbox,uow);
    processWager = new ProcessWagerUseCase(wallets,wagers,ledger,outbox,uow);
    reconcile = new ReconcileWalletUseCase(wallets,ledger,uow);
    const role = (await app.query(`SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user`)).rows[0];
    expect(role).toEqual({ rolsuper:false, rolcreatedb:false, rolcreaterole:false, rolbypassrls:false });
  }, 30000);
  afterAll(async () => { await uow?.close(); await app?.end(); await admin?.end(); await db?.closeAndDrop(); }, 30000);

  it('binds transaction, wallet and currency with the composite FK, independently of duplicates', async () => {
    const a = await wallet(), b = await wallet(), usd = await wallet('USD');
    const tx = await transaction(a);
    for (const [target,currency] of [[b,'BRL'],[usd,'USD']]) {
      await refusal(app,target,insert,[crypto.randomUUID(),target,tx,'CREDIT','1.00',currency,'0.00','1.00'],
        '23503','fk_ledger_wager_tx_wallet_currency');
    }
    await refusal(app,a,insert,[crypto.randomUUID(),a,crypto.randomUUID(),'CREDIT','1.00','BRL','0.00','1.00'],
      '23503','wallet_ledger_entries_transaction_id_fkey');
    await refusal(app,a,insert,[crypto.randomUUID(),crypto.randomUUID(),tx,'CREDIT','1.00','BRL','0.00','1.00'],
      '23503','wallet_ledger_entries_wallet_id_fkey');
  });

  for (const [label,type,amount,before,after,constraint,code] of [
    ['zero','CREDIT','0.00','0.00','0.00','chk_ledger_positive_amount','23514'],
    ['negative','DEBIT','-1.00','0.00','1.00','chk_ledger_positive_amount','23514'],
    ['credit arithmetic','CREDIT','0.01','10.00','10.02','chk_ledger_arithmetic','23514'],
    ['debit arithmetic','DEBIT','0.01','10.00','9.98','chk_ledger_arithmetic','23514'],
    ['unknown type','OTHER','1.00','0.00','1.00','chk_ledger_arithmetic','23514'],
    ['negative before','CREDIT','2.00','-1.00','1.00','chk_ledger_non_negative_balances','23514'],
    ['negative after','DEBIT','2.00','1.00','-1.00','chk_ledger_non_negative_balances','23514'],
    ['amount overflow','CREDIT','10000000000000000.00','0.00','1.00',undefined,'22003'],
    ['before overflow','DEBIT','1.00','10000000000000000.00','1.00',undefined,'22003'],
    ['after overflow','CREDIT','1.00','0.00','10000000000000000.00',undefined,'22003'],
    ['NaN amount','CREDIT','NaN','0.00','NaN','chk_ledger_finite_values','23514'],
    ['NaN before','CREDIT','1.00','NaN','NaN','chk_ledger_finite_values','23514'],
  ]) {
    it(`rejects ${label} with the precise database diagnostic and no partial effects`, async () => {
      const w = await wallet(), tx = await transaction(w);
      await refusal(app,w,insert,[crypto.randomUUID(),w,tx,type,amount,'BRL',before,after],code!,constraint);
    });
  }

  it('keeps wallet balances finite, nonnegative and within NUMERIC capacity', async () => {
    const w = await wallet();
    for (const [value,code,constraint] of [
      ['NaN','23514','chk_wallets_balance_finite'],
      ['-0.01','23514','chk_wallets_balance_non_negative'],
      ['10000000000000000.00','22003',undefined],
    ]) await refusal(app,w,'UPDATE wallets SET balance=$2 WHERE id=$1',[w,value],code!,constraint);
  });

  it('preserves complete existing rows in incremental UP/DOWN/UP; invalid legacy data aborts UP without deletion', async () => {
    const migrationDb = await createIsolatedTestDatabase('m12_migration_');
    const pool = new pg.Pool(migrationDb.adminConfig);
    const w = await wallet('BRL',pool), tx = await transaction(w,'BRL',pool);
    await pool.query(insert,[crypto.randomUUID(),w,tx,'CREDIT','1.00','BRL','0.00','1.00']);
    const before = await snapshot(pool), migrator = new DatabaseMigrator(migrationDb.adminConfig);
    try {
      expect(await migrator.down()).toBe('008_outbox_publisher_lease_and_retry');
      expect(await migrator.down()).toBe('007_ledger_finite_values');
      expect(await snapshot(pool)).toEqual(before);
      expect(await migrator.up()).toEqual(['007_ledger_finite_values', '008_outbox_publisher_lease_and_retry']);
      expect(await snapshot(pool)).toEqual(before);
      expect(await migrator.down()).toBe('008_outbox_publisher_lease_and_retry');
      expect(await migrator.down()).toBe('007_ledger_finite_values');
      // Reproduce the historical loophole without disabling any trigger.
      const legacyTx = await transaction(w,'BRL',pool), legacyId = crypto.randomUUID();
      await pool.query(insert,[legacyId,w,legacyTx,'CREDIT','NaN','BRL','0.00','NaN']);
      const legacy = await snapshot(pool);
      await expect(migrator.up()).rejects.toMatchObject({code:'23514',constraint:'chk_ledger_finite_values'});
      expect(await snapshot(pool)).toEqual(legacy);
      expect((await pool.query("SELECT version FROM schema_migrations WHERE version='007_ledger_finite_values'")).rowCount).toBe(0);
      expect((await pool.query("SELECT conname FROM pg_constraint WHERE conname IN ('chk_ledger_finite_values','chk_wallets_balance_finite')")).rowCount).toBe(0);
      // The entire test transaction is disposable; no ledger record is removed to make UP pass.
    } finally { await migrator.close(); await pool.end(); await migrationDb.closeAndDrop(); }
  }, 30000);

  it('accepts exact cent arithmetic at NUMERIC maximum and rejects a second entry for the operation', async () => {
    const w = await wallet(), tx = await transaction(w);
    const values = [crypto.randomUUID(),w,tx,'CREDIT','0.01','BRL','9999999999999999.98','9999999999999999.99'];
    await app.query(insert,values);
    expect((await admin.query('SELECT amount,balance_before,balance_after FROM wallet_ledger_entries WHERE id=$1',[values[0]])).rows[0])
      .toEqual({ amount:'0.01',balance_before:'9999999999999999.98',balance_after:'9999999999999999.99' });
    await refusal(app,w,insert,[crypto.randomUUID(),...values.slice(1)],'23505','uq_wallet_ledger_entries_tx_wallet');
    const debitTx = await transaction(w);
    await app.query(insert,[crypto.randomUUID(),w,debitTx,'DEBIT','0.01','BRL','9999999999999999.99','9999999999999999.98']);
  });

  it('proves enabled UPDATE/DELETE trigger as admin and permission denial including TRUNCATE as app', async () => {
    const w = await wallet(), tx = await transaction(w), id = crypto.randomUUID();
    await app.query(insert,[id,w,tx,'CREDIT','1.00','BRL','0.00','1.00']);
    const triggers = (await admin.query(`SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid='wallet_ledger_entries'::regclass AND NOT tgisinternal`)).rows;
    expect(triggers).toContainEqual({ tgname:'trg_protect_wallet_ledger_entries',tgenabled:'O' });
    for (const sql of ['UPDATE wallet_ledger_entries SET amount=amount WHERE id=$1','DELETE FROM wallet_ledger_entries WHERE id=$1']) {
      await refusal(admin,w,sql,[id],'P0001',undefined,'Modifications and deletions are strictly prohibited on wallet_ledger_entries');
      await refusal(app,w,sql,[id],'42501',undefined,'wallet_ledger_entries');
    }
    await refusal(app,w,'TRUNCATE wallet_ledger_entries',[],'42501',undefined,'wallet_ledger_entries');
  });

  it('reconciles zero entries and detects direct SQL balance drift exactly beyond safe number precision', async () => {
    const empty = await create.execute({ playerId:crypto.randomUUID(), initialBalance:{amount:'0.00',currency:'BRL'} });
    expect(await reconcile.execute(empty.id)).toMatchObject({consistent:true,checkedEntries:0,calculatedBalance:{amount:'0.00',currency:'BRL'}});
    await admin.query('UPDATE wallets SET balance=0.01 WHERE id=$1',[empty.id]);
    expect(await reconcile.execute(empty.id)).toMatchObject({consistent:false,checkedEntries:0,difference:{amount:'0.01'}});
    const large = await create.execute({ playerId:crypto.randomUUID(), initialBalance:{amount:'9007199254740993.01',currency:'BRL'} });
    expect((await reconcile.execute(large.id)).difference.amount).toBe('0.00');
    await admin.query('UPDATE wallets SET balance=balance-0.01 WHERE id=$1',[large.id]);
    expect(await reconcile.execute(large.id)).toMatchObject({consistent:false,storedBalance:{amount:'9007199254740993.00'},
      calculatedBalance:{amount:'9007199254740993.01'},difference:{amount:'-0.01'}});
  });

  it('reports aggregate drift outside single-column Money limits as exact signed decimal strings', async () => {
    for (const type of ['CREDIT','DEBIT']) {
      const w = await wallet();
      for (let i = 0; i < 2; i++) {
        const tx = await transaction(w);
        await app.query(insert,[crypto.randomUUID(),w,tx,type,'9999999999999999.99','BRL',
          type === 'CREDIT' ? '0.00' : '9999999999999999.99',type === 'CREDIT' ? '9999999999999999.99' : '0.00']);
      }
      // SQL constraints enforce each row, but do not enforce continuity or wallet equality.
      expect(await reconcile.execute(w)).toMatchObject({consistent:false,checkedEntries:2,
        calculatedBalance:{amount:type === 'CREDIT' ? '19999999999999999.98' : '-19999999999999999.98'},
        difference:{amount:type === 'CREDIT' ? '-19999999999999989.98' : '20000000000000009.98'}});
    }
  });

  it('reconciles valid high turnover independently of timestamp/UUID order without intermediate Money overflow', async () => {
    const w = await wallet();
    // Valid chronological path: 0 -> MAX -> 0 -> MAX. Read order is CREDIT, CREDIT, DEBIT.
    const max = '9999999999999999.99';
    for (const [id,type,before,after] of [
      ['00000000-0000-0000-0000-000000000001','CREDIT','0.00',max],
      ['00000000-0000-0000-0000-000000000003','DEBIT',max,'0.00'],
      ['00000000-0000-0000-0000-000000000002','CREDIT','0.00',max],
    ]) {
      const tx = await transaction(w);
      await app.query(`INSERT INTO wallet_ledger_entries
        (id,wallet_id,transaction_id,entry_type,amount,currency,balance_before,balance_after,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'2026-01-01T00:00:00Z')`,
        [id,w,tx,type,max,'BRL',before,after]);
    }
    await admin.query('UPDATE wallets SET balance=$2 WHERE id=$1',[w,max]);
    expect(await reconcile.execute(w)).toMatchObject({consistent:true,checkedEntries:3,calculatedBalance:{amount:max},difference:{amount:'0.00'}});
  });

  it('reconciles opening, BET, WIN, REFUND, ROLLBACK; LOSS, rejection and replay add no entries', async () => {
    const w = await create.execute({playerId:crypto.randomUUID(),initialBalance:{amount:'100.00',currency:'BRL'}});
    const run = async (kind: ProcessWagerDto['kind'], amount: string, reference?: string) => {
      const dto: ProcessWagerDto = { providerId:'m12-flow', externalTransactionId:crypto.randomUUID(),walletId:w.id,
        playerId:w.playerId,roundId:'r',gameId:'g',kind,money:{amount,currency:'BRL'},referenceExternalTransactionId:reference };
      const key = crypto.randomUUID(), response = await processWager.execute(key,dto);
      expect(response.status).toBe(amount === '1000.00' ? 'REJECTED' : 'PROCESSED');
      const before = await snapshot();
      expect((await processWager.execute(key,dto)).idempotentReplay).toBe(true);
      expect(await snapshot()).toEqual(before);
      expect((await reconcile.execute(w.id)).consistent).toBe(true);
      return {dto,response};
    };
    const bet = await run('BET','10.00');
    await run('WIN','3.00',bet.dto.externalTransactionId);
    await run('LOSS','0.00');
    await run('REFUND','10.00',bet.dto.externalTransactionId);
    const otherBet = await run('BET','5.00');
    await run('ROLLBACK','5.00',otherBet.dto.externalTransactionId);
    expect((await run('BET','1000.00')).response.status).toBe('REJECTED');
    expect(await reconcile.execute(w.id)).toMatchObject({consistent:true,checkedEntries:6,storedBalance:{amount:'103.00'},difference:{amount:'0.00'}});
    const rows = (await admin.query('SELECT kind, count(l.id)::int AS entries FROM wager_transactions t LEFT JOIN wallet_ledger_entries l ON l.transaction_id=t.id WHERE t.wallet_id=$1 GROUP BY kind ORDER BY kind',[w.id])).rows;
    expect(rows).toEqual([{kind:'BET',entries:2},{kind:'LOSS',entries:0},{kind:'OPENING',entries:1},{kind:'REFUND',entries:1},{kind:'ROLLBACK',entries:1},{kind:'WIN',entries:1}]);
  });
});
