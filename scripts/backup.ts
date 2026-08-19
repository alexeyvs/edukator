/**
 * Снятие копии каталога данных: управляющая база и база каждого ребёнка.
 *
 * Копия снимается через `VACUUM INTO` (`server/backup.ts`), а не `cp`: под WAL
 * часть зафиксированных транзакций лежит в спутнике `-wal`, и копия одного
 * файла базы молча теряет их вместе с прогрессом последних занятий.
 *
 * Замок каталога данных не берётся: копию снимают при живом сервере, и это
 * единственное время, когда её вообще есть смысл снимать.
 *
 * Запуск:
 *   npm run backup -- --out ../backups/2026-08-19
 *   npm run backup -- --out ../backups/2026-08-19 --data-dir /srv/edukator/data
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupDatabase } from '../server/backup.js';
import {
  CHILDREN_DIR,
  childDatabasePath,
  listAllChildren,
  openControlDatabase,
  validateControlSchema,
  type ChildSummary,
} from '../server/control-db.js';
import {
  CONTROL_DB_FILE,
  controlDatabasePath,
  dataDir as resolveDataDir,
} from '../server/data-dir.js';
import { validateSchema } from '../server/db.js';

/** Одна снятая копия детской базы. */
export interface ChildBackup {
  childId: string;
  path: string;
}

export interface DataDirBackup {
  /** Путь копии управляющей базы. */
  control: string;
  children: ChildBackup[];
  /**
   * Дети, чьей базы на месте не оказалось: заведение сорвалось или файл убрали
   * руками. Не отказ снятия, но и не молчание — иначе неполная копия выглядит
   * полной.
   */
  missing: string[];
}

/**
 * Снимает копию всего каталога данных. Обходятся **все** дети, включая
 * выведенных и незаведённых: `retired_at` — пометка в управляющей базе, а не
 * удаление прогресса, и копия без него обнаруживается ровно тогда, когда
 * возвращать уже нечего.
 *
 * Копия ложится в тот же вид, что и оригинал (`control.db` рядом с
 * `children/<id>.db`), чтобы разворачивание сводилось к переносу каталога.
 */
export function backupDataDir(dir: string, outDir: string): DataDirBackup {
  const out = resolve(outDir);
  const controlCopy = resolve(out, CONTROL_DB_FILE);
  backupDatabase(controlDatabasePath(dir), controlCopy, { verify: validateControlSchema });

  // Состав детей читается из копии, а не из оригинала: она снята одним снимком,
  // и ребёнок, заведённый между этими двумя чтениями, попал бы в список, но не
  // в копию управляющей базы — то есть значился бы в отчёте о бэкапе, которого
  // в самом бэкапе нет.
  const control = openControlDatabase(controlCopy, { fileMustExist: true });
  let children: ChildSummary[];
  try {
    children = listAllChildren(control);
  } finally {
    control.close();
  }

  const copied: ChildBackup[] = [];
  const missing: string[] = [];
  for (const child of children) {
    const from = childDatabasePath(dir, child.id);
    if (!existsSync(from)) {
      missing.push(child.id);
      continue;
    }
    const to = resolve(out, CHILDREN_DIR, `${child.id}.db`);
    backupDatabase(from, to, { verify: validateSchema });
    copied.push({ childId: child.id, path: to });
  }
  return { control: controlCopy, children: copied, missing };
}

export interface BackupArgs {
  outDir: string;
  dataDir?: string;
}

export function parseArgs(argv: string[]): BackupArgs {
  const values = new Map<string, string>();
  const known = new Set(['out', 'data-dir']);

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? '';
    if (!flag.startsWith('--')) throw new Error(`Непонятный аргумент: ${flag}`);
    const name = flag.slice(2);
    if (!known.has(name)) throw new Error(`Неизвестный флаг: ${flag}`);
    if (values.has(name)) throw new Error(`Флаг ${flag} указан дважды`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`У флага ${flag} нет значения`);
    // Пустое значение доезжает до `resolve` и превращается в каталог запуска:
    // копия легла бы туда, откуда скрипт позвали, а не туда, куда просили.
    if (value.trim() === '') throw new Error(`У флага ${flag} пустое значение`);
    values.set(name, value);
    index += 1;
  }

  const out = values.get('out');
  if (out === undefined) throw new Error('Не указан --out: некуда снимать копию');
  const dir = values.get('data-dir');
  return { outDir: resolve(out), ...(dir === undefined ? {} : { dataDir: resolve(dir) }) };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const dir = resolveDataDir(args.dataDir);
  const result = backupDataDir(dir, args.outDir);

  process.stdout.write(`backup: ${result.control}\n`);
  for (const child of result.children) {
    process.stdout.write(`backup: ${child.childId} → ${child.path}\n`);
  }
  if (result.missing.length > 0) {
    // Отсутствующая база — не отказ снятия (ребёнок мог не завестись), но
    // молчать о ней нельзя: копия каталога при этом неполна.
    process.stderr.write(`backup: базы нет у ${result.missing.join(', ')}\n`);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`backup: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
