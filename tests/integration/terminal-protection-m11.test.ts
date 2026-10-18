import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import pg from 'pg';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from '../test-db-helper';
import { DatabaseMigrator } from '../../src/infrastructure/persistence/migrator';

const version = '006_terminal_transaction_protection';
const states = ['PROCESSED', 'REJECTED', 'FAILED'];
const mutations: Record<string, unknown> = {
  id: crypto.randomUUID(), wallet_id: crypto.randomUUID(), player_id: 'other-player',
  provider_id: 'other-provider', external_transaction_id: 'other-external', round_id: 'other-round',
  game_id: 'other-game', kind: 'BET', amount: '2.00', currency: 'USD', status: 'PENDING',
  idempotency_key: 'other-key', payload_hash: 'b'.repeat(64), response_snapshot: { changed: true },
  rejection_reason: 'other-reason', reference_external_transaction_id: 'other-reference',
  created_at: '2000-01-01T00:00:00Z',
};
const nullable = ['idempotency_key', 'payload_hash', 'response_snapshot', 'rejection_reason', 'reference_external_transaction_id'];
let db: IsolatedTestDatabase;
let admin: pg.Pool;
let app: pg.Pool;
let wallet: string;
async function seed(status: string, populated = true) {
  const id = crypto.randomUUID();
  await admin.query(`INSERT INTO wager_transactions
    (id,wallet_id,player_id,provider_id,external_transaction_id,round_id,game_id,kind,amount,currency,status,
     idempotency_key,payload_hash,response_snapshot,rejection_reason,reference_external_transaction_id,created_at,updated_at)
    VALUES ($1::uuid,$2,'player','provider',$1::text,'round','game','OPENING',1,'BRL',$3,$4,$5,$6,$7,$8,now(),now())`,
    [id,wallet,status,populated ? id : null,populated ? 'a'.repeat(64) : null,
      populated ? { balance: '1.00' } : null,populated ? 'reason' : null,populated ? id : null]);
  return id;
}
async function snapshot(id: string) {
  return (await admin.query('SELECT to_jsonb(t) AS row FROM wager_transactions t WHERE id=$1', [id])).rows;
}
async function refusal(pool: pg.Pool, id: string, sql: string, params: unknown[], code: string, reason: string) {
  const before = await snapshot(id);
  let error: pg.DatabaseError | undefined;
  try { await pool.query(sql, params); } catch (e) { error = e as pg.DatabaseError; }
  expect(error?.code).toBe(code);
  expect(error?.message).toContain(reason);
  expect(await snapshot(id)).toEqual(before);
}

