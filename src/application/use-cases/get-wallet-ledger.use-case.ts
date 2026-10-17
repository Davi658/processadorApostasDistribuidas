import { Injectable } from '@nestjs/common';
import type { WalletRepositoryPort } from '../ports/ports';
import { WalletNotFoundError } from '../../domain/errors/domain.error';
import type { WalletLedgerQueryPort } from '../ports/wallet-ledger-query.port';
import type {
  GetWalletLedgerQueryDto,
  WalletLedgerPageResponseDto,
} from '../dto/query-wallet-ledger.dto';
import { QueryValidator } from '../../interfaces/http/validation/query-validator';

@Injectable()
export class GetWalletLedgerUseCase {
  constructor(
    private readonly walletRepo: WalletRepositoryPort,
    private readonly ledgerQueryRepo: WalletLedgerQueryPort
  ) {}

  public async execute(query: GetWalletLedgerQueryDto): Promise<WalletLedgerPageResponseDto> {
    const wallet = await this.walletRepo.findById(query.walletId, false);
    if (!wallet) {
      throw new WalletNotFoundError(query.walletId);
    }

    const result = await this.ledgerQueryRepo.queryLedgerKeyset({
      walletId: query.walletId,
      limit: query.limit,
      cursor: query.cursor,
    });

    const nextCursor =
      result.hasMore && result.nextCursorData
        ? QueryValidator.encodeCursor(result.nextCursorData)
        : null;

    return {
      items: result.items,
      nextCursor,
      hasMore: result.hasMore,
      limit: query.limit,
    };
  }
}
