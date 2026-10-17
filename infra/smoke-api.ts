const base = process.env.API_BASE_URL || `http://127.0.0.1:${process.env.LOCAL_API_PORT || '3000'}`;
console.log(`[smoke-api] Running smoke tests against ${base}...`);

// 1. Abertura com saldo positivo
const playerId = crypto.randomUUID();
const openRes = await fetch(`${base}/wallets`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    playerId,
    initialBalance: { amount: '100.00', currency: 'BRL' },
  }),
});
if (openRes.status !== 201) {
  throw new Error(`POST /wallets failed: ${openRes.status} ${await openRes.text()}`);
}
const wallet = (await openRes.json()) as { id: string; balance: { amount: string; currency: string } };
if (!wallet.id || wallet.balance.amount !== '100.00') {
  throw new Error(`Unexpected wallet opening result: ${JSON.stringify(wallet)}`);
}
console.log(`[smoke-api] 1. Abertura OK: walletId=${wallet.id}, balance=${wallet.balance.amount}`);

// Consulta da carteira
const getWalletRes = await fetch(`${base}/wallets/${wallet.id}`);
if (getWalletRes.status !== 200) {
  throw new Error(`GET /wallets/${wallet.id} failed: ${getWalletRes.status} ${await getWalletRes.text()}`);
}
const fetchedWallet = (await getWalletRes.json()) as { id: string; balance: { amount: string } };
if (fetchedWallet.id !== wallet.id || fetchedWallet.balance.amount !== '100.00') {
  throw new Error(`Wallet balance mismatch on GET: ${JSON.stringify(fetchedWallet)}`);
}
console.log(`[smoke-api] 1.1 GET Wallet OK: balance=${fetchedWallet.balance.amount}`);

// 2. BET
const idempotencyKey = `smoke-idemp-${crypto.randomUUID()}`;
const externalTransactionId = `smoke-ext-${crypto.randomUUID()}`;
const betPayload = {
  providerId: 'SMOKE_PROVIDER',
  externalTransactionId,
  playerId,
  walletId: wallet.id,
  roundId: 'smoke-round-1',
  gameId: 'smoke-game-1',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

const betRes = await fetch(`${base}/wagering/transactions`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'idempotency-key': idempotencyKey,
    'x-correlation-id': crypto.randomUUID(),
  },
  body: JSON.stringify(betPayload),
});

if (betRes.status !== 200) {
  throw new Error(`POST /wagering/transactions (BET) failed: ${betRes.status} ${await betRes.text()}`);
}
const betResult = (await betRes.json()) as {
  status: string;
  balance: { amount: string };
  idempotentReplay: boolean;
  transactionId: string;
};
if (
  betResult.status !== 'PROCESSED' ||
  betResult.balance.amount !== '75.00' ||
  betResult.idempotentReplay !== false ||
  !betResult.transactionId
) {
  throw new Error(`Unexpected BET result: ${JSON.stringify(betResult)}`);
}
console.log(`[smoke-api] 2. BET OK: txId=${betResult.transactionId}, newBalance=${betResult.balance.amount}`);

// 3. Replay Idempotente
const replayRes = await fetch(`${base}/wagering/transactions`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'idempotency-key': idempotencyKey,
    'x-correlation-id': crypto.randomUUID(),
  },
  body: JSON.stringify(betPayload),
});

if (replayRes.status !== 200) {
  throw new Error(`POST /wagering/transactions (Replay) failed: ${replayRes.status} ${await replayRes.text()}`);
}
const replayResult = (await replayRes.json()) as {
  status: string;
  balance: { amount: string };
  idempotentReplay: boolean;
  transactionId: string;
};
if (
  replayResult.status !== 'PROCESSED' ||
  replayResult.balance.amount !== '75.00' ||
  replayResult.idempotentReplay !== true ||
  replayResult.transactionId !== betResult.transactionId
) {
  throw new Error(`Unexpected Replay result: ${JSON.stringify(replayResult)}`);
}
console.log(`[smoke-api] 3. Replay OK: idempotentReplay=${replayResult.idempotentReplay}, balance=${replayResult.balance.amount}`);

