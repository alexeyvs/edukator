import type { Database } from 'better-sqlite3';
import type { AnswerFormat, TopicGraph } from './curriculum.js';
import { findNumbers, checkAnswer } from './normalize.js';
import { recomputeTopicState } from './mastery.js';
import { readBankTask } from './codex/bank.js';
import {
  integrityReviewer,
  type IntegrityDecision,
  type IntegrityReviewer,
  type IntegrityVerdict,
} from './codex/integrity.js';
import type { IntegrityPromptItem } from './codex/prompt.js';
import { codexConcurrency, type CodexConcurrency } from './codex/concurrency.js';
import { projectIssuedTask, type IssuedTask } from './issued-task.js';

export const INTEGRITY_JUNK_CONFIDENCE = 0.9;
export const INTEGRITY_FAST_ANSWER_MS = 10_000;
export const INTEGRITY_RETRY_MAX_MS = 15 * 60_000;

export type IntegrityReviewStatus = 'screening' | 'reviewing' | 'needs_retry' | 'passed';
export type IntegrityItemStatus = 'pending' | 'retry_required' | 'approved';

interface ScreeningInput {
  answerFormat: AnswerFormat;
  answer: string;
  choices: readonly string[];
  correct: boolean;
  durationMs: number;
}

const WRITTEN_NUMBER_WORDS = new Set([
  'ноль', 'нуль', 'один', 'одна', 'одно', 'два', 'две', 'три', 'четыре', 'пять',
  'шесть', 'семь', 'восемь', 'девять', 'десять', 'одиннадцать', 'двенадцать',
  'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать',
  'восемнадцать', 'девятнадцать', 'двадцать', 'тридцать', 'сорок', 'пятьдесят',
  'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто', 'сто', 'двести',
  'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот',
  'девятьсот', 'тысяча', 'тысячи', 'тысяч', 'миллион', 'миллиона', 'миллионов',
  'минус', 'целая', 'целых', 'десятая', 'десятых', 'сотая', 'сотых', 'тысячная',
  'тысячных', 'и',
]);

function looksLikeWrittenNumber(answer: string): boolean {
  const normalized = answer.toLocaleLowerCase('ru-RU').trim().replace(/\s+/gu, ' ');
  const words = normalized.match(/[а-яё]+/gu);
  return words !== null
    && words.join(' ') === normalized
    && words.some((word) => !['минус', 'и'].includes(word))
    && words.every((word) => WRITTEN_NUMBER_WORDS.has(word));
}

/** Быстрая проверка лишь добавляет сигнал; решение о халтуре принимает Codex. */
export function integritySignal(input: ScreeningInput): string | null {
  if (input.correct) return null;
  const answer = input.answer.trim();
  if (input.durationMs > INTEGRITY_FAST_ANSWER_MS) return null;
  if (
    input.answerFormat === 'number'
    && findNumbers(answer).length === 0
    && !looksLikeWrittenNumber(answer)
  ) {
    return 'В числовом задании за короткое время введён ответ без числа.';
  }
  if (input.answerFormat === 'choice' && input.choices.length > 0 && !input.choices.includes(answer)) {
    return 'За короткое время введён текст, которого нет среди вариантов.';
  }
  if (/^([\p{L}])\1{1,2}$/iu.test(answer)) {
    return 'За короткое время введены повторяющиеся буквы.';
  }
  return null;
}

interface AttemptCandidateRow {
  id: number;
  task_id: number;
  answer: string;
  is_correct: number;
  duration_ms: number;
  is_current: number;
  topic_id: string;
  choices: string | null;
}

function choicesOf(raw: string | null, taskId: number): string[] {
  if (raw === null) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error(`Проверка осмысленности: choices задания ${taskId} повреждён`);
  }
  return parsed;
}

