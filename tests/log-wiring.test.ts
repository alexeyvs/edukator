/**
 * Аварии доезжают до журнала.
 *
 * Проверяется не форма записи (это `tests/log.test.ts`), а разводка: каждый вид
 * происшествия обязан оказаться в файле каталога данных с ожидаемым `event`.
 * Отсюда и настоящие каталоги вместо подменённого `failures` — забытая передача
 * журнала в сборке сервера видна только так.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { buildServer } from '../server/index.js';
import { openDatabase } from '../server/db.js';
import {
  buildTopicGraph,
  syncTopicState,
  type Topic,
  type TopicGraph,
} from '../server/curriculum.js';
import {
  childDatabasePath,
  createChild,
  createParent,
  markChildReady,
  openControlDatabase,
} from '../server/control-db.js';
import { controlDatabasePath, ensureDataDir } from '../server/data-dir.js';
import { failureLogFor, logFilePath, type LogEntry } from '../server/log.js';
import { TenantRegistry } from '../server/tenant-registry.js';
import { WarmupDispatcher, type CycleRunner } from '../server/codex/dispatcher.js';
import { startTenantServer } from './server-harness.js';

const NOW = new Date('2026-08-21T09:00:00.000Z');

const TOPICS: Topic[] = [
  {
    id: 'math.a',
    subject: 'math',
    title: 'Тема math.a',
    examWeight: 3,
    difficulty: 2,
    prereqs: [],
    answerFormat: 'number',
    promptSeed: 'Спрашивай по теме math.a.',
  },
];

/** Что легло в журнал каталога данных. Нет файла — пустой список. */
function journal(dir: string): LogEntry[] {
  let raw: string;
  try {
    raw = readFileSync(logFilePath(dir), 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as LogEntry);
}

/** Виды происшествий в журнале, по одному разу и в порядке появления. */
function events(dir: string): string[] {
  return [...new Set(journal(dir).map((entry) => entry.event))];
}

describe('разводка журнала аварий', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-log-wiring-'));
    // Подробности аварий уходят и в stderr: без заглушки прогон тестов тонет в
    // текстах, ради которых журнал и заведён.
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('каркас сервера', () => {
    it('пишет server-error на пятисотку маршрута', async () => {
      const dataDir = join(tempDir, 'пятисотка');
      const app = buildServer(undefined, { dataDir, worker: false });
      // Маршрута, который бросает, в самом сервере нет: обработчик отказов
      // проверяется только на подставленном.
      app.get('/api/boom', () => {
        throw new Error('поломка внутри');
      });
      await app.ready();
      try {
        const response = await app.inject({ method: 'GET', url: '/api/boom?topic=math.a' });
        expect(response.statusCode).toBe(500);
      } finally {
        await app.close();
      }

      const entry = journal(dataDir).find((item) => item.event === 'server-error');
      expect(entry?.message).toContain('поломка внутри');
      expect(entry?.status).toBe(500);
      expect(entry?.route).toBe('/api/boom?topic=math.a');
    });

    it('не пишет server-error на отказ по состоянию', async () => {
      const dataDir = join(tempDir, 'четырёхсотка');
      const app = buildServer(undefined, { dataDir, worker: false });
      await app.ready();
      try {
        // Незалогиненный запрос — это 401, а не авария сервера.
        const response = await app.inject({ method: 'GET', url: '/api/auth/me' });
        expect(response.statusCode).toBeLessThan(500);
      } finally {
        await app.close();
      }

      expect(events(dataDir)).not.toContain('server-error');
    });

    it('пишет startup-failed, когда карта тем не прочитана', async () => {
      const dataDir = join(tempDir, 'без-карты');
      const app = buildServer(join(tempDir, 'нет-такого-каталога'), { dataDir, worker: false });
      await app.ready();
      try {
        const body = (await app.inject({ method: 'GET', url: '/api/health' })).json() as {
          curriculum: string;
        };
        expect(body.curriculum).toBe('error');
      } finally {
        await app.close();
      }

      const entry = journal(dataDir).find((item) => item.event === 'startup-failed');
      expect(entry?.message).toBe('карта тем не загружена');
      expect(entry?.detail).not.toBe('');
    });

    it('пишет control-error, когда управляющая база не открылась', async () => {
      // Каталог данных исправен — журнал в него ложится, — а на месте
      // `control.db` лежит каталог: открыть его нечем.
      const dataDir = ensureDataDir(join(tempDir, 'без-управляющей'));
      mkdirSync(controlDatabasePath(dataDir), { recursive: true });
      const app = buildServer(undefined, { dataDir, worker: false });
      await app.ready();
      try {
        const response = await app.inject({ method: 'GET', url: '/api/health' });
        expect(response.statusCode).toBe(503);
      } finally {
        await app.close();
      }

      const entry = journal(dataDir).find((item) => item.event === 'control-error');
      expect(entry?.message).toBe('управляющая база не открыта');
    });

    it('пишет tenant-detached на подменённую базу открытого ребёнка', async () => {
      const dataDir = join(tempDir, 'подмена-в-health');
      const server = await startTenantServer({ dataDir, worker: false });
      try {
        for (const suffix of ['', '-wal', '-shm']) {
          rmSync(`${server.dbPath}${suffix}`, { force: true });
        }
        openDatabase(server.dbPath).close();

        const response = await server.app.inject({ method: 'GET', url: '/api/health' });
        expect(response.statusCode).toBe(503);
      } finally {
        await server.close();
      }

      const entry = journal(dataDir).find((item) => item.event === 'tenant-detached');
      expect(entry?.childId).toBe(server.childId);
      expect(entry?.message).toContain('перезапуск');
    });

    it('пишет аварию health один раз на состояние, а не на опрос', async () => {
      const dataDir = join(tempDir, 'повторный-health');
      const server = await startTenantServer({ dataDir, worker: false });
      try {
        for (const suffix of ['', '-wal', '-shm']) {
          rmSync(`${server.dbPath}${suffix}`, { force: true });
        }
        openDatabase(server.dbPath).close();

        for (let attempt = 0; attempt < 5; attempt += 1) {
          const response = await server.app.inject({ method: 'GET', url: '/api/health' });
          expect(response.statusCode).toBe(503);
        }
      } finally {
        await server.close();
      }

      // Маршрут здоровья не авторизован, а оба его состояния держатся до
      // перезапуска: запись на каждый опрос — не диагностика, а её
      // уничтожение. Весь ретеншен журнала — 4 файла по 8 МБ, и монитор,
      // опрашивающий раз в минуту, вытеснил бы из них ровно ту запись, которая
      // называет причину.
      expect(journal(dataDir).filter((item) => item.event === 'tenant-detached')).toHaveLength(1);
    });
  });

  describe('реестр арендаторов', () => {
    let dataDir: string;
    let control: Database;
    let graph: TopicGraph;
    let childId: string;

    beforeEach(() => {
      dataDir = ensureDataDir(join(tempDir, 'реестр'));
      control = openControlDatabase(controlDatabasePath(dataDir));
      graph = buildTopicGraph(TOPICS);
      const parentId = createParent(control, 'родитель@example.com', NOW);
      childId = createChild(control, parentId, 'Ученик', NOW);
      markChildReady(control, childId);
    });

    afterEach(() => {
      control.close();
    });

    /** Реестр без подменённого журнала: проверяется как раз его умолчание. */
    function registry(openSession?: () => undefined): TenantRegistry {
      return new TenantRegistry({
        control,
        dataDir,
        graph,
        log: () => {},
        ...(openSession === undefined ? {} : { openSession }),
      });
    }

    it('пишет tenant-open-failed на испорченный файл базы', () => {
      writeFileSync(childDatabasePath(dataDir, childId), 'это не база');

      expect(() => registry().open(childId)).toThrow();

      const entry = journal(dataDir).find((item) => item.event === 'tenant-open-failed');
      expect(entry?.childId).toBe(childId);
      expect(entry?.message).toBe('база ребёнка не открыта');
    });

    it('пишет tenant-open-failed на базу новее приложения', () => {
      // Отказ миграции доезжает тем же путём: она идёт внутри `openDatabase`.
      const db = openDatabase(childDatabasePath(dataDir, childId));
      db.pragma('user_version = 999');
      db.close();

      expect(() => registry().open(childId)).toThrow();

      const entry = journal(dataDir).find((item) => item.event === 'tenant-open-failed');
      expect(entry?.childId).toBe(childId);
      expect(entry?.detail).toContain('999');
    });

    it('пишет tenant-open-failed, когда файла базы нет вовсе', () => {
      expect(() => registry(() => undefined).open(childId)).toThrow();

      const entry = journal(dataDir).find((item) => item.event === 'tenant-open-failed');
      expect(entry?.message).toBe('файл базы не открылся');
      expect(events(dataDir)).not.toContain('tenant-detached');
    });

    it('пишет tenant-detached, когда файл на месте, а соединение не открылось', () => {
      // Файл есть, а `openSession` отказал — значит, отпечатки разошлись:
      // база подменена в окно открытия.
      openDatabase(childDatabasePath(dataDir, childId)).close();

      expect(() => registry(() => undefined).open(childId)).toThrow();

      const entry = journal(dataDir).find((item) => item.event === 'tenant-detached');
      expect(entry?.childId).toBe(childId);
      expect(events(dataDir)).not.toContain('tenant-open-failed');
    });

    it('пишет tenant-open-failed, когда потолок открытых баз исчерпан', () => {
      openDatabase(childDatabasePath(dataDir, childId)).close();
      const tenants = new TenantRegistry({ control, dataDir, graph, log: () => {}, maxOpen: 1 });
      tenants.open(childId);

      const parentId = createParent(control, 'второй@example.com', NOW);
      const second = createChild(control, parentId, 'Второй', NOW);
      markChildReady(control, second);
      openDatabase(childDatabasePath(dataDir, second)).close();

      expect(() => tenants.open(second)).toThrow();

      const entry = journal(dataDir).find((item) => item.childId === second);
      expect(entry?.event).toBe('tenant-open-failed');
      expect(entry?.message).toContain('потолке 1');
    });
  });

  describe('диспетчер прогрева', () => {
    let dataDir: string;
    let control: Database;
    let graph: TopicGraph;
    let childId: string;
    let childDb: Database;

    beforeEach(() => {
      dataDir = ensureDataDir(join(tempDir, 'диспетчер'));
      control = openControlDatabase(controlDatabasePath(dataDir));
      graph = buildTopicGraph(TOPICS);
      const parentId = createParent(control, 'родитель@example.com', NOW);
      childId = createChild(control, parentId, 'Ученик', NOW);
      markChildReady(control, childId);
      control.prepare('UPDATE children SET last_activity_at = ? WHERE id = ?')
        .run(NOW.toISOString(), childId);
      childDb = openDatabase(childDatabasePath(dataDir, childId));
      syncTopicState(childDb, graph);
    });

    afterEach(() => {
      childDb.close();
      control.close();
    });

    function dispatcher(options: {
      cycle: CycleRunner;
      wait?: (ms: number) => Promise<void>;
    }): WarmupDispatcher {
      return new WarmupDispatcher({
        control,
        graph,
        log: () => {},
        failures: failureLogFor(dataDir),
        open: () => childDb,
        now: () => NOW,
        cycle: options.cycle,
        ...(options.wait === undefined ? {} : { worker: { wait: options.wait } }),
      });
    }

    it('пишет sweep-failed на упавший заход по ребёнку', async () => {
      await dispatcher({
        cycle: () => {
          throw new Error('цикл прогрева упал');
        },
      }).sweep();

      const entry = journal(dataDir).find((item) => item.event === 'sweep-failed');
      expect(entry?.childId).toBe(childId);
      expect(entry?.detail).toBe('цикл прогрева упал');
    });

    it('пишет codex-unavailable на каждый отступ подряд', async () => {
      const delays: number[] = [];
      const worker = dispatcher({
        cycle: () => Promise.resolve({ topics: [], refilled: [], codexUnavailable: true }),
        wait: async (ms) => {
          delays.push(ms);
          if (delays.length >= 2) void worker.stop();
        },
      });

      worker.start();
      await worker.done;

      const written = journal(dataDir).filter((item) => item.event === 'codex-unavailable');
      expect(written).toHaveLength(delays.length);
      expect(written[0]?.detail).toBe('codex не запускается');
      // Растущая пауза видна прямо в записи: по журналу читается, до какого
      // отступа дошло удвоение, а не только сам факт отказа.
      expect(written[0]?.message).toContain('60 с');
      expect(written[1]?.message).toContain('120 с');
    });
  });
});
