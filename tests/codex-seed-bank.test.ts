import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase, SUBJECTS } from '../server/db.js';
import {
  buildTopicGraph,
  loadCurriculum,
  syncTopicState,
  type Topic,
  type TopicGraph,
} from '../server/curriculum.js';
import { buildServer } from '../server/index.js';
import { countAvailable, storeTasks, takeTask } from '../server/codex/bank.js';
import { CodexUnavailableError } from '../server/codex/client.js';
import { runWarmupCycle } from '../server/codex/worker.js';
import type { GeneratedTask } from '../server/codex/task-schema.js';
import {
  collectSeedTasks,
  formatSeedBank,
  loadSeedBank,
  parseSeedBank,
  readSeedBank,
  seedBankPath,
  SEED_BANK_DIR,
  takeTaskOrSeed,
} from '../server/codex/seed-bank.js';

function topic(id: string, patch: Partial<Topic> = {}): Topic {
  return {
    id,
    subject: id.startsWith('math') ? 'math' : id.startsWith('russian') ? 'russian' : 'english',
    title: `Тема ${id}`,
    examWeight: 3,
    difficulty: 2,
    prereqs: [],
    answerFormat: 'number',
    promptSeed: `Спрашивай по теме ${id}.`,
    ...patch,
  };
}

const GRAPH: TopicGraph = buildTopicGraph([
  topic('math.a'),
  topic('russian.a', { answerFormat: 'text' }),
]);

function task(patch: Partial<GeneratedTask> = {}): GeneratedTask {
  return {
    question: 'Сколько будет 2 + 2?',
    answer: '4',
    accept: ['4', '4 штуки'],
    hint: 'Сложи столбиком.',
    explain: 'Два плюс два — четыре.',
    joke: 'Не Нобелевка, но зачёт.',
    difficulty: 2,
    ...patch,
  };
}

function batch(count: number): GeneratedTask[] {
  return Array.from({ length: count }, (_, index) =>
    task({ question: `Задание ${index + 1}: сколько будет ${index + 1} + 2?` }),
  );
}

/** Посев в том же виде, в каком он лежит в репозитории. */
function seedJson(topics: { topic_id: string; tasks: GeneratedTask[] }[], subject = 'math'): unknown {
  return { subject, topics };
}

