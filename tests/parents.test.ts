import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../server/db.js';
import { buildTopicGraph, syncTopicState, type Topic, type TopicGraph } from '../server/curriculum.js';
import {
  readParentsDashboard,
  readParentsRunDetail,
  PARENTS_PLANNED_MINUTES,
} from '../server/parents.js';

const NOW = new Date('2026-08-08T12:00:00.000Z');
const databases: Database[] = [];
const dirs: string[] = [];

function topic(id: string, subject: Topic['subject'], title: string, weight = 2): Topic {
  return { id, subject, title, examWeight: weight, difficulty: 2, prereqs: [], answerFormat: 'text', promptSeed: title };
}

function setup(topics: Topic[] = [
  topic('math.fractions', 'math', 'Дроби', 3),
  topic('math.percent', 'math', 'Проценты', 2),
  topic('russian.not', 'russian', 'НЕ с разными частями речи', 3),
  topic('english.zero', 'english', 'Zero weight', 0),
]): { db: Database; graph: TopicGraph } {
  const dir = mkdtempSync(join(tmpdir(), 'edukator-parents-'));
  dirs.push(dir);
  const db = openDatabase(join(dir, 'parents.db'));
  databases.push(db);
  const graph = buildTopicGraph(topics);
  syncTopicState(db, graph);
  return { db, graph };
}

function task(db: Database, topicId: string): number {
  return Number(db.prepare(
    "INSERT INTO task_bank (topic_id, question, answer, difficulty, status) VALUES (?, 'q', 'a', 2, 'used')",
  ).run(topicId).lastInsertRowid);
}

