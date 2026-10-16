import { BadRequestException } from '@nestjs/common';
import { CreateWalletDto } from '../../../application/dto/wallet.dto';
import { ProcessWagerDto, WagerOperationKind } from '../../../application/dto/wager.dto';
import { MoneyObjectDto } from '../../../application/dto/common.dto';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL_AMOUNT_REGEX = /^(?:0|[1-9]\d*)\.\d{2}$/;
const SIGNED_DECIMAL_AMOUNT_REGEX = /^-?(?:0|[1-9]\d*)\.\d{2}$/;

/**
 * Normalization & Validation Policy:
 * 1. All fields are strictly type-checked prior to calling any string methods (no unhandled TypeErrors).
 * 2. Primitives like number, boolean, null, or empty string are never silently coerced to zero money.
 * 3. Identifiers are trimmed and validated for non-emptiness and max column lengths.
 * 4. The canonical SHA-256 payload hash is computed directly on the normalized values.
 * 5. Unexpected properties on JSON payloads are strictly rejected with 400 Bad Request.
 */
export class HttpValidator {
  public static validateUuid(value: unknown, fieldName: string): string {
    if (typeof value !== 'string') {
      throw new BadRequestException(`${fieldName} must be a valid UUID string`);
    }
    const trimmed = value.trim();
    if (!UUID_REGEX.test(trimmed)) {
      throw new BadRequestException(`${fieldName} must be a valid UUID in canonical hyphenated format`);
    }
    return trimmed.toLowerCase();
  }

  public static validateString(value: unknown, fieldName: string, minLength = 1, maxLength = 128): string {
    if (typeof value !== 'string') {
      throw new BadRequestException(`${fieldName} must be a string`);
    }
    const trimmed = value.trim();
    if (trimmed.length < minLength) {
      throw new BadRequestException(`${fieldName} cannot be empty or contain only whitespace`);
    }
    if (trimmed.length > maxLength) {
      throw new BadRequestException(`${fieldName} exceeds maximum length of ${maxLength} characters`);
    }
    return trimmed;
  }

  public static validateMoneyObject(
    value: unknown,
    fieldName: string,
    options: { allowZero?: boolean; allowNegative?: boolean } = { allowZero: true, allowNegative: false }
  ): MoneyObjectDto {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new BadRequestException(`${fieldName} must be an object with "amount" and "currency"`);
    }

    const obj = value as Record<string, unknown>;
    const allowedKeys = ['amount', 'currency'];
    for (const key of Object.keys(obj)) {
      if (!allowedKeys.includes(key)) {
        throw new BadRequestException(`Unexpected property "${key}" in ${fieldName}`);
      }
    }

    if (typeof obj.amount !== 'string') {
      throw new BadRequestException(
        `${fieldName}.amount must be a decimal string with exactly two decimal places (e.g. "100.00"). Numbers, booleans, or null are strictly prohibited.`
      );
    }

    const regex = options.allowNegative ? SIGNED_DECIMAL_AMOUNT_REGEX : DECIMAL_AMOUNT_REGEX;
    if (!regex.test(obj.amount)) {
      throw new BadRequestException(
        `${fieldName}.amount "${obj.amount}" is invalid. Must be a decimal string with exactly two decimal places (e.g. "25.00").`
      );
    }

    if (!options.allowZero && obj.amount === '0.00') {
      throw new BadRequestException(`${fieldName}.amount must be strictly greater than "0.00"`);
    }

    if (typeof obj.currency !== 'string') {
      throw new BadRequestException(`${fieldName}.currency must be a string`);
    }

    const trimmedCurrency = obj.currency.trim().toUpperCase();
    if (trimmedCurrency !== 'BRL') {
      throw new BadRequestException(
        `Unsupported currency: "${obj.currency}". Only "BRL" is currently supported.`
      );
    }

