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

  public static encodeCursor(cursor: LedgerKeysetCursor): string {
    const payload = JSON.stringify({
      walletId: cursor.walletId.toLowerCase(),
      createdAt: cursor.createdAt,
      id: cursor.id.toLowerCase(),
    });
    return Buffer.from(payload, 'utf-8').toString('base64url');
  }

  public static validateAndDecodeCursor(
    cursorValue: unknown,
    expectedWalletId: string
  ): LedgerKeysetCursor | undefined {
    if (cursorValue === undefined) {
      return undefined;
    }

    if (typeof cursorValue !== 'string') {
      throw new BadRequestException('cursor must be an opaque string');
    }

    const trimmed = cursorValue.trim();
    if (trimmed.length === 0) {
      throw new BadRequestException('cursor cannot be empty or contain only whitespace');
    }

    let decodedString: string;
    try {
      // Validate that it looks like base64 / base64url characters only
      if (!/^[A-Za-z0-9_-]+={0,2}$/.test(trimmed)) {
        throw new Error('Not base64');
      }
      decodedString = Buffer.from(trimmed, 'base64url').toString('utf-8');
    } catch {
      throw new BadRequestException('Invalid pagination cursor: malformed encoding');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(decodedString);
    } catch {
      throw new BadRequestException('Invalid pagination cursor: payload must be valid JSON');
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new BadRequestException('Invalid pagination cursor: payload must be an object');
    }

    const obj = parsed as Record<string, unknown>;

    if (typeof obj.walletId !== 'string' || !UUID_REGEX.test(obj.walletId.trim())) {
      throw new BadRequestException('Invalid pagination cursor: walletId must be a valid UUID');
    }

    if (typeof obj.id !== 'string' || !UUID_REGEX.test(obj.id.trim())) {
      throw new BadRequestException('Invalid pagination cursor: id must be a valid UUID');
    }

    if (typeof obj.createdAt !== 'string' || isNaN(Date.parse(obj.createdAt))) {
      throw new BadRequestException('Invalid pagination cursor: createdAt must be a valid ISO date string');
    }

    const normalizedWalletId = obj.walletId.trim().toLowerCase();
    const normalizedExpectedWalletId = expectedWalletId.trim().toLowerCase();

    // Strict wallet binding check: prevent wallet mixing across cursor tokens
    if (normalizedWalletId !== normalizedExpectedWalletId) {
      throw new BadRequestException('Cursor does not belong to the requested wallet');
    }

    return {
      walletId: normalizedWalletId,
      createdAt: obj.createdAt,
      id: obj.id.trim().toLowerCase(),
    };
  }
}
