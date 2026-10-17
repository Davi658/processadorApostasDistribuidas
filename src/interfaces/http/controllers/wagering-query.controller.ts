import { Controller, Get, Param } from '@nestjs/common';
import { GetWageringTransactionByIdUseCase } from '../../../application/use-cases/get-wagering-transaction-by-id.use-case';
import type { WagerTransactionQueryResponseDto } from '../../../application/dto/query-wagering-transaction.dto';
import { QueryValidator } from '../validation/query-validator';

@Controller('wagering')
export class WageringQueryController {
  constructor(
    private readonly getWageringTransactionByIdUseCase: GetWageringTransactionByIdUseCase
  ) {}

  @Get('transactions/:transactionId')
  public async getTransactionById(
    @Param('transactionId') transactionId: string
  ): Promise<WagerTransactionQueryResponseDto> {
    const validatedId = QueryValidator.validateUuid(transactionId, 'transactionId');
    return await this.getWageringTransactionByIdUseCase.execute(validatedId);
  }
}