function questionsForRun(
  db: Database,
  graph: TopicGraph,
  runId: number,
): Array<{ taskId: number; attemptId: number; signal: string }> {
  const rows = db.prepare<[number], AttemptCandidateRow>(
    `SELECT attempts.id, attempts.task_id, attempts.answer, attempts.is_correct,
            attempts.duration_ms, attempts.is_current, attempts.topic_id, task_bank.choices
       FROM attempts JOIN task_bank ON task_bank.id = attempts.task_id
      WHERE attempts.run_id = ? ORDER BY attempts.id`,
  ).all(runId);
  const grouped = new Map<number, AttemptCandidateRow[]>();
  for (const row of rows) grouped.set(row.task_id, [...(grouped.get(row.task_id) ?? []), row]);

  const result: Array<{ taskId: number; attemptId: number; signal: string }> = [];
  for (const [taskId, attempts] of grouped) {
    const current = attempts.findLast((attempt) => attempt.is_current === 1);
    if (current === undefined) continue;
    const topic = graph.byId.get(current.topic_id);
    if (topic === undefined) throw new Error(`Проверка осмысленности: темы «${current.topic_id}» нет`);
    const choices = choicesOf(current.choices, taskId);
    const signals = attempts.flatMap((attempt) => {
      const signal = integritySignal({
        answerFormat: topic.answerFormat,
        answer: attempt.answer,
        choices,
        correct: attempt.is_correct === 1,
        durationMs: attempt.duration_ms,
      });
      return signal === null ? [] : [signal];
    });
    result.push({
      taskId,
      attemptId: current.id,
      signal: signals.length > 0
        ? signals.join(' ')
        : 'Предварительная эвристика не нашла отдельного сигнала.',
    });
  }
  return result;
}

interface ReviewRow {
  run_id: number;
  status: IntegrityReviewStatus;
  last_error: string | null;
}

interface ItemRow {
  id: number;
  run_id: number;
  task_id: number;
  attempt_id: number;
  status: IntegrityItemStatus;
  decision: IntegrityDecision | null;
  confidence: number | null;
  reason: string | null;
  reviewed_by: 'codex' | 'parent' | 'heuristic' | null;
}

export interface IntegrityRetryTask {
  itemId: number;
  task: IssuedTask;
}

export type IntegrityPublicStatus =
  | { status: 'checking'; flagged: number }
  | { status: 'retry_required'; flagged: number; remaining: number; retry: IntegrityRetryTask }
  | { status: 'completed'; result: Record<string, unknown> };

function readRunSummary(db: Database, runId: number): Record<string, unknown> | null {
  const row = db.prepare<[number], { summary: string | null }>(
    'SELECT summary FROM runs WHERE id = ? AND finished_at IS NOT NULL',
  ).get(runId);
  if (row?.summary === null || row === undefined) return null;
  return JSON.parse(row.summary) as Record<string, unknown>;
}

export function readIntegrityStatus(
  db: Database,
  graph: TopicGraph,
  runId: number,
): IntegrityPublicStatus | null {
  const completed = readRunSummary(db, runId);
  if (completed !== null) return { status: 'completed', result: completed };
  const review = db.prepare<[number], ReviewRow>(
    'SELECT run_id, status, last_error FROM integrity_reviews WHERE run_id = ?',
  ).get(runId);
  if (review === undefined) return null;
  const items = db.prepare<[number], ItemRow>(
    `SELECT id, run_id, task_id, attempt_id, status, decision, confidence, reason, reviewed_by
       FROM integrity_items WHERE run_id = ? ORDER BY id`,
  ).all(runId);
  const retries = items.filter((item) => item.status === 'retry_required');
  const next = retries[0];
  if (review.status === 'needs_retry' && next !== undefined) {
    const bankTask = readBankTask(db, next.task_id);
    if (bankTask === null || bankTask.topicId === undefined) {
      throw new Error(`Проверка осмысленности: задание ${next.task_id} исчезло`);
    }
    const topic = graph.byId.get(bankTask.topicId);
    if (topic === undefined) throw new Error(`Проверка осмысленности: темы «${bankTask.topicId}» нет`);
    const run = db.prepare<[number], { kind: string }>('SELECT kind FROM runs WHERE id = ?').get(runId);
    if (run === undefined) throw new Error(`Проверка осмысленности: занятие ${runId} исчезло`);
    return {
      status: 'retry_required',
      flagged: items.length,
      remaining: retries.length,
      retry: {
        itemId: next.id,
        task: projectIssuedTask(topic, bankTask, { exposeHint: run.kind === 'run' }),
      },
    };
  }
  return { status: 'checking', flagged: items.length };
}

