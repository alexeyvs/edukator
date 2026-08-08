import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from '../server/atomic-write.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'edukator-atomic-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Временные файлы записи: всё, кроме самого снимка. */
function leftovers(path: string): string[] {
  return readdirSync(dir).filter((name) => join(dir, name) !== path);
}

describe('writeFileAtomic', () => {
  it('создаёт файл, которого не было', () => {
    const path = join(dir, 'curriculum.json');

    writeFileAtomic(path, '{"topics":[]}');

    expect(readFileSync(path, 'utf8')).toBe('{"topics":[]}');
    expect(leftovers(path)).toEqual([]);
  });

  it('переписывает существующий файл целиком', () => {
    const path = join(dir, 'seed.json');
    writeFileSync(path, 'старый снимок целиком');

    writeFileAtomic(path, 'новый');

    expect(readFileSync(path, 'utf8')).toBe('новый');
    expect(leftovers(path)).toEqual([]);
  });

  it('на отказе записи оставляет прежний файл нетронутым и не копит временные', () => {
    // Каталог на месте снимка: `renameSync` отказывает уже после успешной
    // записи временного файла — ровно тот случай, ради которого нужна уборка.
    const path = join(dir, 'seed.json');
    mkdirSync(path);

    expect(() => writeFileAtomic(path, 'новый')).toThrow();

    expect(leftovers(path)).toEqual([]);
  });

  it('не заслоняет причину отказа и убирает временный файл', () => {
    // Каталог только на чтение: `openSync` временного файла падает `EACCES`,
    // и наружу обязана уйти именно эта ошибка, а не что-то из уборки.
    const readOnly = join(dir, 'readonly');
    mkdirSync(readOnly);
    const path = join(readOnly, 'seed.json');
    writeFileSync(path, 'прежний снимок');
    chmodSync(readOnly, 0o500);

    try {
      expect(() => writeFileAtomic(path, 'новый')).toThrow(/EACCES|EPERM/);
      expect(readFileSync(path, 'utf8')).toBe('прежний снимок');
      expect(readdirSync(readOnly)).toEqual(['seed.json']);
    } finally {
      chmodSync(readOnly, 0o700);
    }
  });

  it('на отказе посреди записи закрывает дескриптор и уносит исходную ошибку', async () => {
    // Отказ между `openSync` и `closeSync` подставляется: кончившееся место —
    // единственный настоящий его источник, а именно на нём `closeSync` в уборке
    // выносит ту же ошибку повторно и без своего catch заменил бы причину.
    const path = join(dir, 'seed.json');
    writeFileSync(path, 'прежний снимок');

    const closed: number[] = [];
    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const real = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...real,
        fsyncSync: () => {
          throw new Error('ENOSPC: no space left on device');
        },
        closeSync: (handle: number) => {
          closed.push(handle);
          real.closeSync(handle);
          // Повторный отказ уборки: он не должен ни всплыть, ни отменить `rmSync`.
          throw new Error('ENOSPC при закрытии');
        },
      };
    });

    try {
      const { writeFileAtomic: patched } = await import('../server/atomic-write.js');

      expect(() => patched(path, 'новый')).toThrow('ENOSPC: no space left on device');
      expect(closed).toHaveLength(1);
      expect(readFileSync(path, 'utf8')).toBe('прежний снимок');
      expect(leftovers(path)).toEqual([]);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });

  it('не закрывает дескриптор дважды, когда отказ выносит сам closeSync', async () => {
    // Отложенная ошибка записи всплывает именно в `closeSync`: файл к этому
    // моменту уже закрыт, номер дескриптора свободен, и его успевает занять
    // соседний `openSync` — второе закрытие рвало бы чужой файл.
    const path = join(dir, 'seed.json');

    const closed: number[] = [];
    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const real = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...real,
        closeSync: (handle: number) => {
          closed.push(handle);
          real.closeSync(handle);
          throw new Error('ENOSPC: no space left on device');
        },
      };
    });

    try {
      const { writeFileAtomic: patched } = await import('../server/atomic-write.js');

      expect(() => patched(path, 'новый')).toThrow('ENOSPC: no space left on device');
      expect(closed).toHaveLength(1);
      expect(leftovers(path)).toEqual([]);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });

  it('не сообщает об успехе, когда каталог не удалось сбросить на диск', async () => {
    const path = join(dir, 'seed.json');
    let syncs = 0;
    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const real = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...real,
        fsyncSync: (handle: number) => {
          syncs += 1;
          if (syncs === 2) {
            const error = new Error('EIO: directory sync failed') as NodeJS.ErrnoException;
            error.code = 'EIO';
            throw error;
          }
          real.fsyncSync(handle);
        },
      };
    });

    try {
      const { writeFileAtomic: patched } = await import('../server/atomic-write.js');

      expect(() => patched(path, 'новый снимок')).toThrow(/directory sync failed/);
      // Rename уже атомарно состоялся; ошибка означает именно неподтверждённую
      // долговечность, а не возможность безопасно вернуть прежний снимок.
      expect(readFileSync(path, 'utf8')).toBe('новый снимок');
      expect(leftovers(path)).toEqual([]);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });

  it('не подменяет причину отказом уборки временного файла', async () => {
    // Второй отказ уборки: не убравшийся временный файл — беда куда меньшая,
    // чем потерянная причина, по которой снимок не записался.
    const path = join(dir, 'seed.json');
    mkdirSync(path);

    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const real = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...real,
        rmSync: () => {
          throw new Error('уборка тоже не удалась');
        },
      };
    });

    try {
      const { writeFileAtomic: patched } = await import('../server/atomic-write.js');

      expect(() => patched(path, 'новый')).toThrow(/EISDIR|EPERM|ENOTEMPTY|EACCES/);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });

  it('пишет через соседний временный файл, а не поверх снимка', () => {
    // Содержимое снимка не должно меняться, пока запись не доведена до конца:
    // проверяется тем, что на отказе `renameSync` старые байты целы.
    const path = join(dir, 'seed.json');
    writeFileSync(path, 'прежний снимок');
    const busy = join(dir, 'seed.json.busy');
    mkdirSync(busy);

    writeFileAtomic(path, 'новый снимок');

    expect(readFileSync(path, 'utf8')).toBe('новый снимок');
    // Каталог-помеха на месте: имя временного файла не угадывается заранее.
    expect(leftovers(path)).toEqual(['seed.json.busy']);
  });
});
