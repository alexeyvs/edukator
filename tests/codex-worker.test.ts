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
import { storeTasks, countAvailable, takeTask } from '../server/codex/bank.js';
import { CodexUnavailableError, type CodexRequest } from '../server/codex/client.js';
import type { GeneratedTask } from '../server/codex/task-schema.js';
import {
  activeTopics,
  backoffDelay,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  IDLE_INTERVAL_MS,
  MAX_BATCHES_PER_TOPIC,
  MAX_CODEX_CONCURRENCY,
  QUEUE_TARGET,
  REFILL_BELOW,
  runWarmupCycle,
  startWorker,
  WARM_TOPICS,
  type ProduceRequest,
  type TaskProducer,
} from '../server/codex/worker.js';

function topic(id: string, patch: Partial<Topic> = {}): Topic {
  return {
    id,
    subject: id.startsWith('math') ? 'math' : id.startsWith('russian') ? 'russian' : 'english',
    title: `Тема ${id}`,
    examWeight: 3,
    difficulty: 2,
    prereqs: [],
    answerFormat: 'number',
    promptSeed: `Спрашивай по теме ${id}.`,
    ...patch,
  };
}

/** Карта из шести тем по двум на предмет: планировщик чередует предметы. */
function graphOf(topics: Topic[]): TopicGraph {
  return buildTopicGraph(topics);
}

const WIDE = [
  topic('math.a'),
  topic('math.b'),
  topic('russian.a'),
  topic('russian.b'),
  topic('english.a'),
  topic('english.b'),
];

let counter = 0;

/** Задание с заведомо неповторимой формулировкой: банк отсеивает дубли. */
function task(topicId: string, patch: Partial<GeneratedTask> = {}): GeneratedTask {
  counter += 1;
  return {
    question: `Задание ${counter} по теме ${topicId}: сколько монет останется?`,
    answer: '45',
    accept: ['45', '45 монет'],
    hint: 'Посчитай по шагам.',
    explain: 'Сорок пять — то, что осталось.',
    joke: 'Не Нобелевка, но зачёт.',
    difficulty: 2,
    ...patch,
  };
}

function batchOf(topicId: string, count: number): GeneratedTask[] {
  return Array.from({ length: count }, () => task(topicId));
}

/** Подставной производитель: запоминает запросы, отдаёт по `size` заданий. */
function producer(size = 5): { requests: ProduceRequest[]; produce: TaskProducer } {
  const requests: ProduceRequest[] = [];
  return {
    requests,
    produce: (request: ProduceRequest): Promise<GeneratedTask[]> => {
      requests.push(request);
      return Promise.resolve(batchOf(request.topic.id, size));
    },
  };
}

