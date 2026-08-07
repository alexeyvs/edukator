import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runChild } from '../server/run-child.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function waitUntilDead(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!processExists(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

describe('runChild', () => {
  it.skipIf(process.platform === 'win32')(
    'после выхода лидера добивает потомка, который игнорирует TERM и закрыл stdio',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'edukator-child-'));
      tempDirs.push(dir);
      const pidPath = join(dir, 'survivor.pid');
      const bin = join(dir, 'tree.sh');
      writeFileSync(
        bin,
        [
          '#!/bin/sh',
          "( trap '' TERM; exec >/dev/null 2>&1; while :; do sleep 1; done ) &",
          'survivor=$!',
          'printf \'%s\' "$survivor" > "$1"',
          "trap 'exit 0' TERM",
          'while :; do sleep 1; done',
        ].join('\n'),
      );
      chmodSync(bin, 0o755);

      await expect(
        runChild({ bin, args: [pidPath], label: 'дерево', timeoutMs: 1_000 }),
      ).rejects.toThrow(/превышен срок/);

      const survivor = Number(readFileSync(pidPath, 'utf8'));
      expect(Number.isInteger(survivor)).toBe(true);
      expect(await waitUntilDead(survivor)).toBe(true);
    },
  );
});
