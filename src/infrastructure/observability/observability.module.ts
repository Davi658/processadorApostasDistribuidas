import { Global, Module } from '@nestjs/common';
import { HttpObservability } from './http-observability';
@Global()
@Module({ providers: [{ provide: HttpObservability, useFactory: () => new HttpObservability() }], exports: [HttpObservability] })
export class ObservabilityModule {}
