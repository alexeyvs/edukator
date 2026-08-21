/**
 * Обслуживание операторов из командной строки: завести, сменить пароль,
 * отключить.
 *
 * Оператор — четвёртый предъявитель: он видит чужие семьи. Поэтому у админки
 * нет ни самостоятельной регистрации, ни приглашений по ссылке, ни почтового
 * восстановления: и завести оператора, и починить ему пароль можно только с
 * самой машины, где лежит `control.db`.
 *
 * Пароль **не** передаётся флагом: аргументы командной строки видны в `ps`
 * любому пользователю машины и остаются в истории оболочки. Секрет читается со
 * стандартного ввода и в вывод скрипта не попадает.
 *
 * Запуск:
 *   npm run admin -- create   --email оператор@example.com
 *   npm run admin -- password --email оператор@example.com
 *   npm run admin -- disable  --email оператор@example.com
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import {
  createAdmin,
  disableAdmin,
  findAdminByEmail,
  openControlDatabase,
  setAdminPassword,
  type AdminRecord,
} from '../server/control-db.js';
import { controlDatabasePath, dataDir as resolveDataDir, ensureDataDir } from '../server/data-dir.js';
import { parseAccountArgs, type AccountArgs } from './account-args.js';
import { createSecretReader, readConfirmed } from './secret-input.js';

/** Что делаем. Приглашения здесь нет: пароль ставится на самой машине. */
export type AdminAction = 'create' | 'password' | 'disable';

export const ADMIN_ACTIONS: readonly AdminAction[] = ['create', 'password', 'disable'];

export type AdminArgs = AccountArgs<AdminAction>;

export function parseArgs(argv: string[]): AdminArgs {
  return parseAccountArgs(argv, ADMIN_ACTIONS, 'оператора');
}

export interface AdminCommandDeps {
  control: Database.Database;
  /** Чтение секрета: подменяется в тестах, чтобы не трогать стандартный ввод. */
  readSecret: (prompt: string) => Promise<string>;
  /** Куда писать человеку. Пароль сюда не уходит никогда. */
  out: (line: string) => void;
  now?: () => Date;
}

/** Находит оператора или внятно отказывает: `UNIQUE`-ошибка тут ничего не объясняет. */
function requireAdmin(control: Database.Database, email: string): AdminRecord {
  const admin = findAdminByEmail(control, email);
  if (admin === undefined) throw new Error(`Оператора с адресом ${email} нет в управляющей базе`);
  if (admin.disabledAt !== undefined) {
    throw new Error(`Оператор ${admin.email} отключён с ${admin.disabledAt}`);
  }
  return admin;
}

export async function runAdminCommand(args: AdminArgs, deps: AdminCommandDeps): Promise<void> {
  const { control, out } = deps;
  const now = deps.now ?? ((): Date => new Date());

  switch (args.action) {
    case 'create': {
      const id = createAdmin(control, args.email, now());
      out(`оператор заведён: ${id}`);
      // Заведённый оператор ещё никуда не войдёт: пароля у него нет, и вход
      // отказывает. Сказать об этом обязан тот, кто его завёл, — иначе следом
      // ждут отказа входа и ищут причину не там.
      out('пароля у него пока нет: npm run admin -- password --email <адрес>');
      return;
    }
    case 'password': {
      const admin = requireAdmin(control, args.email);
      const password = await readConfirmed(deps.readSecret, 'пароль');
      setAdminPassword(control, admin.id, password, now());
      out(`пароль ${admin.email} изменён`);
      // Последствие названо вслух: `credentials_changed_at` гасит все сессии
      // оператора, включая ту, из которой он сейчас смотрит админку.
      out('прежние входы оператора погашены, войти нужно заново');
      return;
    }
    case 'disable': {
      // Отключаемого ищем без `requireAdmin`: он отказывается по уже
      // отключённому, а здесь это не отказ, а повтор — про него нужно сказать
      // отдельным текстом.
      const admin = findAdminByEmail(control, args.email);
      if (admin === undefined) {
        throw new Error(`Оператора с адресом ${args.email} нет в управляющей базе`);
      }
      if (!disableAdmin(control, admin.id, now())) {
        throw new Error(`Оператор ${admin.email} уже отключён с ${admin.disabledAt ?? 'неизвестно когда'}`);
      }
      out(`оператор ${admin.email} отключён: его сессии и имперсонации больше не обслуживаются`);
      return;
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dir = ensureDataDir(resolveDataDir(args.dataDir));
  const path = controlDatabasePath(dir);
  // Управляющую базу заводит только `create`: остальным командам пустая база на
  // месте опечатки в `--data-dir` ответила бы «оператора нет в управляющей
  // базе», то есть назвала бы виноватым адрес, а не каталог.
  if (args.action !== 'create' && !existsSync(path)) {
    throw new Error(
      `В каталоге ${dir} нет управляющей базы: проверьте --data-dir или EDUKATOR_DATA_DIR, ` +
        'а первого оператора заводит npm run admin -- create',
    );
  }
  const control = openControlDatabase(path, args.action === 'create' ? {} : { fileMustExist: true });
  const reader = createSecretReader();
  try {
    await runAdminCommand(args, {
      control,
      readSecret: reader.read,
      out: (line) => process.stdout.write(`${line}\n`),
    });
  } finally {
    // Закрывается всегда: открытый stdin держит цикл событий, и процесс не вышел
    // бы даже после успешной смены пароля.
    reader.close();
    control.close();
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: Error) => {
    process.stderr.write(`admin: ${error.message}\n`);
    process.exitCode = 1;
  });
}
