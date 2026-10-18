import { BadRequestException } from '@nestjs/common';
import { WagerInputValidator } from '../../../application/validators/wager-input.validator';

// Preserve the HTTP exception contract while sharing all normalization rules.
export const HttpValidator = new Proxy(WagerInputValidator, {
  get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver);
    if (typeof value !== 'function') return value;
    return (...args: unknown[]) => {
      try { return value.apply(target, args); }
      catch (error) { throw new BadRequestException((error as Error).message); }
    };
  },
});
