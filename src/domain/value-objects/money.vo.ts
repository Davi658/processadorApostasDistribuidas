import { CurrencyMismatchError, InvalidMoneyError, MoneyOverflowError } from '../errors/domain.error';

const DECIMAL_STRING_REGEX = /^(?:0|[1-9]\d*)\.\d{2}$/;
const SIGNED_DECIMAL_STRING_REGEX = /^-?(?:0|[1-9]\d*)\.\d{2}$/;
const CURRENCY_REGEX = /^[A-Z]{3}$/;

export class Money {
  public static readonly MAX_INTEGER_DIGITS = 16;
  public static readonly SCALE = 2;
  public static readonly MAX_LIMIT = '9999999999999999.99';
  public static readonly MIN_SIGNED_LIMIT = '-9999999999999999.99';
  public static readonly MAX_CENTS = 999_999_999_999_999_999n; // 16 nines + 2 decimal nines
  public static readonly MIN_CENTS = -999_999_999_999_999_999n;

  private readonly cents: bigint;
  private readonly currency: string;

  private constructor(cents: bigint, currency: string) {
    if (typeof cents !== 'bigint') {
      throw new InvalidMoneyError('Cents must be a bigint');
    }
    if (cents > Money.MAX_CENTS || cents < Money.MIN_CENTS) {
      throw new MoneyOverflowError(
        `Amount exceeds maximum allowed capacity for NUMERIC(18,2) (limit is ${Money.MAX_LIMIT})`
      );
    }
    Money.validateCurrency(currency);
    this.cents = cents;
    this.currency = currency;
    Object.freeze(this);
  }

  /**
   * Factory for creating non-negative Money instances from external input contracts.
   * Rejects negatives, NaN, Infinity, scientific notation, whitespace and invalid scales.
   */
  public static create(amountStr: string, currency: string): Money {
    if (typeof amountStr !== 'string' || typeof currency !== 'string') {
      throw new InvalidMoneyError('Amount and currency must be strings');
    }

    if (amountStr.trim() !== amountStr) {
      throw new InvalidMoneyError('Non-canonical format: amount string cannot have leading or trailing whitespace');
    }

    if (currency.trim() !== currency) {
      throw new InvalidMoneyError('Non-canonical format: currency string cannot have leading or trailing whitespace');
    }

    Money.validateCurrency(currency);

    if (amountStr.startsWith('-')) {
      throw new InvalidMoneyError('Money input contracts do not accept negative values');
    }

    if (!DECIMAL_STRING_REGEX.test(amountStr)) {
      throw new InvalidMoneyError(
        `Invalid money format: "${amountStr}". Must be a non-negative decimal string with exactly two decimal places, e.g. "100.00"`
      );
    }

    const [intPart, decPart] = amountStr.split('.');
    if (intPart.length > Money.MAX_INTEGER_DIGITS) {
      throw new MoneyOverflowError(
        `Amount exceeds maximum allowed magnitude (max ${Money.MAX_INTEGER_DIGITS} integer digits, limit is ${Money.MAX_LIMIT})`
      );
    }

    const cents = BigInt(intPart) * 100n + BigInt(decPart);
    return new Money(cents, currency);
  }

  /**
   * Factory for internal and persistent state rehydration.
   * Accepts signed decimal strings (e.g. for differences and reconciliation deltas).
   */
  public static rehydrate(amountStr: string, currency: string): Money {
    if (typeof amountStr !== 'string' || typeof currency !== 'string') {
      throw new InvalidMoneyError('Amount and currency must be strings');
    }

    if (amountStr.trim() !== amountStr) {
      throw new InvalidMoneyError('Non-canonical format: amount string cannot have leading or trailing whitespace');
    }

    if (currency.trim() !== currency) {
      throw new InvalidMoneyError('Non-canonical format: currency string cannot have leading or trailing whitespace');
    }

    Money.validateCurrency(currency);

    if (amountStr === '-0.00' || amountStr === '-0' || amountStr === '-0.0') {
      throw new InvalidMoneyError('Negative zero is not a valid canonical decimal');
    }

    if (!SIGNED_DECIMAL_STRING_REGEX.test(amountStr)) {
      throw new InvalidMoneyError(
        `Invalid money format for rehydrate: "${amountStr}". Must have exactly two decimal places`
      );
    }

    const isNegative = amountStr.startsWith('-');
    const unsignedStr = isNegative ? amountStr.slice(1) : amountStr;
    const [intPart, decPart] = unsignedStr.split('.');

    if (intPart.length > Money.MAX_INTEGER_DIGITS) {
      throw new MoneyOverflowError(
        `Amount exceeds maximum allowed magnitude (max ${Money.MAX_INTEGER_DIGITS} integer digits, limit is ${Money.MAX_LIMIT})`
      );
    }

    let cents = BigInt(intPart) * 100n + BigInt(decPart);
    if (isNegative) {
      cents = -cents;
    }

    return new Money(cents, currency);
  }

  /**
   * Factory for creating Money directly from bigint cents.
   */
  public static fromCents(cents: bigint, currency: string): Money {
    if (typeof cents !== 'bigint') {
      throw new InvalidMoneyError('Cents must be a bigint');
    }
    Money.validateCurrency(currency);
    return new Money(cents, currency);
  }

  /**
   * Factory for zero Money in the specified currency.
   */
  public static zero(currency = 'BRL'): Money {
    return Money.create('0.00', currency);
  }

  public static validateCurrency(currency: string): void {
    if (!CURRENCY_REGEX.test(currency)) {
      throw new InvalidMoneyError(`Invalid currency code: "${currency}". Must be 3 uppercase letters (ISO-4217)`);
    }
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(
        `Cannot operate between different currencies: "${this.currency}" and "${other.currency}"`
      );
    }
  }

  public add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  public subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  public equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  public greaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents > other.cents;
  }

  public greaterThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents >= other.cents;
  }

  public lessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  public lessThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents <= other.cents;
  }

  public isZero(): boolean {
    return this.cents === 0n;
  }

  public isPositive(): boolean {
    return this.cents > 0n;
  }

  public isNegative(): boolean {
    return this.cents < 0n;
  }

  public getCents(): bigint {
    return this.cents;
  }

  public getCurrency(): string {
    return this.currency;
  }

  public getAmount(): string {
    const isNegative = this.cents < 0n;
    const abs = isNegative ? -this.cents : this.cents;
    const intPart = (abs / 100n).toString();
    const decPart = (abs % 100n).toString().padStart(2, '0');
    return `${isNegative ? '-' : ''}${intPart}.${decPart}`;
  }

  public toString(): string {
    return `${this.getAmount()} ${this.currency}`;
  }

  public toJSON(): { amount: string; currency: string } {
    return {
      amount: this.getAmount(),
      currency: this.currency,
    };
  }
}
