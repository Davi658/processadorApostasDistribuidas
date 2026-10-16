import { describe, expect, it } from 'bun:test';
import { Money } from '../../src/domain/value-objects/money.vo';
import { CurrencyMismatchError, InvalidMoneyError, MoneyOverflowError } from '../../src/domain/errors/domain.error';

describe('Money Value Object', () => {
  describe('Basic Factory & Creation', () => {
    it('should create valid Money with two decimal places', () => {
      const money = Money.create('100.50', 'BRL');
      expect(money.getAmount()).toBe('100.50');
      expect(money.getCurrency()).toBe('BRL');
      expect(money.getCents()).toBe(10050n);
      expect(money.toString()).toBe('100.50 BRL');
      expect(money.toJSON()).toEqual({ amount: '100.50', currency: 'BRL' });
    });

    it('should create zero Money correctly', () => {
      const zero = Money.zero('BRL');
      expect(zero.getAmount()).toBe('0.00');
      expect(zero.getCents()).toBe(0n);
      expect(zero.isZero()).toBe(true);
      expect(zero.isPositive()).toBe(false);
      expect(zero.isNegative()).toBe(false);
    });
  });

  describe('Boundary Tests: "0.00", "0.01" and "9999999999999999.99"', () => {
    it('should correctly handle "0.00"', () => {
      const m = Money.create('0.00', 'BRL');
      expect(m.getAmount()).toBe('0.00');
      expect(m.getCents()).toBe(0n);
      expect(m.isZero()).toBe(true);
      expect(m.isPositive()).toBe(false);
      expect(m.isNegative()).toBe(false);
    });

    it('should correctly handle "0.01"', () => {
      const m = Money.create('0.01', 'BRL');
      expect(m.getAmount()).toBe('0.01');
      expect(m.getCents()).toBe(1n);
      expect(m.isZero()).toBe(false);
      expect(m.isPositive()).toBe(true);
      expect(m.isNegative()).toBe(false);
    });

    it('should correctly handle exact NUMERIC(18,2) maximum boundary "9999999999999999.99"', () => {
      const maxMoney = Money.create('9999999999999999.99', 'BRL');
      expect(maxMoney.getAmount()).toBe('9999999999999999.99');
      expect(maxMoney.getCents()).toBe(999999999999999999n);
      expect(maxMoney.isPositive()).toBe(true);
      expect(maxMoney.toJSON()).toEqual({ amount: '9999999999999999.99', currency: 'BRL' });
      expect(maxMoney.toString()).toBe('9999999999999999.99 BRL');
    });

    it('should reject the first value above the limit ("10000000000000000.00") without SQL error', () => {
      expect(() => Money.create('10000000000000000.00', 'BRL')).toThrow(MoneyOverflowError);
      expect(() => Money.rehydrate('10000000000000000.00', 'BRL')).toThrow(MoneyOverflowError);
      expect(() => Money.fromCents(1000000000000000000n, 'BRL')).toThrow(MoneyOverflowError);
    });

    it('should reject addition when sum exceeds the limit ("9999999999999999.99" + "0.01")', () => {
      const maxMoney = Money.create('9999999999999999.99', 'BRL');
      const oneCent = Money.create('0.01', 'BRL');

      expect(() => maxMoney.add(oneCent)).toThrow(MoneyOverflowError);
      // Operands must remain intact
      expect(maxMoney.getAmount()).toBe('9999999999999999.99');
      expect(oneCent.getAmount()).toBe('0.01');
    });

    it('should reject addition when adding two large numbers exceeds the limit', () => {
      const half1 = Money.create('5000000000000000.00', 'BRL');
      const half2 = Money.create('5000000000000000.00', 'BRL');
      expect(() => half1.add(half2)).toThrow(MoneyOverflowError);
    });
  });

  describe('Precision Above Number.MAX_SAFE_INTEGER', () => {
    it('should perform exact operations well above Number.MAX_SAFE_INTEGER without precision loss', () => {
      // Number.MAX_SAFE_INTEGER = 9007199254740991 (approx 9e15)
      // 9999999999999999.99 is 9.99e17 cents, > 100x Number.MAX_SAFE_INTEGER
      const big = Money.create('9007199254740991.00', 'BRL');
      const oneCent = Money.create('0.01', 'BRL');
      const sum = big.add(oneCent);

      expect(sum.getAmount()).toBe('9007199254740991.01');
      expect(sum.getCents()).toBe(900719925474099101n);

      // Verify that standard JS number WOULD lose precision here
      const standardJsNumber = Number('9007199254740991.01');
      // Number.isSafeInteger check
      expect(sum.getCents() > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);

      // Verify addition near the maximum limit
      const nearMax = Money.create('9999999999999998.99', 'BRL');
      const oneUnit = Money.create('1.00', 'BRL');
      const resultMax = nearMax.add(oneUnit);
      expect(resultMax.getAmount()).toBe('9999999999999999.99');

      // Verify subtraction near the maximum limit
      const minusOneCent = resultMax.subtract(oneCent);
      expect(minusOneCent.getAmount()).toBe('9999999999999999.98');
    });
  });

  describe('Internal Negative Values & Serialization (Reconciliation deltas)', () => {
    it('should produce internal negative money on subtraction and serialize correctly', () => {
      const smaller = Money.create('100.00', 'BRL');
      const larger = Money.create('150.00', 'BRL');
      const negativeDiff = smaller.subtract(larger);

      expect(negativeDiff.isNegative()).toBe(true);
      expect(negativeDiff.isPositive()).toBe(false);
      expect(negativeDiff.isZero()).toBe(false);
      expect(negativeDiff.getAmount()).toBe('-50.00');
      expect(negativeDiff.getCents()).toBe(-5000n);
      expect(negativeDiff.toString()).toBe('-50.00 BRL');
      expect(negativeDiff.toJSON()).toEqual({ amount: '-50.00', currency: 'BRL' });
    });

    it('should rehydrate signed negative values for reconciliation/ledger differences', () => {
      const rehydrated = Money.rehydrate('-12345678901234.56', 'BRL');
      expect(rehydrated.getAmount()).toBe('-12345678901234.56');
      expect(rehydrated.getCents()).toBe(-1234567890123456n);
      expect(rehydrated.isNegative()).toBe(true);
    });

    it('should allow negative boundary down to MIN_SIGNED_LIMIT ("-9999999999999999.99")', () => {
      const minNegative = Money.rehydrate('-9999999999999999.99', 'BRL');
      expect(minNegative.getAmount()).toBe('-9999999999999999.99');
      expect(minNegative.getCents()).toBe(-999999999999999999n);

      // Underflowing below minimum signed limit throws MoneyOverflowError
      const oneCent = Money.create('0.01', 'BRL');
      expect(() => minNegative.subtract(oneCent)).toThrow(MoneyOverflowError);
    });
  });

  describe('Immutability of Operands', () => {
    it('should remain frozen and not mutate operands after operations or failed operations', () => {
      const m1 = Money.create('100.00', 'BRL');
      const m2 = Money.create('50.00', 'BRL');

      expect(Object.isFrozen(m1)).toBe(true);
      expect(Object.isFrozen(m2)).toBe(true);

      const sum = m1.add(m2);
      expect(m1.getAmount()).toBe('100.00');
      expect(m2.getAmount()).toBe('50.00');
      expect(sum.getAmount()).toBe('150.00');

      const diff = m1.subtract(m2);
      expect(m1.getAmount()).toBe('100.00');
      expect(m2.getAmount()).toBe('50.00');
      expect(diff.getAmount()).toBe('50.00');

      // Attempting to mutate throws or fails silently in JS, but object remains frozen
      expect(() => {
        // @ts-expect-error mutating readonly
        m1.cents = 0n;
      }).toThrow();
    });
  });

  describe('Currency Conflicts', () => {
    it('should throw CurrencyMismatchError on arithmetic between different currencies', () => {
      const brl = Money.create('100.00', 'BRL');
      const usd = Money.create('100.00', 'USD');

      expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl.greaterThan(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl.lessThan(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl.greaterThanOrEqual(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl.lessThanOrEqual(usd)).toThrow(CurrencyMismatchError);
    });

    it('should return false on equals between different currencies without throwing', () => {
      const brl = Money.create('100.00', 'BRL');
      const usd = Money.create('100.00', 'USD');
      expect(brl.equals(usd)).toBe(false);
    });
  });

  describe('Invalid Inputs & Incorrect Types', () => {
    it('should reject non-string inputs in Money.create', () => {
      // @ts-expect-error testing invalid type
      expect(() => Money.create(100.5, 'BRL')).toThrow(InvalidMoneyError);
      // @ts-expect-error testing invalid type
      expect(() => Money.create(0, 'BRL')).toThrow(InvalidMoneyError);
      // @ts-expect-error testing invalid type
      expect(() => Money.create(null, 'BRL')).toThrow(InvalidMoneyError);
      // @ts-expect-error testing invalid type
      expect(() => Money.create(undefined, 'BRL')).toThrow(InvalidMoneyError);
      // @ts-expect-error testing invalid type
      expect(() => Money.create(true, 'BRL')).toThrow(InvalidMoneyError);
      // @ts-expect-error testing invalid type
      expect(() => Money.create({}, 'BRL')).toThrow(InvalidMoneyError);
      // @ts-expect-error testing invalid type
      expect(() => Money.create([], 'BRL')).toThrow(InvalidMoneyError);
      // @ts-expect-error testing invalid type
      expect(() => Money.create(100n, 'BRL')).toThrow(InvalidMoneyError);
    });

    it('should reject non-string currency in Money.create', () => {
      // @ts-expect-error testing invalid type
      expect(() => Money.create('10.00', null)).toThrow(InvalidMoneyError);
      // @ts-expect-error testing invalid type
      expect(() => Money.create('10.00', 123)).toThrow(InvalidMoneyError);
    });

    it('should reject negative values in create factory', () => {
      expect(() => Money.create('-10.00', 'BRL')).toThrow(InvalidMoneyError);
      expect(() => Money.create('-0.01', 'BRL')).toThrow(InvalidMoneyError);
      expect(() => Money.create('-0.00', 'BRL')).toThrow(InvalidMoneyError);
    });

    it('should reject NaN, Infinity, scientific notation, and non-canonical strings', () => {
      expect(() => Money.create('NaN', 'BRL')).toThrow(InvalidMoneyError);
      expect(() => Money.create('Infinity', 'BRL')).toThrow(InvalidMoneyError);
      expect(() => Money.create('-Infinity', 'BRL')).toThrow(InvalidMoneyError);
      expect(() => Money.create('1e2', 'BRL')).toThrow(InvalidMoneyError);
      expect(() => Money.create('1.5e3', 'BRL')).toThrow(InvalidMoneyError);
      expect(() => Money.create('0x10', 'BRL')).toThrow(InvalidMoneyError);
      expect(() => Money.create('abc', 'BRL')).toThrow(InvalidMoneyError);
      expect(() => Money.create('100', 'BRL')).toThrow(InvalidMoneyError); // missing 2 decimals
      expect(() => Money.create('100.5', 'BRL')).toThrow(InvalidMoneyError); // only 1 decimal
      expect(() => Money.create('100.500', 'BRL')).toThrow(InvalidMoneyError); // 3 decimals (excess scale)
      expect(() => Money.create('100.555', 'BRL')).toThrow(InvalidMoneyError);
      expect(() => Money.create('00.00', 'BRL')).toThrow(InvalidMoneyError); // leading zero
      expect(() => Money.create('01.50', 'BRL')).toThrow(InvalidMoneyError); // leading zero
      expect(() => Money.create('+10.00', 'BRL')).toThrow(InvalidMoneyError); // plus sign
      expect(() => Money.create(' 10.00', 'BRL')).toThrow(InvalidMoneyError); // leading whitespace
      expect(() => Money.create('10.00 ', 'BRL')).toThrow(InvalidMoneyError); // trailing whitespace
      expect(() => Money.create('', 'BRL')).toThrow(InvalidMoneyError);
    });

    it('should reject invalid currency codes', () => {
      expect(() => Money.create('10.00', 'brl')).toThrow(InvalidMoneyError); // lowercase
      expect(() => Money.create('10.00', 'US')).toThrow(InvalidMoneyError); // 2 chars
      expect(() => Money.create('10.00', 'USDT')).toThrow(InvalidMoneyError); // 4 chars
      expect(() => Money.create('10.00', '123')).toThrow(InvalidMoneyError);
      expect(() => Money.create('10.00', ' BRL')).toThrow(InvalidMoneyError);
      expect(() => Money.create('10.00', 'BRL ')).toThrow(InvalidMoneyError);
    });

    it('should reject non-bigint input in fromCents factory', () => {
      expect(() => Money.fromCents(100 as unknown as bigint, 'BRL')).toThrow(InvalidMoneyError);
      expect(() => Money.fromCents('100' as unknown as bigint, 'BRL')).toThrow(InvalidMoneyError);
    });
  });
});

