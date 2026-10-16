import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { CreateWalletUseCase } from '../../../application/use-cases/create-wallet.use-case';
import { GetWalletUseCase } from '../../../application/use-cases/get-wallet.use-case';
import { ReconcileWalletUseCase } from '../../../application/use-cases/reconcile-wallet.use-case';
import { CreateWalletDto, ReconciliationResponseDto, WalletResponseDto } from '../../../application/dto/wallet.dto';

@Controller('wallets')
export class WalletController {
  constructor(
    private readonly createWalletUseCase: CreateWalletUseCase,
    private readonly getWalletUseCase: GetWalletUseCase,
    private readonly reconcileWalletUseCase: ReconcileWalletUseCase
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  public async createWallet(@Body() body: CreateWalletDto): Promise<WalletResponseDto> {
    return await this.createWalletUseCase.execute(body);
  }

  @Get(':walletId')
  public async getWallet(@Param('walletId') walletId: string): Promise<WalletResponseDto> {
    return await this.getWalletUseCase.execute(walletId);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  public async reconcile(@Param('walletId') walletId: string): Promise<ReconciliationResponseDto> {
    return await this.reconcileWalletUseCase.execute(walletId);
  }
}
