const base = process.env.API_BASE_URL || 'http://127.0.0.1:3000';
const created = await fetch(`${base}/wallets`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ playerId: `infra-smoke-${crypto.randomUUID()}`, initialBalance: { amount: '0.00', currency: 'BRL' } }),
});
if (created.status !== 201) throw new Error(`POST wallets: ${created.status} ${await created.text()}`);
const wallet = await created.json() as { id: string };
const read = await fetch(`${base}/wallets/${wallet.id}`);
if (read.status !== 200) throw new Error(`GET wallet: ${read.status} ${await read.text()}`);
const fetched = await read.json() as { id: string };
if (fetched.id !== wallet.id) throw new Error('Wallet ID mismatch');
console.log('API POST/GET OK', fetched);
