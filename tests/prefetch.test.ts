import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, SUBJECTS, type Subject } from '../server/db.js';
import { countAvailable } from '../server/codex/bank.js';
import { CodexUnavailableError } from '../server/codex/client.js';
import type { GeneratedTask } from '../server/codex/task-schema.js';
import type { ProduceRequest } from '../server/codex/worker.js';
import { DEFAULT_CYCLES, parseArgs, prefetch } from '../scripts/prefetch.js';

/** Карта из одной темы на предмет: без всех трёх файлов карта не грузится. */
function writeCurriculum(dir: string): void {
  for (const subject of SUBJECTS) {
    writeFileSync(
      join(dir, `${subject}.json`),
      JSON.stringify({
        subject,
        topics: [
          {
            id: `${subject}.a`,
            subject,
            title: `Тема ${subject}`,
            exam_weight: 3,
            difficulty: 2,
            prereqs: [],
            answer_format: 'number',
            prompt_seed: `Спрашивай по теме ${subject}.`,
          },
        ],
      }),
    );
  }
}

let counter = 0;

function task(topicId: string): GeneratedTask {
  counter += 1;
  return {
    question: `Задание ${counter} по теме ${topicId}: сколько монет останется?`,
    answer: '45',
    accept: ['45', '45 монет'],
    hint: 'Посчитай по шагам.',
    explain: 'Сорок пять — то, что осталось.',
    joke: 'Не Нобелевка, но зачёт.',
    difficulty: 2,
  };
}

