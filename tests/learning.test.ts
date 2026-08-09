import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../server/db.js';
import { buildTopicGraph } from '../server/curriculum.js';
import {
  claimLearningMaterial,
  finishLearningMaterial,
  LearningError,
  openLearningMaterial,
  publishLearningMaterial,
  rejectLearningMaterial,
  retireLearningMaterial,
  startLearningRun,
} from '../server/learning.js';

const TOPIC = 'math.fractions';
const START = new Date('2026-08-09T10:00:00.000Z');
const GRAPH = buildTopicGraph([{
  id: TOPIC, subject: 'math', title: 'Дроби', examWeight: 3, difficulty: 2,
  prereqs: [], answerFormat: 'number', promptSeed: 'Действия с дробями',
}]);

function seedTopic(db: Database, mastery = 0.3): void {
  db.prepare('INSERT INTO topic_state (topic_id, mastery) VALUES (?, ?)').run(TOPIC, mastery);
}

function seedTasks(db: Database, count = 5): number[] {
  return Array.from({ length: count }, (_, index) => Number(db.prepare(
    `INSERT INTO task_bank
       (topic_id, question, answer, accept, difficulty, status)
     VALUES (?, ?, '4', '["4"]', 2, 'valid')`,
  ).run(TOPIC, `Вопрос ${index + 1}`).lastInsertRowid));
}

function claim(db: Database, now = START): number {
  const result = claimLearningMaterial(db, {
    subject: 'math',
    topicId: TOPIC,
    recommendationReason: 'Ошибки в действиях с дробями',
    masteryBefore: 0.3,
    now,
  });
  if (result === undefined) throw new Error('claim не создан');
  return result.materialId;
}

function readyMaterial(db: Database): { materialId: number; taskIds: number[] } {
  const materialId = claim(db);
  const taskIds = seedTasks(db);
  publishLearningMaterial(db, materialId, {
    content: { introduction: 'Разберём дроби', objectives: ['Находить общий знаменатель'] },
    taskIds,
    now: new Date('2026-08-09T10:05:00.000Z'),
  });
  return { materialId, taskIds };
}

function activeRun(db: Database): { materialId: number; taskIds: number[]; runId: number } {
  const material = readyMaterial(db);
  openLearningMaterial(db, material.materialId, { now: new Date('2026-08-09T10:06:00.000Z') });
  const run = startLearningRun(db, material.materialId, {
    now: new Date('2026-08-09T10:07:00.000Z'),
  });
  return { ...material, runId: run.runId };
}

