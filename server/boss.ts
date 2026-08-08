/** Доменный жизненный цикл боя с боссом, без HTTP и фоновой генерации. */
import type { Database } from 'better-sqlite3';
import type { Topic, TopicGraph } from './curriculum.js';
import { bossTaskAtPosition, type BankTask } from './codex/bank.js';
import { taskPromptText } from './codex/task-schema.js';
import { type TopicState } from './mastery.js';
import { type RejectReason } from './normalize.js';
import { submitAnswer } from './session.js';
import { finishBossLoss } from './boss-loss.js';
export { BOSS_MASTERY, BOSS_TARGET } from './boss-rules.js';
import { BOSS_MASTERY, BOSS_TARGET } from './boss-rules.js';

export type BossTopicStatus = 'working' | 'preparing' | 'ready' | 'active' | 'closed';
export type BossErrorCode =
  | 'boss-not-eligible'
  | 'boss-closed'
  | 'boss-not-ready'
  | 'boss-not-found'
  | 'boss-finished'
  | 'boss-inconsistent'
  | 'boss-wrong-task'
  | 'boss-hint-forbidden'
  | 'boss-mistake-pending'
  | 'boss-dispute-open'
  | 'boss-complete';

export class BossError extends Error {
  constructor(readonly code: BossErrorCode, message: string) {
    super(message);
    this.name = 'BossError';
  }
}

export type BossTopicState =
  | { status: 'working'; eligible: boolean }
  | { status: 'closed'; eligible: false }
  | { status: 'preparing' | 'ready'; eligible: boolean; batchId: number }
  | { status: 'active'; eligible: boolean; batchId: number; runId: number };

interface TopicStateRow {
  mastery: number;
  closed_at: string | null;
}

interface BatchRow {
  id: number;
  topic_id: string;
  run_id: number | null;
  status: 'preparing' | 'ready' | 'active' | 'won' | 'lost' | 'failed';
}

interface ActiveFightRow {
  batch_id: number;
  batch_topic_id: string;
  batch_status: string;
  batch_run_id: number | null;
  run_id: number;
  run_topic_id: string;
  subject: string;
  kind: string;
  finished_at: string | null;
  total: number;
  correct: number;
}

function topicRow(db: Database, topicId: string): TopicStateRow {
  const row = db.prepare<[string], TopicStateRow>(
    'SELECT mastery, closed_at FROM topic_state WHERE topic_id = ?',
  ).get(topicId);
  if (row === undefined) throw new Error(`Босс: тема «${topicId}» не заведена в topic_state`);
  return row;
}

function liveBatch(db: Database, topicId: string): BatchRow | undefined {
  return db.prepare<[string], BatchRow>(
    `SELECT id, topic_id, run_id, status FROM boss_batches
      WHERE topic_id = ? AND status IN ('preparing', 'ready', 'active')
      ORDER BY id DESC LIMIT 1`,
  ).get(topicId);
}

/** Состояние карты босса. Закрытие темы имеет приоритет над оставшейся битой строкой батча. */
export function bossTopicState(db: Database, topicId: string): BossTopicState {
  const state = topicRow(db, topicId);
  if (state.closed_at !== null) return { status: 'closed', eligible: false };
  const eligible = state.mastery > BOSS_MASTERY;
  const batch = liveBatch(db, topicId);
  if (batch === undefined) return { status: 'working', eligible };
  if (batch.status === 'active') {
    if (batch.run_id === null) {
      throw new BossError('boss-inconsistent', `Босс: активный батч ${batch.id} не связан с забегом`);
    }
    return { status: 'active', eligible, batchId: batch.id, runId: batch.run_id };
  }
  if (batch.status !== 'preparing' && batch.status !== 'ready') {
    throw new BossError('boss-inconsistent', `Босс: живой батч ${batch.id} имеет неизвестное состояние`);
  }
  return { status: batch.status, eligible, batchId: batch.id };
}

