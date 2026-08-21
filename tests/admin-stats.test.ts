import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3, { type Database } from 'better-sqlite3';
import {
  childDatabasePath,
  createChild,
  createParent,
  markChildReady,
  openControlDatabase,
  reserveCodexCall,
  retireChild,
  setParentPassword,
} from '../server/control-db.js';
import { controlDatabasePath, ensureDataDir } from '../server/data-dir.js';
import { buildTopicGraph, syncTopicState, type Topic, type TopicGraph } from '../server/curriculum.js';
import { SCHEMA_VERSION, openDatabase } from '../server/db.js';
import {
  ADMIN_STATS_TTL_MS,
  AdminStatsCache,
  CHURN_SILENCE_DAYS,
  WORST_TOPICS_LIMIT,
  WORST_TOPIC_MIN_ANSWERS,
  collectAdminStats,
  type AdminStats,
} from '../server/admin/stats.js';

const NOW = new Date('2026-08-21T09:00:00.000Z');
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const PARENT_PASSWORD = 'пароль-родителя';

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

function topic(id: string, subject: 'math' | 'russian' = 'math'): Topic {
  return {
    id,
    subject,
    title: `Тема ${id}`,
    examWeight: 3,
    difficulty: 2,
    prereqs: [],
    answerFormat: 'number',
    promptSeed: `Спрашивай по теме ${id}.`,
  };
}

const GRAPH: TopicGraph = buildTopicGraph([
  topic('math.a'),
  topic('math.b'),
  topic('russian.a', 'russian'),
]);

