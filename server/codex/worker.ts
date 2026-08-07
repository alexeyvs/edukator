/**
 * Воркер тёплой очереди: фоном держит в банке запас провалидированных заданий
 * по тем темам, которые ученик увидит ближайшими. Задача этапа сформулирована
 * жёстко — «ученик никогда не видит спиннер», а батч из пяти заданий занимает у
 * модели 23.6 секунды, так что генерировать в момент показа нельзя.
 *
 * Состав тем воркер не хранит: и план ближайших забегов, и темы уже начатых
 * сегодня берутся у планировщика этапа 1. Второе нужно потому, что тема идущего
 * забега для планировщика уже «использована сегодня» и в план больше не попадёт,
 * а задания прямо сейчас берутся именно из неё.
 *
 * Недоступность codex воркер не считает поводом упасть: попытки прекращаются,
 * пауза до следующего цикла растёт, причина уходит в лог. Сервер обязан
 * продолжать отдавать то, что уже лежит в банке.
 */
import type { Database } from 'better-sqlite3';
import type { Topic, TopicGraph } from '../curriculum.js';
import { readProfile, type Profile } from '../db.js';
import { planFromDatabase, topicsUsedToday } from '../scheduler.js';
import { countAvailable, recentQuestions, storeTasks } from './bank.js';
import { CodexUnavailableError, type CodexRunner } from './client.js';
import { generateTaskBatch } from './generate.js';
import type { GeneratedTask } from './task-schema.js';
import { validateTaskBatch } from './validate.js';

/** Запас заданий на активную тему, до которого доливает воркер. */
export const QUEUE_TARGET = 8;

/** Остаток, ниже которого запускается долив. Выше — тема не трогается. */
export const REFILL_BELOW = 4;

/**
 * Предел одновременных вызовов codex. Пополнение одной темы — два вызова
 * подряд (генератор, затем проверяющий), поэтому предел считается по темам.
 */
export const MAX_CODEX_CONCURRENCY = 2;

/** Сколько ближайших забегов планировщика греется про запас. */
export const WARM_TOPICS = 3;

/**
 * Потолок батчей на тему за цикл. Двух батчей хватает на пустую тему; потолок
 * нужен на случай, когда проверяющий отбраковывает всё подряд и цикл иначе
 * крутился бы на одной теме, не давая дойти до остальных.
 */
export const MAX_BATCHES_PER_TOPIC = 4;

/** Пауза между циклами, когда всё в порядке. */
export const IDLE_INTERVAL_MS = 60 * 1000;

/** Первая пауза после недоступности codex; дальше удваивается. */
export const BACKOFF_BASE_MS = 60 * 1000;

/** Потолок паузы: codex может вернуться в любой момент, и ждать его полдня незачем. */
export const BACKOFF_MAX_MS = 30 * 60 * 1000;

/** Что нужно генератору для одного батча по теме. */
export interface ProduceRequest {
  topic: Topic;
  /** Целевая сложность 1-3. */
  difficulty: number;
  /** Формулировки, которые повторять нельзя. */
  recent: string[];
  profile: Profile;
}

/**
 * Производитель заданий: батч, уже прошедший проверку. Вынесен за интерфейс,
 * чтобы тесты проверяли политику очереди, не запуская процессов.
 */
export type TaskProducer = (request: ProduceRequest) => Promise<GeneratedTask[]>;

export type WorkerLog = (message: string) => void;

export interface WorkerOptions {
  db: Database;
  graph: TopicGraph;
  /** Сколько ближайших тем плана греть; по умолчанию `WARM_TOPICS`. */
  topics?: number;
  /** Запас, до которого доливать; по умолчанию `QUEUE_TARGET`. */
  target?: number;
  /** Порог долива; по умолчанию `REFILL_BELOW`. */
  threshold?: number;
  /** Предел одновременных пополнений; по умолчанию `MAX_CODEX_CONCURRENCY`. */
  concurrency?: number;
  /** Потолок батчей на тему за цикл; по умолчанию `MAX_BATCHES_PER_TOPIC`. */
  maxBatches?: number;
  /** Производитель заданий; по умолчанию генератор с проверяющим. */
  produce?: TaskProducer;
  now?: () => Date;
  log?: WorkerLog;
  /** Модель codex для генератора и проверяющего; по умолчанию рабочая. */
  model?: string;
  /** Подменяемый вызов codex: тесты передают заглушку. */
  run?: CodexRunner;
}