function topicOf(graph: TopicGraph, topicId: string): Topic {
  const topic = graph.byId.get(topicId);
  if (topic === undefined) throw new Error(`Босс: темы «${topicId}» нет в карте`);
  return topic;
}

function ensureCompleteBatch(db: Database, batch: BatchRow): void {
  const row = db.prepare<[number], { count: number; first: number | null; last: number | null; bad: number }>(
    `SELECT COUNT(*) AS count, MIN(boss_tasks.position) AS first,
            MAX(boss_tasks.position) AS last,
            SUM(CASE WHEN task_bank.topic_id <> boss_batches.topic_id
                       OR task_bank.status <> 'boss_reserved' THEN 1 ELSE 0 END) AS bad
       FROM boss_batches
       LEFT JOIN boss_tasks ON boss_tasks.batch_id = boss_batches.id
       LEFT JOIN task_bank ON task_bank.id = boss_tasks.task_id
      WHERE boss_batches.id = ?`,
  ).get(batch.id);
  if (row === undefined || row.count !== BOSS_TARGET || row.first !== 1 || row.last !== BOSS_TARGET || row.bad !== 0) {
    throw new BossError(
      'boss-inconsistent',
      `Босс: готовый батч ${batch.id} не содержит полный согласованный набор из пяти заданий`,
    );
  }
}

export interface StartBossOptions { now?: Date }
export interface StartBossResult { batchId: number; runId: number; resumed: boolean }

/** Активирует готовый батч или идемпотентно восстанавливает уже активный. */
export function startBoss(
  db: Database,
  graph: TopicGraph,
  topicId: string,
  options: StartBossOptions = {},
): StartBossResult {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error(`Босс: некорректное время старта (${String(now)})`);
  const topic = topicOf(graph, topicId);

  return db.transaction((): StartBossResult => {
    const state = topicRow(db, topicId);
    if (state.closed_at !== null) {
      throw new BossError('boss-closed', `Босс: тема «${topicId}» уже закрыта`);
    }
    const batch = liveBatch(db, topicId);
    if (batch?.status === 'active') {
      const fight = readFight(db, batch.run_id ?? -1);
      validateFight(fight, topic);
      return { batchId: batch.id, runId: fight.run_id, resumed: true };
    }
    if (state.mastery <= BOSS_MASTERY) {
      throw new BossError('boss-not-eligible', `Босс: тема «${topicId}» пока недоступна`);
    }
    if (batch === undefined || batch.status !== 'ready') {
      throw new BossError('boss-not-ready', `Босс: для темы «${topicId}» нет готового полного батча`);
    }
    ensureCompleteBatch(db, batch);

    const runId = Number(db.prepare(
      `INSERT INTO runs (subject, kind, topic_id, started_at)
       VALUES (?, 'boss', ?, ?)`,
    ).run(topic.subject, topicId, now.toISOString()).lastInsertRowid);
    const activated = db.prepare(
      `UPDATE boss_batches SET status = 'active', run_id = ?, activated_at = ?
        WHERE id = ? AND status = 'ready'`,
    ).run(runId, now.toISOString(), batch.id);
    if (activated.changes !== 1) {
      throw new BossError('boss-inconsistent', `Босс: батч ${batch.id} изменился во время старта`);
    }
    db.prepare(
      `UPDATE task_bank SET issued_run_id = ?
        WHERE id IN (SELECT task_id FROM boss_tasks WHERE batch_id = ?)`,
    ).run(runId, batch.id);
    return { batchId: batch.id, runId, resumed: false };
  }).immediate();
}

function readFight(db: Database, runId: number): ActiveFightRow {
  const row = db.prepare<[number], ActiveFightRow>(
    `SELECT boss_batches.id AS batch_id, boss_batches.topic_id AS batch_topic_id,
            boss_batches.status AS batch_status, boss_batches.run_id AS batch_run_id,
            runs.id AS run_id, runs.topic_id AS run_topic_id, runs.subject, runs.kind,
            runs.finished_at, runs.total, runs.correct
       FROM runs
       LEFT JOIN boss_batches ON boss_batches.run_id = runs.id
      WHERE runs.id = ?`,
  ).get(runId);
  if (row === undefined || row.batch_id === null) {
    throw new BossError('boss-not-found', `Босс: бой ${runId} не найден`);
  }
  return row;
}

