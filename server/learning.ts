/** Атомарный жизненный цикл персонального учебного материала и его теста. */
import type { Database } from 'better-sqlite3';
import type { TopicGraph } from './curriculum.js';
import type { Subject } from './db.js';
import { parseLearningMaterial, type LearningMaterialContent } from './codex/learning-material-schema.js';
import { LEARNING_TASK_COUNT } from './learning-constants.js';
import { finishRun, runProgress, type FinishRunResult, type RunProgress } from './run.js';

export { LEARNING_TASK_COUNT } from './learning-constants.js';
export const LEARNING_PASS_SCORE = 4;
export const LEARNING_CLAIM_STALE_MS = 30 * 60 * 1000;

export type LearningMaterialStatus =
  | 'preparing'
  | 'ready'
  | 'active'
  | 'passed'
  | 'failed'
  | 'rejected'
  | 'retired';

export type LearningErrorCode =
  | 'learning-not-found'
  | 'learning-not-ready'
  | 'learning-incomplete'
  | 'learning-finished'
  | 'learning-dispute-open'
  | 'learning-inconsistent';

export class LearningError extends Error {
  constructor(readonly code: LearningErrorCode, message: string) {
    super(message);
    this.name = 'LearningError';
  }
}

interface MaterialLifecycleRow {
  id: number;
  status: LearningMaterialStatus;
}

interface MaterialStartRow extends MaterialLifecycleRow {
  subject: Subject;
  topic_id: string;
  course_revision_id: number | null;
  latest_run_id: number | null;
  latest_attempt_number: number | null;
  latest_run_kind: string | null;
  latest_run_finished_at: string | null;
}

interface MaterialCardRow {
  id: number;
  subject: Subject;
  topic_id: string;
  status: 'ready' | 'active';
  recommendation_reason: string;
  estimated_minutes: number;
  course_revision_id: number | null;
}

interface MaterialViewRow {
  id: number;
  subject: Subject;
  topic_id: string;
  status: LearningMaterialStatus;
  content: string | null;
  recommendation_reason: string;
  estimated_minutes: number;
  latest_run_id: number | null;
  latest_run_finished_at: string | null;
  course_revision_id: number | null;
}

interface FinishLearningRow {
  id: number;
  topic_id: string;
  status: LearningMaterialStatus;
  mastery_before: number;
  finished_at: string | null;
  summary: string | null;
  total: number;
  correct: number;
  run_kind: string;
  attempt_number: number;
}

export interface LearningMaterialCard {
  id: number;
  subject: Subject;
  topicId: string;
  recommendationReason: string;
  estimatedMinutes: number;
  status: 'ready' | 'active';
  courseRevisionId: number | null;
}

export interface LearningMaterialView extends LearningMaterialCard {
  latestRunId: number | null;
  latestRunFinishedAt: string | null;
  /** Теория скрывается после первого ответа: lesson-run не допускает подсказок. */
  content: LearningMaterialContent | null;
  progress: RunProgress;
  passScore: number;
}

export interface ClaimLearningMaterialOptions {
  subject: Subject;
  topicId: string;
  recommendationReason: string;
  masteryBefore: number;
  estimatedMinutes?: number;
  now?: Date;
  staleAfterMs?: number;
  courseRevisionId?: number | null;
}

export interface LearningMaterialClaim {
  materialId: number;
  recovered: boolean;
}

function expireStaleLearningClaimsInTransaction(
  db: Database,
  now: Date,
  staleAfterMs: number,
): Set<string> {
  const nowIso = timestamp(now, 'восстановления claim');
  const cutoff = new Date(now.getTime() - staleAfterMs).toISOString();
  const stale = db.prepare<[string], { id: number; topic_id: string }>(
    `SELECT id, topic_id FROM learning_materials
      WHERE status = 'preparing' AND updated_at <= ?
      ORDER BY updated_at, id`,
  ).all(cutoff);
  const reject = db.prepare(
    `UPDATE learning_materials
        SET status = 'rejected', updated_at = ?, finished_at = ?
      WHERE id = ? AND status = 'preparing'`,
  );
  for (const row of stale) reject.run(nowIso, nowIso, row.id);
  return new Set(stale.map((row) => row.topic_id));
}

