import pg from 'pg';
import { FinancialQueriesPort, type LedgerPosition, type LedgerQueryDto, type TransactionQueryDto } from '../../../application/ports/financial-queries.port';

// Format in PostgreSQL: JS Date would silently truncate timestamp microseconds.
const timestamp = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const transactionProjection = `id AS "transactionId", wallet_id AS "walletId", player_id AS "playerId",
  provider_id AS "providerId", external_transaction_id AS "externalTransactionId",
  round_id AS "roundId", game_id AS "gameId", kind, status,
  json_build_object('amount', amount::text, 'currency', currency) AS money,
  reference_external_transaction_id AS "referenceExternalTransactionId", rejection_reason AS "failureCode",
  ${timestamp('created_at')} AS "createdAt", ${timestamp('updated_at')} AS "updatedAt"`;

export class PostgresFinancialQueries extends FinancialQueriesPort {
  constructor(private readonly pool: pg.Pool) { super(); }

  async transactionById(id: string): Promise<TransactionQueryDto | null> {
    const result = await this.pool.query<TransactionQueryDto>(`SELECT ${transactionProjection} FROM wager_transactions WHERE id = $1`, [id]);
    return result.rows[0] ?? null;
  }

  async transactionByExternal(providerId: string, externalId: string): Promise<TransactionQueryDto | null> {
    const result = await this.pool.query<TransactionQueryDto>(`SELECT ${transactionProjection} FROM wager_transactions WHERE provider_id = $1 AND external_transaction_id = $2`, [providerId, externalId]);
    return result.rows[0] ?? null;
  }

  async walletExists(walletId: string): Promise<boolean> {
    return (await this.pool.query('SELECT 1 FROM wallets WHERE id = $1', [walletId])).rowCount === 1;
  }

  async ledger(walletId: string, limit: number, after?: LedgerPosition): Promise<LedgerQueryDto[]> {
    const result = await this.pool.query<LedgerQueryDto>(`SELECT id, wallet_id AS "walletId", transaction_id AS "transactionId",
      entry_type AS "entryType", json_build_object('amount', amount::text, 'currency', currency) AS money,
      json_build_object('amount', balance_before::text, 'currency', currency) AS "balanceBefore",
      json_build_object('amount', balance_after::text, 'currency', currency) AS "balanceAfter",
      ${timestamp('created_at')} AS "createdAt"
      FROM wallet_ledger_entries WHERE wallet_id = $1
      ${after ? 'AND (created_at, id) > ($3::timestamptz, $4::uuid)' : ''}
      ORDER BY created_at ASC, id ASC LIMIT $2`,
    after ? [walletId, limit, after.createdAt, after.id] : [walletId, limit]);
    return result.rows;
  }
}
