import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const directory = process.argv[2] ?? `docs/evidence/m16/${process.platform}`;
mkdirSync(directory, { recursive: true });
const commands = [
  ['typecheck', ['run', 'typecheck']],
  ['m16', ['run', 'scripts/run-tests.ts', 'tests/integration/sqs-consumer-m16.test.ts']],
  ['official', ['run', 'test']],
  ['smoke', ['run', 'scripts/m15-financial-smoke.ts']],
] as const;
const results: any[] = existsSync(join(directory, 'results.json')) ? JSON.parse(readFileSync(join(directory, 'results.json'), 'utf8')).results : [];
const current: Array<number | null> = [];
const selected = process.argv.slice(3);
for (const [name, args] of commands) {
  if (selected.length && !selected.includes(name)) continue;
  console.log(`M16 validation: ${name}`);
  const started = new Date().toISOString();
  const result = spawnSync(process.execPath, [...args], { env: process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const logFile = `${name}-${results.length + 1}.log`;
  writeFileSync(join(directory, logFile), output);
  writeFileSync(join(directory, `${name}.log`), output);
  const summary = output.split(/\r?\n/).filter(line => /files; .*failed|^\s*\d+ (pass|skip|fail)|Ran \d+ tests|SMOKE|smoke.*(passed|PASS|ok)/i.test(line));
  current.push(result.status);
  results.push({ name, logFile, command: `bun ${args.join(' ')}`, exitCode: result.status, signal: result.signal, error: result.error?.message,
    started, ended: new Date().toISOString(), outputSha256: createHash('sha256').update(output).digest('hex'), summary });
  writeFileSync(join(directory, 'results.json'), JSON.stringify({ platform: process.platform, runtime: process.version, bun: Bun.version, results }, null, 2) + '\n');
  console.log(`${name}: exit=${result.status} ${summary.slice(-5).join('; ')}`);
}
process.exitCode = current.some(code => code !== 0) ? 1 : 0;