// 4. Consultas (Transação por ID e Ledger Paginado)
const queryTxRes = await fetch(`${base}/wagering/transactions/${betResult.transactionId}`);
if (queryTxRes.status !== 200) {
  throw new Error(`GET /wagering/transactions/${betResult.transactionId} failed: ${queryTxRes.status} ${await queryTxRes.text()}`);
}
const queryTx = (await queryTxRes.json()) as {
  id: string;
  kind: string;
  status: string;
  money: {
    amount: string;
    currency: string;
  };
};
if (
  queryTx.id !== betResult.transactionId ||
  queryTx.kind !== 'BET' ||
  queryTx.status !== 'PROCESSED' ||
  queryTx.money?.amount !== '25.00' ||
  queryTx.money?.currency !== 'BRL'
) {
  throw new Error(`Unexpected transaction query result: ${JSON.stringify(queryTx)}`);
}
console.log(`[smoke-api] 4.1 Consulta Transação OK: id=${queryTx.id}, kind=${queryTx.kind}, status=${queryTx.status}, amount=${queryTx.money.amount} ${queryTx.money.currency}`);

const queryLedgerRes = await fetch(`${base}/wallets/${wallet.id}/ledger`);
if (queryLedgerRes.status !== 200) {
  throw new Error(`GET /wallets/${wallet.id}/ledger failed: ${queryLedgerRes.status} ${await queryLedgerRes.text()}`);
}
const ledgerPage = (await queryLedgerRes.json()) as {
  items: Array<{
    id: string;
    entryType: 'CREDIT' | 'DEBIT';
    amount: { amount: string; currency: string };
  }>;
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
};
if (
  !Array.isArray(ledgerPage.items) ||
  ledgerPage.items.length !== 2 ||
  ledgerPage.hasMore !== false ||
  ledgerPage.nextCursor !== null
) {
  throw new Error(`Unexpected ledger page result: ${JSON.stringify(ledgerPage)}`);
}

const creditEntry = ledgerPage.items.find((item) => item.entryType === 'CREDIT');
const debitEntry = ledgerPage.items.find((item) => item.entryType === 'DEBIT');

if (
  !creditEntry ||
  !debitEntry ||
  creditEntry.amount.amount !== '100.00' ||
  debitEntry.amount.amount !== '25.00'
) {
  throw new Error(`Unexpected ledger entries composition: ${JSON.stringify(ledgerPage.items)}`);
}
console.log(
  `[smoke-api] 4.2 Consulta Ledger OK: items=${ledgerPage.items.length} (CREDIT=${creditEntry.amount.amount}, DEBIT=${debitEntry.amount.amount}), hasMore=${ledgerPage.hasMore}, nextCursor=${ledgerPage.nextCursor}`
);

// 5. Reconciliação
const reconRes = await fetch(`${base}/wallets/${wallet.id}/reconciliation`, {
  method: 'POST',
});
if (reconRes.status !== 200) {
  throw new Error(`POST /wallets/${wallet.id}/reconciliation failed: ${reconRes.status} ${await reconRes.text()}`);
}
const reconResult = (await reconRes.json()) as {
  walletId: string;
  storedBalance: { amount: string };
  calculatedBalance: { amount: string };
  difference: { amount: string };
  consistent: boolean;
  checkedEntries: number;
};
if (
  !reconResult.consistent ||
  reconResult.difference.amount !== '0.00' ||
  reconResult.storedBalance.amount !== '75.00' ||
  reconResult.calculatedBalance.amount !== '75.00'
) {
  throw new Error(`Unexpected reconciliation result: ${JSON.stringify(reconResult)}`);
}
console.log(`[smoke-api] 5. Reconciliação OK: consistent=${reconResult.consistent}, diff=${reconResult.difference.amount}, checkedEntries=${reconResult.checkedEntries}`);

console.log('[smoke-api] All smoke operations passed successfully!');

