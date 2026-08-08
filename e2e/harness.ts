import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { storeTasks } from '../server/codex/bank.js';
import type { DisputeReviewer } from '../server/codex/dispute.js';
import type { GeneratedTask } from '../server/codex/task-schema.js';
import type { TaskProducer } from '../server/codex/worker.js';
import { openDatabase, SUBJECTS, writeProfile, type Subject } from '../server/db.js';
import { buildServer } from '../server/index.js';

const NOW = new Date('2026-08-08T12:00:00.000Z');
const TOPICS_PER_SUBJECT = 12;
const TASKS_PER_TOPIC = 15;

export interface E2eHarness {
  app: FastifyInstance;
  db: Database;
  url: string;
  assertCodexNotCalled(): void;
  prepareBoss(topicId: string): Promise<void>;
  seedParentsDashboard(): void;
  upholdDispute(): void;
  close(): Promise<void>;
}

interface HarnessOptions {
  triagePassed?: Subject;
  controlledWorker?: boolean;
  controlledDispute?: boolean;
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
    instruction: `Задание ${subject}.${topic} номер ${index}: вычисли значение.`,
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
    `INSERT INTO runs (subject, kind, topic_id, started_at, finished_at)
     VALUES (?, 'triage', ?, ?, ?)`,
  ).run(subject, `${subject}.1`, NOW.toISOString(), NOW.toISOString());
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
          wait: async () => new Promise((resolve) => setTimeout(resolve, 10)),
        }
      : false,
    seedDir,
    review,
    now: () => NOW,
  });
  const db = openDatabase(process.env.EDUKATOR_DB);

  try {
    writeProfile(db, {
      name: 'Тимофей',
      partnerName: 'Кекс',
      interests: ['скейт'],
      examDate: '2027-05-20',
    });
    seedTasks(db);
    if (options.triagePassed !== undefined) markTriagePassed(db, options.triagePassed);
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
      async prepareBoss(topicId: string): Promise<void> {
        db.prepare(
          `UPDATE topic_state SET mastery = 0.76, confidence = 0.8, attempts = 4,
             last_seen = ?, next_review = ? WHERE topic_id = ?`,
        ).run(NOW.toISOString(), '2026-08-20T12:00:00.000Z', topicId);
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
          `INSERT INTO runs (subject, kind, topic_id, started_at, finished_at, total, correct)
           VALUES (?, ?, ?, ?, ?, 1, ?)`,
        );
        const ordinary = Number(insertRun.run(
          'math', 'run', 'math.1', '2026-08-07T09:00:00.000Z', '2026-08-07T09:10:00.000Z', 1,
        ).lastInsertRowid);
        const triage = Number(insertRun.run(
          'russian', 'triage', 'russian.1', '2026-08-06T09:00:00.000Z', '2026-08-06T09:10:00.000Z', 1,
        ).lastInsertRowid);
        const boss = Number(insertRun.run(
          'english', 'boss', 'english.1', '2026-08-08T09:00:00.000Z', '2026-08-08T09:10:00.000Z', 1,
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
