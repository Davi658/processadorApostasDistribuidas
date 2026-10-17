import { Controller, Get, Param } from '@nestjs/common';
import { GetWageringTransactionByExternalIdUseCase } from '../../../application/use-cases/get-wagering-transaction-by-external-id.use-case';
import type { WagerTransactionQueryResponseDto } from '../../../application/dto/query-wagering-transaction.dto';
import { QueryValidator } from '../validation/query-validator';

@Controller('providers')
export class ProviderWageringQueryController {
  constructor(
    private readonly getWageringTransactionByExternalIdUseCase: GetWageringTransactionByExternalIdUseCase
  ) {}

  @Get(':providerId/wagering/transactions/:externalTransactionId')
  public async getTransactionByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string
  ): Promise<WagerTransactionQueryResponseDto> {
    const validatedProviderId = QueryValidator.validateString(providerId, 'providerId', 1, 128);
    const validatedExternalTransactionId = QueryValidator.validateString(
      externalTransactionId,
      'externalTransactionId',
      1,
      128
    );
    return await this.getWageringTransactionByExternalIdUseCase.execute(
      validatedProviderId,
      validatedExternalTransactionId
    );
  }
}
