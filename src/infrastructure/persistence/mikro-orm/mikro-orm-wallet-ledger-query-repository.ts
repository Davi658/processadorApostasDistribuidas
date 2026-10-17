import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { MikroOrmUnitOfWork } from './mikro-orm-adapter';
import type {
  LedgerKeysetCursor,
  WalletLedgerEntryQueryResponseDto,
} from '../../../application/dto/query-wallet-ledger.dto';
import type {
  WalletLedgerQueryPort,
  WalletLedgerQueryResult,
} from '../../../application/ports/wallet-ledger-query.port';

@Injectable()
export class MikroOrmWalletLedgerQueryRepository implements WalletLedgerQueryPort {
  constructor(private readonly uow: MikroOrmUnitOfWork) {}

  private get em(): EntityManager {
    return this.uow.getEntityManager() as EntityManager;
  }

  public async queryLedgerKeyset(params: {
    walletId: string;
    limit: number;
    cursor?: LedgerKeysetCursor;
  }): Promise<WalletLedgerQueryResult> {
    const em = this.em;
    const limitPlusOne = params.limit + 1;

    let query: string;
    let queryParams: any[];

    if (params.cursor) {
      query = `
        SELECT 
          id,
          wallet_id,
          transaction_id,
          entry_type,
          amount::text AS amount,
          currency,
          balance_before::text AS balance_before,
          balance_after::text AS balance_after,
          TO_CHAR(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
        FROM wallet_ledger_entries
        WHERE wallet_id = ?
          AND (created_at > ?::timestamptz OR (created_at = ?::timestamptz AND id > ?::uuid))
        ORDER BY created_at ASC, id ASC
        LIMIT ?;
      `;
      queryParams = [
        params.walletId,
        params.cursor.createdAt,
        params.cursor.createdAt,
        params.cursor.id,
        limitPlusOne,
      ];
    } else {
      query = `
        SELECT 
          id,
          wallet_id,
          transaction_id,
          entry_type,
          amount::text AS amount,
          currency,
          balance_before::text AS balance_before,
          balance_after::text AS balance_after,
          TO_CHAR(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
        FROM wallet_ledger_entries
        WHERE wallet_id = ?
        ORDER BY created_at ASC, id ASC
        LIMIT ?;
      `;
      queryParams = [params.walletId, limitPlusOne];
    }

    const rows = await em.execute<
      Array<{
        id: string;
        wallet_id: string;
        transaction_id: string;
        entry_type: 'CREDIT' | 'DEBIT';
        amount: string;
        currency: string;
        balance_before: string;
        balance_after: string;
        created_at: string;
      }>
    >(query, queryParams);

    const hasMore = rows.length > params.limit;
    const pageRows = hasMore ? rows.slice(0, params.limit) : rows;

    const items: WalletLedgerEntryQueryResponseDto[] = pageRows.map((row) => ({
      id: row.id,
      walletId: row.wallet_id,
      transactionId: row.transaction_id,
      entryType: row.entry_type,
      amount: {
        amount: row.amount,
        currency: row.currency,
      },
      balanceBefore: {
        amount: row.balance_before,
        currency: row.currency,
      },
      balanceAfter: {
        amount: row.balance_after,
        currency: row.currency,
      },
      createdAt: row.created_at,
    }));

    let nextCursorData: LedgerKeysetCursor | undefined = undefined;
    if (hasMore && items.length > 0) {
      const last = items[items.length - 1];
      nextCursorData = {
        walletId: params.walletId,
        createdAt: last.createdAt,
        id: last.id,
      };
    }

    return {
      items,
      hasMore,
      nextCursorData,
    };
  }
}
