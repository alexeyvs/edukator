import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase, writeProfile } from '../server/db.js';
import {
  buildTopicGraph,
  syncTopicState,
  type Topic,
  type TopicGraph,
} from '../server/curriculum.js';
import {
  createChild,
  createParent,
  markChildReady,
  openControlDatabase,
  reserveCodexCall,
  type ChildSummary,
} from '../server/control-db.js';
import { countAvailable, storeTasks } from '../server/codex/bank.js';
import { CodexRunError, CodexUnavailableError } from '../server/codex/client.js';
import type { GeneratedTask } from '../server/codex/task-schema.js';
import {
  ACTIVE_WINDOW_MS,
  AT_SCREEN_MS,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  backoffDelay,
  everySweepFailed,
  FLOOR_BATCHES_PER_TOPIC,
  IDLE_INTERVAL_MS,
  orderChildren,
  WarmupDispatcher,
  type SweepReport,
} from '../server/codex/dispatcher.js';
import {
  MAX_BATCHES_PER_TOPIC,
  QUEUE_TARGET,
  REFILL_BELOW,
  type CycleReport,
  type ProduceRequest,
  type WorkerOptions,
} from '../server/codex/worker.js';

const NOW = new Date('2026-08-19T10:00:00.000Z');

function topic(id: string): Topic {
  return {
    id,
    subject: id.startsWith('math') ? 'math' : id.startsWith('russian') ? 'russian' : 'english',
    title: `Тема ${id}`,
    examWeight: 3,
    difficulty: 2,
    prereqs: [],
    answerFormat: 'number',
    promptSeed: `Спрашивай по теме ${id}.`,
  };
}

/** Три темы разных предметов: планировщик выдаёт их все сразу. */
const TOPICS = [topic('math.a'), topic('russian.a'), topic('english.a')];

let counter = 0;

/** Задание с неповторимой формулировкой: банк отсеивает дубли. */
function task(): GeneratedTask {
  counter += 1;
  return {
    instruction: `Задание ${String(counter)}: сколько монет останется?`,
    material: '',
    material_format: 'none',
    choices: [],
    answer: '45',
    accept: ['45'],
    hint: 'Выдели известные величины и посчитай по шагам.',
    explain: 'Сорок пять — то, что осталось.',
    joke: 'Не Нобелевка, но зачёт.',
    difficulty: 2,
  };
}

function batchOf(count: number): GeneratedTask[] {
  return Array.from({ length: count }, () => task());
}

/** Ребёнок теста: строка в управляющей базе плюс своя открытая база занятия. */
interface Kid {
  id: string;
  db: Database;
}

/** Сводка ребёнка для проверок чистого порядка обхода — без всяких баз. */
function summary(id: string, lastActivityAt: string | undefined): ChildSummary {
  return {
    id,
    parentId: 'родитель',
    name: id,
    status: 'ready',
    ...(lastActivityAt === undefined ? {} : { lastActivityAt }),
    createdAt: '2026-08-01T00:00:00.000Z',
  };
}

/** Отметка активности возрастом `ageMs` относительно `NOW`. */
function activity(ageMs: number): string {
  return new Date(NOW.getTime() - ageMs).toISOString();
}

