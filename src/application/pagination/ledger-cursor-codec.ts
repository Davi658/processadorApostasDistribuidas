import type { LedgerKeysetCursor } from '../dto/query-wallet-ledger.dto';

export class InvalidLedgerCursorError extends Error {}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Canonical PostgreSQL UTC timestamp, with all six microsecond digits intact.
// Validate the Gregorian calendar directly: Date would normalize impossible days
// and truncate microseconds to milliseconds.
function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/.exec(value);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
    && hour <= 23 && minute <= 59 && second <= 59;
}

export class LedgerCursorCodec {
  private static validate(value: unknown, walletId: string): LedgerKeysetCursor {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new InvalidLedgerCursorError('Invalid pagination cursor: payload must be an object');
    }
    const obj = value as Record<string, unknown>;
    if (Object.keys(obj).sort().join(',') !== 'createdAt,id,walletId'
      || typeof obj.walletId !== 'string' || !uuid.test(obj.walletId)
      || typeof obj.id !== 'string' || !uuid.test(obj.id) || !validTimestamp(obj.createdAt)) {
      throw new InvalidLedgerCursorError('Invalid pagination cursor: expected UUIDs and UTC timestamp YYYY-MM-DDTHH:mm:ss.ffffffZ');
    }
    if (obj.walletId.toLowerCase() !== walletId.toLowerCase()) {
      throw new InvalidLedgerCursorError('Cursor does not belong to the requested wallet');
    }
    return { walletId: obj.walletId.toLowerCase(), id: obj.id.toLowerCase(), createdAt: obj.createdAt };
  }

  public static encode(cursor: LedgerKeysetCursor): string {
    return Buffer.from(JSON.stringify(this.validate(cursor, cursor.walletId)), 'utf8').toString('base64url');
  }

  public static decode(value: unknown, walletId: string): LedgerKeysetCursor | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new InvalidLedgerCursorError('Invalid pagination cursor: malformed Base64URL encoding');
    }
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new InvalidLedgerCursorError('Invalid pagination cursor: noncanonical encoding');
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new InvalidLedgerCursorError('Invalid pagination cursor: payload must be valid JSON'); }
    return this.validate(parsed, walletId);
  }
}
