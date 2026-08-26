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
import { CodexQuotaError } from './quota.js';
import type { TopicBackoff } from './topic-backoff.js';
import { generateTaskBatch, TaskBatchRejectedError } from './generate.js';
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
  /**
   * Готовить ли босса в этом заходе; по умолчанию да.
   *
   * Флаг нужен диспетчеру: одного ребёнка он обходит дважды за обход — сначала
   * добивая банк до порога всем подряд, потом до полного запаса. Подготовка
   * босса относится не к запасу, а к ребёнку целиком, и без флага второй заход
   * заказывал бы её заново — то есть тратил бы вызовы модели на уже сделанное.
   */
  prepareBoss?: boolean;
  /** Готовить ли персональный материал в этом заходе; по умолчанию да. */
  prepareLearning?: boolean;
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
  /**
   * Отступы тем этого ребёнка. Экземпляр приходит снаружи потому, что состояние
   * обязано пережить цикл: провал темы имеет смысл только по отношению к
   * следующему обходу. `undefined` — отступа нет вовсе (`npm run prefetch` идёт
   * одним проходом, и хранить между проходами ему нечего).
   */
  backoff?: TopicBackoff;
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
  /**
   * Модель отвечала, и её ответы забракованы — то есть виновата тема, а не
   * модель. Отделено от `error` потому, что сорванный запуск codex выглядит
   * здесь так же, а реакция на него противоположная: откладывать надо обход, а
   * не тему.
   */
  rejected?: boolean;
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
function revisionFor(graph: TopicGraph, topic: Topic): number | null {
  return graph.courses.get(topic.subject)?.revisionId ?? null;
}

function countOrZero(db: Database, topicId: string, courseRevisionId: number | null): number {
  try {
    return countAvailable(db, topicId, courseRevisionId);
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
  graph: TopicGraph;
}

/**
 * Доливает одну тему до `target`. Ошибку генерации записывает в отчёт и
 * прекращает долив этой темы: остальные темы всё равно надо успеть погреть.
 * Недоступность codex летит наверх — она относится не к теме, а к циклу.
 */
async function refillTopic(topic: Topic, context: RefillContext): Promise<RefillReport> {
  const { db, log, target } = context;
  const courseRevisionId = revisionFor(context.graph, topic);
  let available = countAvailable(db, topic.id, courseRevisionId);
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
          recent: recentQuestions(db, topic.id, undefined, courseRevisionId),
          profile: context.profile,
        }),
      );
    } catch (error) {
      if (error instanceof CodexUnavailableError) throw error;
      const message = (error as Error).message;
      log(`воркер: тема «${topic.id}» не пополнена: ${message}`);
      return {
        topicId: topic.id, batches, stored, available, error: message,
        rejected: error instanceof TaskBatchRejectedError,
      };
    }

    // Запись в банк — под тем же перехватом, что и генерация: без него отказ
    // базы улетал бы в общий перехват цикла, а тот отчитывается нулями и стирает
    // из отчёта всё, что тема успела налить прошлыми батчами.
    let result: ReturnType<typeof storeTasks>;
    try {
      result = storeTasks(db, topic.id, tasks, { courseRevisionId });
      stored += result.stored.length;
      available = countAvailable(db, topic.id, courseRevisionId);
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
      // Проверяющий, забраковавший батч целиком, возвращает пустой список, а не
      // бросает: модель отвечала, и виновата тема.
      rejected: true,
    };
  }

  return { topicId: topic.id, batches, stored, available };
}

/**
 * Записывает исход долива в отступ темы. Отдельной функцией потому, что «что
 * считать провалом» обязано совпадать с `everyRefillFailed`: разъехавшись, они
 * дали бы тему, которую диспетчер считает рабочей, а прогрев — безнадёжной.
 */
