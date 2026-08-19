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
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
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
import { hashParentPin } from '../server/parent-pin.js';

/** Что делаем. Адрес есть у всех команд: он и есть ключ учётной записи. */
export type ParentAction = 'create' | 'invite' | 'password' | 'pin' | 'disable';

export const PARENT_ACTIONS: readonly ParentAction[] = [
  'create',
  'invite',
  'password',
  'pin',
  'disable',
];

export interface ParentArgs {
  action: ParentAction;
  email: string;
  dataDir?: string;
}

export function parseArgs(argv: string[]): ParentArgs {
  const action = argv[0];
  if (action === undefined) {
    throw new Error(`Не указана команда, ожидается одна из: ${PARENT_ACTIONS.join(', ')}`);
  }
  if (!PARENT_ACTIONS.includes(action as ParentAction)) {
    throw new Error(`Неизвестная команда «${action}», ожидается одна из: ${PARENT_ACTIONS.join(', ')}`);
  }

  const values = new Map<string, string>();
  const known = new Set(['email', 'data-dir']);
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index] ?? '';
    if (!flag.startsWith('--')) throw new Error(`Непонятный аргумент: ${flag}`);
    const name = flag.slice(2);
    // Пароль и PIN флагами не принимаются вовсе, а не «принимаются, но не
    // рекомендуются»: иначе они попадали бы в `ps` и в историю оболочки.
    if (name === 'password' || name === 'pin') {
      throw new Error(`Секрет не передаётся флагом ${flag}: он виден в списке процессов, скрипт спросит его сам`);
    }
    if (!known.has(name)) throw new Error(`Неизвестный флаг: ${flag}`);
    if (values.has(name)) throw new Error(`Флаг ${flag} указан дважды`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`У флага ${flag} нет значения`);
    if (value.trim() === '') throw new Error(`У флага ${flag} пустое значение`);
    values.set(name, value);
    index += 1;
  }

  const email = values.get('email');
  if (email === undefined) throw new Error('Не указан --email: без адреса родителя не найти');
  const dir = values.get('data-dir');
  return {
    action: action as ParentAction,
    email,
    ...(dir === undefined ? {} : { dataDir: resolve(dir) }),
  };
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

/**
 * Спрашивает секрет дважды и сверяет. Опечатка в пароле, который нигде не
 * отображается, иначе обнаружилась бы только при следующем входе — то есть
 * тогда, когда сменить его уже нечем.
 */
async function readConfirmed(
  readSecret: ParentCommandDeps['readSecret'],
  what: string,
): Promise<string> {
  const first = await readSecret(`Новый ${what}: `);
  const second = await readSecret(`Ещё раз: `);
  if (first !== second) throw new Error(`Введённый ${what} не совпал с повтором`);
  return first;
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
      const pepper = deps.pinPepper ?? process.env['EDUKATOR_PIN_PEPPER'];
      if (pepper === undefined) {
        throw new Error('Не задан EDUKATOR_PIN_PEPPER: без него PIN перебирается по дампу базы');
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

/**
 * Читает секрет со стандартного ввода, не отображая его. Вывод readline уходит
 * в никуда, приглашение печатается в stderr: перенаправленный stdout не должен
 * уносить с собой вопрос, на который никто не увидел ответа.
 */
async function readSecretFromStdin(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  const silent = new Writable({
    write(_chunk, _encoding, callback): void {
      callback();
    },
  });
  const rl = createInterface({
    input: process.stdin,
    output: silent,
    terminal: process.stdin.isTTY === true,
  });
  try {
    return await new Promise<string>((done) => {
      rl.question('', (answer) => {
        done(answer);
      });
    });
  } finally {
    rl.close();
    process.stderr.write('\n');
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dir = ensureDataDir(resolveDataDir(args.dataDir));
  const control = openControlDatabase(controlDatabasePath(dir));
  try {
    await runParentCommand(args, {
      control,
      readSecret: readSecretFromStdin,
      out: (line) => process.stdout.write(`${line}\n`),
    });
  } finally {
    control.close();
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: Error) => {
    process.stderr.write(`parent: ${error.message}\n`);
    process.exitCode = 1;
  });
}
