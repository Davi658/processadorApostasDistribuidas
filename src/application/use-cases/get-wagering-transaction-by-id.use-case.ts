import { Injectable, NotFoundException } from '@nestjs/common';
import type { WagerTransactionRepositoryPort } from '../ports/ports';
import type { WagerTransactionQueryResponseDto } from '../dto/query-wagering-transaction.dto';

@Injectable()
export class GetWageringTransactionByIdUseCase {
  constructor(private readonly wagerRepo: WagerTransactionRepositoryPort) {}

  public async execute(transactionId: string): Promise<WagerTransactionQueryResponseDto> {
    const tx = await this.wagerRepo.findById(transactionId, false);
    if (!tx) {
      throw new NotFoundException({
        statusCode: 404,
        error: 'Not Found',
        code: 'TRANSACTION_NOT_FOUND',
        message: `Wager transaction with ID "${transactionId}" was not found`,
      });
    }

    return {
      id: tx.id,
      walletId: tx.walletId,
      playerId: tx.playerId,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      money: {
        amount: tx.money.getAmount(),
        currency: tx.money.getCurrency(),
      },
      status: tx.status,
      rejectionReason: tx.rejectionReason,
      referenceExternalTransactionId: tx.referenceExternalTransactionId,
      createdAt: tx.createdAt,
      updatedAt: tx.updatedAt,
    };
  }
}
