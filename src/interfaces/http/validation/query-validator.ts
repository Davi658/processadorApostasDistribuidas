import { LedgerCursorCodec, InvalidLedgerCursorError } from '../../../application/pagination/ledger-cursor-codec';
import { BadRequestException } from '@nestjs/common';
import type { LedgerKeysetCursor } from '../../../application/dto/query-wallet-ledger.dto';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class QueryValidator {
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

  public static validateLimit(value: unknown, defaultLimit = 50, maxLimit = 100): number {
    if (value === undefined) {
      return defaultLimit;
    }

    if (typeof value === 'number') {
      if (!Number.isInteger(value) || value < 1 || value > maxLimit) {
        throw new BadRequestException(`limit must be an integer between 1 and ${maxLimit}`);
      }
      return value;
    }

    if (typeof value !== 'string') {
      throw new BadRequestException(`limit must be an integer between 1 and ${maxLimit}`);
    }

    const trimmed = value.trim();
    if (trimmed.length === 0 || !/^\d+$/.test(trimmed)) {
      throw new BadRequestException(`limit must be a positive integer between 1 and ${maxLimit}`);
    }

    const parsed = parseInt(trimmed, 10);
    if (parsed < 1 || parsed > maxLimit) {
      throw new BadRequestException(`limit must be between 1 and ${maxLimit}`);
    }

    return parsed;
  }

  public static validateAndDecodeCursor(value: unknown, walletId: string): LedgerKeysetCursor | undefined {
    try {
      return LedgerCursorCodec.decode(value, walletId);
    } catch (error) {
      if (error instanceof InvalidLedgerCursorError) throw new BadRequestException(error.message);
      throw error;
    }
  }
}
