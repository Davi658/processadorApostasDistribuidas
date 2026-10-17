// Exercise an implemented read route and its real database connection.
const response = await fetch('http://127.0.0.1:3000/wallets/00000000-0000-4000-8000-000000000000');
if (response.status !== 404 && response.status !== 200) {
  throw new Error(`Wallet route returned ${response.status}`);
}
const body = await response.json() as { code?: string; id?: string };
if (response.status === 404 && body.code !== 'WALLET_NOT_FOUND') {
  throw new Error('Expected a domain response from the wallet repository');
}
