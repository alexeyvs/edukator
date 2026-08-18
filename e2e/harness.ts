import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { storeTasks } from '../server/codex/bank.js';
import type { DisputeReviewer } from '../server/codex/dispute.js';
import type { GeneratedTask } from '../server/codex/task-schema.js';
import type { TaskProducer } from '../server/codex/worker.js';
import type { LearningProducer } from '../server/learning-prep.js';
import { openDatabase, SUBJECTS, writeProfile, type Subject } from '../server/db.js';
import { buildServer } from '../server/index.js';
import { loadCurriculum } from '../server/curriculum.js';
import { startRun } from '../server/run.js';
import { submitAnswer } from '../server/session.js';

const NOW = new Date('2026-08-08T12:00:00.000Z');
const TOPICS_PER_SUBJECT = 12;
const TASKS_PER_TOPIC = 15;

export interface E2eHarness {
  app: FastifyInstance;
  db: Database;
  url: string;
  assertCodexNotCalled(): void;
  waitForLearningMaterial(topicId: string): Promise<number>;
  prepareBoss(topicId: string): Promise<void>;
  seedParentsDashboard(): void;
  upholdDispute(): void;
  close(): Promise<void>;
}

interface HarnessOptions {
  triagePassed?: Subject;
  controlledWorker?: boolean;
  controlledDispute?: boolean;
  learningForecastFixture?: Subject;
  parentPin?: string;
}

function writeCurriculum(directory: string): void {
  for (const subject of SUBJECTS) {
    const answerFormat = subject === 'math' ? 'number' : subject === 'russian' ? 'text' : 'choice';
    writeFileSync(
      join(directory, `${subject}.json`),
      JSON.stringify({
        subject,
        topics: Array.from({ length: TOPICS_PER_SUBJECT }, (_, index) => ({
          id: `${subject}.${index + 1}`,
          subject,
          title: `Тема ${subject} ${index + 1}`,
          exam_weight: 3,
          difficulty: 2,
          prereqs: [],
          answer_format: answerFormat,
          prompt_seed: `Проверить тему ${subject} ${index + 1}.`,
        })),
      }),
    );
  }
}

function task(subject: Subject, topic: number, index: number): GeneratedTask {
  if (subject === 'russian') {
    return {
      instruction: `Вставь слово в задании ${subject}.${topic} номер ${index}.`,
      material: 'На полке лежит школьный ___ .',
      material_format: 'text',
      choices: [],
      answer: 'учебник',
      accept: ['учебник'],
      hint: 'Определи, какой предмет обычно лежит на школьной полке. Подставь слово и проверь согласование с прилагательным.',
      explain: 'На полке лежит школьный учебник.',
      joke: 'Учебник нашёлся без помощи библиотечного детектива.',
      difficulty: index % 3 + 1,
    };
  }
  if (subject === 'english') {
    return {
      instruction: `Выбери правильный перевод в задании ${subject}.${topic} номер ${index}.`,
      material: 'window',
      material_format: 'text',
      choices: ['дверь', 'окно', 'крыша'],
      answer: 'окно',
      accept: ['окно'],
      hint: 'Вспомни предмет, через который в комнату попадает дневной свет. Сопоставь это значение с каждым вариантом и проверь, что остальные обозначают другие части здания.',
      explain: 'Window переводится как «окно».',
      joke: 'Английский открыл окно возможностей.',
      difficulty: index % 3 + 1,
    };
  }
  return {
    // Инлайн-формула в инструкции — не украшение: до `SafeRichText` в условии
    // ученик читал бы «\(40+5\)» исходником, и сценарий это ловит.
    instruction: String.raw`Задание ${subject}.${topic} номер ${index}: вычисли значение \(40+5\).`,
    material: '40 + 5',
    material_format: 'math',
    choices: [],
    answer: '45',
    accept: ['45'],
    hint: 'Раздели число на десятки и единицы. Прибавь единицы к десяткам и проверь результат обратным вычитанием.',
    explain: '40 + 5 = 45.',
    joke: 'Пять единиц добрались до ответа.',
    difficulty: index % 3 + 1,
  };
}

