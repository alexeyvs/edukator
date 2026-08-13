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
import { prepareNextBoss, type BossPreparationReport } from '../boss-prep.js';
import {
  prepareLearningMaterials,
  type LearningPreparationReport,
  type LearningProducer,
} from '../learning-prep.js';
import type { Topic, TopicGraph } from '../curriculum.js';
import { readProfile, type Profile } from '../db.js';
import { activeTopics } from '../scheduler.js';
import { countAvailable, recentQuestions, storeTasks } from './bank.js';
import { CodexUnavailableError, type CodexRunner } from './client.js';
import { generateTaskBatch } from './generate.js';
import { taskPromptText, type GeneratedTask } from './task-schema.js';
import { validateTaskBatch } from './validate.js';
import {
  codexConcurrency,
  MAX_CODEX_CONCURRENCY,
  type CodexConcurrency,
} from './concurrency.js';

/** Запас заданий на активную тему, до которого доливает воркер. */
export const QUEUE_TARGET = 8;

/** Остаток, ниже которого запускается долив. Выше — тема не трогается. */
export const REFILL_BELOW = 4;

/**
 * Предел одновременных вызовов codex. Пополнение одной темы — два вызова
 * подряд (генератор, затем проверяющий), поэтому предел считается по темам.
 */
export { MAX_CODEX_CONCURRENCY } from './concurrency.js';

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
  /**
   * Одна модель сразу на генератор и на проверяющего; по умолчанию каждый
   * берёт модель своей роли. Разводить роли этим полем нельзя — для этого
   * есть `EDUKATOR_MODEL_GENERATE` и `EDUKATOR_MODEL_VALIDATE`.
   */
  model?: string;
  /** Подменяемый вызов codex: тесты передают заглушку. */
  run?: CodexRunner;
  /** Общий с разборами споров бюджет процесса. */
  budget?: CodexConcurrency;
  /** Подменяемая подготовка полного материала и теста. */
  learningProduce?: LearningProducer;
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
  /** Подготовка босса входит в тот же проход и тот же расчёт отступа. */
  bossPreparation?: BossPreparationReport;
  /** Подготовка персональных материалов выполняется после обычного банка. */
  learningPreparation?: LearningPreparationReport;
}

function defaultLog(message: string): void {
  process.stderr.write(`${message}\n`);
}

export interface ProducerOptions {
  log?: WorkerLog;
  /**
   * Одна модель сразу на генератор и на проверяющего; по умолчанию каждый
   * берёт модель своей роли. Разводить роли этим полем нельзя — для этого
   * есть `EDUKATOR_MODEL_GENERATE` и `EDUKATOR_MODEL_VALIDATE`.
   */
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
    for (let safetyAttempt = 1; safetyAttempt <= 3; safetyAttempt += 1) {
      const { tasks } = await generateTaskBatch({
        topic, difficulty: request.difficulty, profile: request.profile,
        recent: request.recent, ...codex,
      });
      const { accepted, rejected } = await validateTaskBatch({ topic, tasks, ...codex });
      for (const { task, reason } of rejected) {
        log(`воркер: тема «${topic.id}», задание отбраковано (${reason}): ${taskPromptText(task)}`);
      }
      const unsafeHint = rejected.some(({ reason }) => reason.includes('подсказка раскрывает'));
      if (!unsafeHint || safetyAttempt === 3) return accepted;
      log(`воркер: тема «${topic.id}», небезопасная подсказка — перегенерация батча`);
    }
    return [];
  };
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

  // `allSettled`, а не `all`: `all` отпускает вызывающего на первой же ошибке,
  // но соседние исполнители продолжают разбирать ту же очередь и писать в базу
  // уже после того, как цикл отчитался, — отчёт перестаёт описывать то, что
  // на самом деле произошло. Первая ошибка всё равно летит наверх, просто
  // тогда, когда работа действительно закончилась.
  const settled = await Promise.allSettled(runners);
  const failed = settled.find((result) => result.status === 'rejected');
  if (failed !== undefined) throw (failed as PromiseRejectedResult).reason;
}

/** Остаток очереди для отчёта об уже случившейся ошибке — см. место вызова. */
function countOrZero(db: Database, topicId: string): number {
  try {
    return countAvailable(db, topicId);
  } catch {
    return 0;
  }
}