function validateFight(fight: ActiveFightRow, topic: Topic): void {
  if (fight.finished_at !== null) {
    throw new BossError('boss-finished', `Босс: бой ${fight.run_id} уже завершён`);
  }
  if (
    fight.kind !== 'boss' || fight.batch_status !== 'active' ||
    fight.batch_run_id !== fight.run_id || fight.batch_topic_id !== fight.run_topic_id ||
    fight.run_topic_id !== topic.id || fight.subject !== topic.subject
  ) {
    throw new BossError('boss-inconsistent', `Босс: batch и run боя ${fight.run_id} несогласованы`);
  }
  if (fight.total < 0 || fight.correct < 0 || fight.correct > fight.total || fight.total > BOSS_TARGET) {
    throw new BossError('boss-inconsistent', `Босс: счёт боя ${fight.run_id} несогласован`);
  }
}

interface FightAttemptSummary { total: number; correct: number; wrong: number; open_disputes: number }

function attemptSummary(db: Database, runId: number): FightAttemptSummary {
  return db.prepare<[number], FightAttemptSummary>(
    `SELECT COUNT(DISTINCT attempts.id) AS total,
            COALESCE(SUM(attempts.is_correct), 0) AS correct,
            COALESCE(SUM(CASE WHEN attempts.is_correct = 0 THEN 1 ELSE 0 END), 0) AS wrong,
            COUNT(DISTINCT CASE WHEN disputes.status = 'open' THEN disputes.id END) AS open_disputes
       FROM attempts
       LEFT JOIN disputes ON disputes.attempt_id = attempts.id
      WHERE attempts.run_id = ?`,
  ).get(runId) ?? { total: 0, correct: 0, wrong: 0, open_disputes: 0 };
}

function ensureProgress(fight: ActiveFightRow, summary: FightAttemptSummary): void {
  if (fight.total >= BOSS_TARGET || summary.total >= BOSS_TARGET) {
    throw new BossError('boss-complete', `Босс: пять ответов боя ${fight.run_id} уже исчерпаны`);
  }
  if (fight.total !== summary.total || fight.correct !== summary.correct) {
    throw new BossError(
      'boss-inconsistent',
      `Босс: сохранённый счёт боя ${fight.run_id} несогласован с попытками`,
    );
  }
  if (summary.open_disputes > 0) {
    throw new BossError('boss-dispute-open', `Босс: бой ${fight.run_id} приостановлен открытым спором`);
  }
  if (summary.wrong > 0) {
    throw new BossError('boss-mistake-pending', `Босс: после ошибки нужно признать поражение или открыть спор`);
  }
}

export interface BossIssuedTask {
  id: number;
  topicId: string;
  subject: Topic['subject'];
  topicTitle: string;
  question: string;
  instruction?: string;
  material?: string;
  materialFormat?: 'none' | 'text' | 'math';
  choices?: string[];
  difficulty: number;
  answerFormat: Topic['answerFormat'];
}

function projectBossTask(topic: Topic, task: BankTask): BossIssuedTask {
  return {
    id: task.id,
    topicId: topic.id,
    subject: topic.subject,
    topicTitle: topic.title,
    question: taskPromptText(task),
    ...(task.instruction === undefined ? {} : {
      instruction: task.instruction,
      material: task.material ?? '',
      materialFormat: task.material_format ?? 'none',
      choices: task.choices ?? [],
    }),
    difficulty: task.difficulty,
    answerFormat: topic.answerFormat,
  };
}

export interface NextBossTaskResult { batchId: number; runId: number; position: number; task: BossIssuedTask }

