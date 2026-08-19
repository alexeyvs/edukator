import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { openDatabase, SUBJECTS, type Subject } from '../server/db.js';
import { countAvailable } from '../server/codex/bank.js';
import { CodexUnavailableError } from '../server/codex/client.js';
import type { GeneratedTask } from '../server/codex/task-schema.js';
import type { ProduceRequest } from '../server/codex/worker.js';
import {
  DEFAULT_CYCLES,
  parseArgs,
  prefetch,
  prefetchChildren,
  prefetchChildrenFailed,
  prefetchFailed,
} from '../scripts/prefetch.js';
import {
  CODEX_DAILY_QUOTA,
  childDatabasePath,
  createChild,
  createParent,
  disableParent,
  openControlDatabase,
  readCodexQuota,
  reserveCodexCall,
  type ChildStatus,
} from '../server/control-db.js';
import { controlDatabasePath, ensureDataDir, provisionChildDatabase } from '../server/data-dir.js';
import { acquireDataLock, dataLockPath, SERVER_LOCK_OWNER } from '../server/data-lock.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsxCli = join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const prefetchCli = join(projectRoot, 'scripts', 'prefetch.ts');

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
    instruction: `Задание ${counter} по теме ${topicId}: сколько монет останется?`, material: '', material_format: 'none', choices: [],
    answer: '45',
    accept: ['45', '45 монет'],
    hint: 'Определи нужные действия. Проверь вычисление обратным действием.',
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
    // База заводится заранее, как её заводит появление ребёнка: сам прогрев
    // отсутствующий файл считает отказом, а не поводом создать пустую базу.
    openDatabase(dbPath).close();
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
                instruction: `Посевное задание ${index + 1}: сколько будет ${index + 1} + 2?`,
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

    it('не переписывает посевной файл предмета, которого нет в банке', async () => {
      const outDir = join(tempDir, 'out');
      mkdirSync(outDir);
      const existing = JSON.stringify({ subject: 'math', topics: [] }, null, 2);
      for (const subject of SUBJECTS) {
        writeFileSync(join(outDir, `${subject}.json`), existing);
      }

      // Генерация ничего не вернула: в базе нет ни одного задания. Пустая
      // выгрузка поверх снимка уничтожила бы то, ради чего снимок и держат.
      const result = await run({
        topics: 3,
        batches: 1,
        exportSeed: true,
        outDir,
        produce: () => Promise.resolve([]),
      });

      expect(result.exported).toEqual([]);
      expect(result.exportFailed).toEqual(SUBJECTS);
      expect(prefetchFailed(result)).toBe(true);
      for (const subject of SUBJECTS) {
        expect(readFileSync(join(outDir, `${subject}.json`), 'utf8')).toBe(existing);
      }
      expect(logged.join('\n')).toMatch(/не переписан/u);
    });

    // Проверки на пустоту тут мало: переименованная в карте тема роняет разбор
    // всего файла, а долитый следом батч делает предмет непустым — снимок из
    // полусотни заданий сменился бы горсткой свежесгенерированных.
    it('не переписывает посевной файл предмета, который не загрузился', async () => {
      const outDir = join(tempDir, 'out');
      mkdirSync(outDir);
      const snapshot = JSON.stringify({ subject: 'math', topics: [] }, null, 2);
      writeFileSync(join(outDir, 'math.json'), snapshot);
      // Тема, которой нет в карте: разбор посева математики падает целиком.
      writeFileSync(
        join(seedDir, 'math.json'),
        JSON.stringify({ subject: 'math', topics: [{ topic_id: 'math.старая', tasks: [] }] }),
      );

      const result = await run({ topics: 3, batches: 1, exportSeed: true, outDir });

      const db = openDatabase(dbPath);
      try {
        expect(countAvailable(db, 'math.a')).toBeGreaterThan(0);
      } finally {
        db.close();
      }
      expect(result.exported).not.toContain(join(outDir, 'math.json'));
      expect(readFileSync(join(outDir, 'math.json'), 'utf8')).toBe(snapshot);
      expect(logged.join('\n')).toMatch(/посев math: файл не загрузился/u);
      // Осторожность осторожностью, а прогон провален: просили файлы, а снимок
      // математики остался прежним — с нулём на выходе это неотличимо от удачи.
      expect(result.exportFailed).toEqual(['math']);
      expect(prefetchFailed(result)).toBe(true);
    });

    // `--seed-dir` мимо `--out`: посева на входе не было, значит в банке лежит
    // только нагенерированное, а по пути выгрузки — полный чужой снимок.
    it('не переписывает чужой снимок предмета, посева которого не было на входе', async () => {
      const outDir = join(tempDir, 'out');
      mkdirSync(outDir);
      const snapshot = JSON.stringify({ subject: 'russian', topics: [] }, null, 2);
      writeFileSync(join(outDir, 'russian.json'), snapshot);
      writeFileSync(join(outDir, 'math.json'), JSON.stringify({ subject: 'math', topics: [] }));
      // У математики посев на входе есть — её снимок обновляется как обычно.
      writeFileSync(
        join(seedDir, 'math.json'),
        JSON.stringify({
          subject: 'math',
          topics: [{ topic_id: 'math.a', tasks: [task('math.a')] }],
        }),
      );

      const result = await run({ topics: 3, exportSeed: true, outDir });

      expect(result.exported).toContain(join(outDir, 'math.json'));
      expect(result.exported).not.toContain(join(outDir, 'russian.json'));
      expect(readFileSync(join(outDir, 'russian.json'), 'utf8')).toBe(snapshot);
      expect(logged.join('\n')).toMatch(/посев russian: исходного файла не было/u);
      expect(result.exportFailed).toContain('russian');
      expect(prefetchFailed(result)).toBe(true);
    });

    // Строка банка без подсказки не пройдёт обратную загрузку, и `collectSeedTasks`
    // на ней падает. Обрыв всей выгрузки этой ошибкой оставлял бы часть файлов
    // обновлённой, а часть — прежней: набор перестал бы быть одним снимком.
    it('пропускает предмет с битой строкой банка и выгружает остальные', async () => {
      await run({ topics: 3 });

      const db = openDatabase(dbPath);
      try {
        db.prepare(`UPDATE task_bank SET hint = '' WHERE topic_id = 'math.a'`).run();
      } finally {
        db.close();
      }

      const result = await run({ topics: 3, exportSeed: true, outDir: seedDir });

      expect(result.exportFailed).toEqual(['math']);
      expect(prefetchFailed(result)).toBe(true);
      expect(result.exported).toHaveLength(SUBJECTS.length - 1);
      for (const subject of SUBJECTS.filter((item) => item !== 'math')) {
        expect(result.exported).toContain(join(seedDir, `${subject}.json`));
      }
      expect(existsSync(join(seedDir, 'math.json'))).toBe(false);
      expect(logged.join('\n')).toMatch(/посев math: снимок не собрался/u);
    });

    // Запись падает не реже сборки: каталог на месте файла, права, место на
    // диске. Обрыв на ней ещё заметнее — часть снимков уже переписана.
    it('пропускает предмет, снимок которого не записался, и выгружает остальные', async () => {
      const outDir = join(tempDir, 'out');
      mkdirSync(outDir);
      // Каталог вместо файла: переименование временного файла поверх него падает.
      mkdirSync(join(outDir, 'math.json'));
      // Посев на входе есть у всех: иначе предмет отсеялся бы раньше записи.
      for (const subject of SUBJECTS) {
        writeFileSync(
          join(seedDir, `${subject}.json`),
          JSON.stringify({
            subject,
            topics: [{ topic_id: `${subject}.a`, tasks: [task(`${subject}.a`)] }],
          }),
        );
      }

      const result = await run({ topics: 3, exportSeed: true, outDir });

      expect(result.exportFailed).toEqual(['math']);
      expect(prefetchFailed(result)).toBe(true);
      expect(result.exported).toHaveLength(SUBJECTS.length - 1);
      for (const subject of SUBJECTS.filter((item) => item !== 'math')) {
        expect(result.exported).toContain(join(outDir, `${subject}.json`));
      }
      expect(logged.join('\n')).toMatch(/посев math: снимок не записан/u);
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

    // `CodexUnavailableError` покрывает не всякий отказ: просроченная
    // авторизация, кончившаяся квота и обрыв сети приезжают ненулевым кодом
    // возврата и до `codexUnavailable` не доходят. Без второй остановки
    // `--cycles 3` трижды гонял бы все голодные темы по десять минут на вызов,
    // зная заранее, что ни одна не долилась. Воркер так и делает.
    it('прекращает циклы, когда ни одна голодная тема не долилась', async () => {
      const result = await run({
        topics: 3,
        cycles: 3,
        produce: () => Promise.reject(new Error('codex завершился с кодом 1')),
      });

      expect(result.cycles).toHaveLength(1);
      expect(result.cycles[0]?.codexUnavailable).toBe(false);
      expect(logged.join('\n')).toMatch(/прерван: ни одна из 3 голодных тем не пополнена/u);
    });

    // Обратная сторона той же остановки: пока очередь греется, циклы обязаны
    // доигрываться — иначе одна упавшая тема обрывала бы весь прогон.
    it('не прекращает циклы, пока хотя бы одна тема долилась', async () => {
      let failing: string | null = null;
      const result = await run({
        topics: 2,
        cycles: 2,
        produce: (request: ProduceRequest) => {
          failing ??= request.topic.id;
          return request.topic.id === failing
            ? Promise.reject(new Error('codex завершился с кодом 1'))
            : Promise.resolve(Array.from({ length: 5 }, () => task(request.topic.id)));
        },
      });

      expect(result.cycles).toHaveLength(2);
      // И прогон при этом удачен. Долитая в первом цикле тема во втором уже
      // тёплая и в голодные не попадает, так что во втором цикле остаётся ровно
      // упавшая — «ни одна голодная тема не пополнена» становится истинным на
      // прогоне, который наполнил банк. Меряя признак по каждому циклу,
      // `--cycles 2` выходил единицей и рвал `&&`-цепочку, ради которой заведён.
      expect(prefetchFailed(result)).toBe(false);
      expect(result.cycles[1]?.refilled.every((refill) => refill.stored === 0)).toBe(true);
    });

    it('считает провалом прогон, не давший ни одного задания за все циклы', async () => {
      const result = await run({
        topics: 2,
        cycles: 2,
        produce: () => Promise.reject(new Error('codex завершился с кодом 1')),
      });

      expect(prefetchFailed(result)).toBe(true);
    });

    it('переживает битый посев и всё равно наполняет банк', async () => {
      // Генерация от посева не зависит, а prefetch — единственный способ греть
      // очередь: одна битая тема не должна оставлять банк пустым.
      writeFileSync(join(seedDir, 'math.json'), '{ это не json');

      const result = await run({ topics: 1 });

      expect(logged.join('\n')).toMatch(/посев не загружен/u);
      expect(result.cycles[0]?.refilled[0]?.stored).toBeGreaterThan(0);
    });

    // Порог долива по умолчанию — `REFILL_BELOW = 4`, а воркер отвергает порог
    // выше запаса: без прижимания к запасу `--target 2` падал бы уже после
    // того, как посев записан в базу, называя число, которого из командной
    // строки было нечем задать.
    it('греет тему до запаса меньше порога по умолчанию', async () => {
      const result = await run({ topics: 1, target: 2 });

      expect(result.cycles[0]?.refilled[0]?.stored).toBeGreaterThan(0);
      expect(result.cycles[0]?.refilled[0]?.available).toBeGreaterThanOrEqual(2);
    });

    // Один `--target` уже тёплую тему не углубляет: долив меряется порогом.
    it('добирает тему выше порога, когда порог поднят вместе с запасом', async () => {
      await run({ topics: 1, target: 5 });

      const deepened = await run({ topics: 1, target: 10, threshold: 10 });
      expect(deepened.cycles[0]?.refilled[0]?.stored).toBeGreaterThan(0);

      const untouched = await run({ topics: 1, target: 20 });
      expect(untouched.cycles[0]?.refilled).toEqual([]);
    });

    it('заданный руками порог выше запаса всё равно отвергает', async () => {
      await expect(run({ topics: 1, target: 2, threshold: 5 })).rejects.toThrow(
        /порог долива 5 выше запаса 2/u,
      );
    });

    // Прогон, не давший ничего, обязан отличаться кодом возврата от «всё уже
    // тёплое»: `prefetch` зовут из `&&`-цепочек и заданий по расписанию.
    it('считает провалом недоступный codex и цикл без единой долитой темы', async () => {
      const unavailable = await run({
        topics: 2,
        produce: () => Promise.reject(new CodexUnavailableError('codex не найден')),
      });
      expect(prefetchFailed(unavailable)).toBe(true);

      const allFailed = await run({
        topics: 2,
        produce: () => Promise.reject(new Error('codex завершился с кодом 1')),
      });
      expect(allFailed.cycles[0]?.codexUnavailable).toBe(false);
      expect(prefetchFailed(allFailed)).toBe(true);
    });

    it('не считает провалом успешный прогон', async () => {
      expect(prefetchFailed(await run({ topics: 2 }))).toBe(false);
    });

    // Иначе провалом объявлялся бы любой прогон с одной кривой темой, хотя
    // очередь пополнилась: `&&`-цепочка обрывалась бы на здоровой модели.
    it('не считает провалом отказ одной темы из двух', async () => {
      let failing: string | null = null;
      const partial = await run({
        topics: 2,
        produce: (request: ProduceRequest) => {
          failing ??= request.topic.id;
          return request.topic.id === failing
            ? Promise.reject(new Error('codex завершился с кодом 1'))
            : Promise.resolve(Array.from({ length: 5 }, () => task(request.topic.id)));
        },
      });

      expect(partial.cycles[0]?.refilled).toHaveLength(2);
      expect(partial.cycles[0]?.refilled.filter((refill) => refill.error !== undefined)).toHaveLength(1);
      expect(prefetchFailed(partial)).toBe(false);
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
        '--threshold', '10',
        '--batches', '2',
        '--cycles', '3',
        '--model', 'gpt-5.6-luna',
        '--export',
      ]);

      expect(options).toMatchObject({
        topics: 4,
        target: 10,
        threshold: 10,
        batches: 2,
        cycles: 3,
        model: 'gpt-5.6-luna',
        exportSeed: true,
      });
    });

    // Пустое значение — не «не задано»: `--model ''` уходит в codex как `-m ''`
    // (умолчание берётся по `??`), и каждый батч падает уже в модели.
    it('падает на пустом значении текстового флага', () => {
      expect(() => parseArgs(['--model', ''])).toThrow(/пустое значение/u);
      expect(() => parseArgs(['--model', '  '])).toThrow(/пустое значение/u);
      expect(() => parseArgs(['--data-dir', ''])).toThrow(/пустое значение/u);
      expect(() => parseArgs(['--child', ' '])).toThrow(/пустое значение/u);
    });

    // Кого греть — единственное, чего у прогрева нет по умолчанию: баз столько,
    // сколько детей, и молчаливый выбор грел бы очередь не тому ученику.
    it('разбирает выбор ребёнка', () => {
      expect(parseArgs(['--child', 'ребёнок-1'])).toMatchObject({ childId: 'ребёнок-1' });
      expect(parseArgs(['--all'])).toMatchObject({ allChildren: true });
      expect(() => parseArgs(['--all', '--all'])).toThrow(/указан дважды/u);
    });

    // Все четыре сразу: перепутанные местами `--curriculum` и `--seed-dir`
    // разбираются без ошибки и молча читают чужой каталог.
    it('превращает пути в абсолютные и кладёт каждый в своё поле', () => {
      const options = parseArgs([
        '--out', 'content/seed-bank',
        '--data-dir', 'data',
        '--curriculum', 'content/curriculum',
        '--seed-dir', 'content/seed-bank-2',
      ]);

      expect(options.outDir?.endsWith('/content/seed-bank')).toBe(true);
      expect(options.dataDir?.endsWith('/data')).toBe(true);
      expect(options.curriculumDir?.endsWith('/content/curriculum')).toBe(true);
      expect(options.seedDir?.endsWith('/content/seed-bank-2')).toBe(true);
      for (const path of [options.outDir, options.dataDir, options.curriculumDir, options.seedDir]) {
        expect(path?.startsWith('/')).toBe(true);
      }
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
      expect(() => parseArgs(['--topics', 'много'])).toThrow(/ожидает целое число/u);
    });

    // Ноль даёт цикл, который молча ничего не делает, а «99999999999999999999»
    // проходит `/^\d+$/` и превращается в 1e20 настоящих вызовов codex.
    it('падает на нуле и на числе за пределом точного целого', () => {
      expect(() => parseArgs(['--batches', '0'])).toThrow(/не меньше 1/u);
      expect(() => parseArgs(['--cycles', '0'])).toThrow(/не меньше 1/u);
      expect(() => parseArgs(['--topics', '99999999999999999999'])).toThrow(/не меньше 1/u);
    });
  });

  describe('обход детей', () => {
    let dataDir: string;

    /** Заводит ребёнка; без `provision` его база не создаётся — он `provisioning`. */
    function newChild(name: string, provision = true): string {
      const control = openControlDatabase(controlDatabasePath(dataDir));
      try {
        const parentId = createParent(control, `${name}@example.com`);
        const childId = createChild(control, parentId, name);
        if (provision) provisionChildDatabase(control, childId, dataDir);
        return childId;
      } finally {
        control.close();
      }
    }

    function childStatus(childId: string): ChildStatus | undefined {
      const control = openControlDatabase(controlDatabasePath(dataDir));
      try {
        return (
          control.prepare('SELECT status FROM children WHERE id = ?').get(childId) as
            | { status: ChildStatus }
            | undefined
        )?.status;
      } finally {
        control.close();
      }
    }

    function sweep(patch: Record<string, unknown> = {}): ReturnType<typeof prefetchChildren> {
      return prefetchChildren({
        dataDir,
        curriculumDir,
        seedDir,
        topics: 1,
        log,
        produce: (request: ProduceRequest) =>
          Promise.resolve(Array.from({ length: 5 }, () => task(request.topic.id))),
        ...patch,
      });
    }

    beforeEach(() => {
      dataDir = ensureDataDir(join(tempDir, 'данные'));
    });

    it('греет базу указанного ребёнка и снимает замок', async () => {
      const childId = newChild('первый');

      const result = await sweep({ childId });

      expect(result.children.map((child) => child.childId)).toEqual([childId]);
      expect(prefetchChildrenFailed(result)).toBe(false);
      const db = openDatabase(join(dataDir, 'children', `${childId}.db`));
      try {
        const warmed = SUBJECTS.filter((subject) => countAvailable(db, `${subject}.a`) > 0);
        expect(warmed).toHaveLength(1);
      } finally {
        db.close();
      }
      // Замок обязан уйти вместе с прогревом: иначе следующий запуск сервера
      // упёрся бы в замок процесса, которого давно нет.
      expect(existsSync(dataLockPath(dataDir))).toBe(false);
    });

    // Живой сервер держит ту же пару слотов codex: второй процесс сделал бы их
    // четыре, и ответ ученику встал бы в очередь за прогревом. Замок пишется
    // руками от чужого живого номера: свой процесс замок делит с собой же
    // (см. `server/data-lock.ts`), а поднимать настоящий сервер тест не обязан.
    it('отказывается при живом сервере и называет причину', async () => {
      const childId = newChild('первый');
      writeFileSync(
        dataLockPath(dataDir),
        JSON.stringify({
          pid: process.ppid,
          owner: SERVER_LOCK_OWNER,
          since: '2026-08-19T10:00:00.000Z',
          nonce: 'чужой',
        }),
        { flag: 'wx' },
      );

      await expect(sweep({ childId })).rejects.toThrow(/занят: сервер \(pid \d+\)/u);
      await expect(sweep({ childId })).rejects.toThrow(/остановите сервер/u);

      // Свободный замок работать не мешает: отказ обязан быть про сервер, а не
      // про сам факт замка.
      rmSync(dataLockPath(dataDir));
      const result = await sweep({ childId });
      expect(result.children).toHaveLength(1);
    });

    // Квота стоит на расходе ребёнка за московские сутки, а не на способе
    // запуска: считай её только сервер, `npm run prefetch -- --all --cycles 3`
    // тратил бы модель незаметно и оставлял бы диспетчеру полный счётчик на те
    // же сутки — то есть предела не было бы вовсе.
    it('списывает суточную квоту ребёнка на свои вызовы модели', async () => {
      const childId = newChild('первый');
      let calls = 0;

      // Неудачный вызов списывается наравне с удачным — иначе зацикливание на
      // ошибках обходит саму защиту.
      const result = await prefetchChildren({
        dataDir,
        childId,
        curriculumDir,
        seedDir,
        topics: 1,
        log,
        run: () => {
          calls += 1;
          return Promise.reject(new Error('модель не ответила'));
        },
      });

      expect(calls).toBeGreaterThan(0);
      expect(prefetchChildrenFailed(result)).toBe(true);
      const control = openControlDatabase(controlDatabasePath(dataDir));
      try {
        expect(readCodexQuota(control, childId).used).toBe(calls);
      } finally {
        control.close();
      }
    });

    it('не зовёт модель, когда суточная квота ребёнка исчерпана', async () => {
      const childId = newChild('первый');
      const control = openControlDatabase(controlDatabasePath(dataDir));
      try {
        for (let i = 0; i < CODEX_DAILY_QUOTA; i += 1) reserveCodexCall(control, childId);
      } finally {
        control.close();
      }

      const result = await prefetchChildren({
        dataDir,
        childId,
        curriculumDir,
        seedDir,
        topics: 1,
        log,
        run: () => Promise.reject(new Error('прогрев зовёт модель мимо исчерпанной квоты')),
      });

      // Исчерпанная квота неотличима от недоступной модели: заход обрывается,
      // а обход остальных детей идёт дальше.
      expect(result.children[0]?.cycles[0]?.codexUnavailable).toBe(true);
      // Но названа она своим именем и провалом обхода не считается: квота —
      // предел расхода, а не поломка, и ночной `--all` в `&&`-цепочке не имеет
      // права разваливаться из-за ребёнка, который днём назанимался на все
      // шестьдесят вызовов.
      expect(result.children[0]?.quotaExhausted).toBe(true);
      expect(prefetchFailed(result.children[0]!)).toBe(false);
      expect(prefetchChildrenFailed(result)).toBe(false);
      expect(logged.some((line) => /суточная квота codex исчерпана/u.test(line))).toBe(true);
      expect(logged.every((line) => !/codex недоступен/u.test(line))).toBe(true);
    });

    it('требует выбрать ребёнка', async () => {
      await expect(sweep()).rejects.toThrow(/--child <id> или --all/u);
      await expect(sweep({ childId: 'кто-то', allChildren: true })).rejects.toThrow(
        /вместе не имеют смысла/u,
      );
      // Отказ до замка: иначе опечатка в аргументах оставляла бы каталог
      // запертым до конца процесса.
      expect(existsSync(dataLockPath(dataDir))).toBe(false);
    });

    it('греет всех готовых детей и не трогает незаведённого', async () => {
      const first = newChild('первый');
      const second = newChild('второй');
      const pending = newChild('третий', false);
      expect(childStatus(pending)).toBe('provisioning');

      const result = await sweep({ allChildren: true });

      expect(result.children.map((child) => child.childId).sort()).toEqual([first, second].sort());
    });

    it('провалившимся считает обход, где не догрелся хотя бы один', async () => {
      const first = newChild('первый');
      const second = newChild('второй');

      // Один ребёнок не догрелся, второй догрелся: `--all` зовут перед занятием
      // всей семьи, и «двое из трёх» значит, что третий сядет за пустую очередь.
      // Проверка «все провалились» здесь дала бы `false` и код возврата 0.
      // Недоступность обрывает обход того ребёнка, на котором случилась, и
      // прогрев идёт к следующему: первый остаётся ни с чем, второй догревается.
      let calls = 0;
      const result = await sweep({
        allChildren: true,
        produce: (request: ProduceRequest) => {
          calls += 1;
          return calls === 1
            ? Promise.reject(new CodexUnavailableError('codex не найден'))
            : Promise.resolve(Array.from({ length: 5 }, () => task(request.topic.id)));
        },
      });

      // Кто из двоих окажется первым, решает `ORDER BY created_at, id`: секунда
      // у них одна, а `id` случайный, поэтому проверяется не имя, а расклад —
      // ровно один не догрелся, ровно один догрелся.
      expect(result.children.map((child) => child.childId).sort()).toEqual([first, second].sort());
      const unavailable = result.children
        .filter((child) => child.cycles.some((cycle) => cycle.codexUnavailable));
      expect(unavailable).toHaveLength(1);
      expect(prefetchChildrenFailed(result)).toBe(true);
    });

    // `npm run parent -- disable` — единственный рычаг «перестать обслуживать
    // семью», и `--all` отсекает такого ребёнка выборкой. Обойти рычаг именем
    // ребёнка нельзя: иначе отключённая семья продолжала бы тратить настоящие
    // вызовы модели и свою суточную квоту.
    it('отказывается греть ребёнка отключённого родителя и по имени, и в обходе', async () => {
      const disabled = newChild('первый');
      const active = newChild('второй');
      const control = openControlDatabase(controlDatabasePath(dataDir));
      try {
        const row = control.prepare('SELECT parent_id FROM children WHERE id = ?')
          .get(disabled) as { parent_id: string };
        expect(disableParent(control, row.parent_id)).toBe(true);
      } finally {
        control.close();
      }

      await expect(sweep({ childId: disabled })).rejects.toThrow(/родитель отключён/u);
      const result = await sweep({ allChildren: true });
      expect(result.children.map((child) => child.childId)).toEqual([active]);
      // Замок снимается и после отказа.
      expect(existsSync(dataLockPath(dataDir))).toBe(false);
    });

    it('отказывается греть ребёнка без базы и незнакомого', async () => {
      const pending = newChild('третий', false);

      await expect(sweep({ childId: pending })).rejects.toThrow(/статус provisioning/u);
      await expect(sweep({ childId: 'нет-такого' })).rejects.toThrow(/нет в управляющей базе/u);
      // Замок снимается и после отказа: `finally`, а не «в конце удачного пути».
      expect(existsSync(dataLockPath(dataDir))).toBe(false);
    });

    it('не отменяет прогрев остальных из-за одного ребёнка без базы', async () => {
      const first = newChild('первый');
      const broken = newChild('второй');
      const third = newChild('третий');
      // База пропала у `ready`-ребёнка: ровно тот случай, который отдельно
      // разбирает и снятие копии. Прогрев открывает её с `fileMustExist`, так
      // что заход бросает — и без изоляции уносил бы с собой и отчёт первого,
      // и очередь третьего.
      rmSync(childDatabasePath(dataDir, broken));

      const result = await sweep({ allChildren: true });

      // Порядок обхода задан `ORDER BY created_at, id`, а `id` случайный: имена
      // сравниваются множеством, иначе тест краснел бы от совпавшей секунды.
      expect(result.children.map((child) => child.childId).sort()).toEqual([first, third].sort());
      expect(result.failed.map((child) => child.childId)).toEqual([broken]);
      // Отказ не растворяется: код возврата обязан его назвать.
      expect(prefetchChildrenFailed(result)).toBe(true);
      // Файл не воскрешён: `fileMustExist` не даёт завести пустую базу поверх потерянной.
      expect(existsSync(childDatabasePath(dataDir, broken))).toBe(false);
      for (const id of [first, third]) {
        const db = openDatabase(childDatabasePath(dataDir, id));
        try {
          expect(SUBJECTS.some((subject) => countAvailable(db, `${subject}.a`) > 0)).toBe(true);
        } finally {
          db.close();
        }
      }
    });

    it('отказывается выгружать посев на обходе всех', async () => {
      newChild('первый');

      await expect(sweep({ allChildren: true, exportSeed: true })).rejects.toThrow(
        /--export требует одного ребёнка/u,
      );
    });

    it('называет виноватым каталог, а не сервер, когда управляющей базы нет', async () => {
      // Замок каталога создаёт сам каталог, поэтому опечатка в `--data-dir`
      // выглядела бы обжитым, но пустым сервером: без этой проверки рядом
      // заводилась бы пустая управляющая база и прогрев отчитывался бы
      // «нет ни одного готового ребёнка».
      await expect(sweep({ allChildren: true })).rejects.toThrow(/нет управляющей базы/u);
      expect(existsSync(controlDatabasePath(dataDir))).toBe(false);
    });

    it('отказывается, когда готовых детей нет', async () => {
      // Управляющая база есть, детей в ней нет: это уже про сервер, а не про каталог.
      openControlDatabase(controlDatabasePath(dataDir)).close();

      await expect(sweep({ allChildren: true })).rejects.toThrow(/нет ни одного готового ребёнка/u);
    });
  });

  describe('prefetch CLI', () => {
    let cliDataDir: string;
    let cliChildId: string;

    beforeEach(() => {
      cliDataDir = ensureDataDir(join(tempDir, 'cli-данные'));
      const control = openControlDatabase(controlDatabasePath(cliDataDir));
      try {
        const parentId = createParent(control, 'cli@example.com');
        cliChildId = createChild(control, parentId, 'Ученик');
        provisionChildDatabase(control, cliChildId, cliDataDir);
      } finally {
        control.close();
      }
    });

    function runCli(args: string[]): ReturnType<typeof spawnSync> {
      return spawnSync(process.execPath, [tsxCli, prefetchCli, ...args], {
        encoding: 'utf8',
        // Пустой `PATH` — та же защита, что в остальных тестах: настоящий codex
        // не зовёт ни один из них.
        env: { ...process.env, PATH: '' },
      });
    }

    it('возвращает код 1, когда запрошенная выгрузка не состоялась', () => {
      const outDir = join(tempDir, 'cli-out');
      mkdirSync(outDir);

      const result = runCli([
        '--topics', '1',
        '--cycles', '1',
        '--export',
        '--data-dir', cliDataDir,
        '--child', cliChildId,
        '--curriculum', curriculumDir,
        '--seed-dir', seedDir,
        '--out', outDir,
      ]);

      expect(result.status).toBe(1);
      expect(result.stdout).toMatch(/посев выгружен в 0 файл/u);
      expect(result.stderr).toMatch(/наполнение не удалось/u);
    });

    // Без выбора ребёнка запуск обязан кончиться до первого вызова модели:
    // «погрел кого-то» тут хуже отказа.
    it('возвращает код 1 без выбора ребёнка', () => {
      const result = runCli(['--data-dir', cliDataDir, '--curriculum', curriculumDir]);

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/--child <id> или --all/u);
      expect(result.stdout).toBe('');
    });

    it('возвращает код 1 при живом сервере', () => {
      const server = acquireDataLock(cliDataDir, SERVER_LOCK_OWNER);

      try {
        const result = runCli([
          '--data-dir', cliDataDir,
          '--child', cliChildId,
          '--curriculum', curriculumDir,
        ]);

        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/занят: сервер/u);
      } finally {
        server.release();
      }
    });
  });
});
