import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { buildTopicGraph, type TopicGraph } from '../server/curriculum.js';
import { openDatabase } from '../server/db.js';
import { readDailyGate } from '../server/daily-gate.js';
import {
  createIntegrityCoordinator,
  integritySignal,
  INTEGRITY_FAST_ANSWER_MS,
  INTEGRITY_JUNK_CONFIDENCE,
  type IntegrityCoordinator,
} from '../server/integrity.js';

const NOW = new Date('2026-08-18T09:00:00.000Z');

describe('проверка осмысленности ответа', () => {
  it('держит калибровочные пороги', () => {
    expect(INTEGRITY_FAST_ANSWER_MS).toBe(10_000);
    expect(INTEGRITY_JUNK_CONFIDENCE).toBe(0.9);
  });

  it('отмечает быстрые буквы вместо числа', () => {
    expect(integritySignal({
      answerFormat: 'number', answer: 'Ff', choices: [], correct: false, durationMs: 1_000,
    })).toMatch(/без числа/u);
  });

  it('не отмечает правдоподобную ошибку и быстрый правильный ответ', () => {
    expect(integritySignal({
      answerFormat: 'number', answer: '17', choices: [], correct: false, durationMs: 1_000,
    })).toBeNull();
    expect(integritySignal({
      answerFormat: 'number', answer: '18', choices: [], correct: true, durationMs: 200,
    })).toBeNull();
    expect(integritySignal({
      answerFormat: 'number', answer: 'сорок пять', choices: [], correct: false, durationMs: 1_000,
    })).toBeNull();
  });
});

