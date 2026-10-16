import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { CreateWalletUseCase } from '../../../application/use-cases/create-wallet.use-case';
import { GetWalletUseCase } from '../../../application/use-cases/get-wallet.use-case';
import { ReconcileWalletUseCase } from '../../../application/use-cases/reconcile-wallet.use-case';
import { ReconciliationResponseDto, WalletResponseDto } from '../../../application/dto/wallet.dto';
import { HttpValidator } from '../validation/http-validator';

@Controller('wallets')
export class WalletController {
  constructor(
    private readonly createWalletUseCase: CreateWalletUseCase,
    private readonly getWalletUseCase: GetWalletUseCase,
    private readonly reconcileWalletUseCase: ReconcileWalletUseCase
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  public async createWallet(@Body() rawBody: unknown): Promise<WalletResponseDto> {
    const validatedDto = HttpValidator.validateCreateWalletBody(rawBody);
    return await this.createWalletUseCase.execute(validatedDto);
  }

  @Get(':walletId')
  public async getWallet(@Param('walletId') walletId: string): Promise<WalletResponseDto> {
    const validatedId = HttpValidator.validateUuid(walletId, 'walletId');
    return await this.getWalletUseCase.execute(validatedId);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  public async reconcile(@Param('walletId') walletId: string): Promise<ReconciliationResponseDto> {
    const validatedId = HttpValidator.validateUuid(walletId, 'walletId');
    return await this.reconcileWalletUseCase.execute(validatedId);
  }
}