describe('слой 2 статистики оператора', () => {
  let dir: string;
  let control: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'edukator-admin-stats-'));
    ensureDataDir(dir);
    control = openControlDatabase(controlDatabasePath(dir));
  });

  afterEach(() => {
    control.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function parent(email: string, at: Date = NOW): string {
    const id = createParent(control, email, at);
    setParentPassword(control, id, PARENT_PASSWORD, at);
    return id;
  }

  /** Ребёнок с настоящей базой нынешней схемы и синхронизированной картой тем. */
  function child(parentId: string, name: string, at: Date = NOW): string {
    const id = createChild(control, parentId, name, at);
    const db = openDatabase(childDatabasePath(dir, id));
    try {
      syncTopicState(db, GRAPH);
    } finally {
      db.close();
    }
    markChildReady(control, id);
    return id;
  }

  /** Открывает базу ребёнка на запись: посев идёт мимо доменных модулей. */
  function seed(childId: string, fill: (db: Database) => void): void {
    const db = openDatabase(childDatabasePath(dir, childId));
    try {
      fill(db);
      db.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
  }

  /** Задание банка. Текст намеренно приметный: по нему видно утечку содержания. */
  function addTask(
    db: Database,
    topicId: string,
    status: string,
    createdAt: string,
    question = 'СЕКРЕТНАЯ-ФОРМУЛИРОВКА',
  ): number {
    const info = db
      .prepare(
        `INSERT INTO task_bank (topic_id, question, answer, difficulty, status, fingerprint, created_at)
         VALUES (?, ?, '42', 2, ?, ?, ?)`,
      )
      .run(topicId, question, status, `${topicId}-${createdAt}-${status}-${question}`, createdAt);
    return Number(info.lastInsertRowid);
  }

  function addRun(
    db: Database,
    topicId: string,
    finishedAt: string | null,
    kind: 'run' | 'triage' | 'boss' | 'lesson' = 'run',
  ): number {
    const subject = GRAPH.byId.get(topicId)?.subject ?? 'math';
    const info = db
      .prepare(
        `INSERT INTO runs (subject, kind, topic_id, started_at, finished_at, summary)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        subject,
        kind,
        topicId,
        finishedAt ?? NOW.toISOString(),
        finishedAt,
        finishedAt === null ? null : '{}',
      );
    return Number(info.lastInsertRowid);
  }

  function addAttempt(
    db: Database,
    options: {
      taskId: number;
      topicId: string;
      runId: number;
      correct: boolean;
      createdAt: string;
      durationMs?: number;
      isCurrent?: boolean;
    },
  ): number {
    const info = db
      .prepare(
        `INSERT INTO attempts
           (task_id, topic_id, run_id, answer, is_correct, duration_ms, is_current, created_at)
         VALUES (?, ?, ?, 'ОТВЕТ-РЕБЁНКА', ?, ?, ?, ?)`,
      )
      .run(
        options.taskId,
        options.topicId,
        options.runId,
        options.correct ? 1 : 0,
        options.durationMs ?? 0,
        options.isCurrent === false ? 0 : 1,
        options.createdAt,
      );
    return Number(info.lastInsertRowid);
  }

  function stats(now: Date = NOW): AdminStats {
    return collectAdminStats(control, { dataDir: dir, graph: GRAPH, now });
  }

  it('держит калибровочные константы спеки', () => {
    expect(ADMIN_STATS_TTL_MS).toBe(300_000);
    expect(CHURN_SILENCE_DAYS).toBe(14);
    expect(WORST_TOPICS_LIMIT).toBe(10);
    expect(WORST_TOPIC_MIN_ANSWERS).toBe(5);
  });

  it('считает вовлечённость по нескольким базам сразу', () => {
    const родитель = parent('родитель@example.com', ago(60 * DAY));
    const сегодня = child(родитель, 'Сегодняшний', ago(60 * DAY));
    const наделе = child(родитель, 'Недельный', ago(60 * DAY));
    const давний = child(родитель, 'Давний', ago(60 * DAY));

    seed(сегодня, (db) => {
      const task = addTask(db, 'math.a', 'used', ago(2 * MINUTE).toISOString());
      const run = addRun(db, 'math.a', ago(MINUTE).toISOString());
      addAttempt(db, {
        taskId: task,
        topicId: 'math.a',
        runId: run,
        correct: true,
        createdAt: ago(MINUTE).toISOString(),
        durationMs: 30_000,
      });
    });
    seed(наделе, (db) => {
      const task = addTask(db, 'math.a', 'used', ago(3 * DAY).toISOString());
      const run = addRun(db, 'math.a', ago(3 * DAY).toISOString());
      addAttempt(db, {
        taskId: task,
        topicId: 'math.a',
        runId: run,
        correct: false,
        createdAt: ago(3 * DAY).toISOString(),
        durationMs: 12_000,
      });
    });
    seed(давний, (db) => {
      const task = addTask(db, 'math.a', 'used', ago(40 * DAY).toISOString());
      const run = addRun(db, 'math.a', ago(40 * DAY).toISOString());
      addAttempt(db, {
        taskId: task,
        topicId: 'math.a',
        runId: run,
        correct: true,
        createdAt: ago(40 * DAY).toISOString(),
        durationMs: 5_000,
      });
    });

    const report = stats();
    expect(report.engagement.activeToday).toBe(1);
    expect(report.engagement.active7Days).toBe(2);
    expect(report.engagement.active30Days).toBe(2);
    expect(report.engagement.activeMsTotal).toBe(47_000);
    expect(report.engagement.activeMs7Days).toBe(42_000);
    expect(report.children).toHaveLength(3);
    expect(report.failed).toEqual([]);
    expect(report.stale).toEqual([]);
  });

  it('раскладывает ушедших по неделям от заведения', () => {
    const родитель = parent('родитель@example.com', ago(90 * DAY));
    const молчун = child(родитель, 'Не начал', ago(30 * DAY));
    const продержался = child(родитель, 'Продержался', ago(60 * DAY));
    const живой = child(родитель, 'Живой', ago(60 * DAY));

    seed(продержался, (db) => {
      const task = addTask(db, 'math.a', 'used', ago(40 * DAY).toISOString());
      const run = addRun(db, 'math.a', ago(40 * DAY).toISOString());
      // Последняя попытка через двадцать дней после заведения: третья неделя.
      addAttempt(db, {
        taskId: task,
        topicId: 'math.a',
        runId: run,
        correct: true,
        createdAt: ago(40 * DAY).toISOString(),
      });
    });
    seed(живой, (db) => {
      const task = addTask(db, 'math.a', 'used', ago(MINUTE).toISOString());
      const run = addRun(db, 'math.a', ago(MINUTE).toISOString());
      addAttempt(db, {
        taskId: task,
        topicId: 'math.a',
        runId: run,
        correct: true,
        createdAt: ago(MINUTE).toISOString(),
      });
    });

    const report = stats();
    expect(report.engagement.churned).toBe(2);
    expect(report.engagement.churnByWeek).toEqual([
      { week: 0, children: 1 },
      { week: 2, children: 1 },
    ]);
    expect(report.children.find((row) => row.childId === молчун)?.lastAttemptAt).toBeUndefined();
  });

  it('не записывает в ушедшие того, кого только что завели', () => {
    const родитель = parent('родитель@example.com', ago(MINUTE));
    // Ни одного ответа — но и молчания ещё нет: ребёнок заведён минуту назад.
    // Без окна, отмеряемого от заведения, вся сегодняшняя когорта попадала бы в
    // «отвалившиеся» в ту же минуту, и число, по которому судят как раз о первом
    // занятии, росло бы от удачных регистраций.
    child(родитель, 'Только завели', ago(MINUTE));
    // А молчащий дольше двух недель — попадает: окно у обоих одно.
    child(родитель, 'Молчит с весны', ago(CHURN_SILENCE_DAYS * DAY + DAY));

    const report = stats();
    expect(report.engagement.churned).toBe(1);
    expect(report.engagement.churnByWeek).toEqual([{ week: 0, children: 1 }]);
  });

  it('собирает учебную картину: забеги, точность, mastery, боссы, споры и integrity', () => {
    const родитель = parent('родитель@example.com');
    const первый = child(родитель, 'Первый');
    const второй = child(родитель, 'Второй');

    seed(первый, (db) => {
      const run = addRun(db, 'math.a', ago(MINUTE).toISOString());
      const верный = addTask(db, 'math.a', 'used', ago(2 * MINUTE).toISOString(), 'первый');
      const неверный = addTask(db, 'math.a', 'used', ago(2 * MINUTE).toISOString(), 'второй');
      addAttempt(db, {
        taskId: верный,
        topicId: 'math.a',
        runId: run,
        correct: true,
        createdAt: ago(MINUTE).toISOString(),
      });
      const промах = addAttempt(db, {
        taskId: неверный,
        topicId: 'math.a',
        runId: run,
        correct: false,
        createdAt: ago(MINUTE).toISOString(),
      });
      db.prepare('UPDATE topic_state SET mastery = 0.6, attempts = 2 WHERE topic_id = ?')
        .run('math.a');
      db.prepare(
        `INSERT INTO disputes (attempt_id, status, resolution)
         VALUES (?, 'upheld', 'СЕКРЕТНЫЙ-ВЕРДИКТ')`,
      ).run(промах);
      db.prepare(
        `INSERT INTO boss_batches (topic_id, status, activated_at, finished_at)
         VALUES ('math.a', 'won', ?, ?)`,
      ).run(ago(2 * DAY).toISOString(), ago(2 * DAY).toISOString());
      db.prepare(
        `INSERT INTO integrity_reviews (run_id, status) VALUES (?, 'needs_retry')`,
      ).run(run);
      db.prepare(
        `INSERT INTO integrity_items (run_id, task_id, attempt_id, status)
         VALUES (?, ?, ?, 'retry_required')`,
      ).run(run, неверный, промах);
    });

    seed(второй, (db) => {
      const run = addRun(db, 'russian.a', ago(MINUTE).toISOString());
      const задание = addTask(db, 'russian.a', 'used', ago(2 * MINUTE).toISOString(), 'русский');
      addAttempt(db, {
        taskId: задание,
        topicId: 'russian.a',
        runId: run,
        correct: true,
        createdAt: ago(MINUTE).toISOString(),
      });
      db.prepare('UPDATE topic_state SET mastery = 0.4, attempts = 1 WHERE topic_id = ?')
        .run('russian.a');
      db.prepare(
        `INSERT INTO boss_batches (topic_id, status) VALUES ('russian.a', 'preparing')`,
      ).run();
      db.prepare(
        `INSERT INTO disputes (attempt_id, status) VALUES (1, 'open')`,
      ).run();
    });

    const report = stats();
    expect(report.learning.finishedRuns).toBe(2);
    expect(report.learning.answers).toBe(3);
    expect(report.learning.correct).toBe(2);
    expect(report.learning.accuracy).toBeCloseTo(2 / 3, 10);
    expect(report.learning.mastery).toEqual([
      { subject: 'math', average: 0.6, topics: 1, children: 1 },
      { subject: 'russian', average: 0.4, topics: 1, children: 1 },
    ]);
    expect(report.learning.boss).toEqual({ won: 1, lost: 0, failed: 0, live: 1 });
    expect(report.learning.integrity).toEqual({ reviews: 1, needsRetry: 1, retryItems: 1 });
    // Доля выигранных считается от решённых, а не от всех: открытый спор ещё
    // не проигран, и с `total` в знаменателе цифра падала бы от самой длины
    // очереди — «проверяющий ошибается в половине случаев» там, где ни одного
    // вердикта против ребёнка не было.
    expect(report.learning.disputes).toEqual({
      total: 2,
      upheld: 1,
      rejected: 0,
      open: 1,
      upheldShare: 1,
    });
  });

  it('оставляет точность и долю споров пустыми, пока считать нечего', () => {
    const родитель = parent('родитель@example.com');
    child(родитель, 'Никакой');

    const report = stats();
    expect(report.learning.accuracy).toBeUndefined();
    expect(report.learning.disputes.upheldShare).toBeUndefined();
    expect(report.content.callsPerTask).toBeUndefined();
  });

  it('считает качество контента: расход вызовов против прироста банка и худшие темы', () => {
    const родитель = parent('родитель@example.com');
    const первый = child(родитель, 'Первый');
    const второй = child(родитель, 'Второй');
    reserveCodexCall(control, первый, NOW);
    reserveCodexCall(control, первый, NOW);
    reserveCodexCall(control, второй, NOW);

    seed(первый, (db) => {
      addTask(db, 'math.a', 'valid', NOW.toISOString(), 'свежее-1');
      addTask(db, 'math.a', 'valid', NOW.toISOString(), 'свежее-2');
      addTask(db, 'math.b', 'used', ago(10 * DAY).toISOString(), 'старое');
      const run = addRun(db, 'math.b', ago(MINUTE).toISOString());
      // Пять ответов подряд мимо: тема набирает порог и уходит в худшие.
      for (let index = 0; index < 5; index += 1) {
        const task = addTask(db, 'math.b', 'used', ago(10 * DAY).toISOString(), `мимо-${index}`);
        addAttempt(db, {
          taskId: task,
          topicId: 'math.b',
          runId: run,
          correct: false,
          createdAt: ago(MINUTE).toISOString(),
        });
      }
      // Одна тема с единственным промахом: точность нулевая, но порога нет.
      const редкая = addTask(db, 'math.a', 'used', ago(DAY).toISOString(), 'редкая');
      addAttempt(db, {
        taskId: редкая,
        topicId: 'math.a',
        runId: run,
        correct: false,
        createdAt: ago(MINUTE).toISOString(),
      });
      db.prepare('UPDATE topic_state SET attempts = 5 WHERE topic_id = ?').run('math.b');
    });
    seed(второй, (db) => {
      addTask(db, 'russian.a', 'valid', NOW.toISOString(), 'свежее-3');
    });

    const report = stats();
    expect(report.content.codexCalls).toBe(3);
    expect(report.content.tasksAdded).toBe(3);
    expect(report.content.callsPerTask).toBe(1);
    expect(report.content.worstTopics).toEqual([
      { topicId: 'math.b', answers: 5, correct: 0, accuracy: 0 },
    ]);
    // Тема без годных заданий, которой занимались, попадает в пустые банки.
    expect(report.content.emptyBanks).toEqual([{ topicId: 'math.b', children: 1 }]);
  });

  it('не читает содержания: ни формулировок, ни ответов, ни вердиктов', () => {
    const родитель = parent('родитель@example.com');
    const ребёнок = child(родитель, 'Ребёнок');
    seed(ребёнок, (db) => {
      const run = addRun(db, 'math.a', ago(MINUTE).toISOString());
      const task = addTask(db, 'math.a', 'used', ago(2 * MINUTE).toISOString());
      const attempt = addAttempt(db, {
        taskId: task,
        topicId: 'math.a',
        runId: run,
        correct: false,
        createdAt: ago(MINUTE).toISOString(),
      });
      db.prepare(
        `INSERT INTO disputes (attempt_id, status, resolution)
         VALUES (?, 'rejected', 'СЕКРЕТНЫЙ-ВЕРДИКТ')`,
      ).run(attempt);
    });

    const dump = JSON.stringify(stats());
    expect(dump).not.toContain('СЕКРЕТНАЯ-ФОРМУЛИРОВКА');
    expect(dump).not.toContain('ОТВЕТ-РЕБЁНКА');
    expect(dump).not.toContain('СЕКРЕТНЫЙ-ВЕРДИКТ');
  });

  it('обходит незаведённых, выведенных, битые базы и базы старой схемы', () => {
    const родитель = parent('родитель@example.com');
    const здоровый = child(родитель, 'Здоровый');
    seed(здоровый, (db) => {
      const run = addRun(db, 'math.a', ago(MINUTE).toISOString());
      const task = addTask(db, 'math.a', 'used', ago(2 * MINUTE).toISOString());
      addAttempt(db, {
        taskId: task,
        topicId: 'math.a',
        runId: run,
        correct: true,
        createdAt: ago(MINUTE).toISOString(),
      });
    });

    // Заведение застряло час назад: базы у него нет вовсе.
    const застрявший = createChild(control, родитель, 'Застрявший', ago(2 * DAY));
    const выведенный = child(родитель, 'Выведенный');
    retireChild(control, выведенный, NOW);
    const битый = child(родитель, 'Битый');
    writeFileSync(childDatabasePath(dir, битый), 'это не база SQLite');
    const старый = child(родитель, 'Старая схема');
    const старыйПуть = childDatabasePath(dir, старый);
    const raw = new BetterSqlite3(старыйПуть);
    raw.pragma(`user_version = ${SCHEMA_VERSION - 1}`);
    raw.close();
    const before = statSync(старыйПуть);

    const report = stats();
    expect(report.children.map((row) => row.childId)).toEqual([здоровый]);
    expect(report.skipped).toEqual([
      { childId: застрявший, reason: 'provisioning' },
      { childId: выведенный, reason: 'retired' },
    ]);
    expect(report.failed.map((row) => row.childId)).toEqual([битый]);
    expect(report.stale.map((row) => ({ childId: row.childId, schemaVersion: row.schemaVersion })))
      .toEqual([{ childId: старый, schemaVersion: SCHEMA_VERSION - 1 }]);
    // База старой схемы не мигрируется отчётом: её не трогали вовсе.
    expect(statSync(старыйПуть).mtimeMs).toBe(before.mtimeMs);
    expect(report.engagement.activeToday).toBe(1);
  });

  it('отвечает и без единого ребёнка', () => {
    parent('родитель@example.com');

    const report = stats();
    expect(report.children).toEqual([]);
    expect(report.engagement.activeToday).toBe(0);
    expect(report.learning.finishedRuns).toBe(0);
    expect(report.content.emptyBanks).toEqual([]);
    expect(report.generatedAt).toBe(NOW.toISOString());
    expect(report.day).toBe('2026-08-21');
  });
});

describe('кеш статистики оператора', () => {
  let dir: string;
  let control: Database;
  let childId: string;
  let now: Date;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'edukator-admin-stats-cache-'));
    ensureDataDir(dir);
    control = openControlDatabase(controlDatabasePath(dir));
    const parentId = createParent(control, 'родитель@example.com', NOW);
    setParentPassword(control, parentId, PARENT_PASSWORD, NOW);
    childId = createChild(control, parentId, 'Ребёнок', NOW);
    const db = openDatabase(childDatabasePath(dir, childId));
    try {
      syncTopicState(db, GRAPH);
      db.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
    markChildReady(control, childId);
    now = NOW;
  });

  afterEach(() => {
    control.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function cache(ttlMs?: number): AdminStatsCache {
    return new AdminStatsCache({
      control,
      dataDir: dir,
      graph: GRAPH,
      ...(ttlMs === undefined ? {} : { ttlMs }),
      now: () => now,
    });
  }

  it('второй запрос базу не открывает', () => {
    const stats = cache();
    const first = stats.read();
    expect(first.children).toHaveLength(1);

    // Базы больше нет: живой обход отправил бы ребёнка в `failed[]`, а кеш
    // отдаёт прежний отчёт вместе с его собственной отметкой времени.
    rmSync(childDatabasePath(dir, childId));
    now = new Date(NOW.getTime() + MINUTE);
    const second = stats.read();
    expect(second).toEqual(first);
    expect(second.generatedAt).toBe(NOW.toISOString());
  });

  it('`refresh` пересчитывает и двигает отметку времени', () => {
    const stats = cache();
    const first = stats.read();
    now = new Date(NOW.getTime() + MINUTE);
    const refreshed = stats.read({ refresh: true });

    expect(refreshed.generatedAt).toBe(now.toISOString());
    expect(refreshed.generatedAt).not.toBe(first.generatedAt);
    expect(refreshed.children).toHaveLength(1);
  });

  it('пересчитывает сам, когда отчёт протух', () => {
    const stats = cache();
    const first = stats.read();
    now = new Date(NOW.getTime() + ADMIN_STATS_TTL_MS - 1);
    expect(stats.read().generatedAt).toBe(first.generatedAt);

    now = new Date(NOW.getTime() + ADMIN_STATS_TTL_MS);
    expect(stats.read().generatedAt).toBe(now.toISOString());
  });

  it('держит свой срок, когда его задали снаружи', () => {
    const stats = cache(MINUTE);
    const first = stats.read();
    now = new Date(NOW.getTime() + MINUTE - 1);
    expect(stats.read().generatedAt).toBe(first.generatedAt);

    now = new Date(NOW.getTime() + MINUTE);
    expect(stats.read().generatedAt).toBe(now.toISOString());
  });
});
