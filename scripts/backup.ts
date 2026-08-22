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
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { backupDatabase } from '../server/backup.js';
import {
  CHILDREN_DIR,
  childDatabasePath,
  CONTROL_SCHEMA_VERSION,
  listAllChildren,
  validateControlSchema,
  type ChildSummary,
} from '../server/control-db.js';
import {
  CONTROL_DB_FILE,
  controlDatabasePath,
  dataDir as resolveDataDir,
} from '../server/data-dir.js';
import { SCHEMA_VERSION, validateSchema } from '../server/db.js';
import { failureLogFor } from '../server/log.js';
import { writeFileAtomic } from '../server/atomic-write.js';
import {
  CATALOG_DIR,
  CATALOG_MANIFEST_FILE,
  copyArtifactForBackup,
  verifyArtifactManifest,
  type ArtifactManifest,
  type ArtifactManifestEntry,
} from '../server/course-artifacts.js';

/**
 * Проверка копии составом схемы — только на копии своей версии.
 *
 * Копия снимается **без** миграции намеренно (`server/backup.ts`), а детские
 * базы мигрируются лениво, по первому обращению реестра. Значит сразу после
 * обновления приложения копия ребёнка, который с тех пор не занимался, законно
 * приезжает со схемой прошлой версии — и `validateSchema`, требующий таблиц
 * нынешней, забраковал бы совершенно исправный, разворачиваемый снимок. А код
 * возврата 1 в цепочке `backup && rm -rf прошлая-копия` означал бы, что
 * последнюю целую копию убрали из-за исправной новой.
 *
 * Целость копии этим не теряется: `quick_check` идёт в `backupDatabase` всегда
 * и от версии не зависит.
 */
function verifyCopy(
  version: number,
  validate: (db: Database.Database) => void,
): (copy: Database.Database) => void {
  return (copy) => {
    const [row] = copy.pragma('user_version') as [{ user_version: number }];
    if (row.user_version === version) validate(copy);
  };
}

/** Одна снятая копия детской базы. */
export interface ChildBackup {
  childId: string;
  path: string;
}

/** Ребёнок, чью базу скопировать не вышло: она есть, но копия не удалась. */
export interface ChildBackupFailure {
  childId: string;
  reason: string;
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
  /**
   * Дети, чья база на месте, но скопировать её не удалось (испорченный файл,
   * непрошедший `quick_check`, нет места). Отдельно от `missing`: там копировать
   * было нечего, здесь — было что и не вышло.
   */
  failed: ChildBackupFailure[];
  artifacts: ArtifactManifestEntry[];
  artifactManifest: string;
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
  backupDatabase(controlDatabasePath(dir), controlCopy, {
    verify: verifyCopy(CONTROL_SCHEMA_VERSION, validateControlSchema),
  });

  // Состав детей читается из копии, а не из оригинала: она снята одним снимком,
  // и ребёнок, заведённый между этими двумя чтениями, попал бы в список, но не
  // в копию управляющей базы — то есть значился бы в отчёте о бэкапе, которого
  // в самом бэкапе нет.
  // Копия открывается голым `better-sqlite3` только на чтение: у бэкапа нет
  // права её менять, а `openControlDatabase` включил бы WAL (это запись) и
  // прогнал бы `migrateControl`. Снимок, снятый перед обновлением, тем самым
  // оказался бы уже обновлённым, а копия схемы новее приложения — не читаемой
  // вовсе, хотя разворачивать её будет то приложение, которое её и писало.
  const control = new Database(controlCopy, { fileMustExist: true, readonly: true });
  let children: ChildSummary[];
  let artifactRows: { artifact_path: string; sha256: string }[];
  try {
    children = listAllChildren(control);
    const hasSources = control.prepare<[], { count: number }>(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'course_sources'",
    ).get()?.count === 1;
    artifactRows = hasSources
      ? control.prepare<[], { artifact_path: string; sha256: string }>(
        'SELECT artifact_path, sha256 FROM course_sources ORDER BY artifact_path',
      ).all()
      : [];
  } finally {
    control.close();
  }

