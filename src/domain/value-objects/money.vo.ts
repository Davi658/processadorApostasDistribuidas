import { CurrencyMismatchError, InvalidMoneyError } from '../errors/domain.error';

const DECIMAL_STRING_REGEX = /^\d+\.\d{2}$/;
const SIGNED_DECIMAL_STRING_REGEX = /^-?\d+\.\d{2}$/;
const CURRENCY_REGEX = /^[A-Z]{3}$/;
const MAX_INTEGER_DIGITS = 16; // Conforms to NUMERIC(18,2) max 18 digits (16 integer + 2 decimal)

export class Money {
  private readonly cents: bigint;
  private readonly currency: string;

  private constructor(cents: bigint, currency: string) {
    this.cents = cents;
    this.currency = currency;
    Object.freeze(this);
  }

  /**
   * Factory for creating non-negative Money instances from external input contracts.
   * Rejects negatives, NaN, Infinity, scientific notation, and invalid scales.
   */
  public static create(amountStr: string, currency: string): Money {
    if (typeof amountStr !== 'string' || typeof currency !== 'string') {
      throw new InvalidMoneyError('Amount and currency must be strings');
    }

    const trimmedAmount = amountStr.trim();
    const trimmedCurrency = currency.trim();

    Money.validateCurrency(trimmedCurrency);

    if (trimmedAmount.startsWith('-')) {
      throw new InvalidMoneyError('Money input contracts do not accept negative values');
    }

    if (!DECIMAL_STRING_REGEX.test(trimmedAmount)) {
      throw new InvalidMoneyError(
        `Invalid money format: "${amountStr}". Must be a non-negative decimal string with exactly two decimal places, e.g. "100.00"`
      );
    }

    const [intPart, decPart] = trimmedAmount.split('.');
    if (intPart.length > MAX_INTEGER_DIGITS) {
      throw new InvalidMoneyError(
        `Amount exceeds maximum allowed magnitude (max ${MAX_INTEGER_DIGITS} integer digits)`
      );
    }

    const cents = BigInt(intPart) * 100n + BigInt(decPart);
    return new Money(cents, trimmedCurrency);
  }

  /**
   * Factory for internal and persistent state rehydration.
   * Accepts signed decimal strings (e.g. for differences and ledger balance deltas).
   */
  public static rehydrate(amountStr: string, currency: string): Money {
    if (typeof amountStr !== 'string' || typeof currency !== 'string') {
      throw new InvalidMoneyError('Amount and currency must be strings');
    }

    const trimmedAmount = amountStr.trim();
    const trimmedCurrency = currency.trim();

    Money.validateCurrency(trimmedCurrency);

    if (!SIGNED_DECIMAL_STRING_REGEX.test(trimmedAmount)) {
      throw new InvalidMoneyError(
        `Invalid money format for rehydrate: "${amountStr}". Must have exactly two decimal places`
      );
    }

    const isNegative = trimmedAmount.startsWith('-');
    const unsignedStr = isNegative ? trimmedAmount.slice(1) : trimmedAmount;
    const [intPart, decPart] = unsignedStr.split('.');

    if (intPart.length > MAX_INTEGER_DIGITS) {
      throw new InvalidMoneyError(
        `Amount exceeds maximum allowed magnitude (max ${MAX_INTEGER_DIGITS} integer digits)`
      );
    }

    let cents = BigInt(intPart) * 100n + BigInt(decPart);
    if (isNegative) {
      cents = -cents;
    }

    return new Money(cents, trimmedCurrency);
  }

  /**
   * Factory for creating Money directly from bigint cents.
   */
  public static fromCents(cents: bigint, currency: string): Money {
    Money.validateCurrency(currency);
    return new Money(cents, currency);
  }

  /**
   * Factory for zero Money in the specified currency.
   */
  public static zero(currency = 'BRL'): Money {
    return Money.create('0.00', currency);
  }

  private static validateCurrency(currency: string): void {
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
