/**
 * Занятие: выдача задания, приём ответа и разбор спора «я всё-таки прав».
 * Здесь только логика и доступ к базе — HTTP живёт в `server/routes/session.ts`.
 *
 * Тему выбирает планировщик этапа 1, задание берётся из тёплой очереди с
 * откатом на посевной банк: генерировать в момент показа нельзя, батч занимает
 * у модели полминуты.
 *
 * Ответ сверяется нормализатором, без обращения к модели, и попытка вместе со
 * сдвигом `mastery` пишется одной транзакцией: засчитанный ответ без сдвига
 * модели (или наоборот) — это молча разъехавшийся прогноз.
 *
 * Спор ученик не ждёт: маршрут только ставит его в очередь, а разбор идёт фоном
 * и, при подтверждении, дописывает ответ в `accept[]` и пересчитывает модель по
 * всей истории темы. Банк от этого самоисправляется — следующий такой же ответ
 * засчитается сразу.
 */
import type { Database } from 'better-sqlite3';
import type { AnswerFormat, Topic, TopicGraph } from './curriculum.js';
import type { Subject } from './db.js';
import { recomputeTopicState, recordAttempt, type TopicState } from './mastery.js';
import { checkAnswer, type RejectReason } from './normalize.js';
import { planFromDatabase } from './scheduler.js';
import { takeTaskOrSeed } from './codex/seed-bank.js';
import { duplicateKey } from './codex/task-schema.js';
import type { DisputeContext, DisputeReviewer } from './codex/dispute.js';

/** Причина отказа: по ней маршрут выбирает код ответа. */
export type SessionErrorCode =
  | 'task-not-found'
  | 'task-not-issued'
  | 'already-answered'
  | 'attempt-not-found'
  | 'attempt-correct'
  | 'dispute-not-found';

/** Отказ по состоянию занятия, а не по поломке: маршрут отвечает на него 4xx. */
export class SessionError extends Error {
  constructor(
    readonly code: SessionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SessionError';
  }
}

/**
 * Задание в том виде, в каком его получает ученик. Ни `answer`, ни `accept[]`
 * здесь нет и быть не может: сверка идёт на сервере, а приехавший в браузер
 * ответ означал бы, что смотреть его проще, чем решать.
 *
 * `explain` и `joke` тоже остаются на сервере до ответа: разбор пересказывает
 * решение целиком, то есть содержит тот же ответ другими словами.
 */
export interface IssuedTask {
  id: number;
  topicId: string;
  subject: Subject;
  topicTitle: string;
  question: string;
  hint: string;
  difficulty: number;
  answerFormat: AnswerFormat;
}

export type NextTaskResult =
  | { status: 'ok'; task: IssuedTask }
  /** Планировщику нечего предложить: всё освоено или закрыто предпосылками. */
  | { status: 'no-topic' }
  /** Тема выбрана, но очередь и посев по ней пусты. */
  | { status: 'no-task'; topicId: string };

export interface NextTaskOptions {
  now?: Date;
  /** Каталог посевного банка; по умолчанию репозиторный. */
  seedDir?: string;
}

/**
 * Следующее задание: тема от планировщика, задание из банка. Целевая сложность —
 * базовая сложность темы; подстройку под точность ученика делает триаж этапа 3.
 */
export function nextTask(
  db: Database,
  graph: TopicGraph,
  options: NextTaskOptions = {},
): NextTaskResult {
  const now = options.now ?? new Date();
  const [planned] = planFromDatabase(db, graph, 1, now);
  if (planned === undefined) return { status: 'no-topic' };

  const { topic } = planned;
  const task = takeTaskOrSeed(db, graph, topic.id, {
    difficulty: topic.difficulty,
    ...(options.seedDir === undefined ? {} : { dir: options.seedDir }),
  });
  if (task === null) return { status: 'no-task', topicId: topic.id };

  return {
    status: 'ok',
    task: {
      id: task.id,
      topicId: topic.id,
      subject: topic.subject,
      topicTitle: topic.title,
      question: task.question,
      hint: task.hint,
      difficulty: task.difficulty,
      answerFormat: topic.answerFormat,
    },
  };
}

