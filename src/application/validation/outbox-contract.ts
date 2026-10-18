import type { ClaimedOutboxMessage } from '../ports/ports';
import {
  WalletBalanceChangedEvent, WagerTransactionProcessedEvent,
  WagerTransactionRejectedEvent, WagerTransactionPendingReferenceEvent,
} from '../../domain/events/events';
import { Money } from '../../domain/value-objects/money.vo';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const date = (v: unknown) => text(v) && Number.isFinite(Date.parse(v));
// Derive supported names/versions from domain contracts without rebuilding persisted events.
const contracts = [WalletBalanceChangedEvent, WagerTransactionProcessedEvent,
  WagerTransactionRejectedEvent, WagerTransactionPendingReferenceEvent].map(C =>
  new C({ eventId: 'contract', occurredAt: 'contract', aggregateId: 'contract', correlationId: 'contract', data: {} as never }));

export function validateOutboxContract(event: ClaimedOutboxMessage): { valid: boolean; reason?: string } {
  const invalid = (reason: string) => ({ valid: false, reason });
  if (!uuid.test(event.id)) return invalid('INVALID_EVENT_ID_UUID');
  if (!text(event.aggregateId)) return invalid('MISSING_AGGREGATE_ID');
  if (!contracts.some(c => c.eventType === event.eventType && c.version === event.version))
    return invalid('UNSUPPORTED_EVENT_CONTRACT');
  if (event.aggregateType !== 'Wallet' || !text(event.correlationId) ||
      (event.causationId != null && !text(event.causationId)) || !date(event.occurredAt))
    return invalid('INVALID_ENVELOPE_METADATA');
  const d = event.payload;
  if (!object(d)) return invalid('INVALID_PAYLOAD');
  if (d.walletId !== event.aggregateId || !text(d.playerId)) return invalid('INVALID_PAYLOAD_IDENTITY');
  const money = (v: unknown) => {
    if (!object(v) || Object.keys(v).sort().join(',') !== 'amount,currency') throw Error('INVALID_MONEY');
    Money.create(v.amount, v.currency);
    return v.currency;
  };
  try {
    if (event.eventType === 'WalletBalanceChanged') {
      if (!text(d.triggerTransactionId) || !Number.isInteger(d.version) || d.version < 1 ||
          !text(d.currency) || money(d.previousBalance) !== d.currency || money(d.currentBalance) !== d.currency)
        return invalid('INVALID_BALANCE_PAYLOAD');
    } else {
      if (!['transactionId','providerId','externalTransactionId','roundId','gameId'].every(k => text(d[k])))
        return invalid('INVALID_TRANSACTION_PAYLOAD');
      if (d.referenceExternalTransactionId != null && !text(d.referenceExternalTransactionId))
        return invalid('INVALID_REFERENCE');
      const currency = money(d.amount);
      if (event.eventType === 'WagerTransactionPendingReference') {
        if (!['REFUND','ROLLBACK','WIN'].includes(d.kind) || !text(d.referenceExternalTransactionId) ||
            !Number.isInteger(d.attempts) || d.attempts < 0 || !date(d.nextAttemptAt))
          return invalid('INVALID_PENDING_PAYLOAD');
      } else {
        const kinds = ['BET','WIN','LOSS','REFUND','ROLLBACK'];
        if (event.eventType === 'WagerTransactionProcessed') kinds.push('OPENING');
        if (!kinds.includes(d.kind) || money(d.balance) !== currency ||
            (event.eventType === 'WagerTransactionRejected' && !text(d.failureCode)))
          return invalid('INVALID_TRANSACTION_PAYLOAD');
      }
    }
  } catch { return invalid('INVALID_MONEY'); }
  return { valid: true };
}
