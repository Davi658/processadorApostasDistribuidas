import { spawn } from 'node:child_process';
import { createIsolatedTestDatabase } from '../tests/test-db-helper';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/interfaces/http/app.module';
import { DomainExceptionFilter } from '../src/interfaces/http/filters/domain-exception.filter';
const db = await createIsolatedTestDatabase('m15_smoke_');
const app = await NestFactory.create(AppModule, { logger: false });
try {
  app.useGlobalFilters(new DomainExceptionFilter()); await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ['run', 'infra/smoke-api.ts'], { env: { ...process.env, API_BASE_URL: base }, stdio: 'inherit' });
    child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
  });
  if (code) process.exitCode = code;
} finally { await app.close(); await db.closeAndDrop(); }