describe('M11 terminal protection on disposable PostgreSQL with enabled triggers', () => {
  beforeAll(async () => {
    db = await createIsolatedTestDatabase('m11_');
    admin = new pg.Pool(db.adminConfig); app = new pg.Pool(db.appConfig);
    wallet = crypto.randomUUID();
    await admin.query(`INSERT INTO wallets VALUES ($1,'player','BRL',100,1,now(),now())`, [wallet]);
  }, 30000);
  afterAll(async () => { await app?.end(); await admin?.end(); await db?.closeAndDrop(); }, 30000);

  it('diagnoses the historical missing column and proves UP/DOWN/UP preserves complete rows', async () => {
    const migrator = new DatabaseMigrator(db.adminConfig);
    try {
      const ids = await Promise.all(states.map(s => seed(s)));
      const before = await Promise.all(ids.map(snapshot));
      expect(await migrator.down()).toBe('010_external_inbox_identity');
      expect(await migrator.down()).toBe('009_command_inbox');
      expect(await migrator.down()).toBe('008_outbox_publisher_lease_and_retry');
      expect(await migrator.down()).toBe('007_ledger_finite_values');
      expect(await migrator.down()).toBe(version);
      const columns = await admin.query(`SELECT column_name FROM information_schema.columns WHERE table_name='wager_transactions'`);
      expect(columns.rows.some(r => r.column_name === 'observed_balance')).toBe(false);
      // An operational-only update evaluates the broken historical expression in full.
      await refusal(admin, ids[0], 'UPDATE wager_transactions SET attempts=attempts+1 WHERE id=$1', [ids[0]],
        '42703', 'observed_balance');
      expect(await migrator.up()).toEqual([version, '007_ledger_finite_values', '008_outbox_publisher_lease_and_retry', '009_command_inbox', '010_external_inbox_identity']);
      expect(await Promise.all(ids.map(snapshot))).toEqual(before);
    } finally { await migrator.close(); }
  });

  it('uses a restricted application role and keeps the protection trigger enabled', async () => {
    const role = (await app.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    const nullableColumns = await admin.query(`SELECT column_name FROM information_schema.columns
      WHERE table_name='wager_transactions' AND is_nullable='YES'
      AND column_name NOT IN ('next_attempt_at','lease_token','lease_owner','lease_expires_at','operational_block_reason')`);
    expect(nullableColumns.rows.map(r => r.column_name).sort()).toEqual([...nullable].sort());
    const triggers = await admin.query(`SELECT tgenabled FROM pg_trigger WHERE tgrelid='wager_transactions'::regclass AND tgname='trg_protect_wager_terminal_state'`);
    expect(triggers.rows).toEqual([{ tgenabled: 'O' }]);
    expect((await app.query('SHOW session_replication_role')).rows[0].session_replication_role).toBe('origin');
  });

  for (const status of states) {
    for (const role of ['app', 'admin']) {
      it(`${status}: ${role} rejects every protected field and both NULL directions without changing the row`, async () => {
        const pool = role === 'app' ? app : admin;
        const id = await seed(status);
        for (const [field, value] of Object.entries(mutations)) {
          await refusal(pool,id,`UPDATE wager_transactions SET ${field}=$2 WHERE id=$1`,[id,value],
            '55000','terminal_transaction_protected_fields');
        }
        for (const field of nullable) {
          await refusal(pool,id,`UPDATE wager_transactions SET ${field}=NULL WHERE id=$1`,[id],
            '55000','terminal_transaction_protected_fields');
        }
        const nullId = await seed(status,false);
        for (const field of nullable) {
          await refusal(pool,nullId,`UPDATE wager_transactions SET ${field}=$2 WHERE id=$1`,[nullId,mutations[field]],
            '55000','terminal_transaction_protected_fields');
        }
        await refusal(pool,id,'DELETE FROM wager_transactions WHERE id=$1',[id],
          role === 'app' ? '42501' : '55000',role === 'app' ? 'wager_transactions' : 'terminal_transaction_delete_forbidden');
        // No-op writes and every explicitly allowed operational column remain writable.
        await pool.query('UPDATE wager_transactions SET amount=amount WHERE id=$1',[id]);
        const original = (await snapshot(id))[0].row;
        const operational: Record<string,unknown> = { updated_at: '2030-01-01T00:00:00Z', attempts: 2,
          next_attempt_at: '2030-01-01T00:00:00Z', lease_token: 'token',lease_owner:'worker',
          lease_expires_at:'2030-01-01T00:00:00Z',is_operationally_blocked:true,operational_block_reason:'manual' };
        for (const [field,value] of Object.entries(operational)) {
          await pool.query(`UPDATE wager_transactions SET ${field}=$2 WHERE id=$1`,[id,value]);
          await refusal(pool,id,`UPDATE wager_transactions SET ${field}=$2,amount=2 WHERE id=$1`,[id,value],
            '55000','terminal_transaction_protected_fields');
        }
        const after = (await snapshot(id))[0].row;
        for (const field of Object.keys(operational)) { delete original[field]; delete after[field]; }
        expect(after).toEqual(original);
        await pool.query(`UPDATE wager_transactions SET lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,
          next_attempt_at=NULL,is_operationally_blocked=false,operational_block_reason=NULL WHERE id=$1`,[id]);
      }, 30000);
    }
  }
  it('preserves PENDING/PENDING_REFERENCE transitions to all terminal states and M10 lease operations', async () => {
    for (const initial of ['PENDING','PENDING_REFERENCE']) {
      for (const terminal of states) {
        const id = await seed(initial);
        await app.query(`UPDATE wager_transactions SET attempts=attempts+1,
          lease_token='claim',lease_owner='worker',lease_expires_at=now()+interval '1 minute',next_attempt_at=now() WHERE id=$1`,[id]);
        await app.query(`UPDATE wager_transactions SET status=$2,amount=3,response_snapshot=$3,
          rejection_reason=$4,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1`,
          [id,terminal,{ balance:'3.00' },terminal === 'PROCESSED' ? null : 'reason']);
        expect((await snapshot(id))[0].row.status).toBe(terminal);
      }
    }
    const id = await seed('PENDING');
    await app.query("UPDATE wager_transactions SET status='PENDING_REFERENCE' WHERE id=$1",[id]);
    expect((await admin.query('DELETE FROM wager_transactions WHERE id=$1',[id])).rowCount).toBe(1);
  });
});