describe('prefetch', () => {
  let tempDir: string;
  let curriculumDir: string;
  let seedDir: string;
  let dbPath: string;
  const logged: string[] = [];
  const log = (message: string): void => {
    logged.push(message);
  };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-prefetch-'));
    curriculumDir = join(tempDir, 'curriculum');
    seedDir = join(tempDir, 'seed-bank');
    mkdirSync(curriculumDir);
    mkdirSync(seedDir);
    writeCurriculum(curriculumDir);
    dbPath = join(tempDir, 'test.db');
    logged.length = 0;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function run(patch: Record<string, unknown> = {}): ReturnType<typeof prefetch> {
    return prefetch({
      dbPath,
      curriculumDir,
      seedDir,
      log,
      produce: (request: ProduceRequest) =>
        Promise.resolve(Array.from({ length: 5 }, () => task(request.topic.id))),
      ...patch,
    });
  }

  describe('наполнение банка', () => {
    it('заводит темы и греет ближайшие до запаса', async () => {
      const result = await run({ topics: 2 });

      expect(result.cycles).toHaveLength(DEFAULT_CYCLES);
      expect(result.cycles[0]?.topics).toHaveLength(2);

      const db = openDatabase(dbPath);
      try {
        const warmed = SUBJECTS.filter((subject) => countAvailable(db, `${subject}.a`) > 0);
        expect(warmed).toHaveLength(2);
        expect(countAvailable(db, `${warmed[0] ?? 'math'}.a`)).toBeGreaterThanOrEqual(8);
      } finally {
        db.close();
      }
    });

    it('уважает ограничение числа батчей на тему', async () => {
      const requests: string[] = [];

      await run({
        topics: 1,
        batches: 1,
        produce: (request: ProduceRequest) => {
          requests.push(request.topic.id);
          return Promise.resolve([task(request.topic.id)]);
        },
      });

      expect(requests).toHaveLength(1);
    });

    it('прогоняет столько циклов, сколько попросили', async () => {
      const result = await run({ topics: 1, target: 5, cycles: 3 });

      expect(result.cycles).toHaveLength(3);
      // Второй и третий цикл видят полную очередь и никого не греют.
      expect(result.cycles[1]?.refilled).toEqual([]);
    });

    it('подхватывает посев до наполнения и не просит по нему заданий заново', async () => {
      writeFileSync(
        join(seedDir, 'math.json'),
        JSON.stringify({
          subject: 'math',
          topics: [
            {
              topic_id: 'math.a',
              tasks: Array.from({ length: 8 }, (_, index) => ({
                ...task('math.a'),
                question: `Посевное задание ${index + 1}: сколько будет ${index + 1} + 2?`,
              })),
            },
          ],
        }),
      );
      const requests: string[] = [];

      const result = await run({
        topics: 1,
        produce: (request: ProduceRequest) => {
          requests.push(request.topic.id);
          return Promise.resolve([task(request.topic.id)]);
        },
      });

      expect(result.seeded).toMatchObject({ loaded: 8, skipped: 0 });
      expect(result.cycles[0]?.refilled).toEqual([]);
      expect(requests).toEqual([]);
    });
  });

  describe('выгрузка посева', () => {
    it('пишет файл на каждый предмет и кладёт туда сгенерированное', async () => {
      const result = await run({ topics: 3, exportSeed: true, outDir: seedDir });

      expect(result.exported).toHaveLength(SUBJECTS.length);

      for (const subject of SUBJECTS) {
        const raw = JSON.parse(readFileSync(join(seedDir, `${subject}.json`), 'utf8')) as {
          subject: Subject;
          topics: { topic_id: string; tasks: GeneratedTask[] }[];
        };

        expect(raw.subject).toBe(subject);
        expect(raw.topics[0]?.topic_id).toBe(`${subject}.a`);
        expect(raw.topics[0]?.tasks.length).toBeGreaterThanOrEqual(8);
      }
    });

    it('без флага выгрузки файлов не трогает', async () => {
      const result = await run({ topics: 1 });

      expect(result.exported).toEqual([]);
    });
  });

  describe('ошибочные сценарии', () => {
    it('прекращает циклы, как только codex оказался недоступен', async () => {
      const result = await run({
        topics: 3,
        cycles: 3,
        produce: () => Promise.reject(new CodexUnavailableError('codex не найден')),
      });

      expect(result.cycles).toHaveLength(1);
      expect(result.cycles[0]?.codexUnavailable).toBe(true);
      expect(logged.join('\n')).toMatch(/прерван: codex недоступен/u);
    });

    it('падает на неположительном числе циклов', async () => {
      await expect(run({ cycles: 0 })).rejects.toThrow(/положительным целым/u);
    });

    it('падает на непрочитанной карте тем', async () => {
      rmSync(join(curriculumDir, 'russian.json'));

      await expect(run()).rejects.toThrow(/не найдена/u);
    });
  });

  describe('разбор аргументов', () => {
    it('разбирает числовые, текстовые и булевы флаги', () => {
      const options = parseArgs([
        '--topics', '4',
        '--target', '10',
        '--batches', '2',
        '--cycles', '3',
        '--model', 'gpt-5.6-luna',
        '--export',
      ]);

      expect(options).toMatchObject({
        topics: 4,
        target: 10,
        batches: 2,
        cycles: 3,
        model: 'gpt-5.6-luna',
        exportSeed: true,
      });
    });

    it('превращает пути в абсолютные', () => {
      const options = parseArgs(['--out', 'content/seed-bank', '--db', 'edukator.db']);

      expect(options.outDir?.startsWith('/')).toBe(true);
      expect(options.dbPath?.endsWith('/edukator.db')).toBe(true);
    });

    it('без аргументов не задаёт ничего: умолчания живут в самом наполнении', () => {
      expect(parseArgs([])).toEqual({});
    });

    it('падает на непонятных аргументах', () => {
      expect(() => parseArgs(['topics', '4'])).toThrow(/Непонятный аргумент/u);
      expect(() => parseArgs(['--unknown', '4'])).toThrow(/Неизвестный флаг/u);
      expect(() => parseArgs(['--topics'])).toThrow(/нет значения/u);
      expect(() => parseArgs(['--topics', '4', '--topics', '5'])).toThrow(/указан дважды/u);
      expect(() => parseArgs(['--export', '--export'])).toThrow(/указан дважды/u);
      expect(() => parseArgs(['--topics', 'много'])).toThrow(/ожидает число/u);
    });
  });
});
