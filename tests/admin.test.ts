import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import type { Database } from 'better-sqlite3';
import {
  createAdmin,
  findAdminByEmail,
  loginAdmin,
  openControlDatabase,
  resolveAdminSession,
  setAdminPassword,
  MIN_ADMIN_PASSWORD_LENGTH,
} from '../server/control-db.js';
import { controlDatabasePath, ensureDataDir } from '../server/data-dir.js';
import { parseArgs, runAdminCommand, type AdminArgs } from '../scripts/admin.js';

/** Пароль оператора длиннее шестнадцати знаков: короче `setAdminPassword` не берёт. */
const PASSWORD = 'пароль-оператора-подлиннее';
const NOW = new Date('2026-08-21T10:00:00.000Z');

describe('скрипт обслуживания операторов', () => {
  let dir: string;
  let control: Database;
  let printed: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'edukator-admin-script-'));
    control = openControlDatabase(join(dir, 'control.db'));
    printed = [];
  });

  afterEach(() => {
    control.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Секреты приходят со стандартного ввода; здесь их подаёт очередь. */
  function secrets(...answers: string[]): (prompt: string) => Promise<string> {
    const queue = [...answers];
    return (prompt: string): Promise<string> => {
      const answer = queue.shift();
      if (answer === undefined) throw new Error(`лишний запрос секрета: ${prompt}`);
      return Promise.resolve(answer);
    };
  }

  async function run(
    action: AdminArgs['action'],
    email: string,
    answers: string[] = [],
    now: Date = NOW,
  ): Promise<void> {
    await runAdminCommand(
      { action, email },
      {
        control,
        readSecret: secrets(...answers),
        out: (line) => printed.push(line),
        now: () => now,
      },
    );
  }

  describe('разбор аргументов', () => {
    it('читает команду, адрес и каталог данных', () => {
      expect(parseArgs(['password', '--email', 'Operator@Example.com', '--data-dir', 'данные'])).toEqual({
        action: 'password',
        email: 'Operator@Example.com',
        dataDir: resolve('данные'),
      });
      expect(parseArgs(['create', '--email', 'operator@example.com'])).toEqual({
        action: 'create',
        email: 'operator@example.com',
      });
    });

    it('не знает родительских команд', () => {
      // Приглашений и PIN у оператора нет вовсе, и знакомая по `parent`
      // команда обязана отказать, а не сделать что-нибудь похожее.
      expect(() => parseArgs(['invite', '--email', 'a@b.ru'])).toThrow(/Неизвестная команда/u);
      expect(() => parseArgs(['pin', '--email', 'a@b.ru'])).toThrow(/Неизвестная команда/u);
    });

    it('отвергает секрет во флаге и не вписывает его в отказ', () => {
      // Аргументы видны в `ps` любому пользователю машины и остаются в истории
      // оболочки, поэтому такой флаг не «не рекомендуется», а не существует.
      let message = '';
      try {
        parseArgs(['password', '--email', 'a@b.ru', '--password=тайна-оператора']);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/виден в списке процессов/u);
      expect(message).not.toMatch(/тайна-оператора/u);
    });

    it('отвергает пустое, повторное, неизвестное и отсутствующее', () => {
      expect(() => parseArgs([])).toThrow(/Не указана команда/u);
      expect(() => parseArgs(['удалить', '--email', 'a@b.ru'])).toThrow(/Неизвестная команда/u);
      expect(() => parseArgs(['create'])).toThrow(/без адреса оператора не найти/u);
      expect(() => parseArgs(['create', '--email'])).toThrow(/нет значения/u);
      expect(() => parseArgs(['create', '--email', ' '])).toThrow(/пустое значение/u);
      expect(() => parseArgs(['create', '--email', 'a@b.ru', '--email', 'c@d.ru'])).toThrow(/дважды/u);
      expect(() => parseArgs(['create', '--email', 'a@b.ru', '--что-то', 'x'])).toThrow(/Неизвестный флаг/u);
      expect(() => parseArgs(['create', 'a@b.ru'])).toThrow(/Аргумент №1 не похож на флаг/u);
    });
  });

  describe('create', () => {
    it('заводит оператора без пароля и называет следующий шаг', async () => {
      await run('create', 'Operator@Example.COM');

      const admin = findAdminByEmail(control, 'operator@example.com');
      expect(admin).toMatchObject({ hasPassword: false });
      expect(printed.join('\n')).toContain(admin?.id ?? 'нет такого');
      // Без пароля вход отказывает, и узнать об этом лучше здесь, чем на
      // экране входа.
      expect(printed.join('\n')).toMatch(/npm run admin -- password/u);
      expect(loginAdmin(control, 'operator@example.com', PASSWORD, NOW).ok).toBe(false);
    });

    it('отказывается заводить второй раз тот же адрес', async () => {
      await run('create', 'operator@example.com');
      await expect(run('create', 'operator@example.com')).rejects.toThrow(/уже заведён/u);
    });

    it('отказывается заводить не адрес', async () => {
      await expect(run('create', 'не адрес')).rejects.toThrow(/не похож на электронную почту/u);
    });
  });

  describe('password', () => {
    it('ставит пароль, гасит прежний вход и не печатает секрет', async () => {
      await run('create', 'operator@example.com');
      await run('password', 'operator@example.com', [PASSWORD, PASSWORD]);

      const first = loginAdmin(control, 'operator@example.com', PASSWORD, NOW);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(resolveAdminSession(control, first.session.token, NOW)).toMatchObject({
        email: 'operator@example.com',
      });

      const second = `${PASSWORD}-другой`;
      await run('password', 'operator@example.com', [second, second]);
      // Смена пароля гасит все сессии оператора: иначе украденная cookie
      // переживала бы ровно то действие, которым от неё и защищаются.
      expect(resolveAdminSession(control, first.session.token, NOW)).toBeUndefined();
      expect(loginAdmin(control, 'operator@example.com', second, NOW).ok).toBe(true);
      expect(loginAdmin(control, 'operator@example.com', PASSWORD, NOW).ok).toBe(false);
      expect(printed.join('\n')).not.toContain(second);
    });

    it('не ставит пароль, не совпавший с повтором', async () => {
      await run('create', 'operator@example.com');
      await expect(run('password', 'operator@example.com', [PASSWORD, 'опечатка-в-повторе']))
        .rejects.toThrow(/не совпал с повтором/u);
      expect(findAdminByEmail(control, 'operator@example.com')?.hasPassword).toBe(false);
    });

    it('отказывается ставить короткий пароль', async () => {
      await run('create', 'operator@example.com');
      const short = 'короткий-15знк';
      expect(short.length).toBeLessThan(MIN_ADMIN_PASSWORD_LENGTH);
      await expect(run('password', 'operator@example.com', [short, short]))
        .rejects.toThrow(new RegExp(`короче ${String(MIN_ADMIN_PASSWORD_LENGTH)} знаков`, 'u'));
    });

    it('отказывается менять пароль неизвестному и отключённому', async () => {
      await expect(run('password', 'operator@example.com', [PASSWORD, PASSWORD]))
        .rejects.toThrow(/нет в управляющей базе/u);

      await run('create', 'operator@example.com');
      await run('disable', 'operator@example.com');
      await expect(run('password', 'operator@example.com', [PASSWORD, PASSWORD]))
        .rejects.toThrow(/отключён/u);
    });
  });

  describe('disable', () => {
    it('отключает оператора и гасит его сессии', async () => {
      await run('create', 'operator@example.com');
      await run('password', 'operator@example.com', [PASSWORD, PASSWORD]);
      const login = loginAdmin(control, 'operator@example.com', PASSWORD, NOW);
      expect(login.ok).toBe(true);
      if (!login.ok) return;

      await run('disable', 'operator@example.com');

      expect(findAdminByEmail(control, 'operator@example.com')?.disabledAt).toBe(NOW.toISOString());
      expect(resolveAdminSession(control, login.session.token, NOW)).toBeUndefined();
      expect(loginAdmin(control, 'operator@example.com', PASSWORD, NOW).ok).toBe(false);
    });

    it('отказывается отключать неизвестного и уже отключённого', async () => {
      await expect(run('disable', 'operator@example.com')).rejects.toThrow(/нет в управляющей базе/u);

      await run('create', 'operator@example.com');
      await run('disable', 'operator@example.com');
      await expect(run('disable', 'operator@example.com')).rejects.toThrow(/уже отключён/u);
    });
  });
});

