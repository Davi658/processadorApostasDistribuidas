import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ProcessBetUseCase } from '../../../application/use-cases/process-bet.use-case';
import { ProcessBetDto, WagerResponseDto } from '../../../application/dto/wager.dto';

@Controller('wagering')
export class WageringController {
  constructor(private readonly processBetUseCase: ProcessBetUseCase) {}

  @Post('transactions')
  public async processTransaction(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: ProcessBetDto,
    @Res() res: Response
  ): Promise<Response> {
    if (!idempotencyKey || idempotencyKey.trim() === '') {
      return res.status(HttpStatus.BAD_REQUEST).json({
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'Bad Request',
        message: 'Idempotency-Key header is mandatory and cannot be empty',
      });
    }

    const result: WagerResponseDto = await this.processBetUseCase.execute(idempotencyKey.trim(), body);

    if (result.status === 'REJECTED') {
      // Business rejection mapped cleanly to 422 Unprocessable Entity
      return res.status(HttpStatus.UNPROCESSABLE_ENTITY).json(result);
    }

    return res.status(HttpStatus.OK).json(result);
  }
}