interface RefillContext {
  db: Database;
  produce: TaskProducer;
  profile: Profile;
  target: number;
  maxBatches: number;
  log: WorkerLog;
  aborted: () => boolean;
  budget: CodexConcurrency;
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
      tasks = await context.budget.run(() =>
        context.produce({
          topic,
          // Целевая сложность — базовая сложность темы: очередь греется заранее,
          // когда точность ученика по теме ещё неизвестна.
          difficulty: topic.difficulty,
          recent: recentQuestions(db, topic.id),
          profile: context.profile,
        }),
      );
    } catch (error) {
      if (error instanceof CodexUnavailableError) throw error;
      const message = (error as Error).message;
      log(`воркер: тема «${topic.id}» не пополнена: ${message}`);
      return { topicId: topic.id, batches, stored, available, error: message };
    }

    // Запись в банк — под тем же перехватом, что и генерация: без него отказ
    // базы улетал бы в общий перехват цикла, а тот отчитывается нулями и стирает
    // из отчёта всё, что тема успела налить прошлыми батчами.
    let result: ReturnType<typeof storeTasks>;
    try {
      result = storeTasks(db, topic.id, tasks);
      stored += result.stored.length;
      available = countAvailable(db, topic.id);
    } catch (error) {
      const message = (error as Error).message;
      log(`воркер: тема «${topic.id}» не пополнена: ${message}`);
      return { topicId: topic.id, batches, stored, available, error: message };
    }

    // Батч, целиком отсеянный как повтор, повторять внутри цикла бессмысленно:
    // следующий придёт с тем же списком прошлых формулировок. А вот батч, весь
    // отбракованный проверяющим, до банка не дошёл — прошлые формулировки не
    // изменились, но и заданий в них не добавилось, и следующая попытка честно
    // даёт другие условия. Именно так ведут себя темы с многочастным ответом,
    // то есть самые голодные: обрывая их здесь, воркер не долил бы их никогда.
    if (tasks.length > 0 && result.stored.length === 0) {
      log(`воркер: тема «${topic.id}» не пополнилась, весь батч отсеян как повтор`);
      break;
    }
  }

  // Долив, не давший ни одного задания, обязан назвать причину сам: исключения
  // здесь не было — проверяющий, забраковавший батч целиком, возвращает пустой
  // список, а не бросает. Без этой строки такая тема отчитывалась как удачная,
  // `everyRefillFailed` её не видел, и воркер держал обычную минутную паузу,
  // раз в минуту заново сжигая по восемь вызовов codex на ту же тему, а
  // `npm run prefetch` выходил нулём, отчитавшись «0 новых заданий» — то есть
  // ровно так же, как при полностью тёплой очереди.
  if (batches > 0 && stored === 0) {
    return {
      topicId: topic.id,
      batches,
      stored,
      available,
      error: `ни одно задание не дошло до банка за ${batches} батч(ей)`,
    };
  }

  return { topicId: topic.id, batches, stored, available };
}

/**
 * Один проход пополнения: активные темы, из них голодные, из них — долив до
 * запаса. Исключений наружу не отдаёт, кроме тех, что делают дальнейшую работу
 * бессмысленной (нечитаемая база): цикл крутится фоном (`startWorker`) и в
 * `npm run prefetch`, и падение одной темы не повод останавливать наполнение.
 */
