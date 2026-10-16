import {
  Body,
  Controller,
  Headers,
  HttpStatus,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ProcessBetUseCase } from '../../../application/use-cases/process-bet.use-case';
import { WagerResponseDto } from '../../../application/dto/wager.dto';
import { HttpValidator } from '../validation/http-validator';

@Controller('wagering')
export class WageringController {
  constructor(private readonly processBetUseCase: ProcessBetUseCase) {}

  @Post('transactions')
  public async processTransaction(
    @Headers('idempotency-key') idempotencyKeyHeader: unknown,
    @Body() rawBody: unknown,
    @Res() res: Response
  ): Promise<Response> {
    const { idempotencyKey, dto } = HttpValidator.validateProcessBet(rawBody, idempotencyKeyHeader);

    const result: WagerResponseDto = await this.processBetUseCase.execute(idempotencyKey, dto);

    if (result.status === 'REJECTED') {
      return res.status(HttpStatus.UNPROCESSABLE_ENTITY).json(result);
    }

    return res.status(HttpStatus.OK).json(result);
  }
}
