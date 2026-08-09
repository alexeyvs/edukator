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
import { taskPromptText, type GeneratedTask, type MaterialFormat } from './task-schema.js';
import { LEARNING_TASK_COUNT } from '../learning-constants.js';

/** Задание, лежащее в банке: поля генератора плюс то, чем его различает база. */
type StoredTaskBody = Omit<GeneratedTask, 'instruction' | 'material' | 'material_format' | 'choices'>;
export type BankTask = StoredTaskBody & { id: number; topicId: string; question: string } & (
  | Pick<GeneratedTask, 'instruction' | 'material' | 'material_format' | 'choices'>
  | { question: string; instruction?: undefined }
);

export interface StoreTasksResult {
  stored: BankTask[];
  /** Задания, отвергнутые как повтор: уже лежащий в теме или дубль внутри батча. */
  duplicates: GeneratedTask[];
}

export interface ReserveBossTasksResult extends StoreTasksResult {
  /** Полный набор связан с батчем и может быть активирован. */
  ready: boolean;
}

export interface ReserveLearningTasksResult extends StoreTasksResult {
  /** Содержимое и полный тест опубликованы одной транзакцией. */
  ready: boolean;
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
  instruction: string | null;
  material: string | null;
  material_format: MaterialFormat | null;
  choices: string | null;
  answer: string;
  accept: string;
  hint: string | null;
  explain: string | null;
  joke: string | null;
  difficulty: number;
}

