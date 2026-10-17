import { Module } from '@nestjs/common';
import { PendingReferenceWorkerService } from './pending-reference-worker.service';
import { ReprocessPendingReferencesUseCase } from '../../application/use-cases/reprocess-pending-references.use-case';

@Module({
  providers: [
    {
      provide: PendingReferenceWorkerService,
      useFactory: (reprocessUseCase: ReprocessPendingReferencesUseCase) => {
        return new PendingReferenceWorkerService(reprocessUseCase);
      },
      inject: [ReprocessPendingReferencesUseCase],
    },
  ],
  exports: [PendingReferenceWorkerService],
})
export class PendingReferenceWorkerModule {}
