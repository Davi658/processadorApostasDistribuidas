import { BadRequestException, Controller, Get, Inject, NotFoundException, Param, Query } from '@nestjs/common';
import { FinancialQueriesPort, type LedgerPosition } from '../../../application/ports/financial-queries.port';
import { HttpValidator } from '../validation/http-validator';

interface Cursor extends LedgerPosition { v: 1; walletId: string }
const encode = (value: Cursor) => Buffer.from(JSON.stringify(value)).toString('base64url');

function decode(value: unknown, walletId: string): LedgerPosition | undefined {
  if (value === undefined) return undefined;
  try {
    if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const parsed: Cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!parsed || parsed.v !== 1 || parsed.walletId !== walletId ||
        typeof parsed.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(parsed.createdAt) ||
        parsed.createdAt.startsWith('0000-') || !Number.isFinite(Date.parse(parsed.createdAt)) ||
        HttpValidator.validateUuid(parsed.id, 'cursor.id') !== parsed.id ||
        encode({ v: 1, walletId, createdAt: parsed.createdAt, id: parsed.id }) !== value) throw new Error();
    // Reject calendar overflow (e.g. February 30), retaining all six fractional digits.
    if (new Date(parsed.createdAt).toISOString() !== parsed.createdAt.slice(0, 23) + 'Z') throw new Error();
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new BadRequestException('Invalid ledger cursor for this wallet');
  }
}

@Controller()
export class FinancialQueriesController {
  constructor(@Inject(FinancialQueriesPort) private readonly queries: FinancialQueriesPort) {}

  @Get('wagering/transactions')
  async byExternal(@Query('providerId') providerId: unknown, @Query('externalTransactionId') externalId: unknown) {
    const transaction = await this.queries.transactionByExternal(
      HttpValidator.validateString(providerId, 'providerId'),
      HttpValidator.validateString(externalId, 'externalTransactionId'));
    if (!transaction) throw new NotFoundException('Transaction not found');
    return transaction;
  }

  @Get('wagering/transactions/:transactionId')
  async byId(@Param('transactionId') id: string) {
    const transaction = await this.queries.transactionById(HttpValidator.validateUuid(id, 'transactionId'));
    if (!transaction) throw new NotFoundException('Transaction not found');
    return transaction;
  }

  @Get('wallets/:walletId/ledger')
  async ledger(@Param('walletId') rawWalletId: string, @Query('limit') rawLimit: unknown, @Query('cursor') rawCursor: unknown) {
    const walletId = HttpValidator.validateUuid(rawWalletId, 'walletId');
    if (rawLimit !== undefined && (typeof rawLimit !== 'string' || !/^(?:[1-9]\d?|100)$/.test(rawLimit))) {
      throw new BadRequestException('limit must be an integer between 1 and 100');
    }
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    const after = decode(rawCursor, walletId);
    if (!await this.queries.walletExists(walletId)) throw new NotFoundException('Wallet not found');
    const rows = await this.queries.ledger(walletId, limit + 1, after);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return { items, nextCursor: rows.length > limit && last
      ? encode({ v: 1, walletId, createdAt: last.createdAt, id: last.id }) : null };
  }
}
