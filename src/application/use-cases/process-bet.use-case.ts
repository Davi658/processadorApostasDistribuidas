import { ProcessWagerUseCase } from './process-wager.use-case';
import { ProcessBetDto } from '../dto/wager.dto';

export class ProcessBetUseCase extends ProcessWagerUseCase {
  public static computePayloadHash(dto: ProcessBetDto): string {
    return ProcessWagerUseCase.computePayloadHash(dto);
  }
}