function noteTopicOutcome(
  backoff: TopicBackoff | undefined,
  topicId: string,
  report: { stored: number; error?: string; rejected?: boolean },
  now: Date,
  log: WorkerLog,
): void {
  if (backoff === undefined) return;
  if (report.error === undefined || report.stored > 0) {
    backoff.noteSuccess(topicId);
    return;
  }
  // Отступ назначается только за забракованный ответ модели. Сорванный запуск,
  // отказ базы и прочее к теме отношения не имеют, и откладывать за них тему
  // значило бы прятать общий отказ: просроченная авторизация codex за один
  // обход разложила бы по отступам все темы всех детей, следующий обход не нашёл
  // бы ни одной голодной, и растущая пауза диспетчера с записью
  // `codex-unavailable` не наступила бы вовсе — в журнале осталась бы тишина.
  if (report.rejected !== true) return;
  const delay = backoff.noteFailure(topicId, now);
  log(
    `воркер: тема «${topicId}» отложена на ${String(Math.round(delay / 60000))} мин ` +
      `после провала долива: ${report.error}`,
  );
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
  const now = options.now?.() ?? new Date();
  const backoff = options.backoff;
  // Пустой отчёт вместо вызова: подготовка босса — это генерация целого набора
  // заданий, и «пропустить фазу» обязано означать «не звать модель», а не
  // «позвать и выбросить».
  const boss: BossPreparationReport =
    options.prepareBoss === false
      ? { batches: 0, stored: 0, ready: false, recovered: false, codexUnavailable: false }
      : await prepareNextBoss({
          db,
          graph,
          produce,
          budget,
          ...(options.now === undefined ? {} : { now }),
          log,
          // Отступ у босса и у долива общий на тему: причина провала у них одна
          // — модель не вытягивает эту тему, — и раздельные счётчики означали
          // бы, что отложенную тему всё равно долбит второй конвейер, вчетверо
          // дороже (полный набор босса — до четырёх батчей подряд).
          ...(backoff === undefined
            ? {}
            : { blocked: (topicId: string): boolean => backoff.blocked(topicId, now) }),
        });
  // Недоступная модель — не вина темы: отступ по ней означал бы, что вернувшийся
  // codex застаёт полсемьи тем под запретом, назначенным за его же простой.
  if (boss.topicId !== undefined && !boss.codexUnavailable) {
    noteTopicOutcome(backoff, boss.topicId, boss, now, log);
  }
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
  const starving = topics.filter((topic) =>
    countOrZero(db, topic.id, revisionFor(graph, topic)) < threshold);
  // Тема под отступом выпадает из долива, но остаётся активной: отложен прогрев,
  // а не занятие по ней — то, что уже лежит в банке, выдаётся как обычно.
  //
  // Пропуск не пишется в лог: обход идёт раз в минуту, и строка на каждый
  // пропущенный обход за шесть часов отступа выдавила бы из видимого хвоста
  // журнала ровно ту запись, которая причину отступа и называет. Причина
  // пишется один раз — переходом, там же, где отступ назначается.
  const hungry =
    backoff === undefined ? starving : starving.filter((topic) => !backoff.blocked(topic.id, now));

  const refilled: RefillReport[] = [];
  let unavailable = false;
  const context: RefillContext = {
    db,
    graph,
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
      const report = await refillTopic(topic, context);
      refilled.push(report);
      // Провалом считается ровно то же, что и у `everyRefillFailed`: ошибка при
      // нулевом доливе. Тема, налившая первым батчем и споткнувшаяся на втором,
      // работает — отправлять её в отступ значило бы остужать наполняющуюся
      // очередь.
      noteTopicOutcome(backoff, topic.id, report, now, log);
    } catch (error) {
      if (error instanceof CodexUnavailableError) {
        unavailable = true;
        // Тема названа: в отчёт цикла она не попадает, а искать по логу «на чём
        // всё встало» приходится именно её.
        //
        // Исчерпанная квота обрывает заход тем же путём, что и недоступная
        // модель, но называется своим именем: «codex недоступен» отправило бы
        // разбираться со связью и правами вместо того, чтобы посмотреть расход
        // ребёнка, а различить эти два случая по логу больше нечем.
        log(
          error instanceof CodexQuotaError
            ? `воркер: суточная квота codex исчерпана на теме «${topic.id}» ` +
              `(${error.message}), пополнение отложено до московской полуночи`
            : `воркер: codex недоступен на теме «${topic.id}» (${(error as Error).message}), ` +
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
        available: countOrZero(db, topic.id, revisionFor(graph, topic)),
        error: message,
      });
    }
  });

  let learning: LearningPreparationReport | undefined;
  if (!unavailable && options.prepareLearning !== false) {
    learning = await prepareLearningMaterials({
      db,
      graph,
      budget,
      log,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.learningProduce === undefined ? {} : { produce: options.learningProduce }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.run === undefined ? {} : { run: options.run }),
      ...(backoff === undefined
        ? {}
        : { blocked: (topicId: string): boolean => backoff.blocked(topicId, now) }),
    });
    unavailable = learning.codexUnavailable;
    // Тот же отступ и на третьем потребителе квоты: темы он берёт из того же
    // списка пробелов, а стоит дороже обоих — теория, методист и пять вопросов.
    if (!learning.codexUnavailable) {
      for (const item of learning.prepared) noteTopicOutcome(backoff, item.topicId, item, now, log);
    }
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
 * Попытки фоновой подготовки цикла: долитые темы, босс и персональные
 * материалы. Отдельная функция потому, что таких попыток считает не только
 * `everyRefillFailed`: диспетчер складывает их по всем детям обхода, а
 * собственный обход отчёта у него разъехался бы с этим молча.
 */
export function cycleAttempts(report: CycleReport): { stored: number; error?: string }[] {
  const attempts: { stored: number; error?: string }[] = [...report.refilled];
  if (report.bossPreparation?.topicId !== undefined) attempts.push(report.bossPreparation);
  attempts.push(...(report.learningPreparation?.prepared ?? []));
  return attempts;
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
  const attempts = cycleAttempts(report);
  return attempts.length > 0 && attempts.every(
    (attempt) => attempt.error !== undefined && attempt.stored === 0,
  );
}