/** Возвращает только очередную позицию и никогда не раскрывает решение или подсказку. */
export function nextBossTask(db: Database, graph: TopicGraph, runId: number): NextBossTaskResult {
  return db.transaction((): NextBossTaskResult => {
    const fight = readFight(db, runId);
    const topic = topicOf(graph, fight.run_topic_id);
    validateFight(fight, topic);
    const summary = attemptSummary(db, runId);
    ensureProgress(fight, summary);
    const position = summary.total + 1;
    const task = bossTaskAtPosition(db, fight.batch_id, position);
    if (task === null) {
      throw new BossError(
        'boss-inconsistent',
        `Босс: в батче ${fight.batch_id} нет неотвеченного задания позиции ${position}`,
      );
    }
    if (task.topicId !== topic.id) {
      throw new BossError('boss-inconsistent', `Босс: задание ${task.id} относится к другой теме`);
    }
    return { batchId: fight.batch_id, runId, position, task: projectBossTask(topic, task) };
  }).immediate();
}

export interface SubmitBossAnswerRequest {
  runId: number;
  taskId: number;
  answer: string;
  hintUsed?: boolean;
  durationMs?: number;
  at?: Date;
}

export interface SubmitBossAnswerResult {
  attemptId: number;
  correct: boolean;
  normalized: string;
  reason?: RejectReason;
  answer: string;
  explain: string;
  joke: string;
  state: TopicState;
  xp: number;
  outcome: 'active' | 'mistake' | 'won';
  progress: { total: number; correct: number; target: number; done: boolean };
}

/** Принимает ответ текущей позиции и на пятом успехе закрывает тему одной записью. */
export function submitBossAnswer(
  db: Database,
  graph: TopicGraph,
  request: SubmitBossAnswerRequest,
): SubmitBossAnswerResult {
  const result = submitAnswer(db, graph, {
    runId: request.runId,
    taskId: request.taskId,
    answer: request.answer,
    ...(request.hintUsed === undefined ? {} : { hintUsed: request.hintUsed }),
    ...(request.durationMs === undefined ? {} : { durationMs: request.durationMs }),
    ...(request.at === undefined ? {} : { at: request.at }),
  });
  if (result.bossOutcome === undefined || result.progress === null) {
    throw new BossError('boss-inconsistent', `Босс: ответ боя ${request.runId} прошёл не как boss`);
  }
  return {
    attemptId: result.attemptId,
    correct: result.correct,
    normalized: result.normalized,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    answer: result.answer,
    explain: result.explain,
    joke: result.joke,
    state: result.state,
    xp: result.xp,
    outcome: result.bossOutcome,
    progress: result.progress,
  };
}

export interface ConcedeBossOptions { now?: Date }
export interface ConcedeBossResult { runId: number; batchId: number; replacementBatchId: number }

/** Завершает бой поражением и оставляет отдельный пустой claim для свежего набора. */
export function concedeBoss(
  db: Database,
  runId: number,
  options: ConcedeBossOptions = {},
): ConcedeBossResult {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error(`Босс: некорректное время поражения (${String(now)})`);
  return db.transaction((): ConcedeBossResult => {
    const fight = readFight(db, runId);
    const state = topicRow(db, fight.run_topic_id);
    const topic: Topic = {
      id: fight.run_topic_id,
      subject: fight.subject as Topic['subject'],
      title: '', examWeight: 0, difficulty: 1, prereqs: [], answerFormat: 'text', promptSeed: '',
    };
    validateFight(fight, topic);
    const summary = attemptSummary(db, runId);
    if (summary.open_disputes > 0) {
      throw new BossError('boss-dispute-open', `Босс: бой ${runId} приостановлен открытым спором`);
    }
    if (summary.wrong === 0) {
      throw new BossError('boss-mistake-pending', `Босс: поражение можно признать только после ошибки`);
    }
    if (state.closed_at !== null) {
      throw new BossError('boss-inconsistent', `Босс: проигрываемая тема «${fight.run_topic_id}» уже закрыта`);
    }
    return finishBossLoss(db, runId, now.toISOString());
  }).immediate();
}