describe('admin CLI', () => {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const adminCli = resolve(projectRoot, 'scripts/admin.ts');
  const tsxCli = resolve(projectRoot, 'node_modules/tsx/dist/cli.mjs');

  let cliRoot: string;

  beforeEach(() => {
    cliRoot = mkdtempSync(join(tmpdir(), 'edukator-admin-cli-'));
  });

  afterEach(() => {
    rmSync(cliRoot, { recursive: true, force: true });
  });

  /** Запуск скрипта отдельным процессом: только так видны коды возврата и stdin. */
  function runCli(argv: string[], input: string): ReturnType<typeof spawnSync> {
    return spawnSync(process.execPath, [tsxCli, adminCli, ...argv], {
      encoding: 'utf8',
      input,
      env: { ...process.env, PATH: '' },
    });
  }

  /** Заводит оператора с известным паролем в отдельном каталоге данных CLI. */
  function seedCliAdmin(cliDir: string): void {
    const cliControl = openControlDatabase(controlDatabasePath(cliDir));
    try {
      const adminId = createAdmin(cliControl, 'admin@example.com', NOW);
      setAdminPassword(cliControl, adminId, PASSWORD, NOW);
    } finally {
      cliControl.close();
    }
  }

  it('заводит оператора и управляющую базу первой командой', () => {
    const cliDir = join(cliRoot, 'данные');

    const result = runCli(['create', '--email', 'admin@example.com', '--data-dir', cliDir], '');

    expect(result.status).toBe(0);
    const after = openControlDatabase(controlDatabasePath(cliDir));
    try {
      expect(findAdminByEmail(after, 'admin@example.com')).toMatchObject({ hasPassword: false });
    } finally {
      after.close();
    }
  });

  it('меняет пароль по трубе: секрет и повтор читаются одним интерфейсом', () => {
    const cliDir = ensureDataDir(join(cliRoot, 'данные'));
    seedCliAdmin(cliDir);

    // Две строки одним куском — ровно то, чем CLI пользуются из скриптов
    // заведения. Отдельный `readline` на вопрос забирал бы обе разом, отдавал
    // первую и терял вторую: договор «секрет читается со стандартного ввода»
    // работал бы только с живого терминала.
    const next = 'новый-пароль-оператора';
    const result = runCli(
      ['password', '--email', 'admin@example.com', '--data-dir', cliDir],
      `${next}\n${next}\n`,
    );

    expect(result.stderr).not.toMatch(/стандартный ввод закрыт/u);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(next);

    const after = openControlDatabase(controlDatabasePath(cliDir));
    try {
      expect(loginAdmin(after, 'admin@example.com', next, NOW).ok).toBe(true);
      expect(loginAdmin(after, 'admin@example.com', PASSWORD, NOW).ok).toBe(false);
    } finally {
      after.close();
    }
  });

  it('не считает смену пароля состоявшейся на закрытом вводе', () => {
    const cliDir = ensureDataDir(join(cliRoot, 'данные'));
    seedCliAdmin(cliDir);

    // Пустой stdin: `readline.question` обратный вызов не зовёт никогда, и без
    // разбора закрытия процесс выходил бы с кодом 0, не сменив ничего — в
    // цепочке `&&` это читается как «пароль сменён».
    const result = runCli(['password', '--email', 'admin@example.com', '--data-dir', cliDir], '');

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/стандартный ввод закрыт/u);

    const after = openControlDatabase(controlDatabasePath(cliDir));
    try {
      expect(loginAdmin(after, 'admin@example.com', PASSWORD, NOW).ok).toBe(true);
    } finally {
      after.close();
    }
  });

  it('называет каталог, а не адрес, когда управляющей базы нет', () => {
    const cliDir = join(cliRoot, 'не-тот-каталог');

    const result = runCli(['password', '--email', 'admin@example.com', '--data-dir', cliDir], '');

    expect(result.status).toBe(1);
    // «Оператора нет в управляющей базе» назвало бы виноватым адрес, хотя
    // виноват каталог: пустая база завелась бы рядом с опечаткой.
    expect(result.stderr).toMatch(/нет управляющей базы/u);
    expect(existsSync(controlDatabasePath(cliDir))).toBe(false);
  });

  it('отказывается ненулевым кодом на неизвестной команде', () => {
    const result = runCli(['invite', '--email', 'admin@example.com', '--data-dir', cliRoot], '');

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Неизвестная команда/u);
  });
});