function seedTasks(db: Database): void {
  for (const subject of SUBJECTS) {
    for (let topic = 1; topic <= TOPICS_PER_SUBJECT; topic += 1) {
      storeTasks(
        db,
        `${subject}.${topic}`,
        Array.from(
          { length: TASKS_PER_TOPIC },
          (_, index) => task(subject, topic, index + 1),
        ),
      );
    }
  }
}

function markTriagePassed(db: Database, subject: Subject): void {
  db.prepare(
    `INSERT INTO runs (subject, kind, topic_id, started_at, finished_at, summary)
     VALUES (?, 'triage', ?, ?, ?, ?)`,
  ).run(subject, `${subject}.1`, NOW.toISOString(), NOW.toISOString(), '{}');
}

function seedLearningForecastFixture(db: Database, subject: Subject): void {
  db.prepare(
    `UPDATE topic_state
        SET mastery = CASE WHEN topic_id = ? THEN 0.3 ELSE 0.5 END,
            confidence = 0.8,
            attempts = 5,
            last_seen = ?,
            next_review = ?
      WHERE topic_id LIKE ?`,
  ).run(
    `${subject}.1`,
    NOW.toISOString(),
    '2026-08-07T12:00:00.000Z',
    `${subject}.%`,
  );
}

function bossTask(topicId: string, serial: number, position: number): GeneratedTask {
  return {
    instruction: `Босс ${topicId}: реши уникальное задание ${serial}.${position}.`,
    material: `40 + ${position}`,
    material_format: 'math',
    choices: [],
    answer: String(40 + position),
    accept: [String(40 + position)],
    hint: 'У босса подсказка не показывается.',
    explain: `40 + ${position} = ${40 + position}.`,
    joke: `Босс потерял деление номер ${position}.`,
    difficulty: 2,
  };
}

function controlledProducer(): TaskProducer {
  let serial = 0;
  return async ({ topic }) => {
    serial += 1;
    return Array.from({ length: 5 }, (_, index) => bossTask(topic.id, serial, index + 1));
  };
}

function controlledLearningProducer(): LearningProducer {
  let serial = 0;
  return async ({ topic: selected }) => {
    serial += 1;
    const topicNumber = Number(selected.id.split('.').at(-1)) || 1;
    return {
      content: {
        introduction: `Тестовый материал ${serial} по теме ${selected.title}.`,
        objectives: ['Разобраться в правиле', 'Применить его самостоятельно'],
        sections: [
          { title: 'Идея', blocks: [{ type: 'paragraph', content: 'Короткое объяснение идеи.' }] },
          { title: 'Правило', blocks: [{ type: 'example', content: 'Разбираем правило на примере.' }] },
          { title: 'Проверка', blocks: [{ type: 'warning', content: 'Проверяем ответ перед завершением.' }] },
        ],
        summary: ['Вспомни правило.', 'Проверь ответ.'],
      },
      tasks: Array.from(
        { length: 5 },
        (_, index) => task(selected.subject, topicNumber, TASKS_PER_TOPIC + serial * 10 + index),
      ),
    };
  };
}