interface PreparedTask {
  task: GeneratedTask;
  prompt: string;
  fingerprint: string;
  choices: string;
  accept: string;
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

function parseChoices(raw: string | null, id: number): string[] {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Банк заданий: задание ${id} хранит choices не как JSON (${raw})`);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error(`Банк заданий: choices задания ${id} должен быть массивом строк`);
  }
  return parsed as string[];
}

function toBankTask(row: TaskRow): BankTask {
  const structured = row.instruction === null
    ? { question: row.question }
    : {
        question: row.question,
        instruction: row.instruction,
        material: row.material ?? '',
        material_format: row.material_format ?? 'none',
        choices: parseChoices(row.choices, row.id),
      };
  return {
    id: row.id,
    topicId: row.topic_id,
    ...structured,
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

const TASK_COLUMNS = `id, topic_id, question, instruction, material, material_format, choices,
  answer, accept, hint, explain, joke, difficulty`;

function prepareTasks(tasks: readonly GeneratedTask[]): PreparedTask[] {
  return tasks.map((task) => {
    const prompt = taskPromptText(task);
    const fingerprint = questionFingerprint(prompt);
    if (fingerprint === '') {
      throw new Error(`Банк заданий: формулировка «${prompt}» пуста после нормализации`);
    }
    return {
      task,
      prompt,
      fingerprint,
      choices: JSON.stringify(task.choices),
      accept: JSON.stringify(task.accept),
    };
  });
}

type InsertStatus = 'valid' | 'boss_reserved' | 'lesson_reserved';

function insertPreparedTasks(
  db: Database,
  topicId: string,
  prepared: readonly PreparedTask[],
  status: InsertStatus,
): StoreTasksResult {
  const insert = db.prepare<
    {
      topicId: string;
      question: string;
      instruction: string | null;
      material: string | null;
      materialFormat: MaterialFormat | null;
      choices: string;
      answer: string;
      accept: string;
      hint: string;
      explain: string;
      joke: string;
      difficulty: number;
      status: InsertStatus;
      fingerprint: string;
    },
    { id: number }
  >(
    `INSERT INTO task_bank
       (topic_id, question, instruction, material, material_format, choices,
        answer, accept, hint, explain, joke, difficulty, status, fingerprint)
     VALUES (@topicId, @question, @instruction, @material, @materialFormat, @choices,
             @answer, @accept, @hint, @explain, @joke, @difficulty, @status, @fingerprint)
     ON CONFLICT DO NOTHING
     RETURNING id`,
  );

  const stored: BankTask[] = [];
  const duplicates: GeneratedTask[] = [];
  for (const item of prepared) {
    const { task, fingerprint, prompt } = item;
    const row = insert.get({
      topicId,
      question: prompt,
      instruction: task.instruction,
      material: task.material,
      materialFormat: task.material_format,
      choices: item.choices,
      answer: task.answer,
      accept: item.accept,
      hint: task.hint,
      explain: task.explain,
      joke: task.joke,
      difficulty: task.difficulty,
      status,
      fingerprint,
    });

    if (row === undefined) duplicates.push(task);
    else stored.push({ ...task, question: prompt, accept: [...task.accept], id: row.id, topicId });
  }
  return { stored, duplicates };
}

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
  const prepared = prepareTasks(tasks);

  return db.transaction((): StoreTasksResult => {
    ensureTopic(db, topicId);

    return insertPreparedTasks(db, topicId, prepared, 'valid');
  }).immediate();
}

/**
 * Резервирует ровно пять свежих заданий для уже созданного `preparing`-батча.
 * Связи, строки банка и переход в `ready` фиксируются одной транзакцией.
 */
export function reserveBossTasks(
  db: Database,
  batchId: number,
  tasks: readonly GeneratedTask[],
): ReserveBossTasksResult {
  const prepared = prepareTasks(tasks);

  return db.transaction((): ReserveBossTasksResult => {
    const batch = db.prepare<[number], { topic_id: string; status: string }>(
      'SELECT topic_id, status FROM boss_batches WHERE id = ?',
    ).get(batchId);
    if (batch === undefined) throw new Error(`Банк заданий: boss-батч ${batchId} не найден`);
    if (batch.status !== 'preparing') {
      throw new Error(`Банк заданий: boss-батч ${batchId} не готовится (${batch.status})`);
    }
    ensureTopic(db, batch.topic_id);

    const result = insertPreparedTasks(db, batch.topic_id, prepared, 'boss_reserved');
    if (tasks.length !== 5 || result.stored.length !== 5 || result.duplicates.length > 0) {
      if (result.stored.length > 0) {
        const ids = result.stored.map(({ id }) => id);
        const placeholders = ids.map(() => '?').join(', ');
        db.prepare(`UPDATE task_bank SET status = 'rejected' WHERE id IN (${placeholders})`).run(...ids);
      }
      db.prepare("UPDATE boss_batches SET status = 'failed' WHERE id = ? AND status = 'preparing'")
        .run(batchId);
      return { stored: [], duplicates: result.duplicates, ready: false };
    }

    const link = db.prepare(
      'INSERT INTO boss_tasks (batch_id, task_id, position) VALUES (?, ?, ?)',
    );
    result.stored.forEach(({ id }, index) => link.run(batchId, id, index + 1));
    db.prepare("UPDATE boss_batches SET status = 'ready' WHERE id = ? AND status = 'preparing'")
      .run(batchId);
    return { ...result, ready: true };
  }).immediate();
}

/**
 * Вставляет пять свежих заданий, связывает их с материалом и публикует теорию
 * одной транзакцией. Частичный комплект никогда не становится видимым.
 */
export function reserveLearningTasks(
  db: Database,
  materialId: number,
  content: unknown,
  tasks: readonly GeneratedTask[],
  now: Date = new Date(),
): ReserveLearningTasksResult {
  const prepared = prepareTasks(tasks);
  if (!Number.isFinite(now.getTime())) throw new Error('Банк заданий: некорректное время публикации материала');
  const nowIso = now.toISOString();
  const serialized = JSON.stringify(content);
  if (serialized === undefined) throw new Error('Банк заданий: содержимое материала не сериализуется в JSON');

  return db.transaction((): ReserveLearningTasksResult => {
    const material = db.prepare<[number], { topic_id: string; status: string }>(
      'SELECT topic_id, status FROM learning_materials WHERE id = ?',
    ).get(materialId);
    if (material === undefined) throw new Error(`Банк заданий: материал ${materialId} не найден`);
    if (material.status !== 'preparing') {
      throw new Error(`Банк заданий: материал ${materialId} не готовится (${material.status})`);
    }
    ensureTopic(db, material.topic_id);

    const result = insertPreparedTasks(db, material.topic_id, prepared, 'lesson_reserved');
    if (
      tasks.length !== LEARNING_TASK_COUNT || result.stored.length !== LEARNING_TASK_COUNT ||
      result.duplicates.length > 0
    ) {
      if (result.stored.length > 0) {
        const ids = result.stored.map(({ id }) => id);
        const placeholders = ids.map(() => '?').join(', ');
        db.prepare(`UPDATE task_bank SET status = 'rejected' WHERE id IN (${placeholders})`).run(...ids);
      }
      db.prepare(
        `UPDATE learning_materials
            SET status = 'rejected', updated_at = ?, finished_at = ?
          WHERE id = ? AND status = 'preparing'`,
      ).run(nowIso, nowIso, materialId);
      return { stored: [], duplicates: result.duplicates, ready: false };
    }

    const link = db.prepare(
      'INSERT INTO learning_tasks (material_id, task_id, position) VALUES (?, ?, ?)',
    );
    result.stored.forEach(({ id }, index) => link.run(materialId, id, index + 1));
    const changed = db.prepare(
      `UPDATE learning_materials
          SET content = ?, status = 'ready', updated_at = ?
        WHERE id = ? AND status = 'preparing'`,
    ).run(serialized, nowIso, materialId);
    if (changed.changes !== 1) throw new Error(`Банк заданий: claim материала ${materialId} изменился`);
    return { ...result, ready: true };
  }).immediate();
}

/** Читает только запрошенную позицию батча и не повторяет уже отвеченное задание. */
export function bossTaskAtPosition(db: Database, batchId: number, position: number): BankTask | null {
  if (!Number.isInteger(position) || position < 1 || position > 5) {
    throw new Error(`Банк заданий: позиция босса должна быть от 1 до 5, получено ${position}`);
  }
  const result = db.transaction((): { task: BankTask | null; error?: Error } => {
    const row = db.prepare<[number, number], TaskRow>(
      `SELECT ${TASK_COLUMNS.replaceAll(/\bid\b/gu, 'task_bank.id')}
         FROM boss_tasks
         JOIN task_bank ON task_bank.id = boss_tasks.task_id
        WHERE boss_tasks.batch_id = ? AND boss_tasks.position = ?
          AND task_bank.status = 'boss_reserved'
          AND NOT EXISTS (SELECT 1 FROM attempts WHERE attempts.task_id = task_bank.id)`,
    ).get(batchId, position);
    if (row === undefined) return { task: null };
    try {
      return { task: toBankTask(row) };
    } catch (error) {
      db.prepare(
        `UPDATE task_bank SET status = 'rejected'
          WHERE id IN (SELECT task_id FROM boss_tasks WHERE batch_id = ?)`,
      ).run(batchId);
      db.prepare(
        `UPDATE boss_batches SET status = 'failed'
          WHERE id = ? AND status IN ('preparing', 'ready', 'active')`,
      ).run(batchId);
      return { task: null, error: error instanceof Error ? error : new Error(String(error)) };
    }
  }).immediate();
  if (result.error !== undefined) throw result.error;
  return result.task;
}

/** Читает ровно одну позицию опубликованного теста, не раскрывая соседние задания. */
export function learningTaskAtPosition(
  db: Database,
  materialId: number,
  position: number,
): BankTask | null {
  if (!Number.isInteger(position) || position < 1 || position > LEARNING_TASK_COUNT) {
    throw new Error(
      `Банк заданий: позиция материала должна быть от 1 до ${LEARNING_TASK_COUNT}, получено ${position}`,
    );
  }
  const row = db.prepare<[number, number], TaskRow>(
    `SELECT ${TASK_COLUMNS.replaceAll(/\bid\b/gu, 'task_bank.id')}
       FROM learning_tasks
       JOIN task_bank ON task_bank.id = learning_tasks.task_id
      WHERE learning_tasks.material_id = ? AND learning_tasks.position = ?
        AND task_bank.status = 'lesson_reserved'
        AND NOT EXISTS (SELECT 1 FROM attempts WHERE attempts.task_id = task_bank.id)`,
  ).get(materialId, position);
  return row === undefined ? null : toBankTask(row);
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