describe('посевной банк', () => {
  let tempDir: string;
  let seedDir: string;
  let db: Database;

  function writeSeed(subject: string, payload: unknown): void {
    writeFileSync(join(seedDir, `${subject}.json`), `${JSON.stringify(payload, null, 2)}\n`);
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-seed-'));
    seedDir = join(tempDir, 'seed-bank');
    mkdirSync(seedDir);
    db = openDatabase(join(tempDir, 'test.db'));
    syncTopicState(db, GRAPH);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('разбор файла', () => {
    it('разбирает посев и отдаёт задания по темам', () => {
      const bank = parseSeedBank(
        seedJson([{ topic_id: 'math.a', tasks: batch(2) }]),
        GRAPH,
        'посев.json',
      );

      expect(bank.subject).toBe('math');
      expect(bank.topics).toHaveLength(1);
      expect(bank.topics[0]?.topicId).toBe('math.a');
      expect(bank.topics[0]?.tasks.map((item) => item.answer)).toEqual(['4', '4']);
    });

    it('прогоняет задания через те же проверки, что и ответ модели', () => {
      const broken = seedJson([
        { topic_id: 'math.a', tasks: [task({ answer: '5', accept: ['4'] })] },
      ]);

      expect(() => parseSeedBank(broken, GRAPH, 'посев.json')).toThrow(
        /ответ «5» отсутствует в accept/u,
      );
    });

    it('проверяет accept[] по формату ответа темы, а не по формату файла', () => {
      // Тема числовая: словесный эталон нормализатор не прочтёт.
      const wordy = seedJson([
        { topic_id: 'math.a', tasks: [task({ answer: 'четыре', accept: ['четыре'] })] },
      ]);

      expect(() => parseSeedBank(wordy, GRAPH, 'посев.json')).toThrow(/не читается как одно число/u);
    });

    it('падает на теме вне карты', () => {
      expect(() =>
        parseSeedBank(seedJson([{ topic_id: 'math.unknown', tasks: batch(1) }]), GRAPH, 'посев.json'),
      ).toThrow(/темы «math.unknown» нет в карте/u);
    });

    it('падает, когда тема принадлежит другому предмету', () => {
      expect(() =>
        parseSeedBank(seedJson([{ topic_id: 'russian.a', tasks: batch(1) }]), GRAPH, 'посев.json'),
      ).toThrow(/принадлежит предмету «russian»/u);
    });

    it('падает на теме, встреченной дважды', () => {
      expect(() =>
        parseSeedBank(
          seedJson([
            { topic_id: 'math.a', tasks: batch(1) },
            { topic_id: 'math.a', tasks: batch(1) },
          ]),
          GRAPH,
          'посев.json',
        ),
      ).toThrow(/встречается дважды/u);
    });

    it('падает на посеве не той формы', () => {
      expect(() => parseSeedBank([], GRAPH, 'посев.json')).toThrow(/ожидался объект/u);
      expect(() => parseSeedBank({ subject: 'физика', topics: [] }, GRAPH, 'посев.json')).toThrow(
        /поле subject/u,
      );
      expect(() => parseSeedBank({ subject: 'math' }, GRAPH, 'посев.json')).toThrow(
        /topics должно быть массивом/u,
      );
      expect(() => parseSeedBank({ subject: 'math', topics: ['math.a'] }, GRAPH, 'посев.json')).toThrow(
        /запись 1: ожидался объект/u,
      );
      expect(() =>
        parseSeedBank({ subject: 'math', topics: [{ tasks: [] }] }, GRAPH, 'посев.json'),
      ).toThrow(/topic_id должно быть строкой/u);
    });

    it('падает, когда предмет в файле не совпадает с его именем', () => {
      writeSeed('math', seedJson([{ topic_id: 'russian.a', tasks: batch(1) }], 'russian'));

      expect(() => readSeedBank(GRAPH, 'math', seedDir)).toThrow(
        /объявлен предмет «russian», а файл называется «math.json»/u,
      );
    });

    it('падает на неразбираемом JSON', () => {
      writeFileSync(seedBankPath('math', seedDir), '{ не json');

      expect(() => readSeedBank(GRAPH, 'math', seedDir)).toThrow(/не разбирается как JSON/u);
    });

    it('на отсутствующем файле отдаёт null, а не падает', () => {
      expect(readSeedBank(GRAPH, 'math', seedDir)).toBeNull();
    });
  });

  describe('загрузка в банк', () => {
    it('заливает посев в банк и делает задания доступными', () => {
      writeSeed('math', seedJson([{ topic_id: 'math.a', tasks: batch(3) }]));

      const result = loadSeedBank(db, GRAPH, { dir: seedDir });

      expect(result.loaded).toBe(3);
      expect(result.skipped).toBe(0);
      expect(result.missing).toEqual(['russian']);
      expect(countAvailable(db, 'math.a')).toBe(3);
    });

    it('при перезапуске не загружает посев повторно', () => {
      writeSeed('math', seedJson([{ topic_id: 'math.a', tasks: batch(3) }]));
      loadSeedBank(db, GRAPH, { dir: seedDir });
      takeTask(db, 'math.a');

      const again = loadSeedBank(db, GRAPH, { dir: seedDir });

      expect(again.loaded).toBe(0);
      expect(again.skipped).toBe(3);
      // Выданное задание не вернулось в очередь вторым экземпляром.
      expect(countAvailable(db, 'math.a')).toBe(2);
      expect(db.prepare('SELECT COUNT(*) AS n FROM task_bank').get()).toEqual({ n: 3 });
    });

    it('добавляет только то, чего в банке ещё не было', () => {
      writeSeed('math', seedJson([{ topic_id: 'math.a', tasks: batch(3) }]));
      loadSeedBank(db, GRAPH, { dir: seedDir });
      writeSeed('math', seedJson([{ topic_id: 'math.a', tasks: batch(5) }]));

      const result = loadSeedBank(db, GRAPH, { dir: seedDir });

      expect(result).toMatchObject({ loaded: 2, skipped: 3 });
      expect(countAvailable(db, 'math.a')).toBe(5);
    });

    it('грузит только запрошенные предметы', () => {
      writeSeed('math', seedJson([{ topic_id: 'math.a', tasks: batch(2) }]));
      writeSeed('russian', seedJson([{ topic_id: 'russian.a', tasks: batch(2) }], 'russian'));

      loadSeedBank(db, GRAPH, { dir: seedDir, subjects: ['russian'] });

      expect(countAvailable(db, 'math.a')).toBe(0);
      expect(countAvailable(db, 'russian.a')).toBe(2);
    });
  });

  describe('откат при недоступном codex', () => {
    it('выдаёт задание, когда очередь пуста, а codex недоступен', async () => {
      writeSeed('math', seedJson([{ topic_id: 'math.a', tasks: batch(2) }]));
      const logged: string[] = [];

      const report = await runWarmupCycle({
        db,
        graph: GRAPH,
        log: (message) => logged.push(message),
        produce: () => Promise.reject(new CodexUnavailableError('codex не найден')),
      });

      expect(report.codexUnavailable).toBe(true);
      expect(countAvailable(db, 'math.a')).toBe(0);

      const given = takeTaskOrSeed(db, GRAPH, 'math.a', { dir: seedDir });

      expect(given?.question).toBe('Задание 1: сколько будет 1 + 2?');
      expect(countAvailable(db, 'math.a')).toBe(1);
    });

    it('берёт из очереди, пока она не пуста, и посев не трогает', () => {
      writeSeed('math', seedJson([{ topic_id: 'math.a', tasks: batch(2) }]));
      storeTasks(db, 'math.a', [task({ question: 'Свежее задание: сколько будет 9 + 9?' })]);

      const given = takeTaskOrSeed(db, GRAPH, 'math.a', { dir: seedDir });

      expect(given?.question).toBe('Свежее задание: сколько будет 9 + 9?');
      expect(db.prepare('SELECT COUNT(*) AS n FROM task_bank').get()).toEqual({ n: 1 });
    });

    it('отдаёт null, когда посева по теме нет и очередь пуста', () => {
      expect(takeTaskOrSeed(db, GRAPH, 'math.a', { dir: seedDir })).toBeNull();
    });

    it('отдаёт null, когда посев темы кончился', () => {
      writeSeed('math', seedJson([{ topic_id: 'math.a', tasks: batch(1) }]));

      expect(takeTaskOrSeed(db, GRAPH, 'math.a', { dir: seedDir })).not.toBeNull();
      expect(takeTaskOrSeed(db, GRAPH, 'math.a', { dir: seedDir })).toBeNull();
    });

    it('падает на теме вне карты', () => {
      const stale = buildTopicGraph([topic('math.a')]);
      db.prepare('INSERT INTO topic_state (topic_id) VALUES (?)').run('math.gone');

      expect(() => takeTaskOrSeed(db, stale, 'math.gone', { dir: seedDir })).toThrow(
        /темы «math.gone» нет в карте/u,
      );
    });
  });

  describe('выгрузка посева', () => {
    it('собирает банк в файл, который читается обратно', () => {
      storeTasks(db, 'math.a', batch(2));
      takeTask(db, 'math.a');

      const topics = collectSeedTasks(db, GRAPH, 'math');
      writeFileSync(seedBankPath('math', seedDir), formatSeedBank('math', topics));

      // Выданное задание в посев тоже попадает: это снимок банка, а не остаток очереди.
      expect(topics).toHaveLength(1);
      expect(topics[0]?.tasks).toHaveLength(2);
      expect(readSeedBank(GRAPH, 'math', seedDir)?.topics[0]?.tasks).toEqual(topics[0]?.tasks);
    });

    it('на пустом банке отдаёт пустой список тем', () => {
      expect(collectSeedTasks(db, GRAPH, 'math')).toEqual([]);
      expect(collectSeedTasks(db, GRAPH, 'english')).toEqual([]);
    });

    it('падает на задании с повреждённым accept[]', () => {
      const { stored } = storeTasks(db, 'math.a', [task()]);
      db.prepare('UPDATE task_bank SET accept = ? WHERE id = ?').run('[4]', stored[0]?.id);

      expect(() => collectSeedTasks(db, GRAPH, 'math')).toThrow(/не массив строк/u);

      db.prepare('UPDATE task_bank SET accept = ? WHERE id = ?').run('{не json', stored[0]?.id);

      expect(() => collectSeedTasks(db, GRAPH, 'math')).toThrow(/не разбирается как JSON/u);
    });
  });

  describe('посев в репозитории', () => {
    const graph = loadCurriculum();

    it('проходит проверки разбора батча целиком', () => {
      for (const subject of SUBJECTS) {
        const bank = readSeedBank(graph, subject, SEED_BANK_DIR);

        expect(bank, `посев предмета ${subject} отсутствует`).not.toBeNull();
      }
    });

    it('содержит не меньше 30 заданий на предмет', () => {
      for (const subject of SUBJECTS) {
        const bank = readSeedBank(graph, subject, SEED_BANK_DIR);
        const count = (bank?.topics ?? []).reduce((sum, entry) => sum + entry.tasks.length, 0);

        expect(count, `посев предмета ${subject}`).toBeGreaterThanOrEqual(30);
      }
    });

    it('заливается при старте сервера, а второй старт ничего не добавляет', async () => {
      const path = join(tempDir, 'server.db');
      process.env.EDUKATOR_DB = path;
      try {
        const first = buildServer();
        await first.ready();
        await first.close();

        const fresh = openDatabase(path);
        const count = (): number =>
          (fresh.prepare('SELECT COUNT(*) AS n FROM task_bank').get() as { n: number }).n;
        const seeded = count();

        const second = buildServer();
        await second.ready();
        await second.close();

        expect(seeded).toBeGreaterThanOrEqual(90);
        expect(count()).toBe(seeded);
        fresh.close();
      } finally {
        delete process.env.EDUKATOR_DB;
      }
    });

    it('заливается в базу целиком и не повторяется при перезапуске', () => {
      const fresh = openDatabase(join(tempDir, 'repo-seed.db'));
      try {
        syncTopicState(fresh, graph);
        const first = loadSeedBank(fresh, graph);
        const again = loadSeedBank(fresh, graph);

        expect(first.missing).toEqual([]);
        expect(first.loaded).toBeGreaterThanOrEqual(90);
        expect(again).toMatchObject({ loaded: 0, skipped: first.loaded });
      } finally {
        fresh.close();
      }
    });
  });
});
