import type { Database } from 'better-sqlite3';
import type { Topic, TopicGraph } from './curriculum.js';
import type { Subject } from './db.js';
import { issuedTask, takeTask, type BankTask } from './codex/bank.js';
import { projectIssuedTask, type IssuedTask } from './session.js';

/** Число разных тем, достаточное для первичного ранжирования предмета. */
export const TRIAGE_TARGET = 12;

/** Средняя ступень: первый вопрос не должен быть ни заведомо лёгким, ни пиковым. */
export const TRIAGE_START_DIFFICULTY = 2;

const MIN_DIFFICULTY = 1;
const MAX_DIFFICULTY = 3;

export interface TriageOptions {
  /** Предмет проверяет маршрут по строке забега и передаёт политике явно. */
  subject: Subject;
}

export type TriageIssuedTask = IssuedTask;

export type NextTriageTaskResult =
  | { status: 'ok'; task: TriageIssuedTask }
  | { status: 'done'; total: number; target: number };

function clampDifficulty(value: number): number {
  return Math.max(MIN_DIFFICULTY, Math.min(MAX_DIFFICULTY, value));
}

function issued(task: BankTask, topic: Topic): TriageIssuedTask {
  return projectIssuedTask(topic, task);
}

/**
 * Выбирает следующий вопрос триажа. Строку `runs` здесь намеренно не читаем:
 * принадлежность и состояние забега проверяет HTTP-маршрут, а эта функция
 * отвечает только за воспроизводимую политику тем и сложности.
 *
 * Выбор и пометка задания выполняются под одной write-транзакцией. Иначе два
 * одновременных запроса могли прочитать один список использованных тем и выдать
 * ученику две разные темы, хотя ответить он успеет только на одну.
 */
export function nextTriageTask(
  db: Database,
  graph: TopicGraph,
  runId: number,
  options: TriageOptions,
): NextTriageTaskResult {
  return db.transaction((): NextTriageTaskResult => {
    const attempts = db
      .prepare<[number], { topic_id: string; is_correct: number; difficulty: number }>(
        `SELECT attempts.topic_id, attempts.is_correct, task_bank.difficulty
           FROM attempts
           JOIN task_bank ON task_bank.id = attempts.task_id
          WHERE attempts.run_id = ?
          ORDER BY attempts.created_at, attempts.id`,
      )
      .all(runId);

    if (attempts.length >= TRIAGE_TARGET) {
      return { status: 'done', total: attempts.length, target: TRIAGE_TARGET };
    }

    const last = attempts.at(-1);
    const targetDifficulty = last === undefined
      ? TRIAGE_START_DIFFICULTY
      : clampDifficulty(last.difficulty + (last.is_correct === 1 ? 1 : -1));
    const used = new Set(attempts.map((attempt) => attempt.topic_id));
    const topics = graph.bySubject.get(options.subject) ?? [];

    for (const topic of topics) {
      if (used.has(topic.id)) continue;

      // До ответа повторно отдаётся то же задание: обновление страницы не
      // должно перескочить на новую тему и исказить ранжирование.
      const task = issuedTask(db, topic.id, runId) ?? takeTask(db, topic.id, {
        difficulty: targetDifficulty,
        runId,
      });
      if (task !== null) return { status: 'ok', task: issued(task, topic) };
    }

    // В небольшой карте или при холодном банке доступные темы могут кончиться
    // раньше двенадцатого ответа. Это завершённый, пусть и короткий, триаж.
    return { status: 'done', total: attempts.length, target: TRIAGE_TARGET };
  }).immediate();
}
