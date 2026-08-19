import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Database } from 'better-sqlite3';
import {
  CHILDREN_DIR,
  childDatabasePath,
  createChild,
  createParent,
  isChildServiceable,
  listServiceableChildren,
  markChildReady,
  openControlDatabase,
  readChild,
  retireChild,
} from '../server/control-db.js';
import {
  CONTROL_DB_FILE,
  DEFAULT_DATA_DIR,
  controlDatabasePath,
  dataDir,
  ensureDataDir,
  provisionChildDatabase,
} from '../server/data-dir.js';
import { SCHEMA_VERSION, TABLES, openDatabase } from '../server/db.js';

describe('каталог данных', () => {
  let tempDir: string;
  let control: Database;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-data-dir-'));
    ensureDataDir(tempDir);
    control = openControlDatabase(controlDatabasePath(tempDir));
  });

  afterEach(() => {
    control.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Заводит родителя и ребёнка: заведение базы без них не имеет смысла. */
  function newChild(name = 'Тимофей'): string {
    const parentId = createParent(control, `${name}@example.com`);
    return createChild(control, parentId, name);
  }

  describe('расположение', () => {
    it('берёт каталог из EDUKATOR_DATA_DIR и приводит его к абсолютному', () => {
      expect(dataDir(join(tempDir, 'данные'))).toBe(join(tempDir, 'данные'));
      expect(dataDir('относительный')).toBe(resolve('относительный'));
    });

    it('пустое значение — это умолчание, а не текущий каталог', () => {
      // Пустая строка уходила бы в `resolve` и давала каталог запуска: базы
      // детей появлялись бы там, откуда сервер запустили, и следующий запуск из
      // другого места их бы не нашёл.
      for (const value of [undefined, '', '   ']) {
        expect(dataDir(value)).toBe(DEFAULT_DATA_DIR);
      }
      expect(DEFAULT_DATA_DIR.endsWith(`${'/'}data`)).toBe(true);
    });

    it('управляющая база лежит в каталоге данных', () => {
      expect(controlDatabasePath(tempDir)).toBe(join(tempDir, CONTROL_DB_FILE));
    });

    it('заводит каталог данных вместе с children/', () => {
      const fresh = join(tempDir, 'новый', 'вложенный');
      expect(ensureDataDir(fresh)).toBe(fresh);
      expect(statSync(join(fresh, CHILDREN_DIR)).isDirectory()).toBe(true);
      // Повторный вызов на готовом каталоге — не ошибка: сервер зовёт его на
      // каждом старте.
      expect(() => ensureDataDir(fresh)).not.toThrow();
    });
  });

  describe('заведение базы ребёнка', () => {
    it('создаёт базу с актуальной схемой и переводит ребёнка в ready', () => {
      const childId = newChild();
      const result = provisionChildDatabase(control, childId, tempDir);

      expect(result.created).toBe(true);
      expect(result.path).toBe(childDatabasePath(tempDir, childId));
      expect(existsSync(result.path)).toBe(true);
      expect(readChild(control, childId)?.status).toBe('ready');

      const db = openDatabase(result.path);
      try {
        expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
        const tables = db
          .prepare<[], { name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
          )
          .all()
          .map((row) => row.name);
        expect(tables.sort()).toEqual([...TABLES].sort());
      } finally {
        db.close();
      }
    });

    it('не оставляет за собой ни временных файлов, ни спутников WAL', () => {
      const childId = newChild();
      provisionChildDatabase(control, childId, tempDir);

      expect(readdirSync(join(tempDir, CHILDREN_DIR))).toEqual([`${childId}.db`]);
    });

    it('продолжает заведение, оборвавшееся до rename', () => {
      const childId = newChild();
      const root = join(tempDir, CHILDREN_DIR);
      // Так выглядит обрыв на первом шаге: временный файл написан, в рабочее
      // место не переехал, ребёнок остался `provisioning`.
      const stale = join(root, `${childId}.db.deadbeef.tmp`);
      writeFileSync(stale, 'недописанная база');
      writeFileSync(`${stale}-wal`, 'журнал');

      const result = provisionChildDatabase(control, childId, tempDir);

      expect(result.created).toBe(true);
      expect(readChild(control, childId)?.status).toBe('ready');
      // Времянка не доедет до рабочего места: неизвестно, на каком шаге её
      // бросили, и домигрировать её значило бы отдать ученику базу неизвестного
      // состояния.
      expect(readdirSync(root)).toEqual([`${childId}.db`]);
      openDatabase(result.path).close();
    });

    it('продолжает заведение, оборвавшееся между rename и ready', () => {
      const childId = newChild();
      const target = childDatabasePath(tempDir, childId);
      // База уже на месте, статус ещё нет: ровно то, что остаётся после обрыва
      // между `rename` и переводом в `ready`.
      openDatabase(target).close();
      expect(readChild(control, childId)?.status).toBe('provisioning');

      const result = provisionChildDatabase(control, childId, tempDir);

      expect(result.created).toBe(false);
      expect(readChild(control, childId)?.status).toBe('ready');
    });

    it('не пересоздаёт готовую базу: за ней прогресс ученика', () => {
      const childId = newChild();
      const { path } = provisionChildDatabase(control, childId, tempDir);
      const db = openDatabase(path);
      try {
        db.prepare('INSERT INTO topic_state (topic_id, mastery) VALUES (?, ?)').run('math.a', 0.7);
      } finally {
        db.close();
      }

      expect(provisionChildDatabase(control, childId, tempDir).created).toBe(false);

      const reopened = openDatabase(path);
      try {
        expect(
          reopened
            .prepare<[string], { mastery: number }>('SELECT mastery FROM topic_state WHERE topic_id = ?')
            .get('math.a')?.mastery,
        ).toBe(0.7);
      } finally {
        reopened.close();
      }
    });

    it('помечает ребёнка failed и не оставляет времянки, если базу создать нечем', () => {
      const childId = newChild();
      const root = join(tempDir, CHILDREN_DIR);
      rmSync(root, { recursive: true, force: true });
      // Файл на месте каталога `children/`: `mkdir` под ним не выйдет, и
      // заведение обязано красным закончиться, а не молча оставить ребёнка ждать.
      writeFileSync(root, 'не каталог');

      expect(() => provisionChildDatabase(control, childId, tempDir)).toThrow();
      expect(readChild(control, childId)?.status).toBe('failed');
    });

    it('отказывает неизвестному и выведенному ребёнку', () => {
      expect(() => provisionChildDatabase(control, 'a'.repeat(32), tempDir))
        .toThrow(/нет в управляющей базе/u);

      const childId = newChild();
      retireChild(control, childId);
      expect(() => provisionChildDatabase(control, childId, tempDir)).toThrow(/выведен/u);
      expect(existsSync(childDatabasePath(tempDir, childId))).toBe(false);
    });

    it('повторяет заведение после неудачи, не требуя ручного сброса статуса', () => {
      const childId = newChild();
      const root = join(tempDir, CHILDREN_DIR);
      rmSync(root, { recursive: true, force: true });
      writeFileSync(root, 'не каталог');
      expect(() => provisionChildDatabase(control, childId, tempDir)).toThrow();

      rmSync(root, { force: true });
      mkdirSync(root, { recursive: true });

      expect(provisionChildDatabase(control, childId, tempDir).created).toBe(true);
      expect(readChild(control, childId)?.status).toBe('ready');
    });
  });

  describe('кого можно обслуживать', () => {
    it('ребёнок в provisioning не выдаётся ни маршрутам, ни воркеру', () => {
      const childId = newChild();

      expect(isChildServiceable(readChild(control, childId))).toBe(false);
      expect(listServiceableChildren(control)).toEqual([]);

      provisionChildDatabase(control, childId, tempDir);

      expect(isChildServiceable(readChild(control, childId))).toBe(true);
      expect(listServiceableChildren(control).map((child) => child.id)).toEqual([childId]);
    });

    it('не выдаёт ни failed, ни выведенного, ни несуществующего', () => {
      const failing = newChild('Неудача');
      const root = join(tempDir, CHILDREN_DIR);
      rmSync(root, { recursive: true, force: true });
      writeFileSync(root, 'не каталог');
      expect(() => provisionChildDatabase(control, failing, tempDir)).toThrow();
      rmSync(root, { force: true });
      mkdirSync(root, { recursive: true });

      const retired = newChild('Выведенный');
      provisionChildDatabase(control, retired, tempDir);
      retireChild(control, retired);

      expect(isChildServiceable(readChild(control, failing))).toBe(false);
      expect(isChildServiceable(readChild(control, retired))).toBe(false);
      expect(isChildServiceable(undefined)).toBe(false);
      expect(listServiceableChildren(control)).toEqual([]);
    });

    it('обходит детей в устойчивом порядке', () => {
      const ids = ['Первый', 'Второй', 'Третий'].map((name) => {
        const id = newChild(name);
        provisionChildDatabase(control, id, tempDir);
        return id;
      });
      // Порядок задаётся временем заведения, а не порядком опроса: диспетчер
      // воркера обходит детей по нему, и перестановка равных строк давала бы
      // разный обход на одинаковом состоянии.
      markChildReady(control, ids[1] ?? '');

      expect(listServiceableChildren(control).map((child) => child.id)).toEqual(ids);
    });
  });
});
