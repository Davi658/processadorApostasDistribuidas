// Automated acceptance of the final composition. This is not the candidate's personal test.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
const base = process.env.DELIVERY_API_URL ?? 'http://127.0.0.1:3091';
const sql = new pg.Pool({ host: '127.0.0.1', port: Number(process.env.DELIVERY_DB_PORT ?? 55591),
  user: 'migration_user', password: 'local_migration_only', database: 'betting_db' });
const endpoint = process.env.DELIVERY_SQS_ENDPOINT ?? 'http://127.0.0.1:45691';
const sqs = new SQSClient({ endpoint, useQueueUrlAsEndpoint: false, region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
const statePath = '.data/delivery-compose-snapshot.json';
async function http(path: string, body?: unknown, key?: string, expected = body ? 200 : 200): Promise<any> {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal(response.status, expected, `${path}: ${await response.clone().text()}`);
  return response.json();
}
async function until(check: () => Promise<boolean>, name: string) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) { if (await check()) return; await Bun.sleep(200); }
  throw new Error(`TIMEOUT: ${name}`);
}
async function snapshot(walletId: string) {
  const records: Record<string, any[]> = {};
  for (const table of ['wallets', 'wager_transactions', 'wallet_ledger_entries']) {
    records[table] = (await sql.query(`select to_jsonb(t) as row from ${table} t where ${table === 'wallets' ? 'id' : 'wallet_id'}=$1 order by id`, [walletId])).rows;
  }
  records.inbox = (await sql.query('select to_jsonb(i) as row from command_inbox i join wager_transactions t on t.id=i.transaction_id where t.wallet_id=$1 order by i.command_id', [walletId])).rows;
  records.outbox = (await sql.query('select to_jsonb(o) as row from outbox_messages o where aggregate_id=$1 order by id', [walletId])).rows;
  return records;
}
try {
  await http('/health/live'); await http('/health/ready');
  assert.match(await (await fetch(base + '/metrics')).text(), /financial_invocations_total/);
  const migrations = (await sql.query('select version from schema_migrations order by version')).rows;
  assert.equal(migrations.length, 10);
  if (process.argv.includes('--verify-persistence')) {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.deepEqual(await snapshot(state.walletId), state.records);
    assert.equal((await http(`/wallets/${state.walletId}/reconciliation`, {})).consistent, true);
    console.log(JSON.stringify({ mode: 'persistence', walletId: state.walletId, identicalRecordsById: true, migrations }));
  } else {
    const wallet = await http('/wallets', { playerId: crypto.randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } }, undefined, 201);
    const dto = { providerId: 'delivery-compose', externalTransactionId: crypto.randomUUID(), playerId: wallet.playerId, walletId: wallet.id,
      roundId: 'delivery', gameId: 'delivery', kind: 'BET', money: { amount: '10.00', currency: 'BRL' } };
    const key = crypto.randomUUID();
    const bet = await http('/wagering/transactions', dto, key);
    const replay = await http('/wagering/transactions', dto, key);
    assert.equal(replay.transactionId, bet.transactionId); assert.equal(replay.idempotentReplay, true);
    await http('/wagering/transactions', { ...dto, money: { amount: '11.00', currency: 'BRL' } }, key, 409);
    const command = { type: 'WagerTransactionRequested', messageId: `msg-${crypto.randomUUID()}`, occurredAt: new Date().toISOString(),
      data: { ...dto, idempotencyKey: crypto.randomUUID(), externalTransactionId: crypto.randomUUID(), money: { amount: '5.00', currency: 'BRL' } } };
    const queueUrl = `${endpoint}/queue/us-east-1/000000000000/wager-transactions.fifo`;
    const send = async () => sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(command), MessageGroupId: wallet.id, MessageDeduplicationId: crypto.randomUUID() }));
    await send();
    await until(async () => (await sql.query('select count(*)::int n from command_inbox where command_id=$1', [command.messageId])).rows[0].n === 1, 'real consumer inbox');
    await send();
    const reference = crypto.randomUUID();
    const pending = await http('/wagering/transactions', { ...dto, kind: 'REFUND', externalTransactionId: crypto.randomUUID(), referenceExternalTransactionId: reference, money: { amount: '2.00', currency: 'BRL' } }, crypto.randomUUID(), 202);
    await http('/wagering/transactions', { ...dto, externalTransactionId: reference, money: { amount: '2.00', currency: 'BRL' } }, crypto.randomUUID());
    await until(async () => (await http(`/wagering/transactions/${pending.transactionId}`)).status === 'PROCESSED', 'real reference worker');
    await until(async () => (await sql.query('select count(*)::int n from outbox_messages where aggregate_id=$1 and published_at is null', [wallet.id])).rows[0].n === 0, 'real publisher');
    const reconciliation = await http(`/wallets/${wallet.id}/reconciliation`, {});
    assert.equal(reconciliation.consistent, true); assert.equal(reconciliation.storedBalance.amount, '85.00');
    const records = await snapshot(wallet.id);
    assert.equal(records.wager_transactions!.length, 5); // opening + HTTP BET + SQS BET + WIN + reference BET
    assert.equal(records.wallet_ledger_entries!.length, 5);
    assert.equal(records.inbox!.length, 1);
    const sqsTx = records.wager_transactions!.find(r => r.row.external_transaction_id === command.data.externalTransactionId)!.row;
    assert.equal(records.inbox![0].row.transaction_id, sqsTx.id);
    assert.ok(records.wallet_ledger_entries!.some(r => r.row.transaction_id === sqsTx.id));
    assert.ok(records.outbox!.some(r => r.row.payload.transactionId === sqsTx.id));
    mkdirSync('.data', { recursive: true }); writeFileSync(statePath, JSON.stringify({ walletId: wallet.id, records }, null, 2));
    console.log(JSON.stringify({ mode: 'compose', walletId: wallet.id, migrations, ids: Object.fromEntries(Object.entries(records).map(([table, rows]) => [table, rows.map(r => r.row.id ?? r.row.command_id)])), reconciliation: true }));
  }
} finally { sqs.destroy(); await sql.end(); }
