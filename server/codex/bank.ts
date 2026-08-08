/**
 * Банк заданий: провалидированные задания ложатся в `task_bank`, оттуда их
 * забирает забег, а воркер смотрит на остаток и решает, пора ли генерировать.
 *
 * Повторы отсекаются на входе по отпечатку формулировки (`questionFingerprint`)
 * и уникальному индексу `(topic_id, fingerprint)`: модель, которой скормили
 * список прошлых формулировок, всё равно иногда пересказывает своё же задание,
 * а ученику это читается как «программа топчется на месте».
 *
 * Тема, которой нет в `topic_state`, — ошибка вызывающего, а не пустой банк:
 * состав тем задаёт карта, `syncCurriculumState` заводит строки при старте, и
 * молча вернуть «заданий нет» значило бы спрятать опечатку в `topic_id`.
 */
import type { Database } from 'better-sqlite3';
import { questionFingerprint } from '../normalize.js';
import { RECENT_LIMIT } from './prompt.js';
import type { GeneratedTask } from './task-schema.js';

/** Задание, лежащее в банке: поля генератора плюс то, чем его различает база. */
export interface BankTask extends GeneratedTask {
  id: number;
  topicId: string;
}

export interface StoreTasksResult {
  stored: BankTask[];
  /** Задания, отвергнутые как повтор: уже лежащий в теме или дубль внутри батча. */
  duplicates: GeneratedTask[];
}

export interface TakeTaskOptions {
  /**
   * Желаемая сложность 1-3. Точного совпадения не требуется: пустая очередь
   * нужной сложности — не повод показать ученику спиннер, поэтому берётся
   * ближайшее задание.
   */
  difficulty?: number;
  /** Забег-владелец выдачи; отсутствие означает занятие без забега. */
  runId?: number;
}

interface TaskRow {
  id: number;
  topic_id: string;
  question: string;
  answer: string;
  accept: string;
  hint: string | null;
  explain: string | null;
  joke: string | null;
  difficulty: number;
}

function ensureTopic(db: Database, topicId: string): void {
  const row = db
    .prepare<[string], { ok: number }>('SELECT 1 AS ok FROM topic_state WHERE topic_id = ?')
    .get(topicId);
  if (row === undefined) {
    throw new Error(`Банк заданий: темы «${topicId}» нет в карте`);
  }
}

/**
 * `accept[]` хранится строкой JSON. Повреждение здесь — не «нет вариантов», а
 * задание, которое нормализатор засчитает неверно: тихо подставлять пустой
 * список нельзя.
 */
