/**
 * Обслуживание родителей из командной строки: завести, выпустить приглашение,
 * сменить пароль или PIN, отключить.
 *
 * Самостоятельной регистрации у нас нет намеренно (см. спеку многоарендности),
 * поэтому первый родитель появляется только отсюда, и отсюда же чинится
 * забытый пароль: почтового восстановления нет.
 *
 * Пароль и PIN **не** передаются флагами: аргументы командной строки видны в
 * `ps` любому пользователю машины и остаются в истории оболочки. Секрет всегда
 * читается со стандартного ввода и в вывод скрипта не попадает.
 *
 * Запуск:
 *   npm run parent -- create   --email родитель@example.com
 *   npm run parent -- invite   --email родитель@example.com
 *   npm run parent -- password --email родитель@example.com
 *   npm run parent -- pin      --email родитель@example.com
 *   npm run parent -- disable  --email родитель@example.com
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import {
  createParent,
  disableParent,
  findParentByEmail,
  issueParentInvite,
  openControlDatabase,
  setParentPassword,
  setParentPin,
  type ParentRecord,
} from '../server/control-db.js';
import { controlDatabasePath, dataDir as resolveDataDir, ensureDataDir } from '../server/data-dir.js';
import { parseAccountArgs, type AccountArgs } from './account-args.js';
import { createSecretReader, readConfirmed } from './secret-input.js';
import { hashParentPin, MIN_PIN_PEPPER_LENGTH, readPinPepper } from '../server/parent-pin.js';

/** Что делаем. Адрес есть у всех команд: он и есть ключ учётной записи. */
export type ParentAction = 'create' | 'invite' | 'password' | 'pin' | 'disable';

export const PARENT_ACTIONS: readonly ParentAction[] = [
  'create',
  'invite',
  'password',
  'pin',
  'disable',
];

export type ParentArgs = AccountArgs<ParentAction>;

export function parseArgs(argv: string[]): ParentArgs {
  return parseAccountArgs(argv, PARENT_ACTIONS, 'родителя');
}

export interface ParentCommandDeps {
  control: Database.Database;
  /** Чтение секрета: подменяется в тестах, чтобы не трогать стандартный ввод. */
  readSecret: (prompt: string) => Promise<string>;
  /** Куда писать человеку. Ни пароль, ни PIN сюда не уходят никогда. */
  out: (line: string) => void;
  /** Серверный pepper PIN; по умолчанию из `EDUKATOR_PIN_PEPPER`. */
  pinPepper?: string;
  now?: () => Date;
}

/** Находит родителя или внятно отказывает: `UNIQUE`-ошибка тут ничего не объясняет. */
function requireParent(control: Database.Database, email: string): ParentRecord {
  const parent = findParentByEmail(control, email);
  if (parent === undefined) throw new Error(`Родителя с адресом ${email} нет в управляющей базе`);
  if (parent.disabledAt !== undefined) {
    throw new Error(`Родитель ${parent.email} отключён с ${parent.disabledAt}`);
  }
  return parent;
}

export async function runParentCommand(args: ParentArgs, deps: ParentCommandDeps): Promise<void> {
  const { control, out } = deps;
  const now = deps.now ?? ((): Date => new Date());

  switch (args.action) {
    case 'create': {
      const id = createParent(control, args.email, now());
      out(`родитель заведён: ${id}`);
      out('дальше: npm run parent -- invite --email <адрес> и отдать ссылку родителю');
      return;
    }
    case 'invite': {
      const parent = requireParent(control, args.email);
      const invite = issueParentInvite(control, parent.id, now());
      // Открытый токен существует ровно здесь: в базе лежит только отпечаток,
      // и показать ссылку второй раз нельзя не по недосмотру, а по устройству
      // хранения. Поэтому он и печатается — другого способа её передать нет.
      out(`ссылка действует до ${invite.expiresAt}:`);
      out(`  /invite/${invite.token}`);
      return;
    }
    case 'password': {
      const parent = requireParent(control, args.email);
      const password = await readConfirmed(deps.readSecret, 'пароль');
      setParentPassword(control, parent.id, password, now());
      out(`пароль ${parent.email} изменён`);
      // Последствие названо вслух: `credentials_changed_at` гасит и вход
      // родителя, и токены детских устройств — ребёнку придётся выдать новую
      // ссылку, и узнать об этом лучше здесь, чем от ребёнка перед занятием.
      out('прежние входы и детские устройства погашены, ссылки устройствам нужно выпустить заново');
      return;
    }
    case 'pin': {
      const parent = requireParent(control, args.email);
      // `??` ловит только незаданную переменную, а `EDUKATOR_PIN_PEPPER=` даёт
      // пустую строку: без явной проверки она доезжала бы до `hashParentPin` и
      // жаловалась на длину вместо того, чтобы назвать переменную. Длина
      // проверяется тем же `readPinPepper`, что и на сервере, и **до** вопросов:
      // спрашивать PIN дважды, чтобы отказать по настройке, незачем.
      const pepper = deps.pinPepper ?? process.env['EDUKATOR_PIN_PEPPER'] ?? '';
      if (readPinPepper(pepper) === undefined) {
        throw new Error(
          `Не задан EDUKATOR_PIN_PEPPER длиннее ${MIN_PIN_PEPPER_LENGTH} знаков: ` +
            'без него PIN перебирается по дампу базы',
        );
      }
      const pin = await readConfirmed(deps.readSecret, 'PIN');
      // Хеш считается до записи и вместе с pepper: формат PIN проверяет
      // `hashParentPin`, и записать хеш от мусора значило бы завести PIN,
      // который никогда не подойдёт.
      setParentPin(control, parent.id, hashParentPin(pin, pepper));
      out(`PIN ${parent.email} изменён`);
      return;
    }
    case 'disable': {
      const parent = findParentByEmail(control, args.email);
      if (parent === undefined) {
        throw new Error(`Родителя с адресом ${args.email} нет в управляющей базе`);
      }
      if (!disableParent(control, parent.id, now())) {
        throw new Error(`Родитель ${parent.email} уже отключён с ${parent.disabledAt ?? 'неизвестно когда'}`);
      }
      out(`родитель ${parent.email} отключён: его сессии, дети и их устройства больше не обслуживаются`);
      return;
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dir = ensureDataDir(resolveDataDir(args.dataDir));
  const path = controlDatabasePath(dir);
  // Управляющую базу заводит только `create`: остальным командам пустая база на
  // месте опечатки в `--data-dir` ответила бы «родителя нет в управляющей базе»,
  // то есть назвала бы виноватым адрес, а не каталог. Замок каталога здесь не
  // берётся, так что сам каталог к этому моменту мог быть создан `ensureDataDir`.
  if (args.action !== 'create' && !existsSync(path)) {
    throw new Error(
      `В каталоге ${dir} нет управляющей базы: проверьте --data-dir или EDUKATOR_DATA_DIR, ` +
        'а первого родителя заводит npm run parent -- create',
    );
  }
  const control = openControlDatabase(path, args.action === 'create' ? {} : { fileMustExist: true });
  const reader = createSecretReader();
  try {
    await runParentCommand(args, {
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
    process.stderr.write(`parent: ${error.message}\n`);
    process.exitCode = 1;
  });
}
