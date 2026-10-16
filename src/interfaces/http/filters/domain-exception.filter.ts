import { ExceptionFilter, Catch, ArgumentsHost, HttpStatus, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import {
  DomainError,
  DuplicateWalletError,
  IdempotencyConflictError,
  InsufficientBalanceError,
  InvalidMoneyError,
  InvalidWagerOperationError,
  WalletNotFoundError,
  CurrencyMismatchError,
} from '../../../domain/errors/domain.error';

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  public catch(exception: unknown, host: ArgumentsHost): Response {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    // 1. Preserve NestJS HttpExceptions (validation errors, route not found, body parse errors)
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();
      return response.status(status).json(typeof res === 'object' ? res : { statusCode: status, message: res });
    }

    // 2. Domain Conflicts (409)
    if (exception instanceof DuplicateWalletError) {
      return response.status(HttpStatus.CONFLICT).json({
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        code: exception.code,
        message: exception.message,
      });
    }

    if (exception instanceof IdempotencyConflictError) {
      return response.status(HttpStatus.CONFLICT).json({
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        code: exception.code,
        message: exception.message,
      });
    }

    // 3. Domain Not Found (404)
    if (exception instanceof WalletNotFoundError) {
      return response.status(HttpStatus.NOT_FOUND).json({
        statusCode: HttpStatus.NOT_FOUND,
        error: 'Not Found',
        code: exception.code,
        message: exception.message,
      });
    }

    // 4. Domain Business Rejections (422)
    if (exception instanceof InsufficientBalanceError) {
      return response.status(HttpStatus.UNPROCESSABLE_ENTITY).json({
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        error: 'Unprocessable Entity',
        code: exception.code,
        message: exception.message,
      });
    }

    if (exception instanceof CurrencyMismatchError) {
      return response.status(HttpStatus.UNPROCESSABLE_ENTITY).json({
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        error: 'Unprocessable Entity',
        code: exception.code,
        message: exception.message,
      });
    }

    // 5. Domain Bad Request (400)
    if (exception instanceof InvalidMoneyError || exception instanceof InvalidWagerOperationError || exception instanceof DomainError) {
      return response.status(HttpStatus.BAD_REQUEST).json({
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'Bad Request',
        code: exception.code,
        message: exception.message,
      });
    }

    // 6. Check for recognized transient database and connection errors (503)
    const extractErrorCode = (target: unknown): string => {
      if (!target || typeof target !== 'object') return '';
      const rec = target as Record<string, unknown>;
      if (typeof rec.code === 'string') return rec.code;
      if (rec.cause && typeof (rec.cause as any).code === 'string') return (rec.cause as any).code;
      if (rec.originalError && typeof (rec.originalError as any).code === 'string') return (rec.originalError as any).code;
      if (rec.driverException && typeof (rec.driverException as any).code === 'string') return (rec.driverException as any).code;
      if (rec.driverError && typeof (rec.driverError as any).code === 'string') return (rec.driverError as any).code;
      return '';
    };

    const errorCode = extractErrorCode(exception);
    const transientCodes = [
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ENOTFOUND',
      'ECONNRESET',
      '57P01', // admin shutdown
      '57P02', // crash shutdown
      '57P03', // cannot connect now
      '08006', // connection failure
      '08001', // unable to establish connection
      '08004', // connection rejected
      '53300', // too many connections
      '40001', // serialization failure
      '40P01', // deadlock detected
    ];

    if (transientCodes.includes(errorCode)) {
      return response.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        error: 'Service Unavailable',
        code: 'SERVICE_UNAVAILABLE',
        message: 'The service is temporarily unavailable. Please retry shortly.',
      });
    }

    // 7. Generic 500 for unexpected errors - NEVER expose internal PostgreSQL or runtime internals
    return response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'Internal Server Error',
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected internal error occurred.',
    });
  }
}