describe('слой данных учебных материалов', () => {
  let tempDir: string;
  let db: Database;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-learning-'));
    db = openDatabase(join(tempDir, 'test.db'));
    seedTopic(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('атомарно захватывает тему один раз и восстанавливает зависший claim', () => {
    const first = claimLearningMaterial(db, {
      subject: 'math', topicId: TOPIC, recommendationReason: 'Слабая тема',
      masteryBefore: 0.3, now: START, staleAfterMs: 60_000,
    });
    expect(first).toMatchObject({ recovered: false });

    expect(claimLearningMaterial(db, {
      subject: 'math', topicId: TOPIC, recommendationReason: 'Ещё одна причина',
      masteryBefore: 0.3, now: new Date('2026-08-09T10:00:30.000Z'), staleAfterMs: 60_000,
    })).toBeUndefined();

    const recovered = claimLearningMaterial(db, {
      subject: 'math', topicId: TOPIC, recommendationReason: 'Повторная подача',
      masteryBefore: 0.3, now: new Date('2026-08-09T10:01:01.000Z'), staleAfterMs: 60_000,
    });
    expect(recovered).toMatchObject({ recovered: true });
    expect(db.prepare('SELECT id, status FROM learning_materials ORDER BY id').all()).toEqual([
      { id: first?.materialId, status: 'rejected' },
      { id: recovered?.materialId, status: 'preparing' },
    ]);
  });

  it('публикует содержимое и ровно пять задач одной транзакцией', () => {
    const materialId = claim(db);
    const taskIds = seedTasks(db);

    publishLearningMaterial(db, materialId, {
      content: { introduction: 'Дроби без страха' }, taskIds, now: START,
    });

    expect(db.prepare(
      'SELECT status, content, updated_at FROM learning_materials WHERE id = ?',
    ).get(materialId)).toEqual({
      status: 'ready',
      content: JSON.stringify({ introduction: 'Дроби без страха' }),
      updated_at: START.toISOString(),
    });
    expect(db.prepare(
      `SELECT learning_tasks.task_id, learning_tasks.position, task_bank.status
         FROM learning_tasks JOIN task_bank ON task_bank.id = learning_tasks.task_id
        WHERE material_id = ? ORDER BY position`,
    ).all(materialId)).toEqual(taskIds.map((taskId, index) => ({
      task_id: taskId, position: index + 1, status: 'lesson_reserved',
    })));
  });

  it('откатывает публикацию целиком при неполном или занятом наборе', () => {
    const materialId = claim(db);
    const taskIds = seedTasks(db);
    db.prepare("UPDATE task_bank SET status = 'used' WHERE id = ?").run(taskIds[4]);

    expect(() => publishLearningMaterial(db, materialId, {
      content: { introduction: 'Не сохранится' }, taskIds, now: START,
    })).toThrowError(LearningError);

    expect(db.prepare('SELECT status, content FROM learning_materials WHERE id = ?').get(materialId))
      .toEqual({ status: 'preparing', content: null });
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM task_bank WHERE status = 'lesson_reserved'",
    ).get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM learning_tasks').get()).toEqual({ n: 0 });
  });

  it('идемпотентно открывает материал и создаёт единственный lesson-run', () => {
    const { materialId, taskIds } = readyMaterial(db);

    expect(openLearningMaterial(db, materialId, { now: START }))
      .toEqual({ materialId, resumed: false });
    expect(openLearningMaterial(db, materialId, { now: new Date(START.getTime() + 1000) }))
      .toEqual({ materialId, resumed: true });

    const first = startLearningRun(db, materialId, { now: START });
    const second = startLearningRun(db, materialId, { now: new Date(START.getTime() + 1000) });
    expect(first).toMatchObject({ materialId, resumed: false });
    expect(second).toEqual({ materialId, runId: first.runId, resumed: true });
    expect(db.prepare('SELECT kind, topic_id FROM runs WHERE id = ?').get(first.runId))
      .toEqual({ kind: 'lesson', topic_id: TOPIC });
    expect(db.prepare('SELECT id, issued_run_id FROM task_bank ORDER BY id').all())
      .toEqual(taskIds.map((id) => ({ id, issued_run_id: first.runId })));
  });

  it.each([
    { correct: 4, outcome: 'passed' as const },
    { correct: 3, outcome: 'failed' as const },
  ])('завершает материал как $outcome при результате $correct/5 и повторяет итог', ({ correct, outcome }) => {
    const { materialId, taskIds, runId } = activeRun(db);
    taskIds.forEach((taskId, index) => db.prepare(
      `INSERT INTO attempts (task_id, topic_id, run_id, answer, is_correct, duration_ms)
       VALUES (?, ?, ?, '4', ?, 1000)`,
    ).run(taskId, TOPIC, runId, index < correct ? 1 : 0));
    db.prepare('UPDATE runs SET total = 5, correct = ? WHERE id = ?').run(correct, runId);
    db.prepare('UPDATE topic_state SET mastery = 0.46 WHERE topic_id = ?').run(TOPIC);

    const result = finishLearningMaterial(db, GRAPH, runId, { now: START });
    expect(result).toMatchObject({
      materialId, runId, total: 5, correct, outcome, masteryBefore: 0.3, masteryAfter: 0.46,
    });
    expect(result).toMatchObject({ xp: correct * 25, forecast: { subject: 'math' } });
    expect(finishLearningMaterial(db, GRAPH, runId, { now: new Date(START.getTime() + 5000) }))
      .toEqual(result);
    expect(db.prepare('SELECT status, finished_at FROM learning_materials WHERE id = ?').get(materialId))
      .toEqual({ status: outcome, finished_at: START.toISOString() });
    expect(db.prepare("SELECT COUNT(*) AS n FROM task_bank WHERE status = 'used'").get())
      .toEqual({ n: 5 });
  });

  it('не завершает неполный тест или тест с открытым спором', () => {
    const { taskIds, runId } = activeRun(db);
    db.prepare('UPDATE runs SET total = 4, correct = 4 WHERE id = ?').run(runId);
    expect(() => finishLearningMaterial(db, GRAPH, runId, { now: START }))
      .toThrow(/4 из 5 ответов/);

    db.prepare('UPDATE runs SET total = 5, correct = 4 WHERE id = ?').run(runId);
    const attemptId = Number(db.prepare(
      `INSERT INTO attempts (task_id, topic_id, run_id, answer, is_correct)
       VALUES (?, ?, ?, '4', 1)`,
    ).run(taskIds[0], TOPIC, runId).lastInsertRowid);
    db.prepare("INSERT INTO disputes (attempt_id, status) VALUES (?, 'open')").run(attemptId);
    expect(() => finishLearningMaterial(db, GRAPH, runId, { now: START }))
      .toThrow(/открытым спором/);
    expect(db.prepare('SELECT finished_at FROM runs WHERE id = ?').get(runId))
      .toEqual({ finished_at: null });
  });

  it('retirement возвращает тест неоткрытого материала в банк, но не трогает открытый', () => {
    const first = readyMaterial(db);
    expect(retireLearningMaterial(db, first.materialId, { now: START })).toBe(true);
    expect(db.prepare('SELECT status FROM learning_materials WHERE id = ?').get(first.materialId))
      .toEqual({ status: 'retired' });
    expect(db.prepare("SELECT COUNT(*) AS n FROM task_bank WHERE status = 'valid'").get())
      .toEqual({ n: 5 });

    const second = readyMaterial(db);
    openLearningMaterial(db, second.materialId, { now: START });
    expect(retireLearningMaterial(db, second.materialId, { now: START })).toBe(false);
    expect(db.prepare('SELECT status FROM learning_materials WHERE id = ?').get(second.materialId))
      .toEqual({ status: 'active' });
  });

  it('отбраковывает только готовящийся claim', () => {
    const materialId = claim(db);
    expect(rejectLearningMaterial(db, materialId, { now: START })).toBe(true);
    expect(rejectLearningMaterial(db, materialId, { now: START })).toBe(false);
    expect(db.prepare('SELECT status, finished_at FROM learning_materials WHERE id = ?').get(materialId))
      .toEqual({ status: 'rejected', finished_at: START.toISOString() });
  });
});
