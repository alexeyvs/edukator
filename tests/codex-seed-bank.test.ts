import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase, SUBJECTS, type Subject } from '../server/db.js';
import {
  buildTopicGraph,
  loadCurriculum,
  syncTopicState,
  type Topic,
  type TopicGraph,
} from '../server/curriculum.js';
import { buildServer } from '../server/index.js';
import { childHeaders, startTenantServer } from './server-harness.js';
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
  SeedBankError,
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
    instruction: 'Сколько будет 2 + 2?', material: '', material_format: 'none', choices: [],
    answer: '4',
    accept: ['4', '4 штуки'],
    hint: 'Сложи числа по разрядам. Проверь результат обратным действием.',
    explain: 'Два плюс два — четыре.',
    joke: 'Не Нобелевка, но зачёт.',
    difficulty: 2,
    ...patch,
  };
}

function batch(count: number): GeneratedTask[] {
  return Array.from({ length: count }, (_, index) =>
    task({ instruction: `Задание ${index + 1}: сколько будет ${index + 1} + 2?` }),
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

      const bank = parseSeedBank(broken, GRAPH, 'посев.json');

      expect(bank.topics).toEqual([]);
      expect(bank.problems).toHaveLength(1);
      expect(bank.problems[0]).toMatch(/другое число, чем ответ «5»/u);
    });

    it('проверяет accept[] по формату ответа темы, а не по формату файла', () => {
      // Тема числовая: словесный эталон нормализатор не прочтёт.
      const wordy = seedJson([
        { topic_id: 'math.a', tasks: [task({ answer: 'четыре', accept: ['четыре'] })] },
      ]);

      expect(parseSeedBank(wordy, GRAPH, 'посев.json').problems[0]).toMatch(
        /не читается как одно число/u,
      );
    });

    // Негодная запись выбрасывается поштучно: иначе одна переименованная в карте
    // тема оставляла бы без посева весь предмет — все его темы отвечали бы 503,
    // хотя испорчена одна.
    it('бракует запись, а не файл: здоровые темы разбираются', () => {
      const bank = parseSeedBank(
        seedJson([
          { topic_id: 'math.unknown', tasks: batch(1) },
          { topic_id: 'math.a', tasks: batch(2) },
        ]),
        GRAPH,
        'посев.json',
      );

      expect(bank.topics.map((entry) => entry.topicId)).toEqual(['math.a']);
      expect(bank.topics[0]?.tasks).toHaveLength(2);
      expect(bank.problems[0]).toMatch(/темы «math.unknown» нет в карте/u);
    });

    it('бракует запись, когда тема принадлежит другому предмету', () => {
      const bank = parseSeedBank(
        seedJson([{ topic_id: 'russian.a', tasks: batch(1) }]),
        GRAPH,
        'посев.json',
      );

      expect(bank.topics).toEqual([]);
      expect(bank.problems[0]).toMatch(/принадлежит предмету «russian»/u);
    });

    it('бракует тему, встреченную дважды', () => {
      const bank = parseSeedBank(
        seedJson([
          { topic_id: 'math.a', tasks: batch(1) },
          { topic_id: 'math.a', tasks: batch(1) },
        ]),
        GRAPH,
        'посев.json',
      );

      expect(bank.topics).toHaveLength(1);
      expect(bank.problems[0]).toMatch(/встречается дважды/u);
    });

    it('бракует запись не той формы, оставляя соседние', () => {
      const bank = parseSeedBank(
        { subject: 'math', topics: ['math.a', { tasks: [] }, { topic_id: 'math.a', tasks: batch(1) }] },
        GRAPH,
        'посев.json',
      );

      expect(bank.topics.map((entry) => entry.topicId)).toEqual(['math.a']);
      expect(bank.problems[0]).toMatch(/запись 1: ожидался объект/u);
      expect(bank.problems[1]).toMatch(/запись 2.*topic_id должно быть строкой/su);
    });

    // Поломки самого файла разбор всё-таки роняют: годных записей в нём не
    // бывает — предмет неизвестен, и формат ответа проверять нечем.
    it('падает на посеве не той формы', () => {
      expect(() => parseSeedBank([], GRAPH, 'посев.json')).toThrow(/ожидался объект/u);
      expect(() => parseSeedBank({ subject: 'физика', topics: [] }, GRAPH, 'посев.json')).toThrow(
        /поле subject/u,
      );
      expect(() => parseSeedBank({ subject: 'math' }, GRAPH, 'посев.json')).toThrow(
        /topics должно быть массивом/u,
      );
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

    // Не ENOENT: отсутствие файла — обычный случай, а вот каталог вместо файла
    // означает поломку настройки, и молчать о ней нельзя.
    it('сообщает о нечитаемом посевном файле, а не считает его отсутствующим', () => {
      mkdirSync(join(seedDir, 'math.json'));

      expect(() => loadSeedBank(db, GRAPH, { dir: seedDir })).toThrow(/не читается/u);
    });

    // Иначе дефект в одном файле оставлял бы без заданий все предметы разом:
    // вызывающие эту ошибку только пишут в stderr, и занятие вставало бы целиком.
    it('заливает здоровые предметы, даже когда файл соседнего испорчен', () => {
      writeFileSync(join(seedDir, 'math.json'), 'не json');
      writeSeed('russian', seedJson([{ topic_id: 'russian.a', tasks: batch(2) }], 'russian'));

      expect(() => loadSeedBank(db, GRAPH, { dir: seedDir })).toThrow(/не разбирается как JSON/u);
      expect(countAvailable(db, 'russian.a')).toBe(2);
    });

    // Файл разбирается, а падает уже запись: без перехвата вокруг неё один
    // такой `topic_id` в math.json оставлял бы без заданий и русский.
    it('заливает здоровые предметы, даже когда тема соседнего не заведена в базе', () => {
      db.prepare('DELETE FROM topic_state WHERE topic_id = ?').run('math.a');
      writeSeed('math', seedJson([{ topic_id: 'math.a', tasks: batch(2) }]));
      writeSeed('russian', seedJson([{ topic_id: 'russian.a', tasks: batch(2) }], 'russian'));

      expect(() => loadSeedBank(db, GRAPH, { dir: seedDir })).toThrow(
        /темы «math.a» нет в карте/u,
      );
      expect(countAvailable(db, 'russian.a')).toBe(2);
    });

    // Общий на файл перехват хоронил весь его остаток: отказ на первой теме
    // math.json оставлял бы без посева все следующие, а сообщение в stderr
    // выглядело бы как одна сломанная тема.
    it('заливает здоровые темы файла, даже когда соседняя тема не заведена в базе', () => {
      const wider = buildTopicGraph([topic('math.a'), topic('math.b'), topic('russian.a', { answerFormat: 'text' })]);
      syncTopicState(db, wider);
      db.prepare('DELETE FROM topic_state WHERE topic_id = ?').run('math.a');
      writeSeed(
        'math',
        seedJson([
          { topic_id: 'math.a', tasks: batch(2) },
          { topic_id: 'math.b', tasks: batch(3) },
        ]),
      );

      expect(() => loadSeedBank(db, wider, { dir: seedDir, subjects: ['math'] })).toThrow(
        /посев темы «math.a».*нет в карте/su,
      );
      expect(countAvailable(db, 'math.b')).toBe(3);
    });

    // Та же защита, но для отказа на разборе, а не на записи: тема, которую
    // переименовали в карте, роняла разбор всего файла — и предмет оставался без
    // посева целиком, то есть все его темы отвечали 503, пока codex недоступен.
    it('заливает здоровые темы файла, даже когда соседней темы нет в карте', () => {
      const wider = buildTopicGraph([topic('math.a'), topic('math.b')]);
      syncTopicState(db, wider);
      writeSeed(
        'math',
        seedJson([
          { topic_id: 'math.переименована', tasks: batch(2) },
          { topic_id: 'math.b', tasks: batch(3) },
        ]),
      );

      expect(() => loadSeedBank(db, wider, { dir: seedDir, subjects: ['math'] })).toThrow(
        /темы «math.переименована» нет в карте/u,
      );
      expect(countAvailable(db, 'math.b')).toBe(3);
    });

    // Предмет с испорченной записью обязан остаться в `subjects` ошибки: выгрузка
    // `prefetch --export` иначе переписала бы снимок огрызком банка, и потерянные
    // задания было бы уже не вернуть.
    it('помечает предмет испорченным даже тогда, когда часть его тем загрузилась', () => {
      const wider = buildTopicGraph([topic('math.a'), topic('math.b')]);
      syncTopicState(db, wider);
      writeSeed(
        'math',
        seedJson([
          { topic_id: 'math.переименована', tasks: batch(2) },
          { topic_id: 'math.b', tasks: batch(3) },
        ]),
      );

      try {
        loadSeedBank(db, wider, { dir: seedDir, subjects: ['math'] });
        expect.unreachable('загрузка обязана бросить SeedBankError');
      } catch (error) {
        expect(error).toBeInstanceOf(SeedBankError);
        expect((error as SeedBankError).subjects).toEqual(['math']);
        expect((error as SeedBankError).result.loaded).toBe(3);
      }
    });

    // Список виновных предметов — сигнал для выгрузки посева: предмет с
    // непрочитанным файлом лежит в базе огрызком, и по её содержимому это не
    // отличить от «предмет ещё не грели».
    it('называет предмет, файл посева которого не разобрался', () => {
      writeSeed('math', seedJson([{ topic_id: 'math.нет', tasks: batch(2) }]));
      writeSeed('russian', seedJson([{ topic_id: 'russian.a', tasks: batch(2) }], 'russian'));

      let caught: unknown;
      try {
        loadSeedBank(db, GRAPH, { dir: seedDir });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(SeedBankError);
      expect((caught as SeedBankError).subjects).toEqual(['math']);
      expect(countAvailable(db, 'russian.a')).toBe(2);
      // Частичный итог уходит вместе с ошибкой: без него вызывающий считал бы
      // здоровые предметы незагруженными.
      expect((caught as SeedBankError).result).toMatchObject({ loaded: 2, skipped: 0 });
    });

    // Предмет без файла посева от порчи соседнего не становится загруженным:
    // выгрузка `prefetch --export` по этому списку решает, можно ли переписать
    // снимок на пути `--out`.
    it('перечисляет предметы без файла даже когда посев сорвался', () => {
      writeSeed('math', seedJson([{ topic_id: 'math.нет', tasks: batch(2) }]));

      let caught: unknown;
      try {
        loadSeedBank(db, GRAPH, { dir: seedDir });
      } catch (error) {
        caught = error;
      }

      expect((caught as SeedBankError).result.missing).toEqual(['russian']);
    });

    // Файл разобрался, а упала запись одной темы: в банке всё равно не весь
    // посев предмета, значит выгружать его тоже нельзя.
    it('называет предмет, у которого не записалась одна тема', () => {
      const wider = buildTopicGraph([topic('math.a'), topic('math.b')]);
      syncTopicState(db, wider);
      db.prepare('DELETE FROM topic_state WHERE topic_id = ?').run('math.a');
      writeSeed(
        'math',
        seedJson([
          { topic_id: 'math.a', tasks: batch(2) },
          { topic_id: 'math.b', tasks: batch(3) },
        ]),
      );

      let caught: unknown;
      try {
        loadSeedBank(db, wider, { dir: seedDir, subjects: ['math'] });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(SeedBankError);
      expect((caught as SeedBankError).subjects).toEqual(['math']);
      expect(countAvailable(db, 'math.b')).toBe(3);
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
      storeTasks(db, 'math.a', [task({ instruction: 'Свежее задание: сколько будет 9 + 9?' })]);

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

    // Сервер терпит порчу посева при старте; здесь она пришлась бы на середину
    // занятия, то есть приехала бы ученику пятисоткой.
    it('отдаёт null на испорченном посевном файле, а не бросает', () => {
      writeFileSync(join(seedDir, 'math.json'), 'не json');

      expect(takeTaskOrSeed(db, GRAPH, 'math.a', { dir: seedDir })).toBeNull();
    });

    // `loadSeedBank` бросает уже после обхода всех тем: здоровые до банка
    // доехали, и отказ на соседней теме не повод прятать залитое задание — а
    // вместе с ним (из-за отметки в `seeded`) и весь остаток предмета.
    it('выдаёт задание, когда часть посева предмета не залилась', () => {
      const graph = buildTopicGraph([
        topic('math.a'),
        topic('math.b'),
        topic('russian.a', { answerFormat: 'text' }),
      ]);
      syncTopicState(db, graph);
      db.prepare('DELETE FROM topic_state WHERE topic_id = ?').run('math.b');
      writeSeed(
        'math',
        seedJson([
          { topic_id: 'math.a', tasks: batch(1) },
          { topic_id: 'math.b', tasks: batch(1) },
        ]),
      );

      const given = takeTaskOrSeed(db, graph, 'math.a', { dir: seedDir, seeded: new Set() });

      expect(given?.question).toBe('Задание 1: сколько будет 1 + 2?');
    });

    // Перебор тем в `nextTask` идёт по пяти кандидатам, и без набора каждый
    // промах очереди разбирал бы весь файл предмета заново — на живом запросе.
    it('не дозаливает посев одного предмета дважды за перебор', () => {
      writeSeed('math', seedJson([{ topic_id: 'math.a', tasks: batch(1) }]));
      const seeded = new Set<Subject>();

      expect(takeTaskOrSeed(db, GRAPH, 'math.a', { dir: seedDir, seeded })).not.toBeNull();
      writeSeed('math', seedJson([{ topic_id: 'math.a', tasks: batch(3) }]));

      expect(takeTaskOrSeed(db, GRAPH, 'math.a', { dir: seedDir, seeded })).toBeNull();
      // Без набора — обычное поведение: файл разбирается и пополняет очередь.
      expect(takeTaskOrSeed(db, GRAPH, 'math.a', { dir: seedDir })).not.toBeNull();
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

    // Отбраковал их не человек, а занятие: такое задание либо снова уехало бы
    // ученику, либо уронило бы разбор посевного файла и оставило бы весь предмет
    // без посева.
    it('не берёт в посев отбракованные задания', () => {
      const { stored } = storeTasks(db, 'math.a', [
        task(),
        task({ instruction: 'Второе задание: сколько будет 3 + 3?', answer: '6', accept: ['6'] }),
      ]);
      db.prepare("UPDATE task_bank SET status = 'rejected' WHERE id = ?").run(stored[0]?.id);

      const topics = collectSeedTasks(db, GRAPH, 'math');

      expect(topics[0]?.tasks.map((entry) => entry.answer)).toEqual(['6']);
    });

    it('падает на задании с повреждённым accept[]', () => {
      const { stored } = storeTasks(db, 'math.a', [task()]);
      db.prepare('UPDATE task_bank SET accept = ? WHERE id = ?').run('[4]', stored[0]?.id);

      expect(() => collectSeedTasks(db, GRAPH, 'math')).toThrow(/не массив строк/u);

      db.prepare('UPDATE task_bank SET accept = ? WHERE id = ?').run('{не json', stored[0]?.id);

      expect(() => collectSeedTasks(db, GRAPH, 'math')).toThrow(/не разбирается как JSON/u);
    });

    // Колонки `hint`, `explain` и `joke` допускают NULL, а схема батча требует
    // непустых строк. Выгрузив NULL пустой строкой, экспорт переписал бы снимок
    // файлом, который `readSeedBank` отвергает целиком, — предмет остался бы без
    // посева ровно тогда, когда посев и нужен.
    it('падает на задании с пустым hint, explain или joke', () => {
      const { stored } = storeTasks(db, 'math.a', [task()]);
      const id = stored[0]?.id;

      for (const column of ['hint', 'explain', 'joke']) {
        db.prepare(`UPDATE task_bank SET ${column} = NULL WHERE id = ?`).run(id);

        expect(() => collectSeedTasks(db, GRAPH, 'math')).toThrow(
          new RegExp(`пустое поле ${column}`, 'u'),
        );

        const restored = column === 'hint'
          ? 'Вспомни правило сложения. Проверь результат обратным действием.'
          : 'что-то';
        db.prepare(`UPDATE task_bank SET ${column} = ? WHERE id = ?`).run(restored, id);
      }

      expect(collectSeedTasks(db, GRAPH, 'math')).toHaveLength(1);
    });

    // Банк держит инварианты формата на момент вставки, а `answer_format` темы
    // мог смениться потом — пересборкой карты тем при том же `id`. Строки при
    // этом остаются законными, но выгруженный из них файл `parseSeedBank`
    // отвергнет целиком, и предмет остался бы без посева навсегда: старый
    // снимок к тому моменту уже переписан.
    it('падает, когда задания не пройдут разбор под текущим answer_format темы', () => {
      storeTasks(db, 'russian.a', [
        task({
          instruction: 'Запиши ответ словами.',
          answer: 'сорок пять',
          accept: ['сорок пять'],
          hint: 'Определи соседние десятки. Затем запиши число словами.',
        }),
      ]);

      expect(collectSeedTasks(db, GRAPH, 'russian')).toHaveLength(1);

      const renamedFormat = buildTopicGraph([topic('russian.a', { answerFormat: 'number' })]);

      expect(() => collectSeedTasks(db, renamedFormat, 'russian')).toThrow(
        /не пройдёт обратный разбор/u,
      );
    });
  });

  describe('посев в репозитории', () => {
    const graph = loadCurriculum();

    it('проходит проверки разбора батча целиком', () => {
      const hintsByTopic = new Map<string, Set<string>>();
      for (const subject of SUBJECTS) {
        const bank = readSeedBank(graph, subject, SEED_BANK_DIR);

        expect(bank, `посев предмета ${subject} отсутствует`).not.toBeNull();
        // Именно `problems`, а не отсутствие исключения: негодную запись разбор
        // теперь выбрасывает молча, и без этой проверки тест зеленел бы на
        // посеве, половина которого до банка не доезжает.
        expect(bank?.problems, `посев предмета ${subject}`).toEqual([]);
        for (const entry of bank?.topics ?? []) {
          for (const seededTask of entry.tasks) {
            expect(seededTask.instruction, `${entry.topicId}: instruction`).not.toBe('');
            expect(seededTask.material_format, `${entry.topicId}: material_format`).toMatch(
              /^(none|text|math)$/u,
            );
            expect(seededTask.choices, `${entry.topicId}: choices`).toBeInstanceOf(Array);
            const sentences = seededTask.hint.trim().split(/(?<=[.!?])(?:\s+|$)/u).filter(Boolean);
            expect(sentences.length, `${entry.topicId}: подробная подсказка`).toBeGreaterThanOrEqual(2);
            expect(sentences.length, `${entry.topicId}: подробная подсказка`).toBeLessThanOrEqual(4);
            expect(seededTask.hint, `${entry.topicId}: путь решения`).toMatch(
              /[?]|если|проверь|провер|подстав|подстан|исключ|сравн|перечитай|оцен|убед|прикин|прислуш|подум|смотр|установ|определ|свер|вспом|реши|найди|постав|произнес|спрашив/iu,
            );
            // Предметное наблюдение не обязано называть школьный термин:
            // «найди общее количество, затем вычти» — полноценное правило, но
            // словарный regex его только ложно бракует. Содержательность и
            // безопасность проверяются независимым валидатором при генерации;
            // здесь проверяются измеримые контрактные признаки подсказки.
            const topicHints = hintsByTopic.get(entry.topicId) ?? new Set<string>();
            expect(topicHints.has(seededTask.hint), `${entry.topicId}: подсказка относится к заданию`)
              .toBe(false);
            topicHints.add(seededTask.hint);
            hintsByTopic.set(entry.topicId, topicHints);
            expect(seededTask.instruction, `${entry.topicId}: естественная инструкция`)
              .not.toContain('фрагмент ниже');
            expect(seededTask.hint, `${entry.topicId}: без артефактов шаблона`)
              .not.toMatch(/(?:пропуск|placeholder|undefined|null)\d+/iu);
            expect(seededTask.hint, `${entry.topicId}: без подменённой ссылки на условие`)
              .not.toMatch(/Разбери именно это условие:[^.!?]*пропуск/iu);
          }
        }
      }
      expect([...hintsByTopic.values()].every((hints) => hints.size > 0)).toBe(true);
      const math = readSeedBank(graph, 'math', SEED_BANK_DIR);
      expect(math?.topics.flatMap((entry) => entry.tasks)
        .filter((seededTask) => seededTask.material_format === 'math').length).toBeGreaterThan(5);
    });

    it('содержит не меньше 30 заданий на предмет', () => {
      for (const subject of SUBJECTS) {
        const bank = readSeedBank(graph, subject, SEED_BANK_DIR);
        const count = (bank?.topics ?? []).reduce((sum, entry) => sum + entry.tasks.length, 0);

        expect(count, `посев предмета ${subject}`).toBeGreaterThanOrEqual(30);
      }
    });

    // Посев заливается при открытии базы ребёнка, а не при старте сервера: баз
    // у сервера столько, сколько детей, и открывается база по первому обращению.
    it('заливается при открытии базы ребёнка, а второй старт ничего не добавляет', async () => {
      const dataDir = join(tempDir, 'данные');
      const first = await startTenantServer({ dataDir });
      const dbPath = first.dbPath;
      await first.close();

      const fresh = openDatabase(dbPath);
      const count = (): number =>
        (fresh.prepare('SELECT COUNT(*) AS n FROM task_bank').get() as { n: number }).n;
      const seeded = count();

      const second = buildServer(undefined, { dataDir });
      await second.inject({ method: 'GET', url: '/api/gate/status', headers: childHeaders(first.childToken) });
      await second.close();

      expect(seeded).toBeGreaterThanOrEqual(90);
      expect(count()).toBe(seeded);
      fresh.close();
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
