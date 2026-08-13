/**
 * Занятие: выдача задания, приём ответа и разбор спора «я всё-таки прав».
 * Здесь только логика и доступ к базе — HTTP живёт в `server/routes/session.ts`.
 *
 * Тему выбирает планировщик этапа 1, задание берётся из тёплой очереди с
 * откатом на посевной банк: генерировать в момент показа нельзя, батч занимает
 * у модели полминуты.
 *
 * Ответ сверяется нормализатором, без обращения к модели, и попытка вместе со
 * сдвигом `mastery` и счётчиками забега пишется одной транзакцией: засчитанный
 * ответ без сдвига модели или прогресса — это молча разъехавшийся прогноз.
 *
 * Спор ученик не ждёт: маршрут только ставит его в очередь, а разбор идёт фоном
 * и, при подтверждении, дописывает ответ в `accept[]` и пересчитывает модель по
 * всей истории темы. Банк от этого самоисправляется — следующий такой же ответ
 * засчитается сразу.
 */
import type { Database } from 'better-sqlite3';
import type { Topic, TopicGraph } from './curriculum.js';
import type { Subject } from './db.js';
import {
  readTopicState,
  recomputeTopicState,
  recordAttempt,
  type TopicState,
} from './mastery.js';
import { checkAnswer, type CheckResult, type RejectReason } from './normalize.js';
import { activeTopics } from './scheduler.js';
import { issuedTask, learningTaskAtPosition, readBankTask, type BankTask } from './codex/bank.js';
import { takeTaskOrSeed } from './codex/seed-bank.js';
import { duplicateKey, fitsAccept } from './codex/task-schema.js';
import type { DisputeContext, DisputeReviewer } from './codex/dispute.js';
import { isRunKind, runProgress, type RunKind, type RunProgress } from './run.js';
import { SessionError, type SessionErrorCode } from './session-error.js';
import { taskXp } from './xp.js';
import { projectIssuedTask, type IssuedTask } from './issued-task.js';
import { BOSS_TARGET } from './boss-rules.js';
import { finishBossLoss } from './boss-loss.js';
import { bossFightConsistent, finishBossWin, readBossFight } from './boss-fight.js';
import { LEARNING_TASK_COUNT } from './learning-constants.js';

export type { IssuedTask } from './issued-task.js';

export { SessionError, type SessionErrorCode };

export interface RetryTaskState {
  attemptId: number;
  previousAnswer: string;
  answer: string;
  explain: string;
  joke: string;
  disputeStatus?: DisputeStatus;
}

interface NextTaskOk {
  status: 'ok';
  task: IssuedTask;
  retry?: RetryTaskState;
  /** Снимок прогресса того же run, в котором восстановлено или выдано задание. */
  progress?: RunProgress;
}

export type NextTaskResult =
  | NextTaskOk
  /** Планировщику нечего предложить: всё освоено или закрыто предпосылками. */
  | { status: 'no-topic' }
  /** Тема выбрана, но очередь и посев по ней пусты. */
  | { status: 'no-task'; topicId: string };

export interface NextTaskOptions {
  now?: Date;
  /** Ограничивает перебор тем одним предметом. */
  subject?: Subject;
  /** Активный забег: из него берётся предмет и проверяется его состояние. */
  runId?: number;
  /** Уже показанное задание: предзагрузка должна зарезервировать следующее. */
  excludeTaskId?: number;
  /** Каталог посевного банка; по умолчанию репозиторный. */
  seedDir?: string;
  /** Куда писать про пропущенную тему; по умолчанию stderr. */
  log?: (message: string) => void;
}

interface TopicAllocationRow {
  topic_id: string;
  allocated: number;
}

/**
 * Темы забега остаются в порядке планировщика, но новая выдача идёт по наименее
 * представленной теме. В счёт входят и ответы, и уже зарезервированная
 * предзагрузка: иначе каждый запрос предзагрузки выбирал бы тему показанного,
 * но ещё не отвеченного задания заново.
 */
function balanceRunTopics(db: Database, runId: number, topics: Topic[]): Topic[] {
  const rows = db.prepare<[number, number], TopicAllocationRow>(
    `SELECT topic_id, COUNT(*) AS allocated
       FROM (
         SELECT topic_id FROM attempts WHERE run_id = ? AND is_current = 1
         UNION ALL
         SELECT topic_id FROM task_bank
          WHERE issued_run_id = ? AND status = 'used'
            AND NOT EXISTS (
              SELECT 1 FROM attempts WHERE attempts.task_id = task_bank.id
            )
       )
      GROUP BY topic_id`,
  ).all(runId, runId);
  const allocated = new Map(rows.map((row) => [row.topic_id, row.allocated]));

  return topics
    .map((topic, order) => ({ topic, order, allocated: allocated.get(topic.id) ?? 0 }))
    .sort((left, right) => left.allocated - right.allocated || left.order - right.order)
    .map(({ topic }) => topic);
}

function issuedResult(
  topic: Topic,
  task: BankTask,
  exposeHint = true,
  progress?: RunProgress,
): NextTaskOk {
  return {
    status: 'ok',
    task: projectIssuedTask(topic, task, { exposeHint }),
    ...(progress === undefined ? {} : { progress }),
  };
}

