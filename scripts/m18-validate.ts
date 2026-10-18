import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const directory = `docs/evidence/m18/${process.platform}`;
mkdirSync(directory, { recursive: true });
const steps = [
  ['typecheck', ['run', 'typecheck']],
  ['m18', ['test', 'tests/observability', '--timeout', '30000']],
  ['official', ['run', 'test']],
  ['build', ['build', 'src/main.ts', '--target=bun', '--packages=external', '--outdir=.data/m18-build']],
  ['smoke', ['run', 'scripts/m15-financial-smoke.ts']],
] as const;
const report = { base: 'cf90a10571d2966643b9ac6287658a22e6f66efa', branch: 'codex/m18-final',
  platform: process.platform, bun: Bun.version, started: new Date().toISOString(),
  steps: [] as Array<{ name: string; command: string[]; exitCode: number; durationMs: number; passedTests: number; failedTests: number; filesSummary?: string }> };
for (const [name, args] of steps) {
  console.log(`[m18] ${name}: bun ${args.join(' ')}`);
  const started = performance.now();
  const result = spawnSync(process.execPath, [...args], { env: process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  writeFileSync(`${directory}/${name}.log`, output);
  const step = { name, command: ['bun', ...args], exitCode: result.status ?? 1, durationMs: performance.now() - started,
    passedTests: (output.match(/^\(pass\)/gm) ?? []).length, failedTests: (output.match(/^\(fail\)/gm) ?? []).length,
    filesSummary: output.match(/\[test-runner\] \d+ files; \d+ failed/)?.[0] };
  report.steps.push(step);
  writeFileSync(`${directory}/validation.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(`[m18] ${name}: exit=${step.exitCode}, passed=${step.passedTests}, failed=${step.failedTests}`);
  if (step.exitCode !== 0 || result.error || result.signal) {
    appendFileSync(`${directory}/attempts.jsonl`, JSON.stringify({ at: new Date().toISOString(), step }) + '\n');
    console.error(output.slice(-10000)); process.exitCode = 1; break;
  }
}