describe('очередь проверки занятия', () => {
  let dir: string;
  let db: Database;
  let graph: TopicGraph;
  let runId: number;
  let coordinator: IntegrityCoordinator | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'edukator-integrity-'));
    db = openDatabase(join(dir, 'test.db'));
    graph = buildTopicGraph([{
      id: 'math.ratio', subject: 'math', title: 'Пропорции', examWeight: 3,
      difficulty: 2, prereqs: [], answerFormat: 'number', promptSeed: 'Решай пропорции.',
    }]);
    db.prepare('INSERT INTO topic_state (topic_id) VALUES (?)').run('math.ratio');
    runId = Number(db.prepare(
      "INSERT INTO runs (subject, kind, topic_id, started_at, total, correct) VALUES ('math', 'run', 'math.ratio', ?, 1, 0)",
    ).run(NOW.toISOString()).lastInsertRowid);
    const taskId = Number(db.prepare(
      `INSERT INTO task_bank
        (topic_id, question, instruction, material, material_format, answer, accept, difficulty, status, issued_run_id)
       VALUES ('math.ratio', 'Найди x', 'Найди значение переменной.', '12/x = 18/27', 'math', '18', '["18"]', 2, 'used', ?)`,
    ).run(runId).lastInsertRowid);
    db.prepare(
      `INSERT INTO attempts
        (task_id, topic_id, run_id, answer, is_correct, duration_ms, created_at)
       VALUES (?, 'math.ratio', ?, 'Ff', 0, 1000, ?)`,
    ).run(taskId, runId, NOW.toISOString());
  });

  afterEach(async () => {
    await coordinator?.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function complete(id: number, at: Date): Record<string, unknown> {
    const result = { runId: id, total: 1, correct: 1 };
    db.prepare('UPDATE runs SET finished_at = ?, summary = ? WHERE id = ?')
      .run(at.toISOString(), JSON.stringify(result), id);
    return result;
  }

  async function settle(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  it('требует повтор только при junk с уверенностью не ниже 0,9', async () => {
    coordinator = createIntegrityCoordinator({
      db, graph, now: () => NOW, complete,
      review: async (items) => items.map((item) => ({
        id: item.id, decision: 'junk', confidence: 0.9, reason: 'Случайные буквы вместо числа.',
      })),
    });

    expect(coordinator.begin(runId)).toMatchObject({ status: 'checking', flagged: 1 });
    await settle();

    expect(coordinator.status(runId)).toMatchObject({ status: 'retry_required', remaining: 1 });
    expect(readDailyGate(db, NOW).completed).toBe(0);
  });

  it('сомнение или junk ниже порога не блокирует занятие', async () => {
    coordinator = createIntegrityCoordinator({
      db, graph, now: () => NOW, complete,
      review: async (items) => items.map((item) => ({
        id: item.id, decision: 'junk', confidence: 0.89, reason: 'Недостаточно уверенности.',
      })),
    });

    coordinator.begin(runId);
    await settle();

    expect(coordinator.status(runId)).toMatchObject({ status: 'completed' });
    expect(readDailyGate(db, NOW).completed).toBe(1);
  });

  it('отправляет одним батчем все вопросы, даже если эвристика не нашла сигнал', async () => {
    const secondTask = Number(db.prepare(
      `INSERT INTO task_bank
        (topic_id, question, instruction, material, material_format, answer, accept, difficulty, status, issued_run_id)
       VALUES ('math.ratio', 'Сложи числа', 'Вычисли сумму.', '8 + 9', 'math', '17', '["17"]', 2, 'used', ?)`,
    ).run(runId).lastInsertRowid);
    db.prepare(
      `INSERT INTO attempts
        (task_id, topic_id, run_id, answer, is_correct, duration_ms, created_at)
       VALUES (?, 'math.ratio', ?, '17', 1, 200, ?)`,
    ).run(secondTask, runId, NOW.toISOString());
    db.prepare('UPDATE runs SET total = 2, correct = 1 WHERE id = ?').run(runId);
    let reviewedSignals: string[] = [];
    coordinator = createIntegrityCoordinator({
      db, graph, now: () => NOW, complete,
      review: async (items) => {
        reviewedSignals = items.map((item) => item.signal);
        return items.map((item) => ({
          id: item.id, decision: 'meaningful', confidence: 0.99, reason: 'Ответ осмысленный.',
        }));
      },
    });

    expect(coordinator.begin(runId)).toMatchObject({ status: 'checking', flagged: 2 });
    await settle();

    expect(reviewedSignals).toHaveLength(2);
    expect(reviewedSignals).toContain('Предварительная эвристика не нашла отдельного сигнала.');
    expect(coordinator.status(runId)).toMatchObject({ status: 'completed' });
  });

  it('заменяет только отмеченный ответ и повторно проверяет его через Codex', async () => {
    const reviewedAnswers: string[] = [];
    coordinator = createIntegrityCoordinator({
      db, graph, now: () => NOW, complete,
      review: async (items) => items.map((item) => {
        const answer = item.attempts.at(-1)?.answer ?? '';
        reviewedAnswers.push(answer);
        return {
          id: item.id,
          decision: answer === 'Ff' ? 'junk' : 'meaningful',
          confidence: 0.99,
          reason: answer === 'Ff' ? 'Ответ не связан с вопросом.' : 'Видно решение.',
        };
      }),
    });
    coordinator.begin(runId);
    await settle();
    const state = coordinator.status(runId);
    if (state?.status !== 'retry_required') throw new Error('Ожидался повтор вопроса');

    const checking = coordinator.retry(runId, state.retry.itemId, '18', 15_000);
    expect(checking.status).toBe('checking');
    await settle();

    expect(coordinator.status(runId)?.status).toBe('completed');
    expect(reviewedAnswers).toEqual(['Ff', '18']);
    expect(db.prepare(
      'SELECT answer, is_current FROM attempts WHERE run_id = ? ORDER BY id',
    ).all(runId)).toEqual([
      { answer: 'Ff', is_current: 0 },
      { answer: '18', is_current: 1 },
    ]);
  });

  it('после перезапуска продолжает сохранённую проверку', async () => {
    coordinator = createIntegrityCoordinator({
      db, graph, now: () => NOW, complete, retryMs: 60_000,
      review: async () => { throw new Error('codex временно недоступен'); },
    });
    coordinator.begin(runId);
    await settle();
    expect(coordinator.status(runId)).toMatchObject({ status: 'checking' });
    await coordinator.stop();

    coordinator = createIntegrityCoordinator({
      db, graph, now: () => NOW, complete,
      review: async (items) => items.map((item) => ({
        id: item.id, decision: 'meaningful', confidence: 0.95, reason: 'Ответ осмысленный.',
      })),
    });
    await settle();

    expect(coordinator.status(runId)).toMatchObject({ status: 'completed' });
  });
});