/** Освобождает все зависшие claim до выбора новых приоритетных тем. */
export function expireStaleLearningClaims(
  db: Database,
  options: { now?: Date; staleAfterMs?: number } = {},
): Set<string> {
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? LEARNING_CLAIM_STALE_MS;
  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
    throw new Error(`Учебный материал: срок claim должен быть положительным, получено ${staleAfterMs}`);
  }
  return db.transaction(() => expireStaleLearningClaimsInTransaction(db, now, staleAfterMs)).immediate();
}

function timestamp(value: Date, operation: string): string {
  if (!Number.isFinite(value.getTime())) {
    throw new Error(`Учебный материал: некорректное время ${operation} (${String(value)})`);
  }
  return value.toISOString();
}

function materialLifecycleRow(db: Database, materialId: number): MaterialLifecycleRow {
  const row = db.prepare<[number], MaterialLifecycleRow>(
    'SELECT id, status FROM learning_materials WHERE id = ?',
  ).get(materialId);
  if (row === undefined) {
    throw new LearningError('learning-not-found', `Учебный материал ${materialId} не найден`);
  }
  return row;
}

function materialStartRow(db: Database, materialId: number): MaterialStartRow {
  const row = db.prepare<[number, number], MaterialStartRow>(
    `WITH latest_run AS (
       SELECT run_id, attempt_number
         FROM learning_runs
        WHERE material_id = ?
        ORDER BY attempt_number DESC LIMIT 1
     )
     SELECT learning_materials.id, learning_materials.subject,
            learning_materials.topic_id, learning_materials.course_revision_id,
            learning_materials.status,
            latest_run.run_id AS latest_run_id,
            latest_run.attempt_number AS latest_attempt_number,
            runs.kind AS latest_run_kind,
            runs.finished_at AS latest_run_finished_at
       FROM learning_materials
       LEFT JOIN latest_run ON TRUE
       LEFT JOIN runs ON runs.id = latest_run.run_id
      WHERE learning_materials.id = ?`,
  ).get(materialId, materialId);
  if (row === undefined) {
    throw new LearningError('learning-not-found', `Учебный материал ${materialId} не найден`);
  }
  return row;
}

/** Карточки главного экрана: claim и закрытая история наружу не попадают. */
export function learningMaterialCards(
  db: Database,
  revisions?: ReadonlyMap<string, number>,
): LearningMaterialCard[] {
  return db.prepare<[], MaterialCardRow>(
    `SELECT id, subject, topic_id, status, recommendation_reason, estimated_minutes,
            course_revision_id
       FROM learning_materials
      WHERE status IN ('ready', 'active')
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at, id`,
  ).all().filter((row) => revisions === undefined ||
    row.course_revision_id === revisions.get(row.subject))
    .map((row) => ({
      id: row.id,
      subject: row.subject,
      topicId: row.topic_id,
      recommendationReason: row.recommendation_reason,
      estimatedMinutes: row.estimated_minutes,
      status: row.status as 'ready' | 'active',
      courseRevisionId: row.course_revision_id,
    }));
}