export interface AnswerRequest {
  taskId: number;
  answer: string;
  hintUsed?: boolean;
  durationMs?: number;
  /** Время попытки; по умолчанию — сейчас. Задаётся явно в тестах. */
  at?: Date;
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
      `SELECT id, topic_id, answer, accept, explain, joke, difficulty, status
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
  const at = request.at ?? new Date();
  const hintUsed = request.hintUsed ?? false;
  const durationMs = Math.max(0, Math.round(request.durationMs ?? 0));

  // Всё одной `immediate`-транзакцией: проверка «уже отвечали», запись попытки
  // и сдвиг модели обязаны видеть один снимок, иначе два одновременных ответа
  // на одно задание оба пройдут проверку и оба сдвинут `mastery`.
  return db.transaction((): AnswerResult => {
    const row = readTask(db, request.taskId);
    if (row.status !== 'used') {
      throw new SessionError(
        'task-not-issued',
        `Занятие: задание ${request.taskId} ученику не выдавалось`,
      );
    }

    const answered = db
      .prepare<[number], { id: number }>('SELECT id FROM attempts WHERE task_id = ? LIMIT 1')
      .get(request.taskId);
    if (answered !== undefined) {
      throw new SessionError(
        'already-answered',
        `Занятие: на задание ${request.taskId} уже отвечали`,
      );
    }

    const topic = topicOf(graph, row.topic_id);
    const check = checkAnswer(
      request.answer,
      { answer: row.answer, accept: parseAccept(row.accept, row.id) },
      topic.answerFormat,
    );

    const info = db
      .prepare(
        `INSERT INTO attempts (task_id, topic_id, answer, is_correct, hint_used, duration_ms, created_at)
         VALUES (@taskId, @topicId, @answer, @isCorrect, @hintUsed, @durationMs, @createdAt)`,
      )
      .run({
        taskId: row.id,
        topicId: row.topic_id,
        // Пишется то, что ученик набрал: нормализованную запись всегда можно
        // получить заново, а вот разбор спора смотрит именно на исходную.
        answer: request.answer.trim(),
        isCorrect: check.correct ? 1 : 0,
        hintUsed: hintUsed ? 1 : 0,
        durationMs,
        createdAt: at.toISOString(),
      });

    const state = recordAttempt(db, row.topic_id, {
      correct: check.correct,
      difficulty: row.difficulty,
      hintUsed,
      at,
    });

    return {
      attemptId: Number(info.lastInsertRowid),
      correct: check.correct,
      normalized: check.normalized,
      ...(check.reason === undefined ? {} : { reason: check.reason }),
      answer: row.answer,
      explain: row.explain ?? '',
      joke: row.joke ?? '',
      state,
    };
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
      .prepare<[number], { id: number; is_correct: number }>(
        'SELECT id, is_correct FROM attempts WHERE id = ?',
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

    if (attempt.is_correct === 1) {
      throw new SessionError(
        'attempt-correct',
        `Занятие: попытка ${attemptId} и так засчитана, спорить не о чем`,
      );
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
}

interface DisputeRow {
  id: number;
  status: DisputeStatus;
  resolution: string | null;
  attempt_id: number;
  topic_id: string;
  given: string;
  task_id: number;
  question: string;
  answer: string;
  accept: string;
}

function readDispute(db: Database, disputeId: number): DisputeRow {
  const row = db
    .prepare<[number], DisputeRow>(
      `SELECT disputes.id, disputes.status, disputes.resolution,
              attempts.id AS attempt_id, attempts.topic_id, attempts.answer AS given,
              task_bank.id AS task_id, task_bank.question, task_bank.answer, task_bank.accept
         FROM disputes
         JOIN attempts ON attempts.id = disputes.attempt_id
         JOIN task_bank ON task_bank.id = attempts.task_id
        WHERE disputes.id = ?`,
    )
    .get(disputeId);
  if (row === undefined) {
    throw new SessionError('dispute-not-found', `Занятие: спора ${disputeId} нет`);
  }
  return row;
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
      };
    }

    const status: DisputeStatus = verdict.studentCorrect ? 'upheld' : 'rejected';
    db.prepare(
      `UPDATE disputes
          SET status = @status, resolution = @resolution,
              resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = @id`,
    ).run({ id: disputeId, status, resolution: verdict.note });

    if (!verdict.studentCorrect) {
      return { id: disputeId, status, resolution: verdict.note, accept: current, state: null };
    }

    const given = fresh.given.trim();
    const keys = new Set(
      [fresh.answer, ...current].map((value) => duplicateKey(value, topic.answerFormat)),
    );
    const next = keys.has(duplicateKey(given, topic.answerFormat)) ? current : [...current, given];

    db.prepare('UPDATE task_bank SET accept = @accept WHERE id = @id').run({
      id: fresh.task_id,
      accept: JSON.stringify(next),
    });
    db.prepare('UPDATE attempts SET is_correct = 1 WHERE id = ?').run(fresh.attempt_id);

    return {
      id: disputeId,
      status,
      resolution: verdict.note,
      accept: next,
      state: recomputeTopicState(db, fresh.topic_id),
    };
  }).immediate();
}

/** Споры, ждущие разбора: по ним фоновая очередь и работает. */
export function openDisputes(db: Database): number[] {
  return db
    .prepare<[], { id: number }>("SELECT id FROM disputes WHERE status = 'open' ORDER BY id")
    .all()
    .map((row) => row.id);
}
