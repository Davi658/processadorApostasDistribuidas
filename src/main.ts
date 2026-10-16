import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './interfaces/http/app.module';
import { DomainExceptionFilter } from './interfaces/http/filters/domain-exception.filter';
import { config } from 'dotenv';

config();

export async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalFilters(new DomainExceptionFilter());
  app.enableShutdownHooks();

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`Server listening on port ${port}`);
  return app;
}

if (import.meta.main) {
  bootstrap();
}