function parseAccept(raw: string, taskId: number): string[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error(`Проверка осмысленности: accept задания ${taskId} повреждён`);
  }
  return parsed;
}

function replaceIntegrityAttempt(
  db: Database,
  graph: TopicGraph,
  runId: number,
  itemId: number,
  answer: string,
  durationMs: number,
  hintUsed: boolean,
  now: Date,
): boolean {
  return db.transaction((): boolean => {
    const item = db.prepare<[number, number], ItemRow>(
      `SELECT id, run_id, task_id, attempt_id, status, decision, confidence, reason, reviewed_by
         FROM integrity_items WHERE id = ? AND run_id = ?`,
    ).get(itemId, runId);
    if (item === undefined || item.status !== 'retry_required') {
      throw new Error('Этот вопрос больше не ожидает повторного ответа');
    }
    const run = db.prepare<[number], { finished_at: string | null; kind: string }>(
      'SELECT finished_at, kind FROM runs WHERE id = ?',
    ).get(runId);
    if (run === undefined || run.finished_at !== null || (run.kind !== 'run' && run.kind !== 'lesson')) {
      throw new Error('Занятие уже завершено или не поддерживает проверку');
    }
    const task = db.prepare<[number], {
      id: number; topic_id: string; answer: string; accept: string; choices: string | null;
    }>('SELECT id, topic_id, answer, accept, choices FROM task_bank WHERE id = ?').get(item.task_id);
    const previous = db.prepare<[number], {
      id: number; is_correct: number; affects_progress: number;
    }>('SELECT id, is_correct, affects_progress FROM attempts WHERE id = ? AND is_current = 1')
      .get(item.attempt_id);
    if (task === undefined || previous === undefined) {
      throw new Error('Проверяемый ответ изменился до повторной попытки');
    }
    const topic = graph.byId.get(task.topic_id);
    if (topic === undefined) throw new Error(`Проверка осмысленности: темы «${task.topic_id}» нет`);
    const checked = checkAnswer(answer, {
      answer: task.answer,
      accept: parseAccept(task.accept, task.id),
    }, topic.answerFormat);
    const at = now.toISOString();
    db.prepare('UPDATE attempts SET is_current = 0 WHERE id = ?').run(previous.id);
    const inserted = db.prepare(
      `INSERT INTO attempts
        (task_id, topic_id, run_id, answer, is_correct, hint_used, duration_ms,
         is_current, life_charged, affects_progress, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
    ).run(
      task.id, task.topic_id, runId, answer.trim(), checked.correct ? 1 : 0,
      hintUsed ? 1 : 0, durationMs, previous.affects_progress, at,
    );
    const attemptId = Number(inserted.lastInsertRowid);
    db.prepare('UPDATE runs SET correct = correct + ? - ? WHERE id = ?')
      .run(checked.correct ? 1 : 0, previous.is_correct, runId);
    if (previous.affects_progress === 1) recomputeTopicState(db, task.topic_id);

    const signal = integritySignal({
      answerFormat: topic.answerFormat,
      answer,
      choices: choicesOf(task.choices, task.id),
      correct: checked.correct,
      durationMs,
    });
    db.prepare(
      `UPDATE integrity_items SET attempt_id = ?, status = 'pending', decision = NULL,
              confidence = NULL, reason = ?, reviewed_by = NULL, updated_at = ? WHERE id = ?`,
    ).run(
      attemptId,
      signal ?? 'Повторный ответ ожидает обязательной проверки Codex.',
      at,
      itemId,
    );
    const retries = db.prepare<[number], { count: number }>(
      "SELECT COUNT(*) AS count FROM integrity_items WHERE run_id = ? AND status = 'retry_required'",
    ).get(runId)?.count ?? 0;
    db.prepare('UPDATE integrity_reviews SET status = ?, last_error = NULL, updated_at = ? WHERE run_id = ?')
      .run(retries > 0 ? 'needs_retry' : 'screening', at, runId);
    return retries === 0;
  }).immediate();
}

function contextForPending(db: Database, graph: TopicGraph, runId: number): IntegrityPromptItem[] {
  const items = db.prepare<[number], ItemRow>(
    `SELECT id, run_id, task_id, attempt_id, status, decision, confidence, reason, reviewed_by
       FROM integrity_items WHERE run_id = ? AND status = 'pending' ORDER BY id`,
  ).all(runId);
  return items.map((item) => {
    const task = db.prepare<[number], {
      topic_id: string; question: string; instruction: string | null; material: string | null;
      choices: string | null; answer: string;
    }>(
      `SELECT topic_id, question, instruction, material, choices, answer
         FROM task_bank WHERE id = ?`,
    ).get(item.task_id);
    if (task === undefined) throw new Error(`Проверка осмысленности: задания ${item.task_id} нет`);
    const topic = graph.byId.get(task.topic_id);
    if (topic === undefined) throw new Error(`Проверка осмысленности: темы «${task.topic_id}» нет`);
    const attempts = db.prepare<[number, number], { answer: string; duration_ms: number; hint_used: number }>(
      'SELECT answer, duration_ms, hint_used FROM attempts WHERE run_id = ? AND task_id = ? ORDER BY id',
    ).all(runId, item.task_id).map((attempt) => ({
      answer: attempt.answer,
      durationMs: attempt.duration_ms,
      hintUsed: attempt.hint_used === 1,
    }));
    return {
      id: item.id,
      topicTitle: topic.title,
      answerFormat: topic.answerFormat,
      question: task.instruction ?? task.question,
      ...(task.material === null ? {} : { material: task.material }),
      choices: choicesOf(task.choices, item.task_id),
      expected: task.answer,
      attempts,
      signal: item.reason ?? 'Ответ отмечен предварительной проверкой.',
    };
  });
}

function applyVerdicts(db: Database, runId: number, verdicts: readonly IntegrityVerdict[], now: Date): boolean {
  return db.transaction((): boolean => {
    const at = now.toISOString();
    for (const verdict of verdicts) {
      const item = db.prepare<[number, number], { status: IntegrityItemStatus }>(
        'SELECT status FROM integrity_items WHERE id = ? AND run_id = ?',
      ).get(verdict.id, runId);
      if (item?.status !== 'pending') continue;
      const retry = verdict.decision === 'junk' && verdict.confidence >= INTEGRITY_JUNK_CONFIDENCE;
      db.prepare(
        `UPDATE integrity_items SET status = ?, decision = ?, confidence = ?, reason = ?,
                reviewed_by = 'codex', updated_at = ? WHERE id = ?`,
      ).run(retry ? 'retry_required' : 'approved', verdict.decision, verdict.confidence,
        verdict.reason, at, verdict.id);
    }
    const open = db.prepare<[number], { count: number }>(
      "SELECT COUNT(*) AS count FROM integrity_items WHERE run_id = ? AND status <> 'approved'",
    ).get(runId)?.count ?? 0;
    const retries = db.prepare<[number], { count: number }>(
      "SELECT COUNT(*) AS count FROM integrity_items WHERE run_id = ? AND status = 'retry_required'",
    ).get(runId)?.count ?? 0;
    const status: IntegrityReviewStatus = open === 0 ? 'passed' : retries > 0 ? 'needs_retry' : 'screening';
    db.prepare('UPDATE integrity_reviews SET status = ?, last_error = NULL, updated_at = ? WHERE run_id = ?')
      .run(status, at, runId);
    return status === 'passed';
  }).immediate();
}

export interface IntegrityCoordinatorOptions {
  db: Database;
  graph: TopicGraph;
  complete: (runId: number, now: Date) => Record<string, unknown>;
  review?: IntegrityReviewer;
  budget?: CodexConcurrency;
  background?: (task: () => Promise<void>) => void;
  now?: () => Date;
  available?: () => boolean;
  retryMs?: number;
  log?: (message: string) => void;
}

export interface IntegrityCoordinator {
  begin(runId: number): IntegrityPublicStatus;
  status(runId: number): IntegrityPublicStatus | null;
  retry(runId: number, itemId: number, answer: string, durationMs: number, hintUsed: boolean): IntegrityPublicStatus;
  approve(runId: number, itemId: number): IntegrityPublicStatus;
  stop(): Promise<void>;
}

export function createIntegrityCoordinator(options: IntegrityCoordinatorOptions): IntegrityCoordinator {
  const { db, graph } = options;
  const review = options.review ?? integrityReviewer();
  const budget = options.budget ?? codexConcurrency;
  const background = options.background ?? ((task): void => void task());
  const now = options.now ?? ((): Date => new Date());
  const available = options.available ?? ((): boolean => true);
  const retryMs = options.retryMs ?? 1_000;
  const log = options.log ?? ((message: string): void => void process.stderr.write(`${message}\n`));
  const reviewing = new Set<number>();
  const pending = new Set<Promise<unknown>>();
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const delays = new Map<number, number>();
  let stopped = false;

  function finish(runId: number): void {
    if (!available()) throw new Error('файл базы заменён во время проверки осмысленности');
    if (readRunSummary(db, runId) === null) options.complete(runId, now());
  }

  function scheduleRetry(runId: number): void {
    if (stopped || !available() || timers.has(runId)) return;
    const delay = delays.get(runId) ?? retryMs;
    delays.set(runId, Math.min(delay * 2, INTEGRITY_RETRY_MAX_MS));
    timers.set(runId, setTimeout(() => {
      timers.delete(runId);
      schedule(runId);
    }, delay));
  }

  function schedule(runId: number): void {
    if (stopped || !available() || reviewing.has(runId)) return;
    const state = db.prepare<[number], { status: IntegrityReviewStatus }>(
      'SELECT status FROM integrity_reviews WHERE run_id = ?',
    ).get(runId)?.status;
    if (state === undefined || state === 'needs_retry') return;
    if (state === 'passed') {
      try { finish(runId); } catch (error) {
        log(`завершение занятия ${runId} после проверки отложено: ${(error as Error).message}`);
        scheduleRetry(runId);
      }
      return;
    }
    const contexts = contextForPending(db, graph, runId);
    if (contexts.length === 0) return;
    const work = budget.tryRun(() => review(contexts));
    if (work === undefined) {
      scheduleRetry(runId);
      return;
    }
    db.prepare("UPDATE integrity_reviews SET status = 'reviewing', updated_at = ? WHERE run_id = ?")
      .run(now().toISOString(), runId);
    reviewing.add(runId);
    pending.add(work);
    background(async () => {
      try {
        const verdicts = await work;
        if (!available()) throw new Error('файл базы заменён во время проверки');
        if (applyVerdicts(db, runId, verdicts, now())) finish(runId);
        delays.delete(runId);
      } catch (error) {
        log(`проверка осмысленности занятия ${runId} не выполнена: ${(error as Error).message}`);
        if (available()) {
          db.prepare(
            "UPDATE integrity_reviews SET status = 'screening', last_error = ?, updated_at = ? WHERE run_id = ? AND status = 'reviewing'",
          ).run((error as Error).message.slice(0, 500), now().toISOString(), runId);
          scheduleRetry(runId);
        }
      } finally {
        reviewing.delete(runId);
        pending.delete(work);
      }
    });
  }

  function current(runId: number): IntegrityPublicStatus {
    const state = readIntegrityStatus(db, graph, runId);
    if (state === null) throw new Error(`Проверка занятия ${runId} не найдена`);
    return state;
  }

  function begin(runId: number): IntegrityPublicStatus {
    const summary = readRunSummary(db, runId);
    if (summary !== null) return { status: 'completed', result: summary };
    const existing = db.prepare<[number], ReviewRow>(
      'SELECT run_id, status, last_error FROM integrity_reviews WHERE run_id = ?',
    ).get(runId);
    if (existing !== undefined) {
      schedule(runId);
      return current(runId);
    }
    const run = db.prepare<[number], { kind: string; finished_at: string | null }>(
      'SELECT kind, finished_at FROM runs WHERE id = ?',
    ).get(runId);
    if (run === undefined || run.finished_at !== null || (run.kind !== 'run' && run.kind !== 'lesson')) {
      throw new Error('Проверка доступна только для незавершённого забега или разбора');
    }
    const questions = questionsForRun(db, graph, runId);
    if (questions.length === 0) {
      const result = options.complete(runId, now());
      return { status: 'completed', result };
    }
    const at = now().toISOString();
    db.transaction(() => {
      db.prepare("INSERT INTO integrity_reviews (run_id, status, created_at, updated_at) VALUES (?, 'screening', ?, ?)")
        .run(runId, at, at);
      const insert = db.prepare(
        `INSERT INTO integrity_items
          (run_id, task_id, attempt_id, status, reason, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
      );
      for (const question of questions) {
        insert.run(runId, question.taskId, question.attemptId, question.signal, at, at);
      }
    }).immediate();
    schedule(runId);
    return current(runId);
  }

  function retry(
    runId: number,
    itemId: number,
    answer: string,
    durationMs: number,
    hintUsed: boolean,
  ): IntegrityPublicStatus {
    const ready = replaceIntegrityAttempt(db, graph, runId, itemId, answer, durationMs, hintUsed, now());
    if (ready) schedule(runId);
    return current(runId);
  }

  function approve(runId: number, itemId: number): IntegrityPublicStatus {
    const at = now().toISOString();
    const passed = db.transaction((): boolean => {
      const changed = db.prepare(
        `UPDATE integrity_items SET status = 'approved', decision = 'meaningful', confidence = 1,
                reason = 'Родитель подтвердил осмысленный ответ.', reviewed_by = 'parent', updated_at = ?
          WHERE id = ? AND run_id = ? AND status <> 'approved'`,
      ).run(at, itemId, runId);
      if (changed.changes === 0) throw new Error('Отмеченный вопрос не найден или уже подтверждён');
      const open = db.prepare<[number], { count: number }>(
        "SELECT COUNT(*) AS count FROM integrity_items WHERE run_id = ? AND status <> 'approved'",
      ).get(runId)?.count ?? 0;
      const pendingCount = db.prepare<[number], { count: number }>(
        "SELECT COUNT(*) AS count FROM integrity_items WHERE run_id = ? AND status = 'pending'",
      ).get(runId)?.count ?? 0;
      const retryCount = db.prepare<[number], { count: number }>(
        "SELECT COUNT(*) AS count FROM integrity_items WHERE run_id = ? AND status = 'retry_required'",
      ).get(runId)?.count ?? 0;
      const status: IntegrityReviewStatus = open === 0
        ? 'passed' : retryCount > 0 ? 'needs_retry' : pendingCount > 0 ? 'screening' : 'needs_retry';
      db.prepare('UPDATE integrity_reviews SET status = ?, last_error = NULL, updated_at = ? WHERE run_id = ?')
        .run(status, at, runId);
      return status === 'passed';
    }).immediate();
    if (passed) finish(runId);
    else schedule(runId);
    return current(runId);
  }

  for (const row of db.prepare<[], { run_id: number }>(
    "SELECT run_id FROM integrity_reviews WHERE status IN ('screening', 'reviewing', 'passed')",
  ).all()) schedule(row.run_id);

  return {
    begin,
    status: (runId) => {
      const state = readIntegrityStatus(db, graph, runId);
      if (state !== null && state.status === 'checking') schedule(runId);
      return state;
    },
    retry,
    approve,
    stop: async () => {
      stopped = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      await Promise.allSettled([...pending]);
    },
  };
}
