/** Доменный жизненный цикл боя с боссом, без HTTP и фоновой генерации. */
import type { Database } from 'better-sqlite3';
import type { Topic, TopicGraph } from './curriculum.js';
import { bossTaskAtPosition, type BankTask } from './codex/bank.js';
import { taskPromptText } from './codex/task-schema.js';
import { type TopicState } from './mastery.js';
import { type RejectReason } from './normalize.js';
import { submitAnswer } from './session.js';
import { SessionError } from './session-error.js';
import { finishBossLoss, hasPriorBossLoss } from './boss-loss.js';
import { bossFightConsistent, readBossFight, type BossFight } from './boss-fight.js';
import type { IssuedTask } from './issued-task.js';
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
  const batch = liveBatch(db, topicId);
  const eligible = state.mastery > BOSS_MASTERY || (
    batch !== undefined && hasPriorBossLoss(db, topicId, batch.id)
  );
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
  if (topic === undefined) throw new BossError('boss-not-found', `Босс: темы «${topicId}» нет в карте`);
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
      return { batchId: batch.id, runId: fight.runId, resumed: true };
    }
    const retry = batch !== undefined && hasPriorBossLoss(db, topicId, batch.id);
    if (state.mastery <= BOSS_MASTERY && !retry) {
      throw new BossError('boss-not-eligible', `Босс: тема «${topicId}» пока недоступна`);
    }
    if (batch === undefined || batch.status !== 'ready') {
      throw new BossError('boss-not-ready', `Босс: для темы «${topicId}» нет готового полного батча`);
    }
    ensureCompleteBatch(db, batch);

    const runId = Number(db.prepare(
      `INSERT INTO runs (subject, kind, topic_id, started_at, lives_remaining)
       VALUES (?, 'boss', ?, ?, NULL)`,
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

function readFight(db: Database, runId: number): BossFight {
  const fight = readBossFight(db, runId);
  if (fight === undefined) {
    throw new BossError('boss-not-found', `Босс: бой ${runId} не найден`);
  }
  return fight;
}

function validateFight(fight: BossFight, topic: Pick<Topic, 'id' | 'subject'>): void {
  if (fight.finishedAt !== null) {
    throw new BossError('boss-finished', `Босс: бой ${fight.runId} уже завершён`);
  }
  if (fight.batchStatus !== 'active' || !bossFightConsistent(fight, topic)) {
    throw new BossError('boss-inconsistent', `Босс: batch и run боя ${fight.runId} несогласованы`);
  }
  if (fight.total < 0 || fight.correct < 0 || fight.correct > fight.total || fight.total > BOSS_TARGET) {
    throw new BossError('boss-inconsistent', `Босс: счёт боя ${fight.runId} несогласован`);
  }
}

function ensureProgress(fight: BossFight): void {
  if (fight.total >= BOSS_TARGET) {
    throw new BossError('boss-complete', `Босс: пять ответов боя ${fight.runId} уже исчерпаны`);
  }
  if (fight.openDisputes > 0) {
    throw new BossError('boss-dispute-open', `Босс: бой ${fight.runId} приостановлен открытым спором`);
  }
  if (fight.wrong > 0) {
    throw new BossError('boss-mistake-pending', `Босс: после ошибки нужно признать поражение или открыть спор`);
  }
}

export type BossIssuedTask = Omit<IssuedTask, 'hint'>;

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

export type BossFightState =
  | { outcome: 'active'; progress: { total: number; correct: number; target: number; done: false } }
  | { outcome: 'mistake' | 'dispute'; attemptId: number; progress: { total: number; correct: number; target: number; done: false } }
  | { outcome: 'won' | 'lost'; progress: { total: number; correct: number; target: number; done: true } };

/** Снимок боя для безопасного восстановления экрана после reload. */
export function bossFightState(db: Database, graph: TopicGraph, runId: number): BossFightState {
  const fight = readBossFight(db, runId);
  if (fight === undefined) throw new BossError('boss-not-found', `Босс: бой ${runId} не найден`);
  const topic = topicOf(graph, fight.runTopicId);
  if (!bossFightConsistent(fight, topic)) {
    throw new BossError('boss-inconsistent', `Босс: batch и run боя ${runId} несогласованы`);
  }
  const progress = {
    total: fight.total, correct: fight.correct, target: BOSS_TARGET,
    done: fight.batchStatus === 'won' || fight.batchStatus === 'lost',
  };
  if (fight.batchStatus === 'won' || fight.batchStatus === 'lost') {
    return { outcome: fight.batchStatus, progress: { ...progress, done: true } };
  }
  if (fight.batchStatus !== 'active' || fight.finishedAt !== null) {
    throw new BossError('boss-inconsistent', `Босс: состояние боя ${runId} несогласовано`);
  }
  if (fight.openDisputes > 0 || fight.wrong > 0) {
    if (fight.lastAttemptId === null) throw new BossError('boss-inconsistent', `Босс: попытка боя ${runId} потеряна`);
    return {
      outcome: fight.openDisputes > 0 ? 'dispute' : 'mistake',
      attemptId: fight.lastAttemptId,
      progress: { ...progress, done: false },
    };
  }
  return { outcome: 'active', progress: { ...progress, done: false } };
}

/** Возвращает только очередную позицию и никогда не раскрывает решение или подсказку. */
export function nextBossTask(db: Database, graph: TopicGraph, runId: number): NextBossTaskResult {
  return db.transaction((): NextBossTaskResult => {
    const fight = readFight(db, runId);
    const topic = topicOf(graph, fight.runTopicId);
    if (fight.finishedAt !== null) {
      throw new BossError('boss-finished', `Босс: бой ${fight.runId} уже завершён`);
    }
    ensureProgress(fight);
    validateFight(fight, topic);
    const position = fight.attemptTotal + 1;
    const task = bossTaskAtPosition(db, fight.batchId, position);
    if (task === null) {
      throw new BossError(
        'boss-inconsistent',
        `Босс: в батче ${fight.batchId} нет неотвеченного задания позиции ${position}`,
      );
    }
    if (task.topicId !== topic.id) {
      throw new BossError('boss-inconsistent', `Босс: задание ${task.id} относится к другой теме`);
    }
    return { batchId: fight.batchId, runId, position, task: projectBossTask(topic, task) };
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
  let result;
  try {
    result = submitAnswer(db, graph, {
      runId: request.runId,
      taskId: request.taskId,
      answer: request.answer,
      ...(request.hintUsed === undefined ? {} : { hintUsed: request.hintUsed }),
      ...(request.durationMs === undefined ? {} : { durationMs: request.durationMs }),
      ...(request.at === undefined ? {} : { at: request.at }),
    });
  } catch (error) {
    if (!(error instanceof SessionError)) throw error;
    if (error.code === 'run-not-found') throw new BossError('boss-not-found', error.message);
    if (error.code === 'run-finished') throw new BossError('boss-finished', error.message);
    if (error.code === 'run-complete') throw new BossError('boss-complete', error.message);
    if (error.code === 'boss-dispute-open') throw new BossError('boss-dispute-open', error.message);
    if (error.code === 'boss-mistake-pending') throw new BossError('boss-mistake-pending', error.message);
    if (request.hintUsed === true && error.code === 'task-not-in-run') {
      throw new BossError('boss-hint-forbidden', error.message);
    }
    if (
      error.code === 'task-not-found' || error.code === 'task-not-issued' ||
      error.code === 'task-not-in-run' || error.code === 'already-answered'
    ) {
      throw new BossError('boss-wrong-task', error.message);
    }
    throw new BossError('boss-inconsistent', error.message);
  }
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
    const state = topicRow(db, fight.runTopicId);
    const topic = { id: fight.runTopicId, subject: fight.subject as Topic['subject'] };
    validateFight(fight, topic);
    if (fight.openDisputes > 0) {
      throw new BossError('boss-dispute-open', `Босс: бой ${runId} приостановлен открытым спором`);
    }
    if (fight.wrong === 0) {
      throw new BossError('boss-mistake-pending', `Босс: поражение можно признать только после ошибки`);
    }
    if (state.closed_at !== null) {
      throw new BossError('boss-inconsistent', `Босс: проигрываемая тема «${fight.runTopicId}» уже закрыта`);
    }
    return finishBossLoss(db, runId, now.toISOString());
  }).immediate();
}
