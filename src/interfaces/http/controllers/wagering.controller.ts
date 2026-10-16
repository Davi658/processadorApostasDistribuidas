import {
  Body,
  Controller,
  Headers,
  HttpStatus,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ProcessWagerUseCase } from '../../../application/use-cases/process-wager.use-case';
import { WagerResponseDto } from '../../../application/dto/wager.dto';
import { HttpValidator } from '../validation/http-validator';

@Controller('wagering')
export class WageringController {
  constructor(private readonly processWagerUseCase: ProcessWagerUseCase) {}

  @Post('transactions')
  public async processTransaction(
    @Headers('idempotency-key') idempotencyKeyHeader: unknown,
    @Headers('x-correlation-id') correlationIdHeader: unknown,
    @Body() rawBody: unknown,
    @Res() res: Response
  ): Promise<Response> {
    const { idempotencyKey, dto } = HttpValidator.validateProcessWager(
      rawBody,
      idempotencyKeyHeader,
      correlationIdHeader
    );

    const result: WagerResponseDto = await this.processWagerUseCase.execute(idempotencyKey, dto);

    if (result.status === 'REJECTED') {
      return res.status(HttpStatus.UNPROCESSABLE_ENTITY).json(result);
    }

    if (result.status === 'PENDING_REFERENCE') {
      return res.status(HttpStatus.ACCEPTED).json(result);
    }

    return res.status(HttpStatus.OK).json(result);
  }
}