export interface RefillReport {
  topicId: string;
  /** Сколько батчей запрошено, включая отбракованные целиком. */
  batches: number;
  /** Сколько заданий доехало до банка. */
  stored: number;
  /** Остаток непросмотренных заданий темы после долива. */
  available: number;
  /** Причина, по которой долив прекратился раньше цели. */
  error?: string;
}

export interface CycleReport {
  /** Активные темы цикла в том порядке, в котором их греет воркер. */
  topics: string[];
  refilled: RefillReport[];
  /** codex не запускается: следующий цикл откладывается с возрастающей паузой. */
  codexUnavailable: boolean;
}

function defaultLog(message: string): void {
  process.stderr.write(`${message}\n`);
}

export interface ProducerOptions {
  log?: WorkerLog;
  /** Модель codex для генератора и проверяющего; по умолчанию рабочая. */
  model?: string;
  /** Подменяемый вызов codex: тесты передают заглушку. */
  run?: CodexRunner;
}

/**
 * Батч через генератор и проверяющего: наружу выходят только принятые задания,
 * причины отбраковки уходят в лог — по ним видно, что именно портит генерацию.
 */
export function createValidatingProducer(options: ProducerOptions = {}): TaskProducer {
  const { model, run } = options;
  const log = options.log ?? defaultLog;
  const codex = {
    ...(model === undefined ? {} : { model }),
    ...(run === undefined ? {} : { run }),
  };

  return async (request: ProduceRequest): Promise<GeneratedTask[]> => {
    const { topic } = request;
    const { tasks } = await generateTaskBatch({
      topic,
      difficulty: request.difficulty,
      profile: request.profile,
      recent: request.recent,
      ...codex,
    });

    const { accepted, rejected } = await validateTaskBatch({ topic, tasks, ...codex });

    for (const { task, reason } of rejected) {
      log(`воркер: тема «${topic.id}», задание отбраковано (${reason}): ${task.question}`);
    }

    return accepted;
  };
}

/**
 * Темы, которые воркер греет: сначала темы уже начатых сегодня забегов, потом
 * план ближайших. Свой список воркер не ведёт — оба источника принадлежат
 * планировщику, и расхождение означало бы генерацию не туда.
 */
export function activeTopics(
  db: Database,
  graph: TopicGraph,
  options: { topics?: number; now?: Date } = {},
): Topic[] {
  const now = options.now ?? new Date();
  const started = [...topicsUsedToday(db, now)]
    .map((id) => graph.byId.get(id))
    .filter((topic): topic is Topic => topic !== undefined);
  const planned = planFromDatabase(db, graph, options.topics ?? WARM_TOPICS, now).map(
    (run) => run.topic,
  );

  const seen = new Set<string>();
  const active: Topic[] = [];
  for (const topic of [...started, ...planned]) {
    if (seen.has(topic.id)) continue;
    seen.add(topic.id);
    active.push(topic);
  }
  return active;
}

/** Очередь с пределом одновременных исполнителей. Порядок выдачи — исходный. */
async function pool<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await work(item);
    }
  });
  await Promise.all(runners);
}

interface RefillContext {
  db: Database;
  produce: TaskProducer;
  profile: Profile;
  target: number;
  maxBatches: number;
  log: WorkerLog;
  aborted: () => boolean;
}

/**
 * Доливает одну тему до `target`. Ошибку генерации записывает в отчёт и
 * прекращает долив этой темы: остальные темы всё равно надо успеть погреть.
 * Недоступность codex летит наверх — она относится не к теме, а к циклу.
 */
async function refillTopic(topic: Topic, context: RefillContext): Promise<RefillReport> {
  const { db, log, target } = context;
  let available = countAvailable(db, topic.id);
  let batches = 0;
  let stored = 0;

  while (available < target && batches < context.maxBatches && !context.aborted()) {
    batches += 1;

    let tasks: GeneratedTask[];
    try {
      tasks = await context.produce({
        topic,
        // Целевая сложность — базовая сложность темы: очередь греется заранее,
        // когда точность ученика по теме ещё неизвестна.
        difficulty: topic.difficulty,
        recent: recentQuestions(db, topic.id),
        profile: context.profile,
      });
    } catch (error) {
      if (error instanceof CodexUnavailableError) throw error;
      const message = (error as Error).message;
      log(`воркер: тема «${topic.id}» не пополнена: ${message}`);
      return { topicId: topic.id, batches, stored, available, error: message };
    }

    const result = storeTasks(db, topic.id, tasks);
    stored += result.stored.length;
    available = countAvailable(db, topic.id);

    // Батч, из которого не осталось ничего нового, повторять внутри цикла
    // бессмысленно: следующий придёт с тем же списком прошлых формулировок.
    if (result.stored.length === 0) {
      log(`воркер: тема «${topic.id}» не пополнилась, весь батч отсеян`);
      break;
    }
  }

  return { topicId: topic.id, batches, stored, available };
}