  const artifacts = artifactRows.map((row) =>
    copyArtifactForBackup(dir, out, row.artifact_path, row.sha256));
  const artifactManifest = resolve(out, CATALOG_MANIFEST_FILE);
  mkdirSync(resolve(out, CATALOG_DIR), { recursive: true });
  const manifest: ArtifactManifest = { version: 1, artifacts };
  writeFileAtomic(artifactManifest, `${JSON.stringify(manifest, null, 2)}\n`);
  verifyArtifactManifest(out, manifest);

  const copied: ChildBackup[] = [];
  const missing: string[] = [];
  const failed: ChildBackupFailure[] = [];
  for (const child of children) {
    // Путь считается внутри `try` вместе с самой копией: `childDatabasePath`
    // проверяет `id` и бросает, а вылет отсюда наружу оставил бы без копии всех
    // следующих детей из-за одной испорченной строки управляющей базы.
    // Отказ одного ребёнка не отменяет копию остальных: испорченная база — это
    // ровно тот случай, когда копии нужны сильнее всего, и падение на первом же
    // ребёнке оставило бы каталог полукопией, которую повторный запуск с тем же
    // `--out` даже не смог бы дописать (`backupDatabase` не перезаписывает).
    // Путь считается здесь же: `childDatabasePath` проверяет `id` и бросает.
    try {
      const from = childDatabasePath(dir, child.id);
      if (!existsSync(from)) {
        // У `ready`-ребёнка база обязана быть: её отсутствие — уже потеря, и
        // нулевой код возврата в цепочке `backup && rm -rf прошлая` означал бы,
        // что последнюю целую копию убрали ровно из-за неё. У `provisioning` и
        // `failed` базы нет законно, и отказом это не считается.
        if (child.status === 'ready') {
          failed.push({ childId: child.id, reason: `база ${from} не найдена` });
        } else {
          missing.push(child.id);
        }
        continue;
      }
      const to = resolve(out, CHILDREN_DIR, `${child.id}.db`);
      backupDatabase(from, to, { verify: verifyCopy(SCHEMA_VERSION, validateSchema) });
      copied.push({ childId: child.id, path: to });
    } catch (error) {
      failed.push({ childId: child.id, reason: (error as Error).message });
    }
  }
  return { control: controlCopy, children: copied, missing, failed, artifacts, artifactManifest };
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
  process.stdout.write(`backup: ${result.artifactManifest}\n`);
  for (const child of result.children) {
    process.stdout.write(`backup: ${child.childId} → ${child.path}\n`);
  }
  if (result.missing.length > 0) {
    // Отсутствующая база — не отказ снятия (ребёнок мог не завестись), но
    // молчать о ней нельзя: копия каталога при этом неполна.
    process.stderr.write(`backup: базы нет у ${result.missing.join(', ')}\n`);
  }
  if (result.failed.length > 0) {
    // Журнал ведётся в исходном каталоге данных, а не в каталоге копии: копию
    // уносят с машины, и запись о том, что она неполна, уехала бы вместе с ней.
    const failures = failureLogFor(dir);
    for (const failure of result.failed) {
      process.stderr.write(`backup: ${failure.childId} не скопирован: ${failure.reason}\n`);
      // Копию снимают из cron, и её отказ не видит никто. Без записи в журнале
      // экран аварий молчал бы ровно про то состояние, ради которого копии и
      // снимают, — а молчание там читается как «копии в порядке».
      failures({
        event: 'backup-failed',
        message: 'база ребёнка не скопирована',
        detail: failure.reason,
        childId: failure.childId,
      });
    }
    // Неполная копия обязана отличаться кодом возврата: в цепочке `&&` она
    // иначе читается как удачно снятая.
    process.exitCode = 1;
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
