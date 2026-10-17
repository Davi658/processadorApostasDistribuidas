import { Controller, Get, Param, Query } from '@nestjs/common';
import { GetWalletLedgerUseCase } from '../../../application/use-cases/get-wallet-ledger.use-case';
import type { WalletLedgerPageResponseDto } from '../../../application/dto/query-wallet-ledger.dto';
import { QueryValidator } from '../validation/query-validator';

@Controller('wallets')
export class WalletLedgerQueryController {
  constructor(private readonly getWalletLedgerUseCase: GetWalletLedgerUseCase) {}

  @Get(':walletId/ledger')
  public async getWalletLedger(
    @Param('walletId') walletId: string,
    @Query('limit') rawLimit?: unknown,
    @Query('cursor') rawCursor?: unknown
  ): Promise<WalletLedgerPageResponseDto> {
    const validatedWalletId = QueryValidator.validateUuid(walletId, 'walletId');
    const validatedLimit = QueryValidator.validateLimit(rawLimit, 50, 100);
    const validatedCursor = QueryValidator.validateAndDecodeCursor(
      rawCursor,
      validatedWalletId
    );

    return await this.getWalletLedgerUseCase.execute({
      walletId: validatedWalletId,
      limit: validatedLimit,
      cursor: validatedCursor,
    });
  }
}
