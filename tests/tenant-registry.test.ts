import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../server/db.js';
import { buildTopicGraph, type Topic, type TopicGraph } from '../server/curriculum.js';
import {
  childDatabasePath,
  createChild,
  createParent,
  markChildFailed,
  openControlDatabase,
  retireChild,
} from '../server/control-db.js';
import { controlDatabasePath, ensureDataDir, provisionChildDatabase } from '../server/data-dir.js';
import {
  DEFAULT_MAX_OPEN_TENANTS,
  TenantError,
  TenantRegistry,
  openSessionDatabase,
  type SessionDatabase,
} from '../server/tenant-registry.js';

function topic(id: string, patch: Partial<Topic> = {}): Topic {
  return {
    id,
    subject: 'math',
    title: `Тема ${id}`,
    examWeight: 3,
    difficulty: 2,
    prereqs: [],
    answerFormat: 'number',
    promptSeed: `Спрашивай по теме ${id}.`,
    ...patch,
  };
}

const GRAPH: TopicGraph = buildTopicGraph([topic('math.a'), topic('math.b')]);

/** Посев в том же виде, в каком он лежит в репозитории. */
const SEED = {
  subject: 'math',
  topics: [
    {
      topic_id: 'math.a',
      tasks: [
        {
          instruction: 'Сколько будет 2 + 2?',
          material: '',
          material_format: 'none',
          choices: [],
          answer: '4',
          accept: ['4', '4 штуки'],
          hint: 'Сложи числа по разрядам. Проверь результат обратным действием.',
          explain: 'Два плюс два — четыре.',
          joke: 'Не Нобелевка, но зачёт.',
          difficulty: 2,
        },
      ],
    },
  ],
};