function run(db: Database, subject: Topic['subject'], topicId: string, kind: 'run' | 'triage' | 'boss' | 'lesson',
  startedAt: string, finishedAt: string, total = 1, correct = 1): number {
  return Number(db.prepare(
    `INSERT INTO runs
       (subject, kind, topic_id, started_at, finished_at, summary, total, correct)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    subject, kind, topicId, startedAt, finishedAt,
    kind === 'boss' ? null : '{}', total, correct,
  ).lastInsertRowid);
}

function attempt(db: Database, topicId: string, at: string, durationMs: number, runId: number | null = null): number {
  const taskId = task(db, topicId);
  db.prepare(
    `INSERT INTO attempts (task_id, topic_id, run_id, answer, is_correct, duration_ms, created_at)
     VALUES (?, ?, ?, 'a', 1, ?, ?)`,
  ).run(taskId, topicId, runId, durationMs, at);
  return taskId;
}

function snapshot(db: Database, subject: Topic['subject'], score: number, band: number, at: string): void {
  db.prepare('INSERT INTO forecast_snapshots (subject, score, band, created_at) VALUES (?, ?, ?, ?)')
    .run(subject, score, band, at);
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
  while (dirs.length > 0) rmSync(dirs.pop() ?? '', { recursive: true, force: true });
});

describe('readParentsDashboard', () => {
  it('возвращает один полный пустой снимок с явным семисуточным окном', () => {
    const { db, graph } = setup();
    const result = readParentsDashboard(db, graph, NOW);

    expect(PARENTS_PLANNED_MINUTES).toBe(630);
    expect(result).toMatchObject({
      generatedAt: '2026-08-08T12:00:00.000Z',
      window: { since: '2026-08-01T12:00:00.000Z', until: '2026-08-08T12:00:00.000Z' },
      time: { plannedMinutes: 630, actualMinutes: 0, daily: [] },
      gaps: [], activity: [],
      flags: { threeFullDaysWithoutRun: true, forecastNotGrowing: [] },
    });
    expect(result.forecasts.map((item) => item.subject)).toEqual(['math', 'russian']);
    expect(result.forecasts.every((item) => item.currentSnapshot === undefined && item.delta === undefined)).toBe(true);
  });

  it('возвращает live-прогноз, текущий снимок и delta от ближайшей точки на/до начала окна', () => {
    const { db, graph } = setup();
    db.prepare(
      `UPDATE topic_state SET mastery = .6, confidence = .8, attempts = 4,
       last_seen = '2026-08-08T10:00:00.000Z' WHERE topic_id LIKE 'math.%'`,
    ).run();
    snapshot(db, 'math', 3, 0.8, '2026-07-31T12:00:00.000Z');
    snapshot(db, 'math', 3.5, 0.4, '2026-08-01T12:00:00.000Z');
    snapshot(db, 'math', 3.8, 0.2, '2026-08-07T12:00:00.000Z');

    const forecast = readParentsDashboard(db, graph, NOW).forecasts[0];
    expect(forecast).toMatchObject({
      subject: 'math', score: 4, currentSnapshot: {
        score: 3.8, band: 0.2, createdAt: '2026-08-07T12:00:00.000Z',
      },
    });
    expect(forecast?.delta).toBeCloseTo(0.5, 10);
    expect(forecast?.low).toBeLessThan(forecast?.score ?? 0);
    expect(forecast?.high).toBeGreaterThan(forecast?.score ?? 0);
  });

  it('не подменяет отсутствующую старую точку нулевым delta', () => {
    const { db, graph } = setup();
    snapshot(db, 'math', 3.5, 0.3, '2026-08-03T12:00:00.000Z');
    expect(readParentsDashboard(db, graph, NOW).forecasts[0]).not.toHaveProperty('delta');
  });

  it('считает только duration_ms внутри обеих включённых границ и разбивает по московским дням', () => {
    const { db, graph } = setup();
    attempt(db, 'math.fractions', '2026-08-01T11:59:59.999Z', 600_000);
    attempt(db, 'math.fractions', '2026-08-01T12:00:00.000Z', 60_000);
    attempt(db, 'math.fractions', '2026-08-07T20:59:59.999Z', 120_000);
    attempt(db, 'math.fractions', '2026-08-07T21:00:00.000Z', 180_000);
    attempt(db, 'math.fractions', '2026-08-08T12:00:00.000Z', 240_000);
    attempt(db, 'math.fractions', '2026-08-08T12:00:00.001Z', 600_000);

    expect(readParentsDashboard(db, graph, NOW).time).toEqual({
      plannedMinutes: 630,
      actualMinutes: 10,
      daily: [
        { date: '2026-08-01', minutes: 1 },
        { date: '2026-08-07', minutes: 2 },
        { date: '2026-08-08', minutes: 7 },
      ],
    });
  });

  it('согласует округление суточных столбцов с общим временем на долях минуты', () => {
    const { db, graph } = setup();
    attempt(db, 'math.fractions', '2026-08-06T10:00:00.000Z', 299);
    attempt(db, 'math.fractions', '2026-08-07T10:00:00.000Z', 299);

    const time = readParentsDashboard(db, graph, NOW).time;
    expect(time).toEqual({
      plannedMinutes: 630,
      actualMinutes: 0.01,
      daily: [
        { date: '2026-08-06', minutes: 0.01 },
        { date: '2026-08-07', minutes: 0 },
      ],
    });
    expect(time.daily.reduce((sum, day) => sum + day.minutes, 0)).toBe(time.actualMinutes);
  });

  it('ранжирует только проверенные темы с confidence и не раскрывает topic_id', () => {
    const topics = Array.from({ length: 7 }, (_, index) =>
      topic(`math.t${index}`, 'math', `Тема ${index}`, index === 6 ? 0 : 3 - (index % 3)));
    const { db, graph } = setup(topics);
    for (let index = 0; index < 6; index += 1) {
      db.prepare(
        `UPDATE topic_state SET mastery = ?, confidence = .8, attempts = 3,
         last_seen = '2026-08-08T10:00:00.000Z' WHERE topic_id = ?`,
      ).run(index / 10, `math.t${index}`);
    }

    const gaps = readParentsDashboard(db, graph, NOW).gaps;
    expect(gaps).toHaveLength(5);
    expect(gaps.map((gap) => gap.title)).toEqual(['Тема 0', 'Тема 3', 'Тема 1', 'Тема 4', 'Тема 2']);
    expect(gaps[0]).toEqual({ title: 'Тема 0', subject: 'math' });
    expect(JSON.stringify(gaps)).not.toContain('topicId');
  });

  it('строит стабильную ленту всех видов, активное время и исход босса', () => {
    const { db, graph } = setup();
    const first = run(db, 'math', 'math.fractions', 'run', '2026-08-07T09:00:00.000Z', '2026-08-07T10:00:00.000Z', 2, 1);
    const second = run(db, 'russian', 'russian.not', 'triage', '2026-08-07T09:30:00.000Z', '2026-08-07T10:00:00.000Z');
    const boss = run(db, 'math', 'math.fractions', 'boss', '2026-08-08T09:00:00.000Z', '2026-08-08T10:00:00.000Z', 1, 0);
    const lesson = run(db, 'math', 'math.fractions', 'lesson', '2026-08-08T10:15:00.000Z', '2026-08-08T10:30:00.000Z', 5, 4);
    db.prepare("INSERT INTO boss_batches (topic_id, run_id, status, finished_at) VALUES (?, ?, 'lost', ?)")
      .run('math.fractions', boss, '2026-08-08T10:00:00.000Z');
    const retriedTask = attempt(
      db, 'math.fractions', '2026-08-07T09:45:00.000Z', 90_000, first,
    );
    db.prepare('UPDATE attempts SET is_current = 0 WHERE task_id = ?').run(retriedTask);
    db.prepare(
      `INSERT INTO attempts
        (task_id, topic_id, run_id, answer, is_correct, duration_ms, created_at)
       VALUES (?, 'math.fractions', ?, 'a', 1, 30000, '2026-08-07T09:46:00.000Z')`,
    ).run(retriedTask, first);
    attempt(db, 'russian.not', '2026-08-07T09:45:00.000Z', 30_000, second);
    attempt(db, 'math.fractions', '2026-08-08T09:45:00.000Z', 45_000, boss);
    attempt(db, 'math.fractions', '2026-08-08T10:20:00.000Z', 120_000, lesson);

    const dashboard = readParentsDashboard(db, graph, NOW);
    expect(dashboard.time.actualMinutes).toBe(5.25);
    expect(dashboard.activity).toEqual([
      expect.objectContaining({ kind: 'lesson', activeMinutes: 2, total: 5, correct: 4 }),
      expect.objectContaining({ kind: 'boss', bossOutcome: 'lost', activeMinutes: 0.75 }),
      expect.objectContaining({ kind: 'triage', activeMinutes: 0.5 }),
      expect.objectContaining({ kind: 'run', activeMinutes: 2 }),
    ]);
  });

  it('учитывает в общем времени только ответы lesson-run, без времени чтения', () => {
    const { db, graph } = setup();
    const lesson = run(
      db, 'math', 'math.fractions', 'lesson',
      '2026-08-08T09:00:00.000Z', '2026-08-08T09:20:00.000Z', 5, 4,
    );
    attempt(db, 'math.fractions', '2026-08-08T09:10:00.000Z', 90_000, lesson);

    const dashboard = readParentsDashboard(db, graph, NOW);
    expect(dashboard.time.actualMinutes).toBe(1.5);
    expect(dashboard.activity).toEqual([
      expect.objectContaining({ kind: 'lesson', activeMinutes: 1.5 }),
    ]);
  });

  it('возвращает полную историю занятия с заданиями, исправлениями и суммарным временем', () => {
    const { db, graph } = setup();
    const lesson = run(
      db, 'math', 'math.fractions', 'lesson',
      '2026-08-08T09:00:00.000Z', '2026-08-08T09:20:00.000Z', 1, 1,
    );
    const taskId = Number(db.prepare(
      `INSERT INTO task_bank
        (topic_id, question, instruction, material, material_format, choices,
         answer, hint, explain, difficulty, status)
       VALUES ('math.fractions', 'Полная формулировка', 'Выбери дробь', '\\frac{2}{3}',
               'math', '["2/3","3/5"]', '2/3', 'Сравни знаменатели',
               'Приведи к общему знаменателю', 2, 'used')`,
    ).run().lastInsertRowid);
    db.prepare(
      `INSERT INTO attempts
        (task_id, topic_id, run_id, answer, is_correct, hint_used, duration_ms, is_current, created_at)
       VALUES (?, 'math.fractions', ?, '3/5', 0, 1, 61000, 0, '2026-08-08T09:05:00.000Z'),
              (?, 'math.fractions', ?, '2/3', 1, 0, 35000, 1, '2026-08-08T09:06:00.000Z')`,
    ).run(taskId, lesson, taskId, lesson);

    expect(readParentsRunDetail(db, graph, lesson, NOW)).toEqual({
      runId: lesson,
      kind: 'lesson',
      subject: 'math',
      startedAt: '2026-08-08T09:00:00.000Z',
      finishedAt: '2026-08-08T09:20:00.000Z',
      total: 1,
      correct: 1,
      activeMilliseconds: 96_000,
      attempts: [
        expect.objectContaining({
          number: 1,
          topicTitle: 'Дроби',
          answerFormat: 'text',
          question: 'Полная формулировка',
          instruction: 'Выбери дробь',
          material: '\\frac{2}{3}',
          materialFormat: 'math',
          choices: ['2/3', '3/5'],
          studentAnswer: '3/5',
          correctAnswer: '2/3',
          explanation: 'Приведи к общему знаменателю',
          hint: 'Сравни знаменатели',
          correct: false,
          correction: false,
          durationMilliseconds: 61_000,
        }),
        expect.objectContaining({
          number: 2,
          studentAnswer: '2/3',
          correct: true,
          correction: true,
          durationMilliseconds: 35_000,
        }),
      ],
    });
  });

  it('не раскрывает незавершённые и вышедшие из недельного окна занятия', () => {
    const { db, graph } = setup();
    const old = run(
      db, 'math', 'math.fractions', 'run',
      '2026-07-31T09:00:00.000Z', '2026-07-31T09:20:00.000Z',
    );
    const unfinished = run(
      db, 'math', 'math.fractions', 'run',
      '2026-08-08T09:00:00.000Z', '2026-08-08T09:20:00.000Z',
    );
    db.prepare('UPDATE runs SET finished_at = NULL, summary = NULL WHERE id = ?').run(unfinished);

    expect(readParentsRunDetail(db, graph, old, NOW)).toBeNull();
    expect(readParentsRunDetail(db, graph, unfinished, NOW)).toBeNull();
    expect(readParentsRunDetail(db, graph, 999, NOW)).toBeNull();
  });

  it('показывает полное активное время завершённого в окне забега', () => {
    const { db, graph } = setup();
    const completed = run(
      db, 'math', 'math.fractions', 'run',
      '2026-08-01T11:00:00.000Z', '2026-08-01T12:30:00.000Z', 2, 2,
    );
    attempt(db, 'math.fractions', '2026-08-01T11:30:00.000Z', 45_000, completed);
    attempt(db, 'math.fractions', '2026-08-01T12:15:00.000Z', 30_000, completed);

    const dashboard = readParentsDashboard(db, graph, NOW);
    expect(dashboard.time.actualMinutes).toBe(0.5);
    expect(dashboard.activity).toEqual([
      expect.objectContaining({ kind: 'run', activeMinutes: 1.25 }),
    ]);
  });

  it('ставит флаг только после трёх полных московских дней без обычного run', () => {
    const { db, graph } = setup();
    run(db, 'math', 'math.fractions', 'triage', '2026-08-07T10:00:00.000Z', '2026-08-07T11:00:00.000Z');
    const boss = run(db, 'math', 'math.fractions', 'boss', '2026-08-06T10:00:00.000Z', '2026-08-06T11:00:00.000Z');
    db.prepare("INSERT INTO boss_batches (topic_id, run_id, status, finished_at) VALUES (?, ?, 'won', ?)")
      .run('math.fractions', boss, '2026-08-06T11:00:00.000Z');
    expect(readParentsDashboard(db, graph, NOW).flags.threeFullDaysWithoutRun).toBe(true);

    run(db, 'math', 'math.fractions', 'run', '2026-08-05T20:00:00.000Z', '2026-08-05T21:00:00.000Z');
    expect(readParentsDashboard(db, graph, NOW).flags.threeFullDaysWithoutRun).toBe(false);
  });

  it('не считает брошенный автозакрытый run обычным занятием', () => {
    const { db, graph } = setup();
    snapshot(db, 'math', 3.6, 0.3, '2026-08-03T12:00:00.000Z');
    snapshot(db, 'math', 3.5, 0.2, '2026-08-08T11:00:00.000Z');
    const abandoned = run(
      db, 'math', 'math.fractions', 'run',
      '2026-08-05T09:00:00.000Z', '2026-08-05T09:00:00.000Z', 0, 0,
    );
    db.prepare('UPDATE runs SET summary = NULL WHERE id = ?').run(abandoned);
    const abandonedTriage = run(
      db, 'russian', 'russian.not', 'triage',
      '2026-08-06T09:00:00.000Z', '2026-08-06T09:00:00.000Z', 0, 0,
    );
    db.prepare('UPDATE runs SET summary = NULL WHERE id = ?').run(abandonedTriage);

    const dashboard = readParentsDashboard(db, graph, NOW);
    expect(dashboard.flags).toMatchObject({
      threeFullDaysWithoutRun: true,
      forecastNotGrowing: [],
    });
    expect(dashboard.activity).toEqual([]);
  });

  it('ставит пятисуточный флаг только с обычным занятием и двумя достаточными снимками', () => {
    const { db, graph } = setup();
    snapshot(db, 'math', 3.6, 0.3, '2026-08-03T12:00:00.000Z');
    snapshot(db, 'math', 3.5, 0.2, '2026-08-08T11:00:00.000Z');
    expect(readParentsDashboard(db, graph, NOW).flags.forecastNotGrowing).toEqual([]);

    run(db, 'math', 'math.fractions', 'run', '2026-08-07T09:00:00.000Z', '2026-08-07T10:00:00.000Z');
    expect(readParentsDashboard(db, graph, NOW).flags.forecastNotGrowing).toEqual(['math']);
  });

  it('предлагает снизить нагрузку только если нижняя граница достигла 4.0', () => {
    const { db, graph } = setup();
    db.prepare(
      `UPDATE topic_state SET mastery = .615, confidence = .8, attempts = 7,
       last_seen = '2026-08-08T12:00:00.000Z' WHERE topic_id LIKE 'math.%'`,
    ).run();
    expect(readParentsDashboard(db, graph, NOW).forecasts[0]?.score).toBeCloseTo(4.075, 10);
    expect(readParentsDashboard(db, graph, NOW).flags.reduceLoad).not.toContain('math');

    db.prepare("UPDATE topic_state SET confidence = 1, attempts = 100 WHERE topic_id LIKE 'math.%'").run();
    expect(readParentsDashboard(db, graph, NOW).flags.reduceLoad).toContain('math');
  });

  it('не выдаёт неполный отчёт при повреждённой истории или неизвестном kind', () => {
    const { db, graph } = setup();
    db.pragma('ignore_check_constraints = ON');
    db.prepare(
      `INSERT INTO runs (subject, kind, topic_id, started_at, finished_at)
       VALUES ('math', 'exam', 'math.fractions', '2026-08-07T10:00:00.000Z', '2026-08-07T11:00:00.000Z')`,
    ).run();
    expect(() => readParentsDashboard(db, graph, NOW)).toThrow(/неизвестный kind/);
    db.prepare("DELETE FROM runs WHERE kind = 'exam'").run();
    db.prepare(
      `INSERT INTO runs (subject, kind, topic_id, started_at, finished_at)
       VALUES ('math', 'run', 'math.fractions', 'not-a-date', 'also-not-a-date')`,
    ).run();
    expect(() => readParentsDashboard(db, graph, NOW)).toThrow(/повреждённое время/);
  });
});
