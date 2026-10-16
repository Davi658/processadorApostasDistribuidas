import { describe, expect, it } from 'bun:test';
import { ProcessWagerUseCase } from '../../src/application/use-cases/process-wager.use-case';
import { ProcessWagerDto } from '../../src/application/dto/wager.dto';

describe('Idempotency Payload Hash Canonicalization Tests', () => {
  const baseDto: ProcessWagerDto = {
    providerId: 'prv-alpha',
    externalTransactionId: 'tx-1001',
    playerId: '3d5b0b2e-0a56-4c28-912e-9d22fa92cf33',
    walletId: '7f9c8d1a-2b3c-4d5e-8f9a-0b1c2d3e4f5a',
    roundId: 'round-99',
    gameId: 'game-roulette',
    kind: 'BET',
    money: {
      amount: '50.00',
      currency: 'BRL',
    },
    referenceExternalTransactionId: 'ref-tx-001',
  };

  it('1. should produce the EXACT same hash when keys are passed in a different order (recursive canonical sorting)', () => {
    // DTO with keys rearranged in arbitrary order at top-level and nested level
    const rearrangedDto: ProcessWagerDto = {
      roundId: 'round-99',
      gameId: 'game-roulette',
      money: {
        currency: 'BRL', // inverted order inside money
        amount: '50.00',
      },
      kind: 'BET',
      walletId: '7f9c8d1a-2b3c-4d5e-8f9a-0b1c2d3e4f5a',
      playerId: '3d5b0b2e-0a56-4c28-912e-9d22fa92cf33',
      externalTransactionId: 'tx-1001',
      referenceExternalTransactionId: 'ref-tx-001',
      providerId: 'prv-alpha',
    };

    const hashBase = ProcessWagerUseCase.computePayloadHash(baseDto);
    const hashRearranged = ProcessWagerUseCase.computePayloadHash(rearrangedDto);

    expect(hashBase).toBeDefined();
    expect(hashBase.length).toBe(64); // SHA-256 hex string
    expect(hashBase).toBe(hashRearranged);
  });

  it('2. should produce DIFFERENT hashes when altering only amount', () => {
    const alteredAmountDto: ProcessWagerDto = {
      ...baseDto,
      money: {
        amount: '50.01', // Altered by 1 cent
        currency: 'BRL',
      },
    };

    const hashBase = ProcessWagerUseCase.computePayloadHash(baseDto);
    const hashAltered = ProcessWagerUseCase.computePayloadHash(alteredAmountDto);

    expect(hashBase).not.toBe(hashAltered);
  });

  it('2. should produce DIFFERENT hashes when altering only currency', () => {
    const alteredCurrencyDto: ProcessWagerDto = {
      ...baseDto,
      money: {
        amount: '50.00',
        currency: 'USD', // Altered currency
      },
    };

    const hashBase = ProcessWagerUseCase.computePayloadHash(baseDto);
    const hashAltered = ProcessWagerUseCase.computePayloadHash(alteredCurrencyDto);

    expect(hashBase).not.toBe(hashAltered);
  });

  it('2. should produce DIFFERENT hashes when altering only referenceExternalTransactionId', () => {
    const alteredRefDto: ProcessWagerDto = {
      ...baseDto,
      referenceExternalTransactionId: 'ref-tx-002', // Altered reference
    };

    const hashBase = ProcessWagerUseCase.computePayloadHash(baseDto);
    const hashAltered = ProcessWagerUseCase.computePayloadHash(alteredRefDto);

    expect(hashBase).not.toBe(hashAltered);
  });

  it('should exclude transport metadata and produce the same hash regardless of correlationId or idempotency key header', () => {
    const dtoWithTransport1: ProcessWagerDto = {
      ...baseDto,
      correlationId: 'corr-id-12345',
    };

    const dtoWithTransport2: ProcessWagerDto = {
      ...baseDto,
      correlationId: 'corr-id-99999',
    };

    const hash1 = ProcessWagerUseCase.computePayloadHash(dtoWithTransport1, 'idemp-key-aaa');
    const hash2 = ProcessWagerUseCase.computePayloadHash(dtoWithTransport2, 'idemp-key-bbb');

    expect(hash1).toBe(hash2);
    expect(hash1).toBe(ProcessWagerUseCase.computePayloadHash(baseDto));
  });

  it('canonicalStringify should sort keys recursively and preserve array item order', () => {
    const objA = {
      z: 1,
      a: {
        d: [3, 2, 1], // array order must be preserved: [3, 2, 1]
        c: 'nested-val',
        b: { f: true, e: false },
      },
    };

    const objB = {
      a: {
        b: { e: false, f: true },
        c: 'nested-val',
        d: [3, 2, 1],
      },
      z: 1,
    };

    const jsonA = ProcessWagerUseCase.canonicalStringify(objA);
    const jsonB = ProcessWagerUseCase.canonicalStringify(objB);

    expect(jsonA).toBe(jsonB);
    expect(jsonA).toBe('{"a":{"b":{"e":false,"f":true},"c":"nested-val","d":[3,2,1]},"z":1}');
  });
});