describe('диспетчер прогрева', () => {
  let tempDir: string;
  let control: Database;
  let parentId: string;
  let graph: TopicGraph;
  const kids: Kid[] = [];
  const logged: string[] = [];
  const log = (message: string): void => {
    logged.push(message);
  };

  /** Заводит ребёнка с готовой базой и отметкой активности возрастом `ageMs`. */
  function addKid(name: string, ageMs: number | undefined = 0): Kid {
    // Порядок обхода задаётся `created_at`: одинаковая отметка у всех свела бы
    // его к случайному порядку идентификаторов.
    const id = createChild(control, parentId, name, new Date(NOW.getTime() + kids.length));
    markChildReady(control, id);
    if (ageMs !== undefined) {
      control.prepare('UPDATE children SET last_activity_at = ? WHERE id = ?')
        .run(activity(ageMs), id);
    }
    const db = openDatabase(join(tempDir, `${id}.db`));
    syncTopicState(db, graph);
    // Имя профиля отличает ребёнка в запросе генератора: производитель у
    // диспетчера один на всех, а проверять надо, чью тему он греет.
    writeProfile(db, { name, interests: [] });
    const kid = { id, db };
    kids.push(kid);
    return kid;
  }

  function dispatcher(options: {
    produce?: (request: ProduceRequest) => Promise<GeneratedTask[]>;
    cycle?: (options: WorkerOptions) => Promise<CycleReport>;
    wait?: (ms: number) => Promise<void>;
    now?: () => Date;
  } = {}): WarmupDispatcher {
    return new WarmupDispatcher({
      control,
      graph,
      log,
      open: (childId) => kids.find((kid) => kid.id === childId)?.db,
      now: options.now ?? ((): Date => NOW),
      ...(options.cycle === undefined ? {} : { cycle: options.cycle }),
      worker: {
        ...(options.produce === undefined ? {} : { produce: options.produce }),
        ...(options.wait === undefined ? {} : { wait: options.wait }),
      },
    });
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-dispatcher-'));
    control = openControlDatabase(join(tempDir, 'control.db'));
    parentId = createParent(control, 'родитель@example.com', NOW);
    graph = buildTopicGraph(TOPICS);
    kids.length = 0;
    logged.length = 0;
  });

  afterEach(() => {
    for (const kid of kids) kid.db.close();
    control.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('порядок обхода', () => {
    it('ставит занимающихся сейчас впереди остальных, свежего первым', () => {
      const order = orderChildren(
        [
          summary('спящий', activity(2 * AT_SCREEN_MS)),
          summary('давний', activity(AT_SCREEN_MS - 1000)),
          summary('свежий', activity(1000)),
        ],
        { now: NOW },
      );

      expect(order.atScreen.map((child) => child.id)).toEqual(['свежий', 'давний']);
      expect(order.rest.map((child) => child.id)).toEqual(['спящий']);
    });

    it('выкидывает из обхода брошенного и ни разу не заходившего', () => {
      const order = orderChildren(
        [
          summary('брошенный', activity(ACTIVE_WINDOW_MS)),
          summary('новичок', undefined),
          summary('живой', activity(ACTIVE_WINDOW_MS - 1000)),
        ],
        { now: NOW },
      );

      expect(order.idle.map((child) => child.id)).toEqual(['брошенный', 'новичок']);
      expect(order.rest.map((child) => child.id)).toEqual(['живой']);
      expect(order.atScreen).toEqual([]);
    });

    it('крутит очередь указателем и называет, с кого начинать следующий обход', () => {
      const children = [
        summary('первый', activity(AT_SCREEN_MS)),
        summary('второй', activity(AT_SCREEN_MS)),
        summary('третий', activity(AT_SCREEN_MS)),
      ];

      const first = orderChildren(children, { now: NOW });
      expect(first.rest.map((child) => child.id)).toEqual(['первый', 'второй', 'третий']);
      expect(first.next).toBe('второй');

      const second = orderChildren(children, { now: NOW, cursor: first.next });
      expect(second.rest.map((child) => child.id)).toEqual(['второй', 'третий', 'первый']);
      expect(second.next).toBe('третий');
    });

    it('не крутит очередь из одного ребёнка', () => {
      const order = orderChildren([summary('один', activity(AT_SCREEN_MS))], { now: NOW });
      expect(order.next).toBeUndefined();
    });

    it('обслуживает ученика за экраном раньше остальных', async () => {
      const sleeping = addKid('Соня', AT_SCREEN_MS + 1000);
      const active = addKid('Ученик', 60 * 1000);
      const served: string[] = [];

      await dispatcher({
        produce: (request) => {
          served.push(request.profile.name);
          return Promise.resolve(batchOf(QUEUE_TARGET));
        },
      }).sweep();

      expect(served[0]).toBe('Ученик');
      expect(new Set(served)).toEqual(new Set(['Ученик', 'Соня']));
      expect(sleeping.id).not.toBe(active.id);
    });

    it('не даёт указателю уморить последнего в очереди', async () => {
      addKid('Первый', AT_SCREEN_MS);
      addKid('Второй', AT_SCREEN_MS);
      addKid('Третий', AT_SCREEN_MS);
      const starts: string[] = [];
      const worker = dispatcher({
        cycle: (options: WorkerOptions) => {
          const name = (options.db.prepare('SELECT name FROM profile').get() as { name: string }).name;
          starts.push(name);
          return Promise.resolve({ topics: [], refilled: [], codexUnavailable: false });
        },
      });

      await worker.sweep();
      const first = starts[0];
      starts.length = 0;
      await worker.sweep();

      expect(first).toBe('Первый');
      expect(starts[0]).toBe('Второй');
    });
  });

  describe('фазы обхода', () => {
    it('обходит ребёнка сначала до порога, потом до запаса', async () => {
      addKid('Ученик');
      const phases: { target?: number; maxBatches?: number; prepareBoss?: boolean }[] = [];
      await dispatcher({
        cycle: (options: WorkerOptions) => {
          phases.push({
            ...(options.target === undefined ? {} : { target: options.target }),
            ...(options.maxBatches === undefined ? {} : { maxBatches: options.maxBatches }),
            ...(options.prepareBoss === undefined ? {} : { prepareBoss: options.prepareBoss }),
          });
          return Promise.resolve({ topics: [], refilled: [], codexUnavailable: false });
        },
      }).sweep();

      expect(phases).toEqual([
        { target: REFILL_BELOW, maxBatches: FLOOR_BATCHES_PER_TOPIC, prepareBoss: false },
        { target: QUEUE_TARGET, maxBatches: MAX_BATCHES_PER_TOPIC, prepareBoss: true },
      ]);
    });

    it('заказывает босса и материал ровно один раз за обход ребёнка', async () => {
      addKid('Первый');
      addKid('Второй');
      const orders: boolean[] = [];
      await dispatcher({
        cycle: (options: WorkerOptions) => {
          orders.push(options.prepareBoss !== false && options.prepareLearning !== false);
          return Promise.resolve({ topics: [], refilled: [], codexUnavailable: false });
        },
      }).sweep();

      expect(orders.filter(Boolean)).toHaveLength(kids.length);
    });

    it('не даёт холодному ребёнку выесть обход целиком', async () => {
      addKid('Холодный');
      addKid('Второй');
      const served: string[] = [];
      // Батч по одному заданию: до запаса такой теме далеко, и без потолка фазы
      // порога первый ребёнок сжёг бы все четыре батча на каждой из трёх тем.
      await dispatcher({
        produce: (request) => {
          served.push(request.profile.name);
          return Promise.resolve(batchOf(1));
        },
      }).sweep();

      // Три темы по одному батчу — и обход переходит ко второму ребёнку.
      expect(served.slice(0, TOPICS.length).every((name) => name === 'Холодный')).toBe(true);
      expect(served[TOPICS.length]).toBe('Второй');
    });

    it('доливает до запаса только в фазе излишков', async () => {
      const kid = addKid('Ученик');
      await dispatcher({ produce: () => Promise.resolve(batchOf(2)) }).sweep();

      // Фаза порога кладёт по два задания на тему (один батч), фаза излишков
      // добивает остальное: без второй фазы тема осталась бы на пороге.
      expect(countAvailable(kid.db, 'math.a')).toBe(QUEUE_TARGET);
    });
  });

  describe('брошенные, недоступные и исчерпавшие квоту', () => {
    it('не греет брошенного ребёнка и берёт его обратно после ответа', async () => {
      const kid = addKid('Вернувшийся', ACTIVE_WINDOW_MS + 1000);
      const served: string[] = [];
      const worker = dispatcher({
        produce: (request) => {
          served.push(request.profile.name);
          return Promise.resolve(batchOf(QUEUE_TARGET));
        },
      });

      const first = await worker.sweep();
      expect(first.idle).toEqual([kid.id]);
      expect(served).toEqual([]);

      // Ответ ученика обновляет отметку тем же путём, что и допуск.
      control.prepare('UPDATE children SET last_activity_at = ? WHERE id = ?')
        .run(activity(0), kid.id);
      const second = await worker.sweep();

      expect(second.idle).toEqual([]);
      expect(served.length).toBeGreaterThan(0);
    });

    it('идёт дальше, когда база одного ребёнка не открывается', async () => {
      const broken = addKid('Испорченный');
      const healthy = addKid('Здоровый');
      const served: string[] = [];
      const worker = new WarmupDispatcher({
        control,
        graph,
        log,
        now: () => NOW,
        open: (childId) => (childId === broken.id ? undefined : healthy.db),
        worker: {
          produce: (request) => {
            served.push(request.profile.name);
            return Promise.resolve(batchOf(QUEUE_TARGET));
          },
        },
      });

      const report = await worker.sweep();

      expect(report.children.find((child) => child.childId === broken.id)?.skipped)
        .toBe('unavailable');
      expect(served.every((name) => name === 'Здоровый')).toBe(true);
      expect(served.length).toBeGreaterThan(0);
    });

    // Исчерпанная квота приезжает той же недоступностью, что и отсутствующий
    // codex. Останавливать из-за неё обход значило бы, что один наигравшийся
    // ребёнок морозит прогрев всей семье до полуночи.
    it('пропускает исчерпавшего квоту, не останавливая обход', async () => {
      const spent = addKid('Наигравшийся');
      addKid('Второй');
      for (let call = 0; call < 3; call += 1) reserveCodexCall(control, spent.id, NOW, 3);
      const served: string[] = [];

      const worker = new WarmupDispatcher({
        control,
        graph,
        log,
        now: () => NOW,
        quotaLimit: 3,
        open: (childId) => kids.find((kid) => kid.id === childId)?.db,
        worker: {
          produce: (request) => {
            served.push(request.profile.name);
            return Promise.resolve(batchOf(QUEUE_TARGET));
          },
        },
      });
      const report = await worker.sweep();

      expect(report.codexUnavailable).toBe(false);
      expect(report.children.find((child) => child.childId === spent.id)?.skipped).toBe('quota');
      expect(served.every((name) => name === 'Второй')).toBe(true);
      expect(served.length).toBeGreaterThan(0);
      expect(logged.join('\n')).toMatch(/суточная квота ребёнка .* исчерпана/u);
    });
  });

  describe('пауза между обходами', () => {
    it('растёт от базовой вдвое за каждый отказ подряд и упирается в потолок', () => {
      expect(backoffDelay(0)).toBe(IDLE_INTERVAL_MS);
      expect(backoffDelay(1)).toBe(BACKOFF_BASE_MS);
      expect(backoffDelay(2)).toBe(BACKOFF_BASE_MS * 2);
      expect(backoffDelay(3)).toBe(BACKOFF_BASE_MS * 4);
      expect(backoffDelay(50)).toBe(BACKOFF_MAX_MS);
    });

    it('откладывает следующий обход всё дальше, пока codex не отвечает', async () => {
      addKid('Ученик');
      const delays: number[] = [];
      let calls = 0;
      const worker = dispatcher({
        produce: () => {
          calls += 1;
          return Promise.reject(new CodexUnavailableError('codex не найден'));
        },
        wait: async (ms) => {
          delays.push(ms);
          if (delays.length >= 3) void worker.stop();
        },
      });

      worker.start();
      await worker.done;

      expect(delays).toEqual([BACKOFF_BASE_MS, BACKOFF_BASE_MS * 2, BACKOFF_BASE_MS * 4]);
      // По два вызова на обход: недоступность обрывает обход на первом же
      // окне одновременности, не доходя до третьей темы и второй фазы.
      expect(calls).toBe(2 * delays.length);
    });

    it('возвращается к обычному интервалу, когда codex снова отвечает', async () => {
      const kid = addKid('Ученик');
      const delays: number[] = [];
      let calls = 0;
      const worker = dispatcher({
        produce: () => {
          calls += 1;
          return calls === 1
            ? Promise.reject(new CodexUnavailableError('codex не найден'))
            : Promise.resolve(batchOf(QUEUE_TARGET));
        },
        wait: async (ms) => {
          delays.push(ms);
          if (delays.length >= 2) void worker.stop();
        },
      });

      worker.start();
      await worker.done;

      expect(delays).toEqual([BACKOFF_BASE_MS, IDLE_INTERVAL_MS]);
      expect(countAvailable(kid.db, 'math.a')).toBe(QUEUE_TARGET);
    });

    // `CodexUnavailableError` покрывает не всякий отказ модели: процесс,
    // стартовавший и вышедший с ненулевым кодом, приезжает `CodexRunError`.
    it('откладывает обход, в котором ни один ребёнок ничего не долил', async () => {
      addKid('Первый');
      addKid('Второй');
      const delays: number[] = [];
      const worker = dispatcher({
        produce: () => Promise.reject(new CodexRunError('codex завершился с кодом 1: not logged in')),
        wait: async (ms) => {
          delays.push(ms);
          if (delays.length >= 2) void worker.stop();
        },
      });

      worker.start();
      await worker.done;

      expect(delays).toEqual([BACKOFF_BASE_MS, BACKOFF_BASE_MS * 2]);
      expect(logged.join('\n')).toMatch(/ни одна из \d+ фоновых подготовок не дала заданий/u);
    });

    // Иначе отступ включался бы на здоровой модели: одному ребёнку не повезло,
    // соседнему долили — очередь греется, ждать полчаса не за чем.
    it('не откладывает обход, в котором долился хотя бы один ребёнок', async () => {
      addKid('Невезучий');
      addKid('Везучий');
      const delays: number[] = [];
      const worker = dispatcher({
        produce: (request) =>
          request.profile.name === 'Невезучий'
            ? Promise.reject(new CodexRunError('codex завершился с кодом 1'))
            : Promise.resolve(batchOf(QUEUE_TARGET)),
        wait: async (ms) => {
          delays.push(ms);
          void worker.stop();
        },
      });

      worker.start();
      await worker.done;

      expect(delays).toEqual([IDLE_INTERVAL_MS]);
    });

    // Пустой обход — не отказ: греть просто нечего, все темы уже тёплые.
    it('не откладывает обход, в котором голодных тем не было', async () => {
      const kid = addKid('Ученик');
      for (const item of TOPICS) storeTasks(kid.db, item.id, batchOf(QUEUE_TARGET));
      const delays: number[] = [];
      const worker = dispatcher({
        produce: () => Promise.reject(new CodexRunError('сюда дойти не должны')),
        wait: async (ms) => {
          delays.push(ms);
          // Два обхода: `IDLE_INTERVAL_MS` и `BACKOFF_BASE_MS` совпадают, и по
          // одной паузе «отступа нет» от «отступ взведён» не отличить.
          if (delays.length === 2) void worker.stop();
        },
      });

      worker.start();
      await worker.done;

      expect(delays).toEqual([IDLE_INTERVAL_MS, IDLE_INTERVAL_MS]);
    });

    it('не роняет диспетчер на неожиданной ошибке захода', async () => {
      const kid = addKid('Ученик');
      // Профиль читается до всякой генерации: разбор его полей — это уже не
      // отказ темы, а отказ захода.
      kid.db.prepare('UPDATE profile SET interests = ?').run('не json');
      const delays: number[] = [];
      const worker = dispatcher({
        produce: () => Promise.resolve(batchOf(QUEUE_TARGET)),
        wait: async (ms) => {
          delays.push(ms);
          if (delays.length === 2) void worker.stop();
        },
      });

      worker.start();
      await worker.done;

      expect(delays).toEqual([BACKOFF_BASE_MS, BACKOFF_BASE_MS * 2]);
      expect(logged.join('\n')).toMatch(/обход ребёнка .* провалился.*Профиль повреждён/su);
    });

    it('останавливается по stop, не начиная нового обхода', async () => {
      addKid('Ученик');
      const delays: number[] = [];
      let sweeps = 0;
      const worker = dispatcher({
        cycle: () => {
          sweeps += 1;
          return Promise.resolve({ topics: [], refilled: [], codexUnavailable: false });
        },
        wait: async (ms) => {
          delays.push(ms);
          void worker.stop();
        },
      });

      worker.start();
      await worker.done;

      // Два захода — фаза порога и фаза излишков одного и того же обхода.
      expect(sweeps).toBe(2);
      expect(delays).toEqual([IDLE_INTERVAL_MS]);
    });

    it('прерывает начатую паузу будильником, а не досиживает её', async () => {
      addKid('Ученик');
      let paused = false;
      let sweeps = 0;
      const worker = dispatcher({
        cycle: () => {
          sweeps += 1;
          return Promise.resolve({ topics: [], refilled: [], codexUnavailable: false });
        },
        // Пауза не кончается сама: единственный выход — будильник.
        wait: (): Promise<void> => {
          paused = true;
          return new Promise<void>(() => undefined);
        },
      });

      worker.start();
      await waitFor(() => paused);
      worker.wake();
      await waitFor(() => sweeps >= 4);
      await worker.stop();

      expect(sweeps).toBeGreaterThanOrEqual(4);
    });

    // Иначе занимающийся ученик будил бы диспетчер каждым своим запросом, и
    // получасовой отступ по недоступной модели не наступал бы никогда.
    it('не будит диспетчер ради ребёнка, который уже в обходе', async () => {
      const kid = addKid('Ученик');
      let sweeps = 0;
      const worker = dispatcher({
        cycle: () => {
          sweeps += 1;
          return Promise.resolve({ topics: [], refilled: [], codexUnavailable: false });
        },
        wait: (): Promise<void> => new Promise<void>(() => undefined),
      });

      worker.start();
      await waitFor(() => sweeps >= 2);
      worker.wake(kid.id);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      const afterKnown = sweeps;
      worker.wake('чужой');
      await waitFor(() => sweeps > afterKnown);
      await worker.stop();

      expect(afterKnown).toBe(2);
      expect(sweeps).toBeGreaterThan(afterKnown);
    });
  });

  describe('итог обхода', () => {
    const sweepOf = (children: SweepReport['children']): SweepReport => ({
      children,
      idle: [],
      codexUnavailable: false,
    });
    const cycleOf = (stored: number, error?: string): CycleReport => ({
      topics: ['math.a'],
      refilled: [
        { topicId: 'math.a', batches: 1, stored, available: stored, ...(error === undefined ? {} : { error }) },
      ],
      codexUnavailable: false,
    });

    it('считает провалом обход, в котором ни один ребёнок ничего не долил', () => {
      expect(everySweepFailed(sweepOf([
        { childId: 'a', cycles: [cycleOf(0, 'codex завершился с кодом 1')] },
        { childId: 'b', cycles: [cycleOf(0, 'codex завершился с кодом 1')] },
      ]))).toBe(true);
    });

    it('не считает провалом обход, в котором долился хотя бы один ребёнок', () => {
      expect(everySweepFailed(sweepOf([
        { childId: 'a', cycles: [cycleOf(0, 'codex завершился с кодом 1')] },
        { childId: 'b', cycles: [cycleOf(5)] },
      ]))).toBe(false);
    });

    it('считает провалом заход, который не состоялся вовсе', () => {
      expect(everySweepFailed(sweepOf([{ childId: 'a', cycles: [], skipped: 'error' }]))).toBe(true);
    });

    // Ни исчерпанная квота, ни недоступная база вызовов модели не стоят:
    // повторная проверка раз в минуту дешевле получасовой заморозки прогрева.
    it('не считает провалом ни исчерпанную квоту, ни недоступную базу', () => {
      expect(everySweepFailed(sweepOf([
        { childId: 'a', cycles: [], skipped: 'quota' },
        { childId: 'b', cycles: [], skipped: 'unavailable' },
      ]))).toBe(false);
    });

    it('не считает провалом обход без единой попытки', () => {
      expect(everySweepFailed(sweepOf([]))).toBe(false);
    });
  });

  it('держит калибровочные числа спеки', () => {
    expect(IDLE_INTERVAL_MS).toBe(60_000);
    expect(BACKOFF_BASE_MS).toBe(60_000);
    expect(BACKOFF_MAX_MS).toBe(1_800_000);
    expect(ACTIVE_WINDOW_MS).toBe(172_800_000);
    expect(AT_SCREEN_MS).toBe(900_000);
    expect(FLOOR_BATCHES_PER_TOPIC).toBe(1);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('условие теста не наступило');
}
