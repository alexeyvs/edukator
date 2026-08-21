/**
 * Снятие копии базы.
 *
 * Копируется всегда через `VACUUM INTO`, а не `cp`. Под WAL часть уже
 * зафиксированных транзакций лежит в спутнике `-wal`, и `cp` одного файла базы
 * уносит снимок без них: копия открывается, `quick_check` на ней зелёный, а
 * прогресса последних занятий в ней просто нет. Заметить такую потерю можно
 * только тогда, когда копию разворачивают, — то есть когда оригинала уже нет.
 * `VACUUM INTO` читает базу обычным путём (WAL включительно) и пишет
 * согласованный снимок одной операцией.
 *
 * Замок каталога данных здесь **не** берётся намеренно: копия снимается ровно
 * при живом сервере, а замок стоит на бюджете codex, которого снятие копии не
 * тратит (см. `server/data-lock.ts`).
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { syncDirectory } from './atomic-write.js';

export interface BackupDatabaseOptions {
  /**
   * Дополнительная проверка копии: состав схемы. `quick_check` идёт всегда и
   * без неё — копия, которая не открывается, бесполезна независимо от того,
   * чью схему в ней ждали.
   */
  verify?: (db: Database.Database) => void;
}

/**
 * Снимает копию одной базы. Целевой файл обязан отсутствовать: `VACUUM INTO`
 * отказывается писать поверх, и это правильно — молча заменённая вчерашняя
 * копия ничем не отличается от её отсутствия.
 */
export function backupDatabase(
  source: string,
  target: string,
  options: BackupDatabaseOptions = {},
): void {
  const from = resolve(source);
  const to = resolve(target);
  if (!existsSync(from)) throw new Error(`Базы ${from} нет: копировать нечего`);
  if (existsSync(to)) throw new Error(`Файл ${to} уже есть: копия его не перезаписывает`);
  mkdirSync(dirname(to), { recursive: true });

  // Соединение открывается без миграции и только на чтение: копия снимается с
  // базы как она есть, в том числе со схемой прошлой версии приложения.
  // Мигрировать оригинал ради его же копии — последнее, чего от бэкапа ждут, а
  // `readonly` закрывает и вторую правку оригинала: закрываясь последним, обычное
  // соединение сливает `-wal` в основной файл и убирает спутники — то есть
  // снятие копии меняло бы оригинал ровно в том состоянии, ради которого копию и
  // снимают (оставшийся после аварии журнал). `VACUUM INTO` от `readonly` не
  // страдает: он источник только читает.
  const db = new Database(from, { fileMustExist: true, readonly: true });
  try {
    db.prepare('VACUUM INTO ?').run(to);
  } finally {
    db.close();
  }

  // Копию сбрасывают на диск сразу: снимок снимают перед тем, чем рискуют, и
  // питание может уйти следующей же минутой.
  const handle = openSync(to, 'r');
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  syncDirectory(to);

  try {
    const copy = new Database(to, { fileMustExist: true, readonly: true });
    try {
      const [integrity] = copy.pragma('quick_check') as [{ quick_check: string }];
      if (integrity.quick_check !== 'ok') {
        throw new Error(`Копия ${to} не прошла quick_check: ${integrity.quick_check}`);
      }
      options.verify?.(copy);
    } finally {
      copy.close();
    }
  } catch (error) {
    // Непрошедшая копия остаётся человеку, но **не под именем годной**.
    // Оставленная на месте, она неотличима от исправной ни на глаз, ни для
    // `[[ -d ... ]]` серверной половины деплоя, и вдобавок запирает путь
    // навсегда: следующий запуск упирается в «файл уже есть», то есть этот
    // ребёнок остаётся в `failed[]` при любом числе повторов. Убранная молча —
    // уносит с собой причину отказа. Поэтому она переезжает в `.failed`.
    setAside(to);
    throw error;
  }
}

/**
 * Отодвигает непрошедшую копию под имя, которое нельзя принять за годную.
 * Своё `try`: отказ уборки не имеет права заслонить причину отказа копии.
 */
function setAside(path: string): void {
  const aside = `${path}.failed`;
  try {
    rmSync(aside, { force: true });
    renameSync(path, aside);
  } catch (error) {
    process.stderr.write(
      `непрошедшая копия ${path} не отодвинута: ${(error as Error).message}\n`,
    );
  }
}