export async function runWarmupCycle(options: WorkerOptions): Promise<CycleReport> {
  const { db, graph } = options;
  const target = options.target ?? QUEUE_TARGET;
  const threshold = options.threshold ?? REFILL_BELOW;
  if (threshold > target) {
    throw new Error(`Воркер: порог долива ${threshold} выше запаса ${target}`);
  }

  // Нулевой предел `pool` не отличить от «голодных тем нет»: исполнителей ноль,
  // цикл отчитывается пустым доливом и молчит.
  const concurrency = options.concurrency ?? MAX_CODEX_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`Воркер: предел одновременных пополнений должен быть положительным целым, получено ${concurrency}`);
  }

  const log = options.log ?? defaultLog;
  const produce =
    options.produce ??
    createValidatingProducer({
      log,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.run === undefined ? {} : { run: options.run }),
    });
  const budget = options.budget ?? codexConcurrency;
  const boss = await prepareNextBoss({
    db,
    graph,
    produce,
    budget,
    ...(options.now === undefined ? {} : { now: options.now() }),
    log,
  });
  if (boss.codexUnavailable) {
    return { topics: [], refilled: [], codexUnavailable: true, bossPreparation: boss };
  }
  const topics = activeTopics(db, graph, options.topics ?? WARM_TOPICS, options.now?.());

  const profile = readProfile(db);
  // Счётчик под перехватом: тема, добавленная в карту и ещё не синхронизированная
  // в `topic_state`, роняет `countAvailable`, а здесь это обрушило бы весь цикл
  // из-за одной темы — `startWorker` принял бы отказ за недоступность codex и
  // ушёл в получасовой отступ при полностью исправной модели. Ноль означает
  // «голодная»: причина назовётся в отчёте по теме, когда `refillTopic` упрётся
  // в тот же запрос.
  const hungry = topics.filter((topic) => countOrZero(db, topic.id) < threshold);

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
    budget,
  };

  await pool(hungry, concurrency, async (topic) => {
    if (unavailable) return;
    try {
      refilled.push(await refillTopic(topic, context));
    } catch (error) {
      if (error instanceof CodexUnavailableError) {
        unavailable = true;
        // Тема названа: в отчёт цикла она не попадает, а искать по логу «на чём
        // всё встало» приходится именно её.
        log(
          `воркер: codex недоступен на теме «${topic.id}» (${(error as Error).message}), ` +
            'пополнение отложено',
        );
        return;
      }
      const message = (error as Error).message;
      log(`воркер: тема «${topic.id}» не пополнена: ${message}`);
      refilled.push({
        topicId: topic.id,
        batches: 0,
        stored: 0,
        // Счётчик берётся отдельной попыткой: сюда попадает и отказ самого
        // доступа к теме (нет строки в `topic_state`), и тогда тот же запрос
        // упал бы второй раз — уже мимо всякой обработки, обрушив весь цикл
        // из-за одной темы. Причина уже названа в `error`.
        available: countOrZero(db, topic.id),
        error: message,
      });
    }
  });

  let learning: LearningPreparationReport | undefined;
  if (!unavailable) {
    learning = await prepareLearningMaterials({
      db,
      graph,
      budget,
      log,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.learningProduce === undefined ? {} : { produce: options.learningProduce }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.run === undefined ? {} : { run: options.run }),
    });
    unavailable = learning.codexUnavailable;
  }

  return {
    topics: topics.map((topic) => topic.id),
    refilled,
    codexUnavailable: unavailable,
    ...(
      boss.topicId === undefined
        ? {}
        : { bossPreparation: boss }
    ),
    ...(
      learning === undefined || (
        learning.candidates.length === 0 && learning.retired.length === 0 && learning.prepared.length === 0
      )
        ? {}
        : { learningPreparation: learning }
    ),
  };
}

/**
 * Цикл, не давший ничего: голодные темы были, и каждая упёрлась в ошибку.
 *
 * Нужен потому, что `CodexUnavailableError` покрывает не всякий отказ модели:
 * процесс, который стартовал и вышел с ненулевым кодом (просроченная
 * авторизация, исчерпанная квота, обрыв сети), приезжает как `CodexRunError` и
 * до `codexUnavailable` не доходит. Без этой проверки воркер держал бы обычную
 * минутную паузу и раз в минуту заново запускал codex по каждой голодной теме —
 * ровно то, от чего заводился отступ.
 *
 * Смотрит не только на ошибку, но и на `stored`: тема прекращает долив на первом
 * же отказе, и упавший второй батч оставляет в отчёте ошибку рядом с заданиями
 * первого. Считать такую тему провалившейся значило бы уводить воркер в
 * получасовой отступ (а `npm run prefetch` — в ненулевой код возврата) ровно
 * тогда, когда очередь пополняется.
 */
export function everyRefillFailed(report: CycleReport): boolean {
  const attempts: { stored: number; error?: string }[] = [...report.refilled];
  if (report.bossPreparation?.topicId !== undefined) attempts.push(report.bossPreparation);
  attempts.push(...(report.learningPreparation?.prepared ?? []));
  return attempts.length > 0 && attempts.every(
    (attempt) => attempt.error !== undefined && attempt.stored === 0,
  );
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
        const report = await runWarmupCycle(options);
        unavailable = report.codexUnavailable;
        if (!unavailable && everyRefillFailed(report)) {
          unavailable = true;
          const backgroundAttempts = report.refilled.length
            + (report.bossPreparation?.topicId === undefined ? 0 : 1)
            + (report.learningPreparation?.prepared.length ?? 0);
          const failedLabel = backgroundAttempts === report.refilled.length
            ? `ни одна из ${report.refilled.length} голодных тем не пополнена`
            : `все ${backgroundAttempts} фоновые подготовки провалились`;
          log(
            `воркер: ${failedLabel}, ` +
              'пауза увеличена',
          );
        }
      } catch (error) {
        // Цикл не должен уронить сервер: ошибка сюда доходит только неожиданная,
        // и следующий цикл — единственный способ узнать, что она прошла.
        unavailable = true;
        log(`воркер: цикл пополнения провалился: ${(error as Error).message}`);
      }

      failures = unavailable ? failures + 1 : 0;
      if (stopped) break;

      // Гонка паузы с будильником: после отказов codex пауза доходит до
      // получаса, а `stop()` обязан прерывать её, а не досиживать.
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
