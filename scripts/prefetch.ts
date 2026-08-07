/**
 * Опережающее наполнение банка заданий: тот же цикл, что крутит воркер, но
 * запущенный руками и с ограничением числа батчей. Нужен в двух случаях —
 * перед занятием, когда очередь заведомо холодная, и при сборке посевного
 * банка, который потом коммитится в `content/seed-bank/`.
 *
 * Это единственная точка, где codex зовётся по-настоящему ради заданий: тесты
 * его не вызывают никогда.
 *
 * Запуск:
 *   npm run prefetch                                  # погреть ближайшие темы
 *   npm run prefetch -- --topics 12 --target 10       # шире и глубже
 *   npm run prefetch -- --export                      # выгрузить банк в посев
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { databasePath, openDatabase, SUBJECTS } from '../server/db.js';
import { CURRICULUM_DIR, loadCurriculum, syncTopicState } from '../server/curriculum.js';
import type { CodexRunner } from '../server/codex/client.js';
import {
  collectSeedTasks,
  formatSeedBank,
  loadSeedBank,
  seedBankPath,
  SEED_BANK_DIR,
  type LoadSeedBankResult,
} from '../server/codex/seed-bank.js';
import {
  runWarmupCycle,
  type CycleReport,
  type TaskProducer,
  type WorkerLog,
} from '../server/codex/worker.js';

export interface PrefetchOptions {
  /** Сколько ближайших тем плана греть; по умолчанию столько же, сколько у воркера. */
  topics?: number;
  /** Запас заданий на тему. */
  target?: number;
  /** Потолок батчей на тему за цикл: он и есть «ограничение числа батчей». */
  batches?: number;
  /** Сколько циклов пополнения прогнать подряд; между ними план пересчитывается. */
  cycles?: number;
  model?: string;
  /** Выгрузить содержимое банка в посевные файлы после наполнения. */
  exportSeed?: boolean;
  /** Куда выгружать посев; по умолчанию `content/seed-bank`. */
  outDir?: string;
  /** Откуда подгружать посев перед наполнением. */
  seedDir?: string;
  dbPath?: string;
  curriculumDir?: string;
  /** Подменяемый производитель заданий: тесты не запускают процессов. */
  produce?: TaskProducer;
  /** Подменяемый вызов codex. */
  run?: CodexRunner;
  log?: WorkerLog;
}

export interface PrefetchResult {
  /** Отчёты по циклам в порядке выполнения. */
  cycles: CycleReport[];
  seeded: LoadSeedBankResult;
  /** Пути выгруженных посевных файлов; пусто без `--export`. */
  exported: string[];
}

export const DEFAULT_CYCLES = 1;

function defaultLog(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * Греет очередь и, если попросили, выгружает получившийся банк в посев.
 *
 * Циклы идут подряд, а не параллельно: внутри цикла своя очередь с пределом
 * одновременных вызовов codex, и запускать несколько циклов сразу значило бы
 * этот предел обойти.
 */
export async function prefetch(options: PrefetchOptions = {}): Promise<PrefetchResult> {
  const cycles = options.cycles ?? DEFAULT_CYCLES;
  if (!Number.isInteger(cycles) || cycles < 1) {
    throw new Error(`Число циклов должно быть положительным целым, получено ${cycles}`);
  }

  const log = options.log ?? defaultLog;
  const graph = loadCurriculum(options.curriculumDir ?? CURRICULUM_DIR);
  const db = openDatabase(options.dbPath ?? databasePath());

  try {
    syncTopicState(db, graph);
    const seeded = loadSeedBank(db, graph, {
      ...(options.seedDir === undefined ? {} : { dir: options.seedDir }),
    });
    if (seeded.loaded > 0) log(`посев: добавлено ${seeded.loaded} задани(й)`);

    const reports: CycleReport[] = [];
    for (let cycle = 1; cycle <= cycles; cycle += 1) {
      const report = await runWarmupCycle({
        db,
        graph,
        log,
        ...(options.topics === undefined ? {} : { topics: options.topics }),
        ...(options.target === undefined ? {} : { target: options.target }),
        ...(options.batches === undefined ? {} : { maxBatches: options.batches }),
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.produce === undefined ? {} : { produce: options.produce }),
        ...(options.run === undefined ? {} : { run: options.run }),
      });
      reports.push(report);

      for (const refill of report.refilled) {
        log(
          `цикл ${cycle}: тема «${refill.topicId}» — ${refill.stored} новых, ` +
            `остаток ${refill.available}${refill.error === undefined ? '' : `, ошибка: ${refill.error}`}`,
        );
      }
      // Дальше пойдут те же темы с тем же результатом: codex не вернётся между
      // циклами, а ждать его тут, в ручном запуске, незачем.
      if (report.codexUnavailable) {
        log('цикл пополнения прерван: codex недоступен');
        break;
      }
    }

    const exported: string[] = [];
    if (options.exportSeed === true) {
      const outDir = options.outDir ?? SEED_BANK_DIR;
      mkdirSync(outDir, { recursive: true });
      for (const subject of SUBJECTS) {
        const topics = collectSeedTasks(db, graph, subject);
        const path = seedBankPath(subject, outDir);
        writeFileSync(path, formatSeedBank(subject, topics));
        exported.push(path);
        const count = topics.reduce((sum, entry) => sum + entry.tasks.length, 0);
        log(`посев ${subject}: ${count} задани(й) в ${topics.length} теме(ах) → ${path}`);
      }
    }

    return { cycles: reports, seeded, exported };
  } finally {
    db.close();
  }
}