function retryResult(
  db: Database,
  graph: TopicGraph,
  run: SessionRun,
  progress: RunProgress,
): NextTaskOk {
  if (run.retry_task_id === null) throw new Error(`Забег ${run.id} не ожидает исправления`);
  const task = readBankTask(db, run.retry_task_id);
  if (task === null || task.topicId === undefined) {
    throw new Error(`Забег ${run.id} ссылается на отсутствующее задание исправления`);
  }
  const attempt = db.prepare<
    [number, number],
    { id: number; answer: string; dispute_status: DisputeStatus | null }
  >(
    `SELECT attempts.id, attempts.answer, disputes.status AS dispute_status
       FROM attempts
       LEFT JOIN disputes ON disputes.attempt_id = attempts.id
      WHERE attempts.run_id = ? AND attempts.task_id = ? AND attempts.is_current = 1
      ORDER BY disputes.id DESC LIMIT 1`,
  ).get(run.id, task.id);
  if (attempt === undefined) {
    throw new Error(`Забег ${run.id} не хранит текущую попытку для исправления ${task.id}`);
  }
  return {
    status: 'ok',
    task: projectIssuedTask(topicOf(graph, task.topicId), task),
    progress,
    retry: {
      attemptId: attempt.id,
      previousAnswer: attempt.answer,
      answer: task.answer,
      explain: task.explain,
      joke: task.joke,
      ...(attempt.dispute_status === null ? {} : { disputeStatus: attempt.dispute_status }),
    },
  };
}

/**
 * Следующее задание: тема от планировщика, задание из банка. Целевая сложность —
 * базовая сложность темы; подстройку под точность ученика делает триаж этапа 3.
 *
 * Перебирается **весь** план, а не первые несколько тем: пустая очередь темы не
 * повод сказать «заданий нет» — ответить по ней ученик не может, состояние её не
 * меняется, и планировщик предлагает её же снова, то есть занятие встаёт
 * навсегда. Посев покрывает шесть тем предмета из двадцати с лишним, так что
 * окно фиксированного размера регулярно целиком состоит из пустых тем, а
 * остальной банк остаётся недостижимым. Перебор дешёвый: план строится в памяти.
 *
 * Уже выданное, но неотвеченное задание любой темы забега возвращается повторно:
 * перезагрузка страницы не должна сжигать очередь. Только новая выдача
 * балансируется между темами в порядке планировщика — `runs.topic_id` задаёт
 * стартовую тему, а не прикрепляет к ней все двенадцать заданий.
 *
 * Состав тем берётся `activeTopics`, а не голым планом: тему идущего забега
 * планировщик считает использованной сегодня и в план не включает, так что на
 * голом плане занятие перескакивало бы с начатой темы на чужую прямо посреди
 * забега — а уже выданное по ней задание осталось бы висеть навсегда, потому что
 * `issuedTask` по выпавшей теме никто не спросит.
 */
function nextTaskFromSnapshot(
  db: Database,
  graph: TopicGraph,
  options: NextTaskOptions = {},
): NextTaskResult {
  const now = options.now ?? new Date();
  const log = options.log ?? ((message: string): void => void process.stderr.write(`${message}\n`));
  const run = options.runId === undefined ? undefined : readActiveRun(db, options.runId);
  const progress = run === undefined ? undefined : runProgress(db, run.id);
  if (run?.kind === 'lesson') {
    if (run.total >= LEARNING_TASK_COUNT) {
      throw new SessionError('run-complete', `Lesson-run ${run.id} достиг цели и готов к завершению`);
    }
    const material = db.prepare<[number], { id: number; status: string }>(
      `SELECT learning_materials.id, learning_materials.status
         FROM learning_runs
         JOIN learning_materials ON learning_materials.id = learning_runs.material_id
        WHERE learning_runs.run_id = ?`,
    ).get(run.id);
    if (material === undefined || material.status !== 'active') {
      throw new SessionError('task-not-in-run', `Lesson-run ${run.id} не связан с активным материалом`);
    }
    const task = learningTaskAtPosition(db, material.id, run.total + 1, run.id);
    if (task === null || task.topicId !== run.topic_id) {
      throw new Error(`Lesson-run ${run.id} не содержит задание позиции ${run.total + 1}`);
    }
    if (db.prepare<[number, number], { ok: number }>(
      'SELECT 1 AS ok FROM task_bank WHERE id = ? AND issued_run_id = ?',
    ).get(task.id, run.id) === undefined) {
      throw new SessionError('task-not-in-run', `Задание ${task.id} не принадлежит lesson-run ${run.id}`);
    }
    return issuedResult(topicOf(graph, task.topicId), task, false, progress);
  }
  if (run?.kind !== undefined && run.kind !== 'run') {
    throw new SessionError(
      'task-not-in-run',
      run.kind === 'boss'
        ? `Бой с боссом ${run.id} выдаёт задания только из своего батча`
        : `Забег ${run.id} является триажем`,
    );
  }
  if (run?.retry_task_id !== null && run?.retry_task_id !== undefined) {
    if (progress === undefined) throw new Error(`Забег ${run.id} не хранит progress`);
    return retryResult(db, graph, run, progress);
  }
  if (run !== undefined && progress?.done === true) {
    throw new SessionError('run-complete', `Забег ${run.id} достиг цели и готов к завершению`);
  }
  if (run !== undefined && options.subject !== undefined && run.subject !== options.subject) {
    throw new SessionError(
      'task-not-in-run',
      `Занятие: забег ${run.id} относится к другому предмету`,
    );
  }
  const subject = run?.subject ?? options.subject;
  let planned = activeTopics(db, graph, graph.byId.size, now).filter(
    (topic) => subject === undefined || topic.subject === subject,
  );
  const first = planned[0];
  if (first === undefined) return { status: 'no-topic' };

  if (run !== undefined) {
    // Предзагрузка могла быть зарезервирована по теме, которая после предыдущего
    // ответа выпала из свежего плана. Сначала восстанавливаем любое выданное
    // задание предмета и лишь затем выбираем тему для новой выдачи.
    const recovery = new Map<string, Topic>();
    const closed = new Set(db.prepare<[], { topic_id: string }>(
      'SELECT topic_id FROM topic_state WHERE closed_at IS NOT NULL',
    ).all().map((item) => item.topic_id));
    for (const topic of [...planned, ...(graph.bySubject.get(run.subject) ?? [])]) {
      if (closed.has(topic.id)) continue;
      recovery.set(topic.id, topic);
    }
    for (const topic of recovery.values()) {
      try {
        const task = issuedTask(db, topic.id, run.id, options.excludeTaskId);
        if (task !== null) return issuedResult(topic, task, true, progress);
      } catch (error) {
        log(`выданная тема «${topic.id}» пропущена: ${(error as Error).message}`);
      }
    }
    planned = balanceRunTopics(db, run.id, planned);
  }

  // Один набор на весь перебор: посев предмета дозаливается целиком, и второй
  // раз за запрос это только разбор того же файла впустую.
  const seeded = new Set<Subject>();
  // Первая поломка перебора: если сорвались все темы плана без исключения, дело
  // не в банке, а в самой базе (заблокированная запись, рассинхронизованная
  // `topic_state`), и молчаливое «заданий нет» увело бы разбирательство не туда.
  let firstFailure: Error | undefined;
  let failed = 0;
  for (const topic of planned) {
    let task: BankTask | null;
    // Поломка одной темы не должна валить весь перебор: повреждённый `accept[]`
    // одного задания — дефект банка, и превращать его в пятисотку на каждом
    // запросе значит остановить занятие целиком, хотя соседние темы полны.
    try {
      task =
        (run === undefined ? issuedTask(db, topic.id, undefined, options.excludeTaskId) : null) ??
        takeTaskOrSeed(db, graph, topic.id, {
          difficulty: topic.difficulty,
          ...(run === undefined ? {} : { runId: run.id }),
          seeded,
          ...(options.seedDir === undefined ? {} : { dir: options.seedDir }),
        });
    } catch (error) {
      firstFailure ??= error as Error;
      failed += 1;
      log(`тема «${topic.id}» пропущена: ${(error as Error).message}`);
      continue;
    }
    if (task === null) continue;

    return issuedResult(topic, task, true, progress);
  }

  if (firstFailure !== undefined && failed === planned.length) throw firstFailure;

  // Тема первого забега: она же осталась бы выбранной и на следующем запросе.
  return { status: 'no-task', topicId: planned[0]?.id ?? first.id };
}