async function waitUntil(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`E2E не дождался состояния: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function startE2eHarness(
  options: HarnessOptions = {},
): Promise<E2eHarness> {
  const tempDir = mkdtempSync(join(tmpdir(), 'edukator-e2e-'));
  const curriculumDir = join(tempDir, 'curriculum');
  const seedDir = join(tempDir, 'seed-bank');
  const binDir = join(tempDir, 'bin');
  const codexMarker = join(tempDir, 'codex-called');
  mkdirSync(curriculumDir);
  mkdirSync(seedDir);
  mkdirSync(binDir);
  writeCurriculum(curriculumDir);

  const codexShim = join(binDir, 'codex');
  writeFileSync(codexShim, `#!/bin/sh\ntouch '${codexMarker}'\nexit 97\n`);
  chmodSync(codexShim, 0o755);

  const previousDatabase = process.env.EDUKATOR_DB;
  const previousPath = process.env.PATH;
  process.env.EDUKATOR_DB = join(tempDir, 'edukator.db');
  process.env.PATH = `${binDir}:${previousPath ?? ''}`;

  let releaseDispute: (() => void) | undefined;
  const disputeGate = new Promise<void>((resolve) => { releaseDispute = resolve; });
  const review: DisputeReviewer = async () => {
    if (options.controlledDispute === true) await disputeGate;
    return {
      studentCorrect: true,
      note: 'Ответ ученика равнозначен эталону.',
    };
  };
  const app = buildServer(curriculumDir, {
    worker: options.controlledWorker === true
      ? {
          produce: controlledProducer(),
          learningProduce: controlledLearningProducer(),
          wait: async () => new Promise((resolve) => setTimeout(resolve, 10)),
        }
      : false,
    seedDir,
    review,
    integrityReview: async (items) => items.map((item) => ({
      id: item.id,
      decision: 'meaningful',
      confidence: 0.99,
      reason: 'Ответ в браузерном сценарии осмысленный.',
    })),
    now: () => NOW,
    ...(options.parentPin === undefined ? {} : { parentPin: options.parentPin }),
  });
  const db = openDatabase(process.env.EDUKATOR_DB);
  const graph = loadCurriculum(curriculumDir);

  try {
    writeProfile(db, {
      name: 'Тимофей',
      partnerName: 'Кекс',
      interests: ['скейт'],
      examDate: '2027-05-20',
    });
    seedTasks(db);
    if (options.triagePassed !== undefined) markTriagePassed(db, options.triagePassed);
    if (options.learningForecastFixture !== undefined) {
      seedLearningForecastFixture(db, options.learningForecastFixture);
    }
    const url = await app.listen({ host: '127.0.0.1', port: 0 });

    function assertCodexNotCalled(): void {
      if (existsSync(codexMarker)) {
        throw new Error('E2E вызвал настоящий путь codex вместо тестовой подмены');
      }
    }

    return {
      app,
      db,
      url,
      assertCodexNotCalled,
      async waitForLearningMaterial(topicId: string): Promise<number> {
        await waitUntil(
          () => db.prepare<[string], { status: string }>(
            "SELECT status FROM learning_materials WHERE topic_id = ? AND status = 'ready'",
          ).get(topicId)?.status === 'ready',
          `готовый учебный материал ${topicId}`,
        );
        const material = db.prepare<[string], { id: number }>(
          "SELECT id FROM learning_materials WHERE topic_id = ? AND status = 'ready'",
        ).get(topicId);
        if (material === undefined) throw new Error(`E2E: материал ${topicId} исчез после подготовки`);
        return material.id;
      },
      async prepareBoss(topicId: string): Promise<void> {
        const topic = graph.byId.get(topicId);
        if (topic === undefined) throw new Error(`E2E: неизвестная тема ${topicId}`);
        const run = startRun(db, graph, topic.subject, { now: NOW });
        const rows = db.prepare<[string], { id: number; answer: string }>(
          `SELECT id, answer FROM task_bank
            WHERE topic_id = ? AND status IN ('valid', 'ready') ORDER BY id LIMIT 12`,
        ).all(topicId);
        for (const [index, row] of rows.entries()) {
          db.prepare("UPDATE task_bank SET status = 'used', issued_run_id = ? WHERE id = ?")
            .run(run.runId, row.id);
          submitAnswer(db, graph, {
            runId: run.runId, taskId: row.id, answer: row.answer,
            at: new Date(NOW.getTime() + index),
          });
          const mastery = db.prepare<[string], { mastery: number }>(
            'SELECT mastery FROM topic_state WHERE topic_id = ?',
          ).get(topicId)?.mastery ?? 0;
          if (mastery > 0.75) break;
        }
        const achieved = db.prepare<[string], { mastery: number }>(
          'SELECT mastery FROM topic_state WHERE topic_id = ?',
        ).get(topicId)?.mastery ?? 0;
        if (achieved <= 0.75) {
          throw new Error(`E2E: обычные ответы не открыли босса ${topicId}, mastery=${achieved}`);
        }
        await waitUntil(
          () => db.prepare<[string], { status: string }>(
            "SELECT status FROM boss_batches WHERE topic_id = ? AND status = 'ready'",
          ).get(topicId)?.status === 'ready',
          `готовый boss-батч ${topicId}`,
        );
      },
      seedParentsDashboard(): void {
        db.prepare(
          `UPDATE topic_state SET mastery = 0.4, confidence = 0.8, attempts = 4,
             last_seen = '2026-08-08T10:00:00.000Z', next_review = '2026-08-10T10:00:00.000Z'
           WHERE topic_id IN ('math.1', 'russian.1', 'english.1')`,
        ).run();
        db.prepare(
          `INSERT INTO forecast_snapshots (subject, score, band, created_at) VALUES
             ('math', 3.4, 0.4, '2026-08-01T12:00:00.000Z'),
             ('math', 3.3, 0.3, '2026-08-08T11:00:00.000Z'),
             ('russian', 3.0, 0.5, '2026-08-01T12:00:00.000Z'),
             ('english', 3.1, 0.5, '2026-08-01T12:00:00.000Z')`,
        ).run();

        const insertRun = db.prepare(
          `INSERT INTO runs
             (subject, kind, topic_id, started_at, finished_at, summary, total, correct)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
        );
        const ordinary = Number(insertRun.run(
          'math', 'run', 'math.1', '2026-08-07T09:00:00.000Z',
          '2026-08-07T09:10:00.000Z', '{}', 1,
        ).lastInsertRowid);
        const triage = Number(insertRun.run(
          'russian', 'triage', 'russian.1', '2026-08-06T09:00:00.000Z',
          '2026-08-06T09:10:00.000Z', '{}', 1,
        ).lastInsertRowid);
        const boss = Number(insertRun.run(
          'english', 'boss', 'english.1', '2026-08-08T09:00:00.000Z',
          '2026-08-08T09:10:00.000Z', null, 1,
        ).lastInsertRowid);
        db.prepare(
          "INSERT INTO boss_batches (topic_id, run_id, status, created_at, activated_at, finished_at) VALUES ('english.1', ?, 'won', ?, ?, ?)",
        ).run(boss, '2026-08-08T08:50:00.000Z', '2026-08-08T09:00:00.000Z', '2026-08-08T09:10:00.000Z');

        const taskId = db.prepare<[string], { id: number }>(
          'SELECT id FROM task_bank WHERE topic_id = ? ORDER BY id LIMIT 1',
        );
        const insertAttempt = db.prepare(
          `INSERT INTO attempts (task_id, topic_id, run_id, answer, is_correct, duration_ms, created_at)
           VALUES (?, ?, ?, ?, 1, ?, ?)`,
        );
        insertAttempt.run(taskId.get('math.1')?.id, 'math.1', ordinary, '45', 60_000, '2026-08-07T09:05:00.000Z');
        insertAttempt.run(taskId.get('russian.1')?.id, 'russian.1', triage, 'учебник', 120_000, '2026-08-06T09:05:00.000Z');
        insertAttempt.run(taskId.get('english.1')?.id, 'english.1', boss, 'окно', 180_000, '2026-08-08T09:05:00.000Z');
      },
      upholdDispute(): void {
        releaseDispute?.();
      },
      async close(): Promise<void> {
        releaseDispute?.();
        await app.close();
        db.close();
        if (previousDatabase === undefined) delete process.env.EDUKATOR_DB;
        else process.env.EDUKATOR_DB = previousDatabase;
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        const codexCalled = existsSync(codexMarker);
        rmSync(tempDir, { recursive: true, force: true });
        if (codexCalled) throw new Error('E2E вызвал настоящий путь codex вместо тестовой подмены');
      },
    };
  } catch (error) {
    await app.close();
    db.close();
    if (previousDatabase === undefined) delete process.env.EDUKATOR_DB;
    else process.env.EDUKATOR_DB = previousDatabase;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}