const NUMERIC_FLAGS = ['topics', 'target', 'batches', 'cycles'] as const;
const TEXT_FLAGS = ['model', 'out', 'seed-dir', 'db', 'curriculum'] as const;
const BOOLEAN_FLAGS = ['export'] as const;

export function parseArgs(argv: string[]): PrefetchOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const numeric = new Set<string>(NUMERIC_FLAGS);
  const text = new Set<string>(TEXT_FLAGS);
  const boolean = new Set<string>(BOOLEAN_FLAGS);

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? '';
    if (!flag.startsWith('--')) throw new Error(`Непонятный аргумент: ${flag}`);
    const name = flag.slice(2);

    if (boolean.has(name)) {
      if (flags.has(name)) throw new Error(`Флаг ${flag} указан дважды`);
      flags.add(name);
      continue;
    }
    if (!numeric.has(name) && !text.has(name)) throw new Error(`Неизвестный флаг: ${flag}`);
    if (values.has(name)) throw new Error(`Флаг ${flag} указан дважды`);

    const value = argv[index + 1];
    if (value === undefined) throw new Error(`У флага ${flag} нет значения`);
    if (numeric.has(name) && !/^\d+$/.test(value)) {
      throw new Error(`${flag} ожидает число, получено «${value}»`);
    }
    values.set(name, value);
    index += 1;
  }

  const number = (name: string): number | undefined => {
    const raw = values.get(name);
    return raw === undefined ? undefined : Number(raw);
  };
  const path = (name: string): string | undefined => {
    const raw = values.get(name);
    return raw === undefined ? undefined : resolve(raw);
  };

  const topics = number('topics');
  const target = number('target');
  const batches = number('batches');
  const cycles = number('cycles');
  const model = values.get('model');
  const outDir = path('out');
  const seedDir = path('seed-dir');
  const dbPath = path('db');
  const curriculumDir = path('curriculum');

  return {
    ...(topics === undefined ? {} : { topics }),
    ...(target === undefined ? {} : { target }),
    ...(batches === undefined ? {} : { batches }),
    ...(cycles === undefined ? {} : { cycles }),
    ...(model === undefined ? {} : { model }),
    ...(flags.has('export') ? { exportSeed: true } : {}),
    ...(outDir === undefined ? {} : { outDir }),
    ...(seedDir === undefined ? {} : { seedDir }),
    ...(dbPath === undefined ? {} : { dbPath }),
    ...(curriculumDir === undefined ? {} : { curriculumDir }),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await prefetch(options);

  const stored = result.cycles.reduce(
    (sum, cycle) => sum + cycle.refilled.reduce((inner, refill) => inner + refill.stored, 0),
    0,
  );
  process.stdout.write(
    `prefetch: ${stored} новых задани(й) за ${result.cycles.length} цикл(ов)` +
      `${result.exported.length === 0 ? '' : `, посев выгружен в ${result.exported.length} файл(ов)`}\n`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: Error) => {
    process.stderr.write(`prefetch: ${error.message}\n`);
    process.exitCode = 1;
  });
}
