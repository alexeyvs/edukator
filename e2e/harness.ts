import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { storeTasks } from '../server/codex/bank.js';
import type { DisputeReviewer } from '../server/codex/dispute.js';
import type { GeneratedTask } from '../server/codex/task-schema.js';
import { openDatabase, SUBJECTS, writeProfile, type Subject } from '../server/db.js';
import { buildServer } from '../server/index.js';

const NOW = new Date('2026-08-08T12:00:00.000Z');
const TOPICS_PER_SUBJECT = 12;
const TASKS_PER_TOPIC = 15;

export interface E2eHarness {
  app: FastifyInstance;
  db: Database;
  url: string;
  close(): Promise<void>;
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

export async function startE2eHarness(
  options: { triagePassed?: Subject } = {},
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

  const review: DisputeReviewer = async () => ({
    studentCorrect: true,
    note: 'Ответ ученика равнозначен эталону.',
  });
  const app = buildServer(curriculumDir, {
    worker: false,
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

    return {
      app,
      db,
      url,
      async close(): Promise<void> {
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