/**
 * Выдача и её progress читаются из одного снимка. Иначе другое соединение
 * могло закрыть ретрай между чтением `retry_task_id`, текущей попытки и
 * счётчиков, а HTTP-ответ склеил бы уже несовместимые состояния.
 */
export function nextTask(
  db: Database,
  graph: TopicGraph,
  options: NextTaskOptions = {},
): NextTaskResult {
  return db.transaction(() => nextTaskFromSnapshot(db, graph, options)).immediate();
}

export interface AnswerRequest {
  taskId: number;
  answer: string;
  runId?: number;
  /** Идентификатор заменяемой версии; обязателен для явного исправления. */
  retryAttemptId?: number;
  hintUsed?: boolean;
  durationMs?: number;
  /** Время попытки; по умолчанию — сейчас. Задаётся явно в тестах. */
  at?: Date;
  /** Куда писать про отбракованное задание; по умолчанию stderr. */
  log?: (message: string) => void;
}

export interface AnswerResult {
  attemptId: number;
  correct: boolean;
  /** Нормализованный ответ ученика: он же записан в `attempts`. */
  normalized: string;
  reason?: RejectReason;
  /** Эталон, разбор и реакция напарника — их видно только после ответа. */
  answer: string;
  explain: string;
  joke: string;
  state: TopicState;
  /** Начисление за эту попытку; для неверного ответа равно нулю. */
  xp: number;
  /** Счётчики забега после записи попытки либо null для обычного занятия. */
  progress: RunProgress | null;
  /** Есть только у boss: обычный HTTP-путь ответа сохраняет доменный исход боя. */
  bossOutcome?: 'active' | 'mistake' | 'won';
}

interface SessionRun {
  id: number;
  subject: Subject;
  topic_id: string;
  kind: RunKind;
  finished_at: string | null;
  total: number;
  correct: number;
  lives_remaining: number | null;
  retry_task_id: number | null;
}

type SessionRunRow = Omit<SessionRun, 'kind'> & { kind: string };

function readActiveRun(db: Database, runId: number): SessionRun {
  const row = db
    .prepare<[number], SessionRunRow>(
      `SELECT id, subject, topic_id, kind, finished_at, total, correct,
              lives_remaining, retry_task_id
         FROM runs WHERE id = ?`,
    )
    .get(runId);
  if (row === undefined) {
    throw new SessionError('run-not-found', `Занятие: забег ${runId} не найден`);
  }
  if (!isRunKind(row.kind)) {
    throw new Error(`Занятие: забег ${runId} хранит неизвестный kind (${row.kind})`);
  }
  const run: SessionRun = { ...row, kind: row.kind };
  if (run.finished_at !== null) {
    throw new SessionError('run-finished', `Занятие: забег ${runId} уже завершён`);
  }
  return run;
}

interface TaskRow {
  id: number;
  topic_id: string;
  answer: string;
  accept: string;
  explain: string | null;
  joke: string | null;
  difficulty: number;
  status: string;
  issued_run_id: number | null;
}

