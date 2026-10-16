import { describe, expect, it } from 'bun:test';
import { Money } from '../../src/domain/value-objects/money.vo';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/domain/errors/domain.error';

describe('Money Value Object', () => {
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
  });

  it('should reject non-string inputs', () => {
    // @ts-expect-error testing invalid type
    expect(() => Money.create(100.5, 'BRL')).toThrow(InvalidMoneyError);
    // @ts-expect-error testing invalid type
    expect(() => Money.create(null, 'BRL')).toThrow(InvalidMoneyError);
    // @ts-expect-error testing invalid type
    expect(() => Money.create(undefined, 'BRL')).toThrow(InvalidMoneyError);
  });

  it('should reject negative values in create factory', () => {
    expect(() => Money.create('-10.00', 'BRL')).toThrow(InvalidMoneyError);
    expect(() => Money.create('-0.01', 'BRL')).toThrow(InvalidMoneyError);
  });

  it('should reject NaN, Infinity, scientific notation and invalid strings', () => {
    expect(() => Money.create('NaN', 'BRL')).toThrow(InvalidMoneyError);
    expect(() => Money.create('Infinity', 'BRL')).toThrow(InvalidMoneyError);
    expect(() => Money.create('-Infinity', 'BRL')).toThrow(InvalidMoneyError);
    expect(() => Money.create('1e2', 'BRL')).toThrow(InvalidMoneyError);
    expect(() => Money.create('1.5e3', 'BRL')).toThrow(InvalidMoneyError);
    expect(() => Money.create('abc', 'BRL')).toThrow(InvalidMoneyError);
    expect(() => Money.create('100', 'BRL')).toThrow(InvalidMoneyError); // missing 2 decimals
    expect(() => Money.create('100.5', 'BRL')).toThrow(InvalidMoneyError); // only 1 decimal
    expect(() => Money.create('100.500', 'BRL')).toThrow(InvalidMoneyError); // 3 decimals
    expect(() => Money.create('100.555', 'BRL')).toThrow(InvalidMoneyError);
  });

  it('should reject invalid currency codes', () => {
    expect(() => Money.create('10.00', 'brl')).toThrow(InvalidMoneyError); // lowercase
    expect(() => Money.create('10.00', 'US')).toThrow(InvalidMoneyError); // 2 chars
    expect(() => Money.create('10.00', 'USDT')).toThrow(InvalidMoneyError); // 4 chars
    expect(() => Money.create('10.00', '123')).toThrow(InvalidMoneyError);
  });

  it('should allow signed values in rehydrate factory', () => {
    const positive = Money.rehydrate('50.25', 'BRL');
    expect(positive.getAmount()).toBe('50.25');
    expect(positive.getCents()).toBe(5025n);

    const negative = Money.rehydrate('-50.25', 'BRL');
    expect(negative.getAmount()).toBe('-50.25');
    expect(negative.getCents()).toBe(-5025n);
    expect(negative.isNegative()).toBe(true);
  });

  it('should perform exact addition without floating point inaccuracies', () => {
    const m1 = Money.create('0.10', 'BRL');
    const m2 = Money.create('0.20', 'BRL');
    const sum = m1.add(m2);

    expect(sum.getAmount()).toBe('0.30');
    expect(sum.getCents()).toBe(30n);
  });

  it('should perform exact subtraction without floating point inaccuracies', () => {
    const m1 = Money.create('100.00', 'BRL');
    const m2 = Money.create('80.00', 'BRL');
    const diff = m1.subtract(m2);

    expect(diff.getAmount()).toBe('20.00');
    expect(diff.getCents()).toBe(2000n);
  });

  it('should fail when operating between different currencies', () => {
    const brl = Money.create('100.00', 'BRL');
    const usd = Money.create('100.00', 'USD');

    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.greaterThan(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.lessThan(usd)).toThrow(CurrencyMismatchError);
  });

  it('should correctly compare amounts of the same currency', () => {
    const m50 = Money.create('50.00', 'BRL');
    const m100 = Money.create('100.00', 'BRL');
    const m50Duplicate = Money.create('50.00', 'BRL');

    expect(m100.greaterThan(m50)).toBe(true);
    expect(m50.lessThan(m100)).toBe(true);
    expect(m50.equals(m50Duplicate)).toBe(true);
    expect(m50.equals(m100)).toBe(false);
  });

  it('should be immutable (Object.freeze)', () => {
    const money = Money.create('10.00', 'BRL');
    expect(Object.isFrozen(money)).toBe(true);
  });
});