describe('воркер тёплой очереди', () => {
  let tempDir: string;
  let db: Database;
  const logged: string[] = [];
  const log = (message: string): void => {
    logged.push(message);
  };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-worker-'));
    db = openDatabase(join(tempDir, 'test.db'));
    syncTopicState(db, graphOf(WIDE));
    logged.length = 0;
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('пороги пополнения', () => {
    it('доливает тему до запаса и останавливается на нём', async () => {
      const graph = graphOf([topic('math.a')]);
      storeTasks(db, 'math.a', batchOf('math.a', 3));
      const { requests, produce } = producer(5);

      const report = await runWarmupCycle({ db, graph, produce, log });

      expect(requests).toHaveLength(1);
      expect(countAvailable(db, 'math.a')).toBe(QUEUE_TARGET);
      expect(report.refilled).toEqual([
        { topicId: 'math.a', batches: 1, stored: 5, available: QUEUE_TARGET },
      ]);
      expect(report.codexUnavailable).toBe(false);
    });

    it('не трогает тему, пока остаток не упал ниже порога', async () => {
      const graph = graphOf([topic('math.a')]);
      storeTasks(db, 'math.a', batchOf('math.a', REFILL_BELOW));
      const { requests, produce } = producer();

      const report = await runWarmupCycle({ db, graph, produce, log });

      expect(requests).toEqual([]);
      expect(report.refilled).toEqual([]);
      expect(report.topics).toEqual(['math.a']);
    });

    it('запускает долив ровно на падении ниже порога', async () => {
      const graph = graphOf([topic('math.a')]);
      storeTasks(db, 'math.a', batchOf('math.a', REFILL_BELOW));
      takeTask(db, 'math.a');
      const { requests, produce } = producer();

      await runWarmupCycle({ db, graph, produce, log });

      expect(requests).toHaveLength(1);
    });

    it('запрашивает столько батчей, сколько нужно до запаса', async () => {
      const graph = graphOf([topic('math.a')]);
      const { requests, produce } = producer(3);

      const report = await runWarmupCycle({ db, graph, produce, log });

      expect(requests).toHaveLength(3);
      expect(countAvailable(db, 'math.a')).toBe(9);
      expect(report.refilled[0]?.stored).toBe(9);
    });

    it('передаёт производителю тему, её сложность, профиль и прошлые формулировки', async () => {
      const graph = graphOf([topic('math.a', { difficulty: 3 })]);
      writeProfile(db, { name: 'Тимофей', interests: ['Minecraft'] });
      storeTasks(db, 'math.a', [task('math.a', { question: 'Старая формулировка про монеты?' })]);
      const { requests, produce } = producer(7);

      await runWarmupCycle({ db, graph, produce, log });

      expect(requests[0]?.topic.id).toBe('math.a');
      expect(requests[0]?.difficulty).toBe(3);
      expect(requests[0]?.profile.name).toBe('Тимофей');
      expect(requests[0]?.profile.interests).toEqual(['Minecraft']);
      expect(requests[0]?.recent).toEqual(['Старая формулировка про монеты?']);
    });

    it('прекращает долив темы, из батча которой не осталось ничего нового', async () => {
      const graph = graphOf([topic('math.a')]);
      const repeat = task('math.a');
      storeTasks(db, 'math.a', [repeat]);
      const requests: ProduceRequest[] = [];

      const report = await runWarmupCycle({
        db,
        graph,
        log,
        produce: (request) => {
          requests.push(request);
          return Promise.resolve([repeat]);
        },
      });

      expect(requests).toHaveLength(1);
      expect(report.refilled[0]).toMatchObject({ batches: 1, stored: 0, available: 1 });
      expect(logged.join('\n')).toMatch(/весь батч отсеян/u);
    });

    it('не крутится вечно на теме, которую нечем пополнить', async () => {
      const graph = graphOf([topic('math.a')]);
      const requests: ProduceRequest[] = [];

      const report = await runWarmupCycle({
        db,
        graph,
        log,
        produce: (request) => {
          requests.push(request);
          // Каждый батч годен, но до запаса всё равно не дотягивает.
          return Promise.resolve(batchOf(request.topic.id, 1));
        },
      });

      expect(requests).toHaveLength(MAX_BATCHES_PER_TOPIC);
      expect(report.refilled[0]?.batches).toBe(MAX_BATCHES_PER_TOPIC);
    });
  });

  describe('предел одновременных вызовов', () => {
    it('не запускает больше двух пополнений сразу', async () => {
      const graph = graphOf(WIDE);
      let active = 0;
      let peak = 0;
      const seen: string[] = [];

      await runWarmupCycle({
        db,
        graph,
        topics: 4,
        log,
        produce: async (request): Promise<GeneratedTask[]> => {
          active += 1;
          peak = Math.max(peak, active);
          seen.push(request.topic.id);
          // Две уступки планировщику событий: без них вся работа успевает
          // пройти синхронно и предел ничего бы не показал.
          await Promise.resolve();
          await Promise.resolve();
          active -= 1;
          return batchOf(request.topic.id, QUEUE_TARGET);
        },
      });

      expect(new Set(seen).size).toBe(4);
      expect(peak).toBe(MAX_CODEX_CONCURRENCY);
    });

    it('уважает заданный предел одновременности', async () => {
      const graph = graphOf(WIDE);
      let active = 0;
      let peak = 0;

      await runWarmupCycle({
        db,
        graph,
        topics: 4,
        concurrency: 1,
        log,
        produce: async (request): Promise<GeneratedTask[]> => {
          active += 1;
          peak = Math.max(peak, active);
          await Promise.resolve();
          active -= 1;
          return batchOf(request.topic.id, QUEUE_TARGET);
        },
      });

      expect(peak).toBe(1);
    });
  });

  describe('выборка тем', () => {
    it('греет только темы плана, а не всю карту', async () => {
      const graph = graphOf(WIDE);
      const { requests, produce } = producer(QUEUE_TARGET);

      const report = await runWarmupCycle({ db, graph, produce, log, topics: 2 });

      expect(report.topics).toHaveLength(2);
      expect(requests.map((request) => request.topic.id).sort()).toEqual([...report.topics].sort());
    });

    it('не берёт тему, которую планировщик не предложит никогда', async () => {
      const graph = graphOf([topic('math.a'), topic('math.dead', { examWeight: 0 })]);
      syncTopicState(db, graph);
      const { requests, produce } = producer(QUEUE_TARGET);

      const report = await runWarmupCycle({ db, graph, produce, log, topics: WARM_TOPICS });

      expect(report.topics).toEqual(['math.a']);
      expect(requests.map((request) => request.topic.id)).toEqual(['math.a']);
      expect(countAvailable(db, 'math.dead')).toBe(0);
    });

    it('греет тему идущего забега, хотя план её сегодня больше не предложит', () => {
      const graph = graphOf(WIDE);
      const now = new Date('2026-08-07T18:00:00.000Z');
      db.prepare('INSERT INTO runs (subject, topic_id, started_at) VALUES (?, ?, ?)').run(
        'russian',
        'russian.b',
        now.toISOString(),
      );

      const active = activeTopics(db, graph, { topics: 1, now });

      expect(active[0]?.id).toBe('russian.b');
      // Планировщик её сегодня уже не предложит, так что второй раз она в
      // выборку не попадает — иначе воркер грел бы одну тему дважды.
      expect(new Set(active.map((item) => item.id)).size).toBe(active.length);
    });
  });

  describe('производитель по умолчанию', () => {
    /** Ответы codex по порядку: сначала батч генератора, потом вердикты. */
    function codexStub(answers: (string | Error)[]): {
      calls: number;
      run: (request: CodexRequest) => Promise<string>;
    } {
      const state = { calls: 0, run: (): Promise<string> => Promise.resolve('') };
      state.run = (): Promise<string> => {
        const next = answers[state.calls];
        state.calls += 1;
        if (next === undefined) return Promise.reject(new Error('лишний вызов codex'));
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      };
      return state;
    }

    function verdict(answer: string, patch: Record<string, unknown> = {}): unknown {
      return {
        answer,
        unambiguous: true,
        natural: true,
        on_topic: true,
        age_appropriate: true,
        note: '',
        ...patch,
      };
    }

    it('пропускает батч через генератор и проверяющего, кладя в банк только принятые', async () => {
      const graph = graphOf([topic('math.a')]);
      const tasks = batchOf('math.a', 3);
      const stub = codexStub([
        JSON.stringify({ items: tasks }),
        JSON.stringify({
          items: [verdict('45'), verdict('46'), verdict('45', { natural: false })],
        }),
      ]);

      const report = await runWarmupCycle({
        db,
        graph,
        log,
        maxBatches: 1,
        run: stub.run,
      });

      expect(stub.calls).toBe(2);
      expect(report.refilled[0]).toMatchObject({ batches: 1, stored: 1, available: 1 });
      expect(countAvailable(db, 'math.a')).toBe(1);
      expect(logged.join('\n')).toMatch(/отбраковано.*проверяющий ответил «46»/u);
      expect(logged.join('\n')).toMatch(/отбраковано.*ситуация натянута/u);
    });

    it('докладывает о недоступности codex, а не глотает её', async () => {
      const graph = graphOf([topic('math.a')]);
      const stub = codexStub([new CodexUnavailableError('codex не найден')]);

      const report = await runWarmupCycle({ db, graph, log, run: stub.run });

      expect(report.codexUnavailable).toBe(true);
      expect(countAvailable(db, 'math.a')).toBe(0);
    });
  });

  describe('ошибочные сценарии', () => {
    it('не роняет цикл на недоступном codex и пишет о нём в лог', async () => {
      const graph = graphOf(WIDE);
      const seen: string[] = [];

      const report = await runWarmupCycle({
        db,
        graph,
        topics: 4,
        concurrency: 1,
        log,
        produce: (request) => {
          seen.push(request.topic.id);
          return Promise.reject(new CodexUnavailableError('codex не найден'));
        },
      });

      expect(report.codexUnavailable).toBe(true);
      expect(report.refilled).toEqual([]);
      // Остальные темы даже не пробуются: codex не появится к следующей.
      expect(seen).toHaveLength(1);
      expect(logged.join('\n')).toMatch(/codex недоступен.*codex не найден/u);
    });

    it('отбивается от провала генерации по одной теме, не бросая остальные', async () => {
      const graph = graphOf(WIDE);

      const report = await runWarmupCycle({
        db,
        graph,
        topics: 3,
        concurrency: 1,
        log,
        produce: (request) =>
          request.topic.id === 'math.a'
            ? Promise.reject(new Error('не сгенерированы за 3 попыт(ок)'))
            : Promise.resolve(batchOf(request.topic.id, QUEUE_TARGET)),
      });

      expect(report.codexUnavailable).toBe(false);
      expect(report.refilled.find((item) => item.topicId === 'math.a')?.error).toMatch(
        /не сгенерированы/u,
      );
      expect(report.refilled.filter((item) => item.error === undefined)).toHaveLength(2);
      expect(logged.join('\n')).toMatch(/math\.a. не пополнена/u);
    });

    it('падает, когда порог долива выше запаса', async () => {
      const graph = graphOf([topic('math.a')]);

      await expect(
        runWarmupCycle({ db, graph, target: 2, threshold: 5, log, produce: producer().produce }),
      ).rejects.toThrow(/порог долива 5 выше запаса 2/u);
    });
  });

  describe('пауза между циклами', () => {
    it('растёт от базовой вдвое за каждый отказ подряд и упирается в потолок', () => {
      expect(backoffDelay(0)).toBe(IDLE_INTERVAL_MS);
      expect(backoffDelay(1)).toBe(BACKOFF_BASE_MS);
      expect(backoffDelay(2)).toBe(BACKOFF_BASE_MS * 2);
      expect(backoffDelay(3)).toBe(BACKOFF_BASE_MS * 4);
      expect(backoffDelay(50)).toBe(BACKOFF_MAX_MS);
    });

    it('откладывает следующий цикл всё дальше, пока codex не отвечает', async () => {
      const graph = graphOf([topic('math.a')]);
      const delays: number[] = [];
      let cycles = 0;

      const handle = startWorker({
        db,
        graph,
        log,
        produce: () => {
          cycles += 1;
          return Promise.reject(new CodexUnavailableError('codex не найден'));
        },
        wait: (ms): Promise<void> => {
          delays.push(ms);
          if (delays.length >= 3) handle.stop();
          return Promise.resolve();
        },
      });

      await handle.done;

      expect(cycles).toBe(3);
      expect(delays).toEqual([BACKOFF_BASE_MS, BACKOFF_BASE_MS * 2, BACKOFF_BASE_MS * 4]);
    });

    it('возвращается к обычному интервалу, когда codex снова отвечает', async () => {
      const graph = graphOf([topic('math.a')]);
      const delays: number[] = [];
      let cycles = 0;

      const handle = startWorker({
        db,
        graph,
        log,
        produce: (request) => {
          cycles += 1;
          return cycles === 1
            ? Promise.reject(new CodexUnavailableError('codex не найден'))
            : Promise.resolve(batchOf(request.topic.id, QUEUE_TARGET));
        },
        wait: (ms): Promise<void> => {
          delays.push(ms);
          if (delays.length >= 2) handle.stop();
          return Promise.resolve();
        },
      });

      await handle.done;

      expect(delays).toEqual([BACKOFF_BASE_MS, IDLE_INTERVAL_MS]);
      expect(countAvailable(db, 'math.a')).toBe(QUEUE_TARGET);
    });

    it('не роняет воркер на неожиданной ошибке цикла', async () => {
      const graph = graphOf([topic('math.unknown')]);
      const delays: number[] = [];

      const handle = startWorker({
        db,
        graph,
        log,
        produce: producer().produce,
        wait: (ms): Promise<void> => {
          delays.push(ms);
          handle.stop();
          return Promise.resolve();
        },
      });

      await handle.done;

      expect(delays).toEqual([BACKOFF_BASE_MS]);
      expect(logged.join('\n')).toMatch(/цикл пополнения провалился.*нет в карте/su);
    });

    it('останавливается по stop, не начиная нового цикла', async () => {
      const graph = graphOf([topic('math.a')]);
      const delays: number[] = [];
      let cycles = 0;

      const handle = startWorker({
        db,
        graph,
        log,
        produce: (request) => {
          cycles += 1;
          return Promise.resolve(batchOf(request.topic.id, QUEUE_TARGET));
        },
        wait: (ms): Promise<void> => {
          delays.push(ms);
          handle.stop();
          return Promise.resolve();
        },
      });

      await handle.done;

      expect(cycles).toBe(1);
      expect(delays).toEqual([IDLE_INTERVAL_MS]);
    });
  });

  it('держит калибровочные числа спеки', () => {
    expect(QUEUE_TARGET).toBe(8);
    expect(REFILL_BELOW).toBe(4);
    expect(MAX_CODEX_CONCURRENCY).toBe(2);
    expect(WARM_TOPICS).toBe(3);
    expect(IDLE_INTERVAL_MS).toBe(60_000);
    expect(BACKOFF_BASE_MS).toBe(60_000);
    expect(BACKOFF_MAX_MS).toBe(1_800_000);
  });
});
