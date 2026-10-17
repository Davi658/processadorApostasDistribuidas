import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

describe('Official cross-platform test runner', () => {
  it('runs remaining files and exits nonzero after a real failing child test', () => {
    const directory = mkdtempSync(join(tmpdir(), 'm17-runner-'));
    const fail = join(directory, 'a-fail.test.ts');
    const pass = join(directory, 'z-pass.test.ts');
    try {
      writeFileSync(fail, `import { test, expect } from 'bun:test'; test('intentional failure', () => expect(1).toBe(2));`);
      writeFileSync(pass, `import { test, expect } from 'bun:test'; test('remaining file ran', () => expect(1).toBe(1));`);
      const failed = spawnSync(process.execPath, ['run', resolve('scripts/run-tests.ts'), directory], { encoding: 'utf8' });
      expect(failed.status).toBe(1);
      expect(failed.stdout + failed.stderr).toContain('intentional failure');
      expect(failed.stdout + failed.stderr).toContain('remaining file ran');
      expect(failed.stdout).toContain('2 files; 1 failed');
      const passed = spawnSync(process.execPath, ['run', resolve('scripts/run-tests.ts'), pass], { encoding: 'utf8' });
      expect(passed.status).toBe(0);
      expect(passed.stdout).toContain('1 files; 0 failed');
      const empty = spawnSync(process.execPath, ['run', resolve('scripts/run-tests.ts'), fail + '.missing'], { encoding: 'utf8' });
      expect(empty.status).toBe(1);
    } finally {
      unlinkSync(fail);
      unlinkSync(pass);
      rmdirSync(directory);
    }
  });
});
