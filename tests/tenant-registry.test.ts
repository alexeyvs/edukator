import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../server/db.js';
import { buildTopicGraph, syncTopicState, type Topic, type TopicGraph } from '../server/curriculum.js';
import { storeTasks } from '../server/codex/bank.js';
import type { DisputeReview } from '../server/codex/dispute.js';
import { openDispute, submitAnswer } from '../server/session.js';
import {
  childDatabasePath,
  createChild,
  createParent,
  markChildFailed,
  openControlDatabase,
  retireChild,
} from '../server/control-db.js';
import { controlDatabasePath, ensureDataDir, provisionChildDatabase } from '../server/data-dir.js';
import type { FailureRecord } from '../server/log.js';
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
  /** Соединение последнего `failing`: по нему видно, закрыл ли его реестр. */
  let lastSession: Database | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-tenants-'));
    ensureDataDir(tempDir);
    seedDir = join(tempDir, 'посев');
    mkdirSync(seedDir, { recursive: true });
    writeFileSync(join(seedDir, 'math.json'), `${JSON.stringify(SEED, null, 2)}\n`);
    control = openControlDatabase(controlDatabasePath(tempDir));
    log = [];
    lastSession = undefined;
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

  /**
   * Открытие, у которого одна выборка бросает, а остальное работает как обычно:
   * так испорченная база отличается от отсутствующей — соединение живо, а часть
   * работы по нему не идёт. Само соединение запоминается в `lastSession`:
   * проверять, закрыл ли его реестр, больше не по чему.
   */
  function failing(pattern: RegExp): (path: string) => SessionDatabase | undefined {
    return (path) => {
      const opened = openSessionDatabase(path);
      if (opened === undefined) return undefined;
      lastSession = opened.db;
      const prepare = opened.db.prepare.bind(opened.db);
      Object.defineProperty(opened.db, 'prepare', {
        configurable: true,
        value: (sql: string) => {
          if (pattern.test(sql)) throw new Error(`выборка не удалась: ${sql}`);
          return prepare(sql);
        },
      });
      return opened;
    };
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
    it('открывает базу ребёнка, заводит темы и заливает посев', async () => {
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

      await tenants.closeAll();
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

      await tenants.closeAll();
    });

    it('отдаёт то же соединение при повторном обращении', async () => {
      const childId = readyChild();
      const tenants = registry();

      const first = tenants.open(childId);
      const second = tenants.open(childId);

      expect(second).toBe(first);
      expect(second.db).toBe(first.db);
      expect(tenants.peek(childId)).toBe(first);
      expect(tenants.list()).toEqual([first]);

      await tenants.closeAll();
    });

    it('переоткрывает базу после закрытия', async () => {
      const childId = readyChild();
      const tenants = registry();

      const first = tenants.open(childId);
      await tenants.close(childId);
      expect(tenants.size).toBe(0);
      expect(tenants.peek(childId)).toBeUndefined();

      const second = tenants.open(childId);
      expect(second).not.toBe(first);
      expect(second.db.prepare<[], { one: number }>('SELECT 1 AS one').get()?.one).toBe(1);

      await tenants.closeAll();
    });

    it('не пускает повторный вход в открытие той же базы', async () => {
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

      await tenants.closeAll();
    });

    it('говорит о состояниях без темы в карте, но их не удаляет', async () => {
      const childId = readyChild();
      const full = registry();
      full.open(childId);
      await full.closeAll();

      // Тема выпала из карты: обычно это переименованный `id`, то есть прогресс,
      // который больше никогда не попадёт ни в план, ни в прогноз.
      const shrunk = registry({ graph: buildTopicGraph([topic('math.a')]) });
      const tenant = shrunk.open(childId);

      expect(log.some((line) => line.includes('состояния без темы в карте: math.b'))).toBe(true);
      const kept = tenant.db
        .prepare<[string], { topic_id: string }>('SELECT topic_id FROM topic_state WHERE topic_id = ?')
        .get('math.b');
      expect(kept?.topic_id).toBe('math.b');

      await shrunk.closeAll();
    });

    it('порча посева не отменяет открытие базы', async () => {
      // Без посева первая тема просто холодная, а отказ здесь оставил бы
      // ученика вовсе без занятия.
      const childId = readyChild();
      writeFileSync(join(seedDir, 'math.json'), 'не json');
      const tenants = registry();

      const tenant = tenants.open(childId);

      expect(tenant.available()).toBe(true);
      expect(log.some((line) => line.includes('посевной банк ребёнка') && line.includes('не загружен'))).toBe(true);

      await tenants.closeAll();
    });

    it('закрытие неизвестного ребёнка — не ошибка', async () => {
      const tenants = registry();
      await expect(tenants.close('нет-такого')).resolves.toBeUndefined();
    });
  });

  describe('отпечаток файла', () => {
    it('сохраняет отпечаток открытого файла и считает базу доступной', async () => {
      const childId = readyChild();
      const tenants = registry();

      const tenant = tenants.open(childId);
      const info = statSync(tenant.path);

      expect(tenant.file).toBe(`${String(info.dev)}:${String(info.ino)}`);
      expect(tenant.available()).toBe(true);

      await tenants.closeAll();
    });

    it('подмена файла краснит именно того ребёнка, чью базу подменили', async () => {
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

      await tenants.closeAll();
    });
  });

  describe('потолок открытых баз', () => {
    it('отказывает новому арендатору и не трогает уже открытых', async () => {
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

      await tenants.closeAll();
    });

    it('потолок должен быть положительным целым', async () => {
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
    it('не открывает базу неизвестного ребёнка', async () => {
      const tenants = registry();
      expect(() => tenants.open('0123456789ab')).toThrow(TenantError);
      expect(tenants.size).toBe(0);
    });

    it('не открывает базу ребёнка в provisioning, failed и retired', async () => {
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

    it('сообщает о недоступной базе и не запоминает арендатора', async () => {
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

    it('не запоминает арендатора, если темы не завелись', async () => {
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

      await tenants.closeAll();
    });

    // Соединение открыто, а посев или темы упали: без закрытия дескриптор жил бы
    // до конца процесса и считался бы против потолка открытых баз, которого
    // реестру уже нечем освободить — аренды-то нет.
    it('закрывает соединение сорвавшегося открытия, а не бросает его', () => {
      const childId = readyChild();
      const broken = registry({ openSession: failing(/topic_state/u) });

      expect(() => broken.open(childId)).toThrow();
      expect(broken.size).toBe(0);
      expect(lastSession?.open).toBe(false);
    });

    // Сборка координаторов — не инертная часть открытия: `createIntegrityCoordinator`
    // синхронно поднимает незакрытые проверки, и осиротевшая строка бросает
    // прямо из конструктора. Оставленная снаружи защиты, она уносила бы
    // соединение мимо кеша — закрыть его было бы нечем ни `close`, ни
    // `closeAll`, потолок его не считал бы, и каждый следующий запрос открывал
    // бы ещё одно; наружу при этом уходила бы пятисотка вместо 503.
    it('закрывает соединение, когда падает сборка координаторов', () => {
      const childId = readyChild();
      const failures: FailureRecord[] = [];
      const broken = registry({
        openSession: failing(/FROM integrity_reviews/u),
        failures: (record) => failures.push(record),
      });

      expect(() => broken.open(childId)).toThrow(TenantError);
      try {
        broken.open(childId);
      } catch (error) {
        expect((error as TenantError).code).toBe('unavailable');
      }
      expect(broken.size).toBe(0);
      expect(lastSession?.open).toBe(false);
      expect(failures.map((record) => record.event)).toContain('tenant-open-failed');
    });

    // Открытие зовут маршруты, обход диспетчера раз в минуту и опрос агента раз
    // в двадцать секунд, а причина отказа держится до починки: строка на каждую
    // попытку выдавила бы из видимого хвоста журнала ровно ту запись, которая
    // называет причину.
    it('пишет аварию открытия переходом, а не на каждую попытку', () => {
      const childId = readyChild();
      const failures: FailureRecord[] = [];
      const broken = registry({
        openSession: failing(/topic_state/u),
        failures: (record) => failures.push(record),
      });

      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect(() => broken.open(childId)).toThrow();
      }

      expect(failures.filter((record) => record.event === 'tenant-open-failed')).toHaveLength(1);
    });

    // Восстановление незакрытых споров — не условие занятия: оно уже в кеше,
    // часть споров могла встать на разбор и держать соединение, а сам спор
    // переспросится следующим нажатием кнопки. Пятисотка отсюда запрещала бы
    // ребёнку заниматься вовсе.
    it('оставляет аренду рабочей, когда незакрытые споры не восстановились', async () => {
      const childId = readyChild();
      const tenants = registry({ openSession: failing(/FROM disputes/u) });

      const tenant = tenants.open(childId);

      expect(tenant.childId).toBe(childId);
      expect(tenants.size).toBe(1);
      expect(log.some((line) => /споры ребёнка .* не восстановлены/u.test(line))).toBe(true);

      await tenants.closeAll();
    });
  });

  describe('соединение занятия', () => {
    it('привязывает соединение занятия к отпечатку открытого файла', async () => {
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

    it('не поднимает занятие, если файл базы подменили в окне открытия', async () => {
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

    it('не поднимает занятие на месте пропавшего файла и не заводит его', async () => {
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

  describe('разбор споров', () => {
    /**
     * Заводит в базе ребёнка незакрытый спор и закрывает соединение: ровно то
     * состояние, в котором база достаётся серверу после перезапуска.
     */
    function openDisputeFor(childId: string): number {
      const db = openDatabase(childDatabasePath(tempDir, childId));
      try {
        syncTopicState(db, GRAPH);
        const { stored } = storeTasks(db, 'math.a', [
          {
            instruction: `Спорное задание ${childId}: 90 монет пополам — сколько осталось?`,
            material: '',
            material_format: 'none',
            choices: [],
            answer: '45',
            accept: ['45'],
            hint: 'Половина от девяноста.',
            explain: '90 : 2 = 45 — вот и весь фокус.',
            joke: 'Кошелёк похудел вдвое, зато ты нет.',
            difficulty: 2,
          },
        ]);
        const taskId = stored[0]?.id;
        if (taskId === undefined) throw new Error('задание не легло в банк');
        db.prepare("UPDATE task_bank SET status = 'used' WHERE id = ?").run(taskId);
        const attempt = submitAnswer(db, GRAPH, { taskId, answer: 'сорок пять' });
        return openDispute(db, attempt.attemptId).id;
      } finally {
        db.close();
      }
    }

    function statusOf(childId: string, disputeId: number): string | undefined {
      const db = openDatabase(childDatabasePath(tempDir, childId));
      try {
        return db
          .prepare<[number], { status: string }>('SELECT status FROM disputes WHERE id = ?')
          .get(disputeId)?.status;
      } finally {
        db.close();
      }
    }

    it('восстанавливает незакрытый спор при открытии базы', async () => {
      // Восстановление идёт на открытии каждой базы, а не один раз при старте:
      // база второго ребёнка открывается только по первому его обращению.
      const childId = readyChild();
      const disputeId = openDisputeFor(childId);
      const pending: Promise<void>[] = [];
      const tenants = registry({
        review: (): Promise<DisputeReview> =>
          Promise.resolve({ studentCorrect: true, note: 'то же число словами' }),
        background: (job): void => {
          pending.push(job());
        },
      });

      tenants.open(childId);
      await Promise.all(pending);

      expect(
        tenants.peek(childId)?.db
          .prepare<[number], { status: string }>('SELECT status FROM disputes WHERE id = ?')
          .get(disputeId)?.status,
      ).toBe('upheld');

      await tenants.closeAll();
    });

    it('вердикт уходит в ту базу, где спор открыт', async () => {
      const mine = readyChild('Тимофей');
      const alien = readyChild('Мирон');
      const disputeId = openDisputeFor(mine);
      // Номера у разных детей совпадают: общее состояние разбора отправило бы
      // вердикт не в ту базу.
      expect(openDisputeFor(alien)).toBe(disputeId);
      const pending: Promise<void>[] = [];
      const tenants = registry({
        review: (): Promise<DisputeReview> =>
          Promise.resolve({ studentCorrect: true, note: 'то же число словами' }),
        background: (job): void => {
          pending.push(job());
        },
      });

      tenants.open(mine);
      await Promise.all(pending);
      await tenants.closeAll();

      expect(statusOf(mine, disputeId)).toBe('upheld');
      expect(statusOf(alien, disputeId)).toBe('open');
    });

    it('закрытие дожидается идущего разбора, а потом закрывает базу', async () => {
      // Обратный порядок превращал бы штатное закрытие в случайный
      // `database connection is not open` посреди записи вердикта.
      const childId = readyChild();
      const disputeId = openDisputeFor(childId);
      let release: (() => void) | undefined;
      const hanging = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tenants = registry({
        review: async (): Promise<DisputeReview> => {
          await hanging;
          return { studentCorrect: true, note: 'то же число словами' };
        },
      });

      const tenant = tenants.open(childId);
      // Закрытие начинается, пока разбор ещё висит: не дождись оно вердикта,
      // запись пришлась бы на уже закрытое соединение.
      const closing = tenants.closeAll();
      release?.();
      await closing;

      expect(statusOf(childId, disputeId)).toBe('upheld');
      expect(() => tenant.db.prepare('SELECT 1').get()).toThrow();
    });
  });

  describe('закрытие', () => {
    it('closeAll закрывает все открытые базы', async () => {
      const first = readyChild('Тимофей');
      const second = readyChild('Мирон');
      const tenants = registry();
      const one = tenants.open(first);
      const two = tenants.open(second);

      await tenants.closeAll();

      expect(tenants.size).toBe(0);
      expect(() => one.db.prepare('SELECT 1').get()).toThrow();
      expect(() => two.db.prepare('SELECT 1').get()).toThrow();
    });

    it('отказ закрытия попадает в журнал, но не роняет обход', async () => {
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

      await tenants.closeAll();

      expect(log.some((line) => line.includes('не закрыта: соединение занято'))).toBe(true);
      expect(() => two.db.prepare('SELECT 1').get()).toThrow();
      expect(tenants.size).toBe(0);

      Reflect.deleteProperty(stubborn as unknown as object, 'close');
      stubborn?.close();
    });
  });
});
