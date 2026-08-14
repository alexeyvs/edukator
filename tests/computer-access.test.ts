import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import {
  clearComputerAccessOverride,
  readComputerAccessOverride,
  setComputerAccessOverride,
} from '../server/computer-access.js';
import { openDatabase } from '../server/db.js';

const databases: Database[] = [];
const tempDirs: string[] = [];

function setup(): Database {
  const tempDir = mkdtempSync(join(tmpdir(), 'edukator-computer-access-'));
  tempDirs.push(tempDir);
  const db = openDatabase(join(tempDir, 'computer-access.db'));
  databases.push(db);
  return db;
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
  while (tempDirs.length > 0) rmSync(tempDirs.pop() ?? '', { recursive: true, force: true });
});

describe('ручная команда доступа к компьютеру', () => {
  it('атомарно заменяет singleton и очищает его повторяемой операцией', () => {
    const db = setup();
    const first = setComputerAccessOverride(db, 'blocked', new Date('2026-08-08T08:30:00.000Z'));
    const second = setComputerAccessOverride(db, 'unlocked', new Date('2026-08-08T09:45:00.000Z'));

    expect(first).toEqual({
      mode: 'blocked',
      changedAt: '2026-08-08T08:30:00.000Z',
      expiresAt: '2026-08-08T21:00:00.000Z',
    });
    expect(readComputerAccessOverride(db, new Date('2026-08-08T10:00:00.000Z')))
      .toEqual(second);
    expect(db.prepare('SELECT COUNT(*) AS n FROM computer_access_override').get())
      .toEqual({ n: 1 });

    clearComputerAccessOverride(db);
    clearComputerAccessOverride(db);
    expect(readComputerAccessOverride(db, new Date('2026-08-08T10:00:00.000Z'))).toBeNull();
  });

  it('назначает срок на следующую московскую полночь даже при команде на границе суток', () => {
    const db = setup();

    expect(setComputerAccessOverride(
      db,
      'blocked',
      new Date('2026-08-08T21:00:00.000Z'),
    ).expiresAt).toBe('2026-08-09T21:00:00.000Z');
  });

  it('не возвращает истёкшую строку, но сохраняет её для диагностики', () => {
    const db = setup();
    setComputerAccessOverride(db, 'blocked', new Date('2026-08-08T12:00:00.000Z'));

    expect(readComputerAccessOverride(db, new Date('2026-08-08T21:00:00.000Z'))).toBeNull();
    expect(db.prepare('SELECT mode FROM computer_access_override').get())
      .toEqual({ mode: 'blocked' });
  });
});