function parseAccept(raw: string, id: number): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Банк заданий: задание ${id} хранит accept[] не как JSON (${raw})`);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error(`Банк заданий: accept[] задания ${id} должен быть массивом строк`);
  }
  return parsed as string[];
}

function toBankTask(row: TaskRow): BankTask {
  return {
    id: row.id,
    topicId: row.topic_id,
    question: row.question,
    answer: row.answer,
    accept: parseAccept(row.accept, row.id),
    hint: row.hint ?? '',
    explain: row.explain ?? '',
    joke: row.joke ?? '',
    difficulty: row.difficulty,
  };
}

/**
 * Читает строку как задание, а негодную выводит из очереди. Без пометки строка
 * остаётся `used` без попытки, то есть ровно тем, что `issuedTask` находит
 * снова: одно повреждённое `accept[]` хоронило бы тему навсегда, потому что
 * занятие обходит стороной всю тему, а не это задание.
 */
function toBankTaskOrReject(db: Database, row: TaskRow): BankTask {
  try {
    return toBankTask(row);
  } catch (error) {
    db.prepare("UPDATE task_bank SET status = 'rejected' WHERE id = ?").run(row.id);
    throw error;
  }
}

const TASK_COLUMNS = 'id, topic_id, question, answer, accept, hint, explain, joke, difficulty';

/**
 * Кладёт провалидированные задания в банк и отдельно возвращает отсеянные
 * повторы. Батч пишется одной транзакцией: половина батча в базе и ошибка
 * наверх — состояние, в котором непонятно, что перегенерировать.
 */
export function storeTasks(
  db: Database,
  topicId: string,
  tasks: readonly GeneratedTask[],
): StoreTasksResult {
  const prepared = tasks.map((task) => {
    const fingerprint = questionFingerprint(task.question);
    if (fingerprint === '') {
      throw new Error(`Банк заданий: формулировка «${task.question}» пуста после нормализации`);
    }
    return { task, fingerprint };
  });

  // `ON CONFLICT DO NOTHING` вместо «прочитать отпечатки, потом вставить»:
  // проверка и запись — один оператор, и параллельный воркер не может
  // проскочить между ними с тем же заданием.
  const insert = db.prepare<
    {
      topicId: string;
      question: string;
      answer: string;
      accept: string;
      hint: string;
      explain: string;
      joke: string;
      difficulty: number;
      fingerprint: string;
    },
    { id: number }
  >(
    `INSERT INTO task_bank
       (topic_id, question, answer, accept, hint, explain, joke, difficulty, status, fingerprint)
     VALUES (@topicId, @question, @answer, @accept, @hint, @explain, @joke, @difficulty, 'valid', @fingerprint)
     ON CONFLICT DO NOTHING
     RETURNING id`,
  );

  return db.transaction((): StoreTasksResult => {
    ensureTopic(db, topicId);

    const stored: BankTask[] = [];
    const duplicates: GeneratedTask[] = [];

    for (const { task, fingerprint } of prepared) {
      const row = insert.get({
        topicId,
        question: task.question,
        answer: task.answer,
        accept: JSON.stringify(task.accept),
        hint: task.hint,
        explain: task.explain,
        joke: task.joke,
        difficulty: task.difficulty,
        fingerprint,
      });

      if (row === undefined) duplicates.push(task);
      else stored.push({ ...task, accept: [...task.accept], id: row.id, topicId });
    }

    return { stored, duplicates };
  }).immediate();
}

/**
 * Выдаёт непросмотренное задание темы и тем же оператором помечает его
 * выданным: выбор и пометка врозь дали бы двум забегам одно задание. Пустая
 * очередь — обычный ответ `null`, а не ошибка: на него у воркера свой сценарий.
 *
 * Задание с повреждённым `accept[]` роняет вызов уже помеченным выданным,
 * поэтому такая строка тут же помечается `rejected` (`toBankTaskOrReject`):
 * иначе `issuedTask` возвращал бы её снова, а занятие обходит стороной всю тему
 * (`nextTask`), и тема с одним битым заданием больше не выдавалась бы.
 */
export function takeTask(
  db: Database,
  topicId: string,
  options: TakeTaskOptions = {},
): BankTask | null {
  ensureTopic(db, topicId);

  const { difficulty } = options;
  // Отметки времени внутри батча совпадают до миллисекунды, поэтому порядок
  // добивается по `id`: иначе выдача внутри батча непредсказуема.
  const order = difficulty === undefined
    ? 'created_at, id'
    : 'ABS(difficulty - @difficulty), created_at, id';

  const row = db
    .prepare<{ topicId: string; difficulty?: number; runId: number | null }, TaskRow>(
      `UPDATE task_bank SET status = 'used', issued_run_id = @runId
        WHERE id = (
          SELECT id FROM task_bank
           WHERE topic_id = @topicId AND status = 'valid'
           ORDER BY ${order}
           LIMIT 1)
       RETURNING ${TASK_COLUMNS}`,
    )
    .get({ topicId, runId: options.runId ?? null, ...(difficulty === undefined ? {} : { difficulty }) });

  return row === undefined ? null : toBankTaskOrReject(db, row);
}

/**
 * Задание, которое ученику уже выдали, но ответа на него ещё нет. Нужно, чтобы
 * перезагрузка страницы не сжигала очередь: `takeTask` помечает выданное `used`
 * безвозвратно, и без повторной выдачи несколько обновлений подряд опустошали
 * бы тему, ни разу не спросив ученика.
 */
export function issuedTask(
  db: Database,
  topicId: string,
  runId?: number,
  excludeTaskId?: number,
): BankTask | null {
  ensureTopic(db, topicId);

  const row = db
    .prepare<{ topicId: string; runId: number | null; excludeTaskId: number | null }, TaskRow>(
      `SELECT ${TASK_COLUMNS} FROM task_bank
        WHERE topic_id = @topicId AND status = 'used'
          AND issued_run_id IS @runId
          AND (@excludeTaskId IS NULL OR id != @excludeTaskId)
          AND NOT EXISTS (SELECT 1 FROM attempts WHERE attempts.task_id = task_bank.id)
        ORDER BY created_at, id
        LIMIT 1`,
    )
    .get({ topicId, runId: runId ?? null, excludeTaskId: excludeTaskId ?? null });

  return row === undefined ? null : toBankTaskOrReject(db, row);
}

/**
 * Последние формулировки темы — вход промпта генератора. Берутся задания любого
 * состояния: повторять нельзя и то, что ученик уже видел, и то, что лежит в
 * очереди непоказанным. Порядок хронологический, как его ждёт промпт.
 */
export function recentQuestions(
  db: Database,
  topicId: string,
  limit: number = RECENT_LIMIT,
): string[] {
  ensureTopic(db, topicId);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Банк заданий: предел выборки должен быть положительным целым, получено ${limit}`);
  }

  return db
    .prepare<[string, number], { question: string }>(
      `SELECT question FROM task_bank
        WHERE topic_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(topicId, limit)
    .map((row) => row.question)
    .reverse();
}

/** Остаток непросмотренных заданий темы: по нему воркер решает, пора ли доливать. */
export function countAvailable(db: Database, topicId: string): number {
  ensureTopic(db, topicId);

  const row = db
    .prepare<[string], { n: number }>(
      `SELECT COUNT(*) AS n FROM task_bank WHERE topic_id = ? AND status = 'valid'`,
    )
    .get(topicId);
  return row?.n ?? 0;
}