    return {
      amount: obj.amount,
      currency: 'BRL',
    };
  }

  public static validateCreateWalletBody(body: unknown): CreateWalletDto {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new BadRequestException('Request body must be a JSON object');
    }

    const obj = body as Record<string, unknown>;
    const allowedKeys = ['playerId', 'initialBalance'];
    for (const key of Object.keys(obj)) {
      if (!allowedKeys.includes(key)) {
        throw new BadRequestException(`Unexpected property: "${key}"`);
      }
    }

    const playerId = HttpValidator.validateUuid(obj.playerId, 'playerId');

    let initialBalance: MoneyObjectDto | undefined = undefined;
    if ('initialBalance' in obj) {
      if (obj.initialBalance === null || obj.initialBalance === false || obj.initialBalance === '' || obj.initialBalance === 0) {
        throw new BadRequestException(
          'initialBalance cannot be null, empty, false, or 0. Zero balance must be explicitly specified as { "amount": "0.00", "currency": "BRL" }'
        );
      }
      initialBalance = HttpValidator.validateMoneyObject(obj.initialBalance, 'initialBalance', { allowZero: true, allowNegative: false });
    }

    return {
      playerId,
      initialBalance,
    };
  }

  public static validateProcessWager(
    body: unknown,
    idempotencyKeyHeader: unknown,
    correlationIdHeader?: unknown
  ): { idempotencyKey: string; dto: ProcessWagerDto } {
    if (typeof idempotencyKeyHeader !== 'string') {
      throw new BadRequestException('Idempotency-Key header is mandatory and must be a string');
    }

    const idempotencyKey = idempotencyKeyHeader.trim();
    if (idempotencyKey.length === 0) {
      throw new BadRequestException('Idempotency-Key header cannot be empty');
    }
    if (idempotencyKey.length > 255) {
      throw new BadRequestException('Idempotency-Key header exceeds maximum length of 255 characters');
    }

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new BadRequestException('Request body must be a JSON object');
    }

    const obj = body as Record<string, unknown>;
    const allowedKeys = [
      'providerId',
      'externalTransactionId',
      'playerId',
      'walletId',
      'roundId',
      'gameId',
      'kind',
      'money',
      'referenceExternalTransactionId',
    ];

    for (const key of Object.keys(obj)) {
      if (!allowedKeys.includes(key)) {
        throw new BadRequestException(`Unexpected property: "${key}"`);
      }
    }

    const requiredKeys = [
      'providerId',
      'externalTransactionId',
      'playerId',
      'walletId',
      'roundId',
      'gameId',
      'kind',
      'money',
    ];

    for (const key of requiredKeys) {
      if (!(key in obj)) {
        throw new BadRequestException(`Missing required field: "${key}"`);
      }
    }

    const providerId = HttpValidator.validateString(obj.providerId, 'providerId', 1, 128);
    const externalTransactionId = HttpValidator.validateString(obj.externalTransactionId, 'externalTransactionId', 1, 128);
    const playerId = HttpValidator.validateUuid(obj.playerId, 'playerId');
    const walletId = HttpValidator.validateUuid(obj.walletId, 'walletId');
    const roundId = HttpValidator.validateString(obj.roundId, 'roundId', 1, 128);
    const gameId = HttpValidator.validateString(obj.gameId, 'gameId', 1, 128);

    if (typeof obj.kind !== 'string') {
      throw new BadRequestException('kind must be a string');
    }
    const kind = obj.kind.trim().toUpperCase() as WagerOperationKind;
    const allowedKinds: WagerOperationKind[] = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'];
    if (!allowedKinds.includes(kind)) {
      throw new BadRequestException(
        `Unsupported kind: "${obj.kind}". Allowed kinds are: ${allowedKinds.join(', ')}`
      );
    }

    let referenceExternalTransactionId: string | undefined = undefined;
    if (kind === 'REFUND' || kind === 'ROLLBACK') {
      if (!('referenceExternalTransactionId' in obj) || obj.referenceExternalTransactionId === null || obj.referenceExternalTransactionId === '') {
        throw new BadRequestException(
          `referenceExternalTransactionId is required for kind="${kind}"`
        );
      }
      referenceExternalTransactionId = HttpValidator.validateString(
        obj.referenceExternalTransactionId,
        'referenceExternalTransactionId',
        1,
        128
      );
    }

    const allowZeroAmount = kind === 'LOSS';
    const money = HttpValidator.validateMoneyObject(obj.money, 'money', {
      allowZero: allowZeroAmount,
      allowNegative: false,
    });

    const correlationId = typeof correlationIdHeader === 'string' && correlationIdHeader.trim().length > 0
      ? correlationIdHeader.trim()
      : undefined;

    return {
      idempotencyKey,
      dto: {
        providerId,
        externalTransactionId,
        playerId,
        walletId,
        roundId,
        gameId,
        kind,
        money,
        referenceExternalTransactionId,
        correlationId,
      },
    };
  }

  public static validateProcessBet(
    body: unknown,
    idempotencyKeyHeader: unknown,
    correlationIdHeader?: unknown
  ): { idempotencyKey: string; dto: ProcessWagerDto } {
    return HttpValidator.validateProcessWager(body, idempotencyKeyHeader, correlationIdHeader);
  }
}