/** Безопасно разбирает только опубликованное содержимое и текущий прогресс. */
export function readLearningMaterial(db: Database, materialId: number): LearningMaterialView {
  const row = db.prepare<[number, number], MaterialViewRow>(
    `WITH latest_run AS (
       SELECT run_id FROM learning_runs
        WHERE material_id = ?
        ORDER BY attempt_number DESC LIMIT 1
     )
     SELECT learning_materials.id, learning_materials.subject,
            learning_materials.topic_id, learning_materials.status,
            learning_materials.course_revision_id,
            learning_materials.content,
            learning_materials.recommendation_reason, learning_materials.estimated_minutes,
            latest_run.run_id AS latest_run_id,
            runs.finished_at AS latest_run_finished_at
       FROM learning_materials
       LEFT JOIN latest_run ON TRUE
       LEFT JOIN runs ON runs.id = latest_run.run_id
      WHERE learning_materials.id = ?`,
  ).get(materialId, materialId);
  if (row === undefined) {
    throw new LearningError('learning-not-found', `Учебный материал ${materialId} не найден`);
  }
  if (row.status !== 'ready' && row.status !== 'active') {
    throw new LearningError(
      row.status === 'passed' || row.status === 'failed'
        ? 'learning-finished'
        : 'learning-not-ready',
      `Учебный материал ${materialId} нельзя читать в состоянии ${row.status}`,
    );
  }
  const progress = row.latest_run_id === null || row.latest_run_finished_at !== null
    ? { total: 0, correct: 0, target: LEARNING_TASK_COUNT, done: false }
    : runProgress(db, row.latest_run_id);
  if (progress.total > 0) {
    return {
      id: row.id,
      subject: row.subject,
      topicId: row.topic_id,
      recommendationReason: row.recommendation_reason,
      estimatedMinutes: row.estimated_minutes,
      status: row.status,
      courseRevisionId: row.course_revision_id,
      latestRunId: row.latest_run_id,
      latestRunFinishedAt: row.latest_run_finished_at,
      content: null,
      passScore: LEARNING_PASS_SCORE,
      progress,
    };
  }
  if (row.content === null) {
    throw new LearningError('learning-inconsistent', `Учебный материал ${materialId} не содержит теорию`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(row.content);
  } catch {
    throw new LearningError('learning-inconsistent', `Учебный материал ${materialId} хранит повреждённый JSON`);
  }
  let content: LearningMaterialContent;
  try {
    content = parseLearningMaterial(raw);
  } catch (error) {
    throw new LearningError(
      'learning-inconsistent',
      `Учебный материал ${materialId} небезопасен: ${(error as Error).message}`,
    );
  }
  return {
    id: row.id,
    subject: row.subject,
    topicId: row.topic_id,
    recommendationReason: row.recommendation_reason,
    estimatedMinutes: row.estimated_minutes,
    status: row.status,
    courseRevisionId: row.course_revision_id,
    latestRunId: row.latest_run_id,
    latestRunFinishedAt: row.latest_run_finished_at,
    content,
    passScore: LEARNING_PASS_SCORE,
    progress,
  };
}

/**
 * Захватывает тему под генерацию. Незавершённый claim не переиспользуется:
 * новый воркер получает тему лишь после истечения срока, а старую строку
 * оставляет в истории как rejected.
 */
export function claimLearningMaterial(
  db: Database,
  options: ClaimLearningMaterialOptions,
): LearningMaterialClaim | undefined {
  const now = options.now ?? new Date();
  const nowIso = timestamp(now, 'claim');
  const staleAfterMs = options.staleAfterMs ?? LEARNING_CLAIM_STALE_MS;
  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
    throw new Error(`Учебный материал: срок claim должен быть положительным, получено ${staleAfterMs}`);
  }
  if (!Number.isFinite(options.masteryBefore) || options.masteryBefore < 0 || options.masteryBefore > 1) {
    throw new Error(`Учебный материал: mastery_before вне диапазона 0..1 (${options.masteryBefore})`);
  }
  const estimatedMinutes = options.estimatedMinutes ?? 12;
  if (!Number.isInteger(estimatedMinutes) || estimatedMinutes < 10 || estimatedMinutes > 15) {
    throw new Error(`Учебный материал: оценка времени должна быть от 10 до 15 минут`);
  }
  if (options.recommendationReason.trim() === '') {
    throw new Error('Учебный материал: причина рекомендации не может быть пустой');
  }

  return db.transaction((): LearningMaterialClaim | undefined => {
    const topic = db.prepare<[string], { found: number }>(
      'SELECT 1 AS found FROM topic_state WHERE topic_id = ?',
    ).get(options.topicId);
    if (topic === undefined) {
      throw new Error(`Учебный материал: темы «${options.topicId}» нет в topic_state`);
    }

    const expiredTopics = expireStaleLearningClaimsInTransaction(db, now, staleAfterMs);

    const live = db.prepare<[string, string, number | null], { id: number }>(
      `SELECT id FROM learning_materials
        WHERE (topic_id = ? OR subject = ?)
          AND course_revision_id IS ?
          AND status IN ('preparing', 'ready', 'active') LIMIT 1`,
    ).get(options.topicId, options.subject, options.courseRevisionId ?? null);
    if (live !== undefined) return undefined;

    const result = db.prepare(
      `INSERT INTO learning_materials
         (subject, topic_id, course_revision_id, recommendation_reason, estimated_minutes,
          mastery_before, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      options.subject,
      options.topicId,
      options.courseRevisionId ?? null,
      options.recommendationReason.trim(),
      estimatedMinutes,
      options.masteryBefore,
      nowIso,
      nowIso,
    );
    return { materialId: Number(result.lastInsertRowid), recovered: expiredTopics.has(options.topicId) };
  }).immediate();
}

export interface OpenLearningMaterialResult {
  materialId: number;
  resumed: boolean;
}

/** Открывает готовую теорию или идемпотентно продолжает уже открытую. */
export function openLearningMaterial(
  db: Database,
  materialId: number,
  options: { now?: Date } = {},
): OpenLearningMaterialResult {
  const nowIso = timestamp(options.now ?? new Date(), 'открытия');
  return db.transaction((): OpenLearningMaterialResult => {
    const material = materialLifecycleRow(db, materialId);
    if (material.status === 'active') return { materialId, resumed: true };
    if (material.status !== 'ready') {
      throw new LearningError(
        material.status === 'passed' || material.status === 'failed'
          ? 'learning-finished'
          : 'learning-not-ready',
        `Учебный материал ${materialId} нельзя открыть в состоянии ${material.status}`,
      );
    }
    const changed = db.prepare(
      `UPDATE learning_materials
          SET status = 'active', opened_at = ?, updated_at = ?
        WHERE id = ? AND status = 'ready'`,
    ).run(nowIso, nowIso, materialId);
    if (changed.changes !== 1) {
      throw new LearningError('learning-inconsistent', `Материал ${materialId} изменился во время открытия`);
    }
    return { materialId, resumed: false };
  }).immediate();
}

function ensureCompleteMaterial(db: Database, materialId: number): void {
  const row = db.prepare<[number], { count: number; first: number | null; last: number | null; bad: number }>(
    `SELECT COUNT(*) AS count, MIN(learning_tasks.position) AS first,
            MAX(learning_tasks.position) AS last,
            SUM(CASE WHEN task_bank.topic_id <> learning_materials.topic_id
                       OR task_bank.status <> 'lesson_reserved' THEN 1 ELSE 0 END) AS bad
       FROM learning_materials
       LEFT JOIN learning_tasks ON learning_tasks.material_id = learning_materials.id
       LEFT JOIN task_bank ON task_bank.id = learning_tasks.task_id
      WHERE learning_materials.id = ?`,
  ).get(materialId);
  if (
    row === undefined || row.count !== LEARNING_TASK_COUNT || row.first !== 1 ||
    row.last !== LEARNING_TASK_COUNT || row.bad !== 0
  ) {
    throw new LearningError(
      'learning-inconsistent',
      `Учебный материал ${materialId} не содержит полный согласованный тест`,
    );
  }
}

export interface StartLearningRunResult {
  materialId: number;
  runId: number;
  resumed: boolean;
}

/** Возвращает незавершённый lesson-run или создаёт следующую попытку после незачёта. */
export function startLearningRun(
  db: Database,
  materialId: number,
  options: { now?: Date } = {},
): StartLearningRunResult {
  const nowIso = timestamp(options.now ?? new Date(), 'теста');
  return db.transaction((): StartLearningRunResult => {
    const material = materialStartRow(db, materialId);
    if (material.latest_run_id !== null) {
      if (material.latest_run_kind !== 'lesson') {
        throw new LearningError('learning-inconsistent', `Материал ${materialId} связан не с lesson-run`);
      }
      if (material.status === 'passed' || material.status === 'failed') {
        throw new LearningError('learning-finished', `Тест материала ${materialId} уже завершён`);
      }
      if (material.status !== 'active') {
        throw new LearningError(
          'learning-not-ready',
          `Материал ${materialId} нельзя продолжить в состоянии ${material.status}`,
        );
      }
      if (material.latest_run_finished_at === null) {
        return { materialId, runId: material.latest_run_id, resumed: true };
      }
    }
    if (material.status !== 'active') {
      throw new LearningError('learning-not-ready', `Материал ${materialId} ещё не открыт`);
    }
    ensureCompleteMaterial(db, material.id);
    const attemptNumber = (material.latest_attempt_number ?? 0) + 1;

    const runId = Number(db.prepare(
      `INSERT INTO runs
        (subject, course_revision_id, kind, topic_id, started_at, lives_remaining)
       VALUES (?, ?, 'lesson', ?, ?, NULL)`,
    ).run(material.subject, material.course_revision_id, material.topic_id, nowIso).lastInsertRowid);
    const linked = db.prepare(
      `UPDATE learning_materials
          SET mastery_before = CASE WHEN ? = 1 THEN (
                SELECT mastery FROM topic_state WHERE topic_id = learning_materials.topic_id
              ) ELSE mastery_before END,
              updated_at = ?
        WHERE id = ? AND status = 'active'
          AND COALESCE((
                SELECT MAX(attempt_number) FROM learning_runs
                 WHERE material_id = learning_materials.id
              ), 0) = ?`,
    ).run(attemptNumber, nowIso, materialId, attemptNumber - 1);
    if (linked.changes !== 1) {
      throw new LearningError('learning-inconsistent', `Материал ${materialId} изменился во время старта теста`);
    }
    db.prepare(
      `INSERT INTO learning_runs (material_id, run_id, attempt_number) VALUES (?, ?, ?)`,
    ).run(materialId, runId, attemptNumber);
    db.prepare(
      `UPDATE task_bank SET issued_run_id = ?
        WHERE id IN (SELECT task_id FROM learning_tasks WHERE material_id = ?)`,
    ).run(runId, materialId);
    return { materialId, runId, resumed: false };
  }).immediate();
}

export interface FinishLearningMaterialResult extends FinishRunResult {
  materialId: number;
  outcome: 'passed' | 'failed';
  masteryBefore: number;
  masteryAfter: number;
  passScore: number;
}

/** Проверяет готовность lesson-run до запуска обязательного Codex-review. */
export function assertLearningReadyForIntegrity(db: Database, runId: number): void {
  const joined = db.prepare<[number], {
    id: number; status: LearningMaterialStatus; run_kind: string;
    finished_at: string | null; total: number;
  }>(
    `SELECT learning_materials.id, learning_materials.status, runs.kind AS run_kind,
            runs.finished_at, runs.total
       FROM learning_runs
       JOIN learning_materials ON learning_materials.id = learning_runs.material_id
       JOIN runs ON runs.id = learning_runs.run_id
      WHERE runs.id = ?`,
  ).get(runId);
  if (joined === undefined) throw new LearningError('learning-not-found', `Lesson-run ${runId} не найден`);
  if (joined.run_kind !== 'lesson') {
    throw new LearningError('learning-inconsistent', `Забег ${runId} не является lesson-run`);
  }
  if (joined.finished_at !== null) return;
  if (joined.status !== 'active') {
    throw new LearningError('learning-not-ready', `Материал ${joined.id} не проходит тест`);
  }
  if (joined.total !== LEARNING_TASK_COUNT) {
    throw new LearningError(
      'learning-incomplete',
      `Lesson-run ${runId} содержит ${joined.total} из ${LEARNING_TASK_COUNT} ответов`,
    );
  }
  const openDispute = db.prepare<[number], { found: number }>(
    `SELECT 1 AS found FROM attempts JOIN disputes ON disputes.attempt_id = attempts.id
      WHERE attempts.run_id = ? AND disputes.status = 'open' LIMIT 1`,
  ).get(runId);
  if (openDispute !== undefined) {
    throw new LearningError('learning-dispute-open', `Lesson-run ${runId} приостановлен открытым спором`);
  }
}

/** Закрывает одну попытку теста; незачёт оставляет тот же материал для повтора. */
export function finishLearningMaterial(
  db: Database,
  graph: TopicGraph,
  runId: number,
  options: { now?: Date } = {},
): FinishLearningMaterialResult {
  const now = options.now ?? new Date();
  const nowIso = timestamp(now, 'завершения');
  return db.transaction((): FinishLearningMaterialResult => {
    const joined = db.prepare<[number], FinishLearningRow>(
      `SELECT learning_materials.id, learning_materials.topic_id,
              learning_materials.status,
              learning_materials.mastery_before,
              runs.finished_at, runs.summary, runs.total, runs.correct, runs.kind AS run_kind,
              learning_runs.attempt_number
         FROM learning_runs
         JOIN learning_materials ON learning_materials.id = learning_runs.material_id
         JOIN runs ON runs.id = learning_runs.run_id
        WHERE runs.id = ?`,
    ).get(runId);
    if (joined === undefined) {
      throw new LearningError('learning-not-found', `Lesson-run ${runId} не найден`);
    }
    if (joined.run_kind !== 'lesson') {
      throw new LearningError('learning-inconsistent', `Забег ${runId} не является lesson-run`);
    }
    const masteryAfter = db.prepare<[string], { mastery: number }>(
      'SELECT mastery FROM topic_state WHERE topic_id = ?',
    ).get(joined.topic_id)?.mastery;
    if (masteryAfter === undefined) {
      throw new LearningError('learning-inconsistent', `Тема материала ${joined.id} исчезла`);
    }
    if (joined.finished_at !== null) {
      if (joined.summary === null) {
        throw new LearningError('learning-inconsistent', `Lesson-run ${runId} не хранит итог`);
      }
      return JSON.parse(joined.summary) as FinishLearningMaterialResult;
    }
    if (joined.status !== 'active') {
      throw new LearningError('learning-not-ready', `Материал ${joined.id} не проходит тест`);
    }
    if (joined.total !== LEARNING_TASK_COUNT) {
      throw new LearningError(
        'learning-incomplete',
        `Lesson-run ${runId} содержит ${joined.total} из ${LEARNING_TASK_COUNT} ответов`,
      );
    }
    const openDispute = db.prepare<[number], { found: number }>(
      `SELECT 1 AS found FROM attempts
        JOIN disputes ON disputes.attempt_id = attempts.id
       WHERE attempts.run_id = ? AND disputes.status = 'open' LIMIT 1`,
    ).get(runId);
    if (openDispute !== undefined) {
      throw new LearningError('learning-dispute-open', `Lesson-run ${runId} приостановлен открытым спором`);
    }

    const outcome = joined.correct >= LEARNING_PASS_SCORE ? 'passed' : 'failed';
    const runResult = finishRun(db, graph, runId, { now, allowLesson: true });
    if (runResult.total !== LEARNING_TASK_COUNT || runResult.correct !== joined.correct) {
      throw new LearningError('learning-inconsistent', `Счётчики lesson-run ${runId} расходятся с попытками`);
    }
    const result: FinishLearningMaterialResult = {
      ...runResult,
      materialId: joined.id,
      outcome,
      masteryBefore: joined.attempt_number === 1 ? joined.mastery_before : masteryAfter,
      masteryAfter,
      passScore: LEARNING_PASS_SCORE,
    };
    const materialChanged = outcome === 'passed'
      ? db.prepare(
          `UPDATE learning_materials
              SET status = 'passed', finished_at = ?, updated_at = ?
            WHERE id = ? AND status = 'active'`,
        ).run(nowIso, nowIso, joined.id)
      : db.prepare(
          `UPDATE learning_materials SET updated_at = ?
            WHERE id = ? AND status = 'active'`,
        ).run(nowIso, joined.id);
    if (materialChanged.changes !== 1) {
      throw new LearningError('learning-inconsistent', `Lesson-run ${runId} изменился во время завершения`);
    }
    db.prepare('UPDATE runs SET summary = ? WHERE id = ?').run(JSON.stringify(result), runId);
    if (outcome === 'passed') {
      db.prepare(
        `UPDATE task_bank SET status = 'used'
          WHERE status = 'lesson_reserved'
            AND id IN (SELECT task_id FROM learning_tasks WHERE material_id = ?)`,
      ).run(joined.id);
    }
    return result;
  }).immediate();
}

/** Убирает неоткрытый материал и возвращает его тест в обычный валидный банк. */
export function retireLearningMaterial(
  db: Database,
  materialId: number,
  options: { now?: Date } = {},
): boolean {
  const nowIso = timestamp(options.now ?? new Date(), 'retirement');
  return db.transaction((): boolean => {
    const material = materialLifecycleRow(db, materialId);
    if (material.status === 'retired') return false;
    if (material.status !== 'preparing' && material.status !== 'ready') return false;

    if (material.status === 'ready') {
      db.prepare(
        `UPDATE task_bank SET status = 'valid', issued_run_id = NULL
          WHERE status = 'lesson_reserved'
            AND id IN (SELECT task_id FROM learning_tasks WHERE material_id = ?)`,
      ).run(materialId);
    }
    const changed = db.prepare(
      `UPDATE learning_materials
          SET status = 'retired', finished_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('preparing', 'ready')`,
    ).run(nowIso, nowIso, materialId);
    return changed.changes === 1;
  }).immediate();
}

/** Сохраняет смысловой/структурный отказ валидатора без удаления истории claim. */
export function rejectLearningMaterial(
  db: Database,
  materialId: number,
  options: { now?: Date } = {},
): boolean {
  const nowIso = timestamp(options.now ?? new Date(), 'отбраковки');
  return db.transaction((): boolean => {
    materialLifecycleRow(db, materialId);
    const changed = db.prepare(
      `UPDATE learning_materials
          SET status = 'rejected', finished_at = ?, updated_at = ?
        WHERE id = ? AND status = 'preparing'`,
    ).run(nowIso, nowIso, materialId);
    return changed.changes === 1;
  }).immediate();
}