describe('реестр детских баз', () => {
  let tempDir: string;
  let seedDir: string;
  let control: Database;
  let log: string[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-tenants-'));
    ensureDataDir(tempDir);
    seedDir = join(tempDir, 'посев');
    mkdirSync(seedDir, { recursive: true });
    writeFileSync(join(seedDir, 'math.json'), `${JSON.stringify(SEED, null, 2)}\n`);
    control = openControlDatabase(controlDatabasePath(tempDir));
    log = [];
  });

  afterEach(() => {
    control.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Заводит ребёнка вместе с его базой: реестр отдаёт только `ready`. */
  function readyChild(name = 'Тимофей'): string {
    const parentId = createParent(control, `${name}@example.com`);
    const childId = createChild(control, parentId, name);
    provisionChildDatabase(control, childId, tempDir);
    return childId;
  }

  function registry(
    patch: Partial<ConstructorParameters<typeof TenantRegistry>[0]> = {},
  ): TenantRegistry {
    return new TenantRegistry({
      control,
      dataDir: tempDir,
      graph: GRAPH,
      seedDir,
      log: (message) => log.push(message),
      ...patch,
    });
  }

  describe('открытие', () => {
    it('открывает базу ребёнка, заводит темы и заливает посев', () => {
      const childId = readyChild();
      const tenants = registry();

      const tenant = tenants.open(childId);

      expect(tenant.childId).toBe(childId);
      expect(tenant.path).toBe(childDatabasePath(tempDir, childId));
      const topics = tenant.db
        .prepare<[], { topic_id: string }>('SELECT topic_id FROM topic_state ORDER BY topic_id')
        .all()
        .map((row) => row.topic_id);
      expect(topics).toEqual(['math.a', 'math.b']);
      const tasks = tenant.db
        .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM task_bank')
        .get();
      expect(tasks?.count).toBe(1);
      expect(log).toContain(`посевной банк ребёнка ${childId}: добавлено 1 задани(й)`);

      tenants.closeAll();
    });

    it('два одновременных первых обращения дают одну миграцию и один посев', async () => {
      const childId = readyChild();
      let opens = 0;
      const tenants = registry({
        openSession: (path) => {
          opens += 1;
          return openSessionDatabase(path);
        },
      });

      const [first, second] = await Promise.all([
        Promise.resolve().then(() => tenants.open(childId)),
        Promise.resolve().then(() => tenants.open(childId)),
      ]);

      // Второе обращение обязано застать готовую аренду: своё соединение
      // означало бы второй посев и вторую пару отпечатков на один файл.
      expect(opens).toBe(1);
      expect(second).toBe(first);
      expect(tenants.size).toBe(1);
      expect(log.filter((line) => line.startsWith('посевной банк'))).toHaveLength(1);

      tenants.closeAll();
    });

    it('отдаёт то же соединение при повторном обращении', () => {
      const childId = readyChild();
      const tenants = registry();

      const first = tenants.open(childId);
      const second = tenants.open(childId);

      expect(second).toBe(first);
      expect(second.db).toBe(first.db);
      expect(tenants.peek(childId)).toBe(first);
      expect(tenants.list()).toEqual([first]);

      tenants.closeAll();
    });

    it('переоткрывает базу после закрытия', () => {
      const childId = readyChild();
      const tenants = registry();

      const first = tenants.open(childId);
      tenants.close(childId);
      expect(tenants.size).toBe(0);
      expect(tenants.peek(childId)).toBeUndefined();

      const second = tenants.open(childId);
      expect(second).not.toBe(first);
      expect(second.db.prepare<[], { one: number }>('SELECT 1 AS one').get()?.one).toBe(1);

      tenants.closeAll();
    });

    it('не пускает повторный вход в открытие той же базы', () => {
      // Синхронное открытие само по себе замок: событийный цикл не вклинится
      // между проверкой кеша и записью в неё. Заход из собственного стека этот
      // замок обходит — там проверка кеша уже прошла, а записи ещё нет.
      const childId = readyChild();
      let reentered: unknown;
      const tenants: TenantRegistry = registry({
        openSession: (path): SessionDatabase | undefined => {
          try {
            tenants.open(childId);
          } catch (error) {
            reentered = error;
          }
          return openSessionDatabase(path);
        },
      });

      tenants.open(childId);

      expect((reentered as Error).message).toMatch(/Повторный вход/u);
      expect(tenants.size).toBe(1);

      tenants.closeAll();
    });

    it('говорит о состояниях без темы в карте, но их не удаляет', () => {
      const childId = readyChild();
      const full = registry();
      full.open(childId);
      full.closeAll();

      // Тема выпала из карты: обычно это переименованный `id`, то есть прогресс,
      // который больше никогда не попадёт ни в план, ни в прогноз.
      const shrunk = registry({ graph: buildTopicGraph([topic('math.a')]) });
      const tenant = shrunk.open(childId);

      expect(log.some((line) => line.includes('состояния без темы в карте: math.b'))).toBe(true);
      const kept = tenant.db
        .prepare<[string], { topic_id: string }>('SELECT topic_id FROM topic_state WHERE topic_id = ?')
        .get('math.b');
      expect(kept?.topic_id).toBe('math.b');

      shrunk.closeAll();
    });

    it('порча посева не отменяет открытие базы', () => {
      // Без посева первая тема просто холодная, а отказ здесь оставил бы
      // ученика вовсе без занятия.
      const childId = readyChild();
      writeFileSync(join(seedDir, 'math.json'), 'не json');
      const tenants = registry();

      const tenant = tenants.open(childId);

      expect(tenant.available()).toBe(true);
      expect(log.some((line) => line.includes('посевной банк ребёнка') && line.includes('не загружен'))).toBe(true);

      tenants.closeAll();
    });

    it('закрытие неизвестного ребёнка — не ошибка', () => {
      const tenants = registry();
      expect(() => {
        tenants.close('нет-такого');
      }).not.toThrow();
    });
  });

  describe('отпечаток файла', () => {
    it('сохраняет отпечаток открытого файла и считает базу доступной', () => {
      const childId = readyChild();
      const tenants = registry();

      const tenant = tenants.open(childId);
      const info = statSync(tenant.path);

      expect(tenant.file).toBe(`${String(info.dev)}:${String(info.ino)}`);
      expect(tenant.available()).toBe(true);

      tenants.closeAll();
    });

    it('подмена файла краснит именно того ребёнка, чью базу подменили', () => {
      const first = readyChild('Тимофей');
      const second = readyChild('Мирон');
      const tenants = registry();

      const one = tenants.open(first);
      const two = tenants.open(second);

      // Замена файла под живым соединением: под WAL запись в отвязанный файл
      // проходит без ошибки, и без отпечатка подмену было бы не заметить.
      const replacement = join(tempDir, 'замена.db');
      openDatabase(replacement).close();
      renameSync(replacement, one.path);

      expect(one.available()).toBe(false);
      // Общий отпечаток на весь сервер погасил бы занятие и второму ребёнку.
      expect(two.available()).toBe(true);

      tenants.closeAll();
    });
  });

  describe('потолок открытых баз', () => {
    it('отказывает новому арендатору и не трогает уже открытых', () => {
      const first = readyChild('Тимофей');
      const second = readyChild('Мирон');
      const tenants = registry({ maxOpen: 1 });

      const one = tenants.open(first);

      expect(() => tenants.open(second)).toThrow(TenantError);
      try {
        tenants.open(second);
      } catch (error) {
        expect((error as TenantError).code).toBe('too-many-open');
      }

      // Вытеснения нет: чужое соединение живо, и отпечаток вместе с ним.
      expect(tenants.size).toBe(1);
      expect(one.db.prepare<[], { one: number }>('SELECT 1 AS one').get()?.one).toBe(1);
      expect(tenants.open(first)).toBe(one);
      expect(log.some((line) => line.includes('открытые базы не тронуты'))).toBe(true);

      tenants.closeAll();
    });

    it('потолок должен быть положительным целым', () => {
      // Ноль неотличим от «детей нет»: сервер поднялся бы и отказывал всем.
      for (const maxOpen of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => registry({ maxOpen })).toThrow(/положительным целым/u);
      }
      expect(registry({ maxOpen: 1 }).maxOpen).toBe(1);
      expect(registry().maxOpen).toBe(DEFAULT_MAX_OPEN_TENANTS);
      expect(DEFAULT_MAX_OPEN_TENANTS).toBeGreaterThan(0);
    });
  });

  describe('кого не обслуживает', () => {
    it('не открывает базу неизвестного ребёнка', () => {
      const tenants = registry();
      expect(() => tenants.open('0123456789ab')).toThrow(TenantError);
      expect(tenants.size).toBe(0);
    });

    it('не открывает базу ребёнка в provisioning, failed и retired', () => {
      const parentId = createParent(control, 'родитель@example.com');
      const provisioning = createChild(control, parentId, 'Ещё-заводится');
      const failed = createChild(control, parentId, 'Сорвался');
      markChildFailed(control, failed);
      const retired = readyChild('Выведен');
      retireChild(control, retired);
      const tenants = registry();

      for (const childId of [provisioning, failed, retired]) {
        let code: string | undefined;
        try {
          tenants.open(childId);
        } catch (error) {
          code = (error as TenantError).code;
        }
        expect(code).toBe('not-serviceable');
      }
      expect(tenants.size).toBe(0);
    });

    it('сообщает о недоступной базе и не запоминает арендатора', () => {
      const childId = readyChild();
      rmSync(childDatabasePath(tempDir, childId), { force: true });
      const tenants = registry();

      let code: string | undefined;
      try {
        tenants.open(childId);
      } catch (error) {
        code = (error as TenantError).code;
      }

      expect(code).toBe('unavailable');
      expect(tenants.size).toBe(0);
      // Пустая база на месте пропавшей не заводится: по ней всё выглядело бы
      // здоровым, а прогресс остался бы в удалённом файле.
      expect(existsSync(childDatabasePath(tempDir, childId))).toBe(false);
    });

    it('не запоминает арендатора, если темы не завелись', () => {
      const childId = readyChild();
      const tenants = registry({ graph: buildTopicGraph([topic('math.a')]) });
      // Соединение подменено на закрытое: `syncTopicState` упадёт на нём так же,
      // как упал бы на испорченной базе.
      const broken = registry({
        openSession: (path): SessionDatabase | undefined => {
          const opened = openSessionDatabase(path);
          opened?.db.close();
          return opened;
        },
      });

      expect(() => broken.open(childId)).toThrow();
      expect(broken.size).toBe(0);
      // Реестр не испорчен отказом: следующий открывает ту же базу как обычно.
      expect(tenants.open(childId).childId).toBe(childId);

      tenants.closeAll();
    });
  });

  describe('соединение занятия', () => {
    it('привязывает соединение занятия к отпечатку открытого файла', () => {
      const path = join(tempDir, 'отпечаток.db');
      openDatabase(path).close();
      const info = statSync(path);

      const opened = openSessionDatabase(path);
      try {
        expect(opened?.file).toBe(`${String(info.dev)}:${String(info.ino)}`);
        expect(opened?.db.prepare<[], { one: number }>('SELECT 1 AS one').get()?.one).toBe(1);
      } finally {
        opened?.db.close();
      }
    });

    it('не поднимает занятие, если файл базы подменили в окне открытия', () => {
      // Отпечаток снимается и до открытия: сними его только после — соединение
      // осталось бы на прежнем inode, а сверка в health навсегда совпадала бы с
      // новым файлом, то есть 200 отвечал бы занятию, чьи записи уходят в никуда.
      const path = join(tempDir, 'подменена-в-окне.db');
      openDatabase(path).close();

      let leaked: ReturnType<typeof openDatabase> | undefined;
      const opened = openSessionDatabase(path, (target) => {
        const db = openDatabase(target);
        leaked = db;
        rmSync(target, { force: true });
        rmSync(`${target}-wal`, { force: true });
        rmSync(`${target}-shm`, { force: true });
        openDatabase(target).close();
        return db;
      });

      expect(opened).toBeUndefined();
      // Отвергнутое соединение закрыто, а не брошено открытым.
      expect(() => leaked?.prepare('SELECT 1').get()).toThrow();
    });

    it('не поднимает занятие на месте пропавшего файла и не заводит его', () => {
      // Пропавший до открытия файл `openDatabase` завёл бы заново: отпечаток
      // совпал бы с новым, а прогресс остался бы в удалённом. Сверять не с чем —
      // занятие не поднимается. Пустая база при этом не должна остаться на диске:
      // health отвечал бы по ней «ok», и следующий запуск встал бы зелёным.
      const path = join(tempDir, 'заведена-открытием.db');

      const opened = openSessionDatabase(path);

      expect(opened).toBeUndefined();
      expect(existsSync(path)).toBe(false);
    });
  });

  describe('закрытие', () => {
    it('closeAll закрывает все открытые базы', () => {
      const first = readyChild('Тимофей');
      const second = readyChild('Мирон');
      const tenants = registry();
      const one = tenants.open(first);
      const two = tenants.open(second);

      tenants.closeAll();

      expect(tenants.size).toBe(0);
      expect(() => one.db.prepare('SELECT 1').get()).toThrow();
      expect(() => two.db.prepare('SELECT 1').get()).toThrow();
    });

    it('отказ закрытия попадает в журнал, но не роняет обход', () => {
      const first = readyChild('Тимофей');
      const second = readyChild('Мирон');
      let stubborn: Database | undefined;
      const tenants = registry({
        openSession: (path): SessionDatabase | undefined => {
          const opened = openSessionDatabase(path);
          // Отказ закрытия у первой же базы: обход обязан дойти до второй.
          if (opened !== undefined && stubborn === undefined) {
            stubborn = opened.db;
            Object.defineProperty(opened.db, 'close', {
              configurable: true,
              value: () => {
                throw new Error('соединение занято');
              },
            });
          }
          return opened;
        },
      });
      tenants.open(first);
      const two = tenants.open(second);

      tenants.closeAll();

      expect(log.some((line) => line.includes('не закрыта: соединение занято'))).toBe(true);
      expect(() => two.db.prepare('SELECT 1').get()).toThrow();
      expect(tenants.size).toBe(0);

      Reflect.deleteProperty(stubborn as unknown as object, 'close');
      stubborn?.close();
    });
  });
});
