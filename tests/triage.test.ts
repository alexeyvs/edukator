import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../server/db.js';
import {
  buildTopicGraph,
  syncTopicState,
  type Topic,
  type TopicGraph,
} from '../server/curriculum.js';
import { storeTasks } from '../server/codex/bank.js';
import type { GeneratedTask } from '../server/codex/task-schema.js';
import { submitAnswer } from '../server/session.js';
import {
  TRIAGE_START_DIFFICULTY,
  TRIAGE_TARGET,
  nextTriageTask,
} from '../server/triage.js';

function topic(id: string): Topic {
  return {
    id,
    subject: 'math',
    title: `Тема ${id}`,
    examWeight: 2,
    difficulty: 2,
    prereqs: [],
    answerFormat: 'number',
    promptSeed: `Проверь тему ${id}.`,
  };
}

let taskNumber = 0;

function task(difficulty: number): GeneratedTask {
  taskNumber += 1;
  return {
    question: `Задание ${taskNumber}: сколько будет ${difficulty} + 1?`,
    answer: String(difficulty + 1),
    accept: [String(difficulty + 1)],
    hint: 'Сложи числа.',
    explain: `${difficulty} + 1 = ${difficulty + 1}.`,
    joke: 'Лесенка сложности не скрипит.',
    difficulty,
  };
}

describe('политика триажа', () => {
  let tempDir: string;
  let db: Database;
  let graph: TopicGraph;
  let runId: number;

  beforeEach(() => {
    taskNumber = 0;
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-triage-'));
    db = openDatabase(join(tempDir, 'triage.db'));
    graph = buildTopicGraph(Array.from({ length: 14 }, (_, index) => topic(`math.${index + 1}`)));
    syncTopicState(db, graph);
    runId = Number(
      db.prepare(
        `INSERT INTO runs (subject, kind, topic_id, started_at)
         VALUES ('math', 'triage', 'math.1', ?)`,
      ).run(new Date('2026-08-08T09:00:00.000Z').toISOString()).lastInsertRowid,
    );
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function fillTopic(topicId: string): void {
    storeTasks(db, topicId, [task(1), task(2), task(3)]);
  }

  function next(): Extract<ReturnType<typeof nextTriageTask>, { status: 'ok' }> {
    const result = nextTriageTask(db, graph, runId, { subject: 'math' });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('триаж неожиданно завершился');
    return result;
  }

  function answer(correct: boolean): void {
    const result = next();
    submitAnswer(db, graph, {
      taskId: result.task.id,
      runId,
      answer: correct ? String(result.task.difficulty + 1) : '999',
    });
  }

  it('держит калибровочные константы спеки и лесенку в границах 1-3', () => {
    expect(TRIAGE_TARGET).toBe(12);
    expect(TRIAGE_START_DIFFICULTY).toBe(2);
    for (const item of graph.bySubject.get('math') ?? []) fillTopic(item.id);

    expect(next().task.difficulty).toBe(2);
    answer(true);
    expect(next().task.difficulty).toBe(3);
    answer(true);
    expect(next().task.difficulty).toBe(3);
    answer(false);
    expect(next().task.difficulty).toBe(2);
    answer(false);
    expect(next().task.difficulty).toBe(1);
    answer(false);
    expect(next().task.difficulty).toBe(1);
  });

  it('повышает сложность после верного ответа и понижает после неверного', () => {
    for (const item of graph.bySubject.get('math')?.slice(0, 3) ?? []) fillTopic(item.id);

    const first = next();
    expect(first.task.difficulty).toBe(2);
    submitAnswer(db, graph, {
      taskId: first.task.id,
      runId,
      answer: '3',
    });

    const second = next();
    expect(second.task.difficulty).toBe(3);
    submitAnswer(db, graph, {
      taskId: second.task.id,
      runId,
      answer: 'неверно',
    });

    expect(next().task.difficulty).toBe(2);
  });

  it('не повторяет тему внутри одного триажа и повторяет неотвеченное задание', () => {
    fillTopic('math.1');
    fillTopic('math.2');

    const first = next();
    expect(next().task.id).toBe(first.task.id);
    submitAnswer(db, graph, {
      taskId: first.task.id,
      runId,
      answer: '3',
    });

    const second = next();
    expect(second.task.topicId).not.toBe(first.task.topicId);
  });

  it('пропускает пустую тему и досрочно заканчивает исчерпавшийся триаж', () => {
    fillTopic('math.2');

    const result = next();
    expect(result.task.topicId).toBe('math.2');
    submitAnswer(db, graph, {
      taskId: result.task.id,
      runId,
      answer: '3',
    });

    expect(nextTriageTask(db, graph, runId, { subject: 'math' })).toEqual({
      status: 'done',
      total: 1,
      target: 12,
    });
  });

  it('заканчивает триаж после двенадцати ответов, даже если темы ещё есть', () => {
    for (const item of graph.bySubject.get('math') ?? []) fillTopic(item.id);
    for (let index = 0; index < 12; index += 1) answer(true);

    expect(nextTriageTask(db, graph, runId, { subject: 'math' })).toEqual({
      status: 'done',
      total: 12,
      target: 12,
    });
  });
});