function parseAccept(raw: string, id: number): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Занятие: задание ${id} хранит accept[] не как JSON (${raw})`);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error(`Занятие: accept[] задания ${id} должен быть массивом строк`);
  }
  return parsed as string[];
}

function readTask(db: Database, taskId: number): TaskRow {
  const row = db
    .prepare<[number], TaskRow>(
      `SELECT id, topic_id, answer, accept, explain, joke, difficulty, status, issued_run_id
         FROM task_bank WHERE id = ?`,
    )
    .get(taskId);
  if (row === undefined) {
    throw new SessionError('task-not-found', `Занятие: задания ${taskId} нет в банке`);
  }
  return row;
}

function topicOf(graph: TopicGraph, topicId: string): Topic {
  const topic = graph.byId.get(topicId);
  if (topic === undefined) {
    throw new Error(`Занятие: темы «${topicId}» нет в карте`);
  }
  return topic;
}

interface BossAnswerContext {
  batch_id: number;
  batch_topic_id: string;
  batch_status: string;
  position: number | null;
  total: number;
  correct: number;
  wrong: number;
  open_disputes: number;
}

function bossAnswerContext(db: Database, run: SessionRun, taskId: number): BossAnswerContext {
  const fight = readBossFight(db, run.id, taskId);
  if (
    fight === undefined || fight.batchStatus !== 'active' ||
    !bossFightConsistent(fight, { id: run.topic_id, subject: run.subject })
  ) {
    throw new SessionError('task-not-in-run', `Босс: batch и run боя ${run.id} несогласованы`);
  }
  if (fight.openDisputes > 0) {
    throw new SessionError('boss-dispute-open', `Босс: бой ${run.id} приостановлен открытым спором`);
  }
  if (fight.wrong > 0) {
    throw new SessionError(
      'boss-mistake-pending',
      `Босс: после ошибки нужно признать поражение или открыть спор`,
    );
  }
  if (fight.total >= BOSS_TARGET) {
    throw new SessionError('run-complete', `Босс: пять ответов боя ${run.id} уже исчерпаны`);
  }
  if (fight.position !== fight.total + 1) {
    throw new SessionError(
      'task-not-in-run',
      `Босс: ответ принимается только на текущее задание позиции ${fight.total + 1}`,
    );
  }
  return {
    batch_id: fight.batchId, batch_topic_id: fight.batchTopicId,
    batch_status: fight.batchStatus, position: fight.position,
    total: fight.total, correct: fight.correct, wrong: fight.wrong,
    open_disputes: fight.openDisputes,
  };
}

/**
 * Отметка попытки не раньше последней известной по теме. Нечитаемое `last_seen`
 * не чинится здесь: на нём осмысленно падает сам `applyAttempt`, назвав колонку.
 */
function notBefore(at: Date, lastSeen: string | null): Date {
  if (lastSeen === null) return at;
  const previous = Date.parse(lastSeen);
  if (!Number.isFinite(previous) || at.getTime() >= previous) return at;
  return new Date(previous);
}

/**
 * Принимает ответ: сверяет, пишет попытку и двигает модель знаний.
 *
 * Задание, которое ученику не выдавали, ответа не принимает: `takeTask`
 * помечает выданное `used`, и всё остальное — либо чужая очередь, либо подбор
 * идентификатора руками. По той же причине ответ на задание принимается один
 * раз: второй сдвинул бы `mastery` дважды за одно и то же.
 */
export function submitAnswer(
  db: Database,
  graph: TopicGraph,
  request: AnswerRequest,
): AnswerResult {
  const requestedAt = request.at ?? new Date();
  if (!Number.isFinite(requestedAt.getTime())) {
    throw new Error(`Занятие: некорректное время ответа (${String(requestedAt)})`);
  }
  const hintUsed = request.hintUsed ?? false;
  const durationMs = Math.max(0, Math.round(request.durationMs ?? 0));
  const log =
    request.log ?? ((message: string): void => void process.stderr.write(`${message}\n`));

  // Всё одной `immediate`-транзакцией: проверка «уже отвечали», запись попытки
  // и сдвиг модели обязаны видеть один снимок, иначе два одновременных ответа
  // на одно задание оба пройдут проверку и оба сдвинут `mastery`.
  const outcome = db.transaction((): AnswerResult | { defect: string } => {
    const row = readTask(db, request.taskId);
    const topic = topicOf(graph, row.topic_id);
    const run = request.runId === undefined ? undefined : readActiveRun(db, request.runId);
    const closed = db.prepare<[string], { closed_at: string | null }>(
      'SELECT closed_at FROM topic_state WHERE topic_id = ?',
    ).get(row.topic_id);
    if (closed === undefined) {
      throw new Error(`Занятие: тема «${row.topic_id}» не заведена в topic_state`);
    }
    // Открытый материал переживает закрытие темы боссом: ученик должен иметь
    // возможность продолжить единственный уже начатый тест. Сам lesson-run
    // ниже всё равно проверяется на активный материал, принадлежность и порядок
    // заданий. Для обычных забегов, триажа, босса и ответа без run закрытая тема
    // остаётся недоступной.
    if (closed.closed_at !== null && run?.kind !== 'lesson') {
      throw new SessionError('task-not-in-run', `Занятие: тема «${row.topic_id}» уже закрыта`);
    }
    const boss = run?.kind === 'boss' ? bossAnswerContext(db, run, row.id) : undefined;
    if (
      boss !== undefined && run !== undefined &&
      (boss.batch_topic_id !== run.topic_id || row.topic_id !== run.topic_id)
    ) {
      throw new SessionError('task-not-in-run', `Босс: batch, run и task ${request.taskId} несогласованы`);
    }
    if ((run?.kind === 'run' || run?.kind === 'lesson') && runProgress(db, run.id).done) {
      throw new SessionError('run-complete', `Забег ${run.id} достиг цели и готов к завершению`);
    }
    if (run !== undefined && run.subject !== topic.subject) {
      throw new SessionError(
        'task-not-in-run',
        `Занятие: задание ${request.taskId} не относится к забегу ${run.id}`,
      );
    }
    if ((run?.id ?? null) !== row.issued_run_id) {
      throw new SessionError(
        'task-not-in-run',
        run?.kind === 'boss'
          ? `Босс: batch, run и task ${request.taskId} несогласованы`
          : `Занятие: задание ${request.taskId} выдано другому забегу`,
      );
    }
    if ((run?.kind === 'triage' || run?.kind === 'boss' || run?.kind === 'lesson') && hintUsed) {
      throw new SessionError(
        'task-not-in-run',
        run.kind === 'boss'
          ? `Босс: в бою ${run.id} нельзя использовать подсказку`
          : run.kind === 'lesson'
            ? `Учебный тест ${run.id} запрещает подсказки`
            : `Занятие: в триаже ${run.id} нельзя использовать подсказку`,
      );
    }
    const expectedStatus = run?.kind === 'boss'
      ? 'boss_reserved'
      : run?.kind === 'lesson' ? 'lesson_reserved' : 'used';
    if (row.status !== expectedStatus) {
      throw new SessionError(
        'task-not-issued',
        `Занятие: задание ${request.taskId} ученику не выдавалось`,
      );
    }

    const lessonContext = run?.kind === 'lesson'
      ? db.prepare<[number, number], { position: number; attempt_number: number }>(
        `SELECT learning_tasks.position, learning_runs.attempt_number
           FROM learning_runs
           JOIN learning_materials ON learning_materials.id = learning_runs.material_id
           JOIN learning_tasks ON learning_tasks.material_id = learning_materials.id
          WHERE learning_runs.run_id = ? AND learning_tasks.task_id = ?
            AND learning_materials.status = 'active'`,
      ).get(run.id, row.id)
      : undefined;
    if (run?.kind === 'lesson') {
      if (lessonContext === undefined || lessonContext.position !== run.total + 1) {
        throw new SessionError(
          'task-not-in-run',
          `Учебный тест ${run.id} ожидает задание позиции ${run.total + 1}`,
        );
      }
    }

    const affectsProgress = run?.kind !== 'lesson' || lessonContext?.attempt_number === 1;
    const currentAttempt = db.prepare<
      [number, number | null, number],
      { id: number; is_correct: number; hint_used: number; run_id: number | null }
    >(
      `SELECT id, is_correct, hint_used, run_id FROM attempts
        WHERE task_id = ? AND is_current = 1
          AND (? IS NULL OR run_id = ?)
        ORDER BY id DESC LIMIT 1`,
    ).get(request.taskId, run?.kind === 'lesson' ? run.id : null, run?.id ?? 0);
    const retrying = run?.kind === 'run' && run.retry_task_id === row.id;
    if (run?.kind === 'run' && run.retry_task_id !== null && !retrying) {
      throw new SessionError(
        'task-not-in-run',
        `Забег ${run.id} ожидает исправления задания ${run.retry_task_id}`,
      );
    }
    if (retrying) {
      if (currentAttempt === undefined || currentAttempt.run_id !== run.id) {
        throw new Error(`Забег ${run.id} не хранит текущую версию ответа ${row.id}`);
      }
      if (request.retryAttemptId !== currentAttempt.id) {
        throw new SessionError(
          'already-answered',
          `Занятие: исправление должно ссылаться на текущую попытку ${currentAttempt.id}`,
        );
      }
      const open = db.prepare<[number], { id: number }>(
        "SELECT id FROM disputes WHERE attempt_id = ? AND status = 'open' LIMIT 1",
      ).get(currentAttempt.id);
      if (open !== undefined) {
        throw new SessionError(
          'run-not-ready',
          `Забег ${run.id}: исправление недоступно, пока разбирается спор`,
        );
      }
    } else if (currentAttempt !== undefined || request.retryAttemptId !== undefined) {
      throw new SessionError(
        'already-answered',
        `Занятие: на задание ${request.taskId} уже отвечали`,
      );
    }

    // Пропавшая из карты тема — не дефект задания, а расхождение карты с базой:
    // задания темы целы и вернутся вместе с ней (`syncTopicState` ровно поэтому
    // ничего не удаляет), а `rejected` выкинул бы их из выгружаемого посева
    // навсегда. Такое уходит пятисоткой; повторной выдачи она не вызовет —
    // темы вне карты в план не попадают.
    // Шаг часов назад (поправка NTP, ручной перевод времени на ноутбуке) не
    // имеет права стоить ученику ответа. `applyAttempt` требует неубывающего
    // времени и на нарушении бросает обычной ошибкой — а она изнутри этой
    // транзакции откатывает уже вставленную попытку и уходит наружу
    // пятисоткой, и так на каждой повторной отправке, пока часы не догонят
    // сохранённое `last_seen`. Запрет заводился для импорта истории не по
    // порядку; живой ответ происходит сейчас, поэтому его отметка
    // подтягивается к последней известной, а не отвергается.
    const at = notBefore(requestedAt, readTopicState(db, row.topic_id).lastSeen);

    // Дефект самого задания — нечитаемый `accept[]`, эталон без числа на
    // числовой теме — не должен вставать поперёк занятия навсегда. Выдача такое
    // задание уже пропускает (`nextTask`), а здесь оно уже выдано: без пометки
    // задание остаётся `used` без попытки, `issuedTask` возвращает его снова, и
    // ученик получает ту же пятисотку до конца занятия. Пометка `rejected`
    // выводит его из очереди.
    let check: CheckResult;
    try {
      check = checkAnswer(
        request.answer,
        { answer: row.answer, accept: parseAccept(row.accept, row.id) },
        topic.answerFormat,
      );
    } catch (error) {
      if (run?.kind === 'boss' || run?.kind === 'lesson') throw error;
      db.prepare("UPDATE task_bank SET status = 'rejected' WHERE id = ?").run(row.id);
      return { defect: (error as Error).message };
    }

    const effectiveHintUsed = hintUsed || currentAttempt?.hint_used === 1;
    if (retrying) {
      db.prepare('UPDATE attempts SET is_current = 0 WHERE id = ?').run(currentAttempt?.id);
    }
    const lifeCharged =
      run?.kind === 'run' && !check.correct && (run.lives_remaining ?? 0) > 0;
    const info = db
      .prepare(
        `INSERT INTO attempts
          (task_id, topic_id, run_id, answer, is_correct, hint_used, duration_ms,
           is_current, life_charged, affects_progress, created_at)
         VALUES
          (@taskId, @topicId, @runId, @answer, @isCorrect, @hintUsed, @durationMs,
           1, @lifeCharged, @affectsProgress, @createdAt)`,
      )
      .run({
        taskId: row.id,
        topicId: row.topic_id,
        runId: run?.id ?? null,
        // Пишется то, что ученик набрал: нормализованную запись всегда можно
        // получить заново, а вот разбор спора смотрит именно на исходную.
        answer: request.answer.trim(),
        isCorrect: check.correct ? 1 : 0,
        hintUsed: effectiveHintUsed ? 1 : 0,
        durationMs,
        lifeCharged: lifeCharged ? 1 : 0,
        affectsProgress: affectsProgress ? 1 : 0,
        createdAt: at.toISOString(),
      });

    const state = !affectsProgress
      ? readTopicState(db, row.topic_id)
      : retrying
      ? recomputeTopicState(db, row.topic_id)
      : recordAttempt(db, row.topic_id, {
          correct: check.correct,
          difficulty: row.difficulty,
          hintUsed: effectiveHintUsed,
          at,
        });
    const xp = affectsProgress
      ? taskXp({
          difficulty: row.difficulty,
          correct: check.correct,
          hintUsed: effectiveHintUsed,
        })
      : 0;
    if (run?.kind === 'run') {
      if (run.lives_remaining === null) {
        throw new Error(`Обычный забег ${run.id} не хранит число оставшихся жизней`);
      }
      const livesRemaining = run.lives_remaining - (lifeCharged ? 1 : 0);
      const retryTaskId = !check.correct && lifeCharged ? row.id : null;
      if (retrying) {
        db.prepare(
          `UPDATE runs
              SET correct = correct + @correct - @previousCorrect,
                  lives_remaining = @livesRemaining,
                  retry_task_id = @retryTaskId
            WHERE id = @runId`,
        ).run({
          runId: run.id,
          correct: check.correct ? 1 : 0,
          previousCorrect: currentAttempt?.is_correct ?? 0,
          livesRemaining,
          retryTaskId,
        });
      } else {
        db.prepare(
          `UPDATE runs
              SET total = total + 1,
                  correct = correct + @correct,
                  lives_remaining = @livesRemaining,
                  retry_task_id = @retryTaskId
            WHERE id = @runId`,
        ).run({
          runId: run.id,
          correct: check.correct ? 1 : 0,
          livesRemaining,
          retryTaskId,
        });
      }
    } else if (run !== undefined) {
      db.prepare(
        `UPDATE runs
            SET total = total + 1,
                correct = correct + @correct
          WHERE id = @runId`,
      ).run({ runId: run.id, correct: check.correct ? 1 : 0 });
    }

    let progress = run === undefined ? null : runProgress(db, run.id);
    let bossOutcome: AnswerResult['bossOutcome'];
    if (run?.kind === 'boss') {
      const total = (boss?.total ?? 0) + 1;
      const correct = (boss?.correct ?? 0) + (check.correct ? 1 : 0);
      bossOutcome = check.correct ? 'active' : 'mistake';
      if (check.correct && total === BOSS_TARGET) {
        const iso = at.toISOString();
        const fight = readBossFight(db, run.id);
        if (fight === undefined || !bossFightConsistent(fight)) {
          throw new Error(`Босс: бой ${run.id} несогласован перед победой`);
        }
        finishBossWin(db, fight, iso);
        bossOutcome = 'won';
      }
      progress = { total, correct, target: BOSS_TARGET, done: bossOutcome === 'won' };
    }

    return {
      attemptId: Number(info.lastInsertRowid),
      correct: check.correct,
      normalized: check.normalized,
      ...(check.reason === undefined ? {} : { reason: check.reason }),
      answer: row.answer,
      explain: row.explain ?? '',
      joke: row.joke ?? '',
      state,
      xp,
      progress,
      ...(bossOutcome === undefined ? {} : { bossOutcome }),
    };
  }).immediate();

  // Отказ бросается уже после фиксации: пометка `rejected` обязана уцелеть, а
  // исключение изнутри транзакции откатило бы её вместе со всем остальным.
  // Наружу уходит только факт — причина называет эталонный ответ, а его ученик
  // видеть не должен, поэтому подробности идут в журнал.
  if ('defect' in outcome) {
    log(`задание ${request.taskId} отбраковано при приёме ответа: ${outcome.defect}`);
    throw new SessionError(
      'task-defective',
      `Занятие: задание ${request.taskId} отбраковано, возьмите следующее`,
    );
  }
  return outcome;
}

/** Закрывает доступное исправление без возврата уже потраченной жизни. */
export function skipRetry(db: Database, runId: number, taskId: number): RunProgress {
  return db.transaction((): RunProgress => {
    const run = readActiveRun(db, runId);
    if (run.kind !== 'run' || run.retry_task_id !== taskId) {
      throw new SessionError(
        'task-not-in-run',
        `Забег ${runId} не ожидает исправления задания ${taskId}`,
      );
    }
    const current = db.prepare<[number, number], { id: number }>(
      `SELECT id FROM attempts
        WHERE run_id = ? AND task_id = ? AND is_current = 1`,
    ).get(runId, taskId);
    if (current === undefined) {
      throw new Error(`Забег ${runId} не хранит текущую попытку задания ${taskId}`);
    }
    const open = db.prepare<[number], { id: number }>(
      "SELECT id FROM disputes WHERE attempt_id = ? AND status = 'open' LIMIT 1",
    ).get(current.id);
    if (open !== undefined) {
      throw new SessionError(
        'run-not-ready',
        `Забег ${runId}: пропуск недоступен, пока разбирается спор`,
      );
    }
    const changed = db.prepare(
      'UPDATE runs SET retry_task_id = NULL WHERE id = ? AND retry_task_id = ?',
    ).run(runId, taskId);
    if (changed.changes !== 1) {
      throw new SessionError('run-not-ready', `Исправление задания ${taskId} уже закрыто`);
    }
    return runProgress(db, runId);
  }).immediate();
}

export type DisputeStatus = 'open' | 'upheld' | 'rejected';

export interface OpenDisputeResult {
  id: number;
  status: DisputeStatus;
  /** Спор заведён этим вызовом: только тогда его надо ставить на разбор. */
  created: boolean;
}

/**
 * Ставит спорный ответ в очередь разбора. Повторное нажатие кнопки отдаёт тот
 * же спор, а не заводит второй: разбор стоит вызова модели, и два вердикта по
 * одной попытке всё равно спорили бы уже друг с другом.
 */
export function openDispute(db: Database, attemptId: number): OpenDisputeResult {
  return db.transaction((): OpenDisputeResult => {
    const attempt = db
      .prepare<
        [number],
        {
          id: number; is_correct: number; run_id: number | null;
          finished_at: string | null; kind: string | null; is_current: number;
        }
      >(
        `SELECT attempts.id, attempts.is_correct, attempts.run_id, attempts.is_current,
                runs.finished_at, runs.kind
           FROM attempts
           LEFT JOIN runs ON runs.id = attempts.run_id
          WHERE attempts.id = ?`,
      )
      .get(attemptId);
    if (attempt === undefined) {
      throw new SessionError('attempt-not-found', `Занятие: попытки ${attemptId} нет`);
    }
    // Заведённый спор ищется раньше проверки «попытка и так засчитана»: после
    // подтверждённого спора попытка как раз становится верной, и на повторное
    // нажатие кнопки ученик должен получить вердикт по своему спору, а не отказ.
    const existing = db
      .prepare<[number], { id: number; status: DisputeStatus }>(
        'SELECT id, status FROM disputes WHERE attempt_id = ? ORDER BY id LIMIT 1',
      )
      .get(attemptId);
    if (existing !== undefined) {
      return { id: existing.id, status: existing.status, created: false };
    }

    if (attempt.run_id !== null && attempt.finished_at !== null) {
      throw new SessionError('run-finished', `Забег ${attempt.run_id} уже завершён`);
    }

    if (attempt.is_current !== 1) {
      throw new SessionError(
        'attempt-not-found',
        `Занятие: попытка ${attemptId} уже заменена исправлением`,
      );
    }

    if (attempt.is_correct === 1) {
      throw new SessionError(
        'attempt-correct',
        `Занятие: попытка ${attemptId} и так засчитана, спорить не о чем`,
      );
    }

    if (attempt.kind === 'boss' && attempt.run_id !== null) {
      const another = db.prepare<[number, number], { id: number }>(
        `SELECT disputes.id FROM disputes
          JOIN attempts ON attempts.id = disputes.attempt_id
         WHERE attempts.run_id = ? AND disputes.status = 'open'
           AND attempts.id <> ? LIMIT 1`,
      ).get(attempt.run_id, attempt.id);
      if (another !== undefined) {
        throw new SessionError('run-not-ready', `Босс: в бою ${attempt.run_id} уже открыт спор`);
      }
    }

    const info = db.prepare('INSERT INTO disputes (attempt_id) VALUES (?)').run(attemptId);
    return { id: Number(info.lastInsertRowid), status: 'open', created: true };
  }).immediate();
}

export interface ResolveDisputeResult {
  id: number;
  status: DisputeStatus;
  /** Обоснование разбирающего; у уже закрытого спора — сохранённое. */
  resolution: string;
  /** `accept[]` задания после разбора: при подтверждении он пополнен. */
  accept: string[];
  /** Состояние темы после пересчёта; `null`, если пересчитывать было нечего. */
  state: TopicState | null;
  /** Обновлённый прогресс забега и XP текущей версии ответа. */
  progress: RunProgress | null;
  xp: number;
}

interface DisputeRow {
  id: number;
  status: DisputeStatus;
  resolution: string | null;
  attempt_id: number;
  run_id: number | null;
  run_kind: string | null;
  topic_id: string;
  given: string;
  task_id: number;
  question: string;
  answer: string;
  accept: string;
  is_current: number;
  is_correct: number;
  life_charged: number;
  hint_used: number;
  difficulty: number;
  affects_progress: number;
}

function disputeProgress(db: Database, row: DisputeRow): RunProgress | null {
  return row.run_id === null ? null : runProgress(db, row.run_id);
}

function disputeXp(row: DisputeRow): number {
  return row.status === 'upheld' && row.is_current === 1 && row.affects_progress === 1
    ? taskXp({ difficulty: row.difficulty, correct: true, hintUsed: row.hint_used === 1 })
    : 0;
}

function readDispute(db: Database, disputeId: number): DisputeRow {
  const row = db
    .prepare<[number], DisputeRow>(
      `SELECT disputes.id, disputes.status, disputes.resolution,
              attempts.id AS attempt_id, attempts.run_id, runs.kind AS run_kind,
              attempts.topic_id, attempts.is_current, attempts.is_correct,
              attempts.life_charged, attempts.hint_used, attempts.affects_progress,
              attempts.answer AS given,
              task_bank.id AS task_id, task_bank.question, task_bank.answer, task_bank.accept,
              task_bank.difficulty
         FROM disputes
         JOIN attempts ON attempts.id = disputes.attempt_id
         LEFT JOIN runs ON runs.id = attempts.run_id
         JOIN task_bank ON task_bank.id = attempts.task_id
        WHERE disputes.id = ?`,
    )
    .get(disputeId);
  if (row === undefined) {
    throw new SessionError('dispute-not-found', `Занятие: спора ${disputeId} нет`);
  }
  return row;
}

/** Сохранённый результат уже завершённого спора без повторного вызова модели. */
export function readResolvedDispute(
  db: Database,
  disputeId: number,
): Pick<ResolveDisputeResult, 'progress' | 'xp'> | null {
  const row = readDispute(db, disputeId);
  return row.status === 'open'
    ? null
    : { progress: disputeProgress(db, row), xp: disputeXp(row) };
}

/**
 * Разбирает спор и, если ученик прав, возвращает ему баллы задним числом:
 * попытка становится верной, ответ дописывается в `accept[]` задания, а модель
 * знаний темы пересчитывается по всей её истории.
 *
 * Пересчёт, а не обратный сдвиг: `mastery` меняется цепочкой, и после спорной
 * попытки успели пройти другие — вычесть из результата один шаг задним числом
 * уже нельзя.
 *
 * Уже закрытый спор второй раз не разбирается: вызов возвращает сохранённый
 * вердикт, не трогая ни модель, ни задание.
 *
 * Подтверждение спора всегда засчитывает попытку, но не всякий ответ попадает в
 * `accept[]`: пустая строка, «45 и 46» и число, отличное от эталона, не проходят
 * `fitsAccept` и дописаны не будут — иначе выгруженный посевной файл предмета
 * перестал бы разбираться этим же `parseTaskBatch`.
 */
export async function resolveDispute(
  db: Database,
  graph: TopicGraph,
  disputeId: number,
  review: DisputeReviewer,
): Promise<ResolveDisputeResult> {
  const dispute = readDispute(db, disputeId);
  const accept = parseAccept(dispute.accept, dispute.task_id);
  if (dispute.status !== 'open') {
    return {
      id: dispute.id,
      status: dispute.status,
      resolution: dispute.resolution ?? '',
      accept,
      state: null,
      progress: disputeProgress(db, dispute),
      xp: disputeXp(dispute),
    };
  }

  const topic = topicOf(graph, dispute.topic_id);
  const context: DisputeContext = {
    topic,
    question: dispute.question,
    expected: dispute.answer,
    accept,
    given: dispute.given,
  };
  // Вызов модели — вне транзакции: он идёт минуты, а под WAL всё это время
  // держал бы запись, то есть занятие вставало бы на каждом споре.
  const verdict = await review(context);

  return db.transaction((): ResolveDisputeResult => {
    // Спор перечитывается уже под записью: пока шёл вызов модели, его мог
    // закрыть параллельный разбор, и второй вердикт удвоил бы `accept[]`.
    const fresh = readDispute(db, disputeId);
    const current = parseAccept(fresh.accept, fresh.task_id);
    if (fresh.status !== 'open') {
      return {
        id: fresh.id,
        status: fresh.status,
        resolution: fresh.resolution ?? '',
        accept: current,
        state: null,
        progress: disputeProgress(db, fresh),
        xp: disputeXp(fresh),
      };
    }

    const status: DisputeStatus = verdict.studentCorrect ? 'upheld' : 'rejected';
    const resolvedAt = new Date().toISOString();
    db.prepare(
      `UPDATE disputes
          SET status = @status, resolution = @resolution,
              resolved_at = @resolvedAt
        WHERE id = @id`,
    ).run({ id: disputeId, status, resolution: verdict.note, resolvedAt });

    if (!verdict.studentCorrect) {
      if (fresh.run_kind === 'boss' && fresh.run_id !== null) {
        finishBossLoss(db, fresh.run_id, resolvedAt);
      }
      const rejected = readDispute(db, disputeId);
      return {
        id: disputeId,
        status,
        resolution: verdict.note,
        accept: current,
        state: null,
        progress: disputeProgress(db, rejected),
        xp: 0,
      };
    }

    const given = fresh.given.trim();
    const keys = new Set(
      [fresh.answer, ...current].map((value) => duplicateKey(value, topic.answerFormat)),
    );
    const next =
      !fitsAccept(given, topic.answerFormat, fresh.answer) ||
      keys.has(duplicateKey(given, topic.answerFormat))
        ? current
        : [...current, given];

    db.prepare('UPDATE task_bank SET accept = @accept WHERE id = @id').run({
      id: fresh.task_id,
      accept: JSON.stringify(next),
    });
    db.prepare('UPDATE attempts SET is_correct = 1 WHERE id = ?').run(fresh.attempt_id);
    if (fresh.run_id !== null) {
      if (fresh.run_kind === 'run') {
        db.prepare(
          `UPDATE runs
              SET correct = correct + 1,
                  lives_remaining = CASE
                    WHEN @lifeCharged = 1 THEN MIN(3, lives_remaining + 1)
                    ELSE lives_remaining
                  END,
                  retry_task_id = CASE
                    WHEN retry_task_id = @taskId THEN NULL ELSE retry_task_id
                  END
            WHERE id = @runId`,
        ).run({
          runId: fresh.run_id,
          taskId: fresh.task_id,
          lifeCharged: fresh.life_charged,
        });
      } else {
        db.prepare('UPDATE runs SET correct = correct + 1 WHERE id = ?').run(fresh.run_id);
      }
      if (fresh.run_kind === 'boss') {
        const fight = readBossFight(db, fresh.run_id);
        if (fight === undefined || !bossFightConsistent(fight)) {
          throw new Error(`Босс: бой ${fresh.run_id} несогласован после спора`);
        }
        if (fight.total === BOSS_TARGET && fight.correct === BOSS_TARGET) {
          finishBossWin(db, fight, resolvedAt);
        }
      }
    }

    const upheld = readDispute(db, disputeId);
    return {
      id: disputeId,
      status,
      resolution: verdict.note,
      accept: next,
      state: fresh.affects_progress === 1 ? recomputeTopicState(db, fresh.topic_id) : null,
      progress: disputeProgress(db, upheld),
      xp: disputeXp(upheld),
    };
  }).immediate();
}

/**
 * Споры, ждущие разбора. Отдельной очереди по ним нет: спор ставит на разбор
 * маршрут, и он же переставляет его на следующем нажатии кнопки, если разбор не
 * состоялся (codex недоступен, ответ не разобрался, сервер перезапустился).
 * Список нужен, чтобы такой спор было видно снаружи занятия.
 */
export function openDisputes(db: Database): number[] {
  return db
    .prepare<[], { id: number }>("SELECT id FROM disputes WHERE status = 'open' ORDER BY id")
    .all()
    .map((row) => row.id);
}