/**
 * Один проход пополнения: активные темы, из них голодные, из них — долив до
 * запаса. Исключений наружу не отдаёт, кроме тех, что делают дальнейшую работу
 * бессмысленной (нечитаемая база): воркер живёт внутри сервера.
 */
export async function runWarmupCycle(options: WorkerOptions): Promise<CycleReport> {
  const { db, graph } = options;
  const target = options.target ?? QUEUE_TARGET;
  const threshold = options.threshold ?? REFILL_BELOW;
  if (threshold > target) {
    throw new Error(`Воркер: порог долива ${threshold} выше запаса ${target}`);
  }

  const log = options.log ?? defaultLog;
  const produce =
    options.produce ??
    createValidatingProducer({
      log,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.run === undefined ? {} : { run: options.run }),
    });
  const topics = activeTopics(db, graph, {
    ...(options.topics === undefined ? {} : { topics: options.topics }),
    ...(options.now === undefined ? {} : { now: options.now() }),
  });

  const profile = readProfile(db);
  const hungry = topics.filter((topic) => countAvailable(db, topic.id) < threshold);

  const refilled: RefillReport[] = [];
  let unavailable = false;
  const context: RefillContext = {
    db,
    produce,
    profile,
    target,
    maxBatches: options.maxBatches ?? MAX_BATCHES_PER_TOPIC,
    log,
    aborted: () => unavailable,
  };

  await pool(hungry, options.concurrency ?? MAX_CODEX_CONCURRENCY, async (topic) => {
    if (unavailable) return;
    try {
      refilled.push(await refillTopic(topic, context));
    } catch (error) {
      if (error instanceof CodexUnavailableError) {
        unavailable = true;
        log(`воркер: codex недоступен (${(error as Error).message}), пополнение отложено`);
        return;
      }
      const message = (error as Error).message;
      log(`воркер: тема «${topic.id}» не пополнена: ${message}`);
      refilled.push({
        topicId: topic.id,
        batches: 0,
        stored: 0,
        available: countAvailable(db, topic.id),
        error: message,
      });
    }
  });

  return {
    topics: topics.map((topic) => topic.id),
    refilled,
    codexUnavailable: unavailable,
  };
}

/**
 * Пауза до следующего цикла: обычный интервал, пока codex отвечает, и удвоение
 * от `BACKOFF_BASE_MS` за каждый подряд идущий отказ, до потолка.
 */
export function backoffDelay(failures: number): number {
  if (failures <= 0) return IDLE_INTERVAL_MS;
  return Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
}

export interface WorkerHandle {
  /** Прекращает цикл: текущее пополнение доигрывается, новое не начинается. */
  stop: () => void;
  /** Завершается, когда цикл действительно остановлен. */
  done: Promise<void>;
}

export interface StartWorkerOptions extends WorkerOptions {
  /** Пауза между циклами; тесты подменяют её, чтобы не ждать по-настоящему. */
  wait?: (ms: number) => Promise<void>;
}

/** Таймер не держит процесс живым: воркер не повод не дать серверу завершиться. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/** Запускает бесконечный цикл пополнения. Остановка — через `stop()`. */
export function startWorker(options: StartWorkerOptions): WorkerHandle {
  const log = options.log ?? defaultLog;
  const wait = options.wait ?? sleep;
  let stopped = false;
  let wake: (() => void) | null = null;

  const done = (async (): Promise<void> => {
    let failures = 0;

    while (!stopped) {
      let unavailable = false;
      try {
        unavailable = (await runWarmupCycle(options)).codexUnavailable;
      } catch (error) {
        // Цикл не должен уронить сервер: ошибка сюда доходит только неожиданная,
        // и следующий цикл — единственный способ узнать, что она прошла.
        unavailable = true;
        log(`воркер: цикл пополнения провалился: ${(error as Error).message}`);
      }

      failures = unavailable ? failures + 1 : 0;
      if (stopped) break;

      await Promise.race([
        wait(backoffDelay(failures)),
        new Promise<void>((resolve) => {
          wake = resolve;
        }),
      ]);
    }
  })();

  return {
    stop: (): void => {
      stopped = true;
      wake?.();
    },
    done,
  };
}
