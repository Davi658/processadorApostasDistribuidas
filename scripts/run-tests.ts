import { readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

export function discoverTests(paths: string[]): string[] {
  const files = new Set<string>();
  const visit = (path: string) => {
    const absolute = resolve(path);
    if (statSync(absolute).isDirectory()) {
      for (const entry of readdirSync(absolute).sort()) visit(join(absolute, entry));
    } else if (absolute.endsWith('.test.ts')) files.add(absolute);
  };
  for (const path of paths) visit(path);
  return [...files].sort();
}

export function runTests(paths: string[]): number {
  const files = discoverTests(paths);
  if (!files.length) throw new Error('No .test.ts files found');
  let failures = 0;
  // Fresh process for every file: no leaked env/module state between suites.
  // process.execPath and argv avoid shell quoting and work on Windows and Linux.
  for (const file of files) {
    console.log(`\n[test-runner] ${file}`);
    const result = spawnSync(process.execPath, ['test', file, '--timeout', '30000'], {
      stdio: 'inherit', env: process.env,
    });
    if (result.error) console.error(result.error);
    if (result.error || result.signal || result.status !== 0) failures++;
  }
  console.log(`[test-runner] ${files.length} files; ${failures} failed`);
  return failures === 0 ? 0 : 1;
}

if (import.meta.main) {
  try { process.exitCode = runTests(process.argv.slice(2).length ? process.argv.slice(2) : ['tests']); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
