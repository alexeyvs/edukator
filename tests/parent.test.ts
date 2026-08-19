import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import type { Database } from 'better-sqlite3';
import {
  createParent,
  findParentByEmail,
  loginParent,
  openControlDatabase,
  readParentInvite,
  readParentPinHash,
  redeemParentInvite,
  resolveParentSession,
  setParentPassword,
} from '../server/control-db.js';
import { controlDatabasePath, ensureDataDir } from '../server/data-dir.js';
import { verifyParentPin } from '../server/parent-pin.js';
import { parseArgs, runParentCommand, type ParentArgs } from '../scripts/parent.js';

/** Pepper длиннее порога: с коротким `hashParentPin` отказывается считать хеш. */
const PEPPER = 'секретная-приправа-подлиннее';
const PASSWORD = 'пароль-подлиннее';
const NOW = new Date('2026-08-19T10:00:00.000Z');

describe('скрипт обслуживания родителей', () => {
  let dir: string;
  let control: Database;
  let printed: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'edukator-parent-script-'));
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
    action: ParentArgs['action'],
    email: string,
    answers: string[] = [],
    now: Date = NOW,
  ): Promise<void> {
    await runParentCommand(
      { action, email },
      {
        control,
        readSecret: secrets(...answers),
        out: (line) => printed.push(line),
        pinPepper: PEPPER,
        now: () => now,
      },
    );
  }

  describe('разбор аргументов', () => {
    it('читает команду, адрес и каталог данных', () => {
      expect(parseArgs(['invite', '--email', 'Mama@Example.com', '--data-dir', 'данные'])).toEqual({
        action: 'invite',
        email: 'Mama@Example.com',
        dataDir: resolve('данные'),
      });
      expect(parseArgs(['create', '--email', 'mama@example.com'])).toEqual({
        action: 'create',
        email: 'mama@example.com',
      });
    });

    it('отвергает секрет во флаге', () => {
      // Аргументы видны в `ps` любому пользователю машины и остаются в истории
      // оболочки, поэтому такой флаг не «не рекомендуется», а не существует.
      expect(() => parseArgs(['password', '--email', 'a@b.ru', '--password', 'тайна']))
        .toThrow(/виден в списке процессов/u);
      expect(() => parseArgs(['pin', '--email', 'a@b.ru', '--pin', '123456']))
        .toThrow(/виден в списке процессов/u);
    });

    it('не вписывает секрет в текст отказа', () => {
      // Форма `--pin=1234` не совпадает ни с одним известным флагом, и текст
      // отказа с флагом целиком уносил бы секрет в stderr и в лог запуска —
      // третий канал утечки поверх `ps` и истории оболочки, ради закрытия
      // которых секреты флагами и не принимаются.
      for (const argv of [
        ['pin', '--email', 'a@b.ru', '--pin=123456'],
        ['password', '--email', 'a@b.ru', '--password=тайна'],
      ]) {
        let message = '';
        try {
          parseArgs(argv);
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).toMatch(/виден в списке процессов/u);
        expect(message).not.toMatch(/123456|тайна/u);
      }

      // Обычный флаг в той же форме — не ошибка: значение отделяется от имени
      // до всякой проверки, а не после неё.
      expect(parseArgs(['create', '--email=mama@example.com'])).toEqual({
        action: 'create',
        email: 'mama@example.com',
      });
      expect(() => parseArgs(['create', '--email=', '--data-dir', 'данные']))
        .toThrow(/пустое значение/u);
    });

    it('не вписывает в отказ и лишний позиционный аргумент', () => {
      // Привыкший к флагам наберёт `parent password --email a@b тайна`, и
      // названный значением лишний аргумент уносил бы пароль в stderr — ровно
      // та утечка, ради закрытия которой секреты флагами и не принимаются.
      let message = '';
      try {
        parseArgs(['password', '--email', 'a@b.ru', 'тайна']);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/Аргумент №3/u);
      expect(message).not.toMatch(/тайна/u);
    });

    it('отвергает пустое, повторное, неизвестное и отсутствующее', () => {
      expect(() => parseArgs([])).toThrow(/Не указана команда/u);
      expect(() => parseArgs(['удалить', '--email', 'a@b.ru'])).toThrow(/Неизвестная команда/u);
      expect(() => parseArgs(['create'])).toThrow(/--email/u);
      expect(() => parseArgs(['create', '--email'])).toThrow(/нет значения/u);
      expect(() => parseArgs(['create', '--email', ' '])).toThrow(/пустое значение/u);
      expect(() => parseArgs(['create', '--email', 'a@b.ru', '--email', 'c@d.ru']))
        .toThrow(/дважды/u);
      expect(() => parseArgs(['create', '--email', 'a@b.ru', '--что-то', 'x']))
        .toThrow(/Неизвестный флаг/u);
      expect(() => parseArgs(['create', 'a@b.ru'])).toThrow(/Аргумент №1 не похож на флаг/u);
    });
  });

  describe('create', () => {
    it('заводит родителя без пароля и PIN', async () => {
      await run('create', 'Mama@Example.COM');

      const parent = findParentByEmail(control, 'mama@example.com');
      expect(parent).toMatchObject({ hasPassword: false, hasPin: false });
      expect(printed.join('\n')).toContain(parent?.id ?? 'нет такого');
    });

    it('отказывается заводить второй раз тот же адрес', async () => {
      await run('create', 'mama@example.com');
      await expect(run('create', 'mama@example.com')).rejects.toThrow(/уже заведён/u);
    });

    it('отказывается заводить не адрес', async () => {
      await expect(run('create', 'не адрес')).rejects.toThrow(/не похож на электронную почту/u);
    });
  });

  describe('invite', () => {
    it('печатает ссылку, которой можно поставить пароль', async () => {
      await run('create', 'mama@example.com');
      printed = [];
      await run('invite', 'mama@example.com');

      const match = /\/invite\/([A-Za-z0-9_-]{43})/u.exec(printed.join('\n'));
      expect(match).not.toBeNull();
      const token = match?.[1] ?? '';
      expect(readParentInvite(control, token, NOW).ok).toBe(true);
      const redeemed = redeemParentInvite(control, token, PASSWORD, NOW);
      expect(redeemed.ok).toBe(true);
    });

    it('отказывается выпускать приглашение неизвестному и отключённому', async () => {
      await expect(run('invite', 'papa@example.com')).rejects.toThrow(/нет в управляющей базе/u);

      await run('create', 'mama@example.com');
      await run('disable', 'mama@example.com');
      await expect(run('invite', 'mama@example.com')).rejects.toThrow(/отключён/u);
    });
  });

  describe('password', () => {
    it('ставит пароль, гасит прежний вход и не печатает секрет', async () => {
      await run('create', 'mama@example.com');
      await run('password', 'mama@example.com', [PASSWORD, PASSWORD]);
      const first = loginParent(control, 'mama@example.com', PASSWORD, NOW);
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      printed = [];
      // Час спустя: сессия гаснет по строгому сравнению с `credentials_changed_at`,
      // и смена пароля той же миллисекундой её не тронула бы.
      const later = new Date(NOW.getTime() + 60 * 60 * 1000);
      await run('password', 'mama@example.com', ['совсем-другой-пароль', 'совсем-другой-пароль'], later);

      expect(resolveParentSession(control, first.session.token, later)).toBeUndefined();
      expect(loginParent(control, 'mama@example.com', 'совсем-другой-пароль', later).ok).toBe(true);
      // Секрет не уходит ни в один вывод скрипта: там, где печатают, потом ищут.
      expect(printed.join('\n')).not.toContain('совсем-другой-пароль');
      expect(printed.join('\n')).toContain('погашены');
    });

    it('отказывается менять пароль, если повтор не совпал', async () => {
      await run('create', 'mama@example.com');

      await expect(run('password', 'mama@example.com', [PASSWORD, 'опечатка-подлиннее']))
        .rejects.toThrow(/не совпал/u);
      expect(findParentByEmail(control, 'mama@example.com')?.hasPassword).toBe(false);
    });

    it('отказывается ставить короткий пароль', async () => {
      await run('create', 'mama@example.com');

      await expect(run('password', 'mama@example.com', ['кратко', 'кратко']))
        .rejects.toThrow(/короче/u);
      expect(findParentByEmail(control, 'mama@example.com')?.hasPassword).toBe(false);
    });
  });

  describe('pin', () => {
    it('ставит PIN, проверяемый с тем же pepper', async () => {
      await run('create', 'mama@example.com');
      await run('pin', 'mama@example.com', ['135790', '135790']);

      const parent = findParentByEmail(control, 'mama@example.com');
      expect(parent?.hasPin).toBe(true);
      const hash = readParentPinHash(control, parent?.id ?? '');
      expect(verifyParentPin(hash, '135790', PEPPER)).toBe(true);
      expect(verifyParentPin(hash, '135791', PEPPER)).toBe(false);
      // Без pepper тот же PIN не подходит: он и добирает стойкость, которой у
      // шестизначного значения нет.
      expect(verifyParentPin(hash, '135790', undefined)).toBe(false);
      expect(printed.join('\n')).not.toContain('135790');
    });

    it('отказывается без pepper и на PIN не того вида', async () => {
      await run('create', 'mama@example.com');
      // Переменная гасится явно: у разработчика с заданным в оболочке pepper
      // ветка «pepper нет» иначе не проверялась бы вовсе.
      vi.stubEnv('EDUKATOR_PIN_PEPPER', '');

      await expect(
        runParentCommand(
          { action: 'pin', email: 'mama@example.com' },
          {
            control,
            readSecret: secrets('135790', '135790'),
            out: (line) => printed.push(line),
            now: () => NOW,
          },
        ),
      ).rejects.toThrow(/EDUKATOR_PIN_PEPPER/u);

      // Пустая переменная — тот же отказ, а не жалоба на длину: `??` ловит
      // только незаданную, и `EDUKATOR_PIN_PEPPER=` доезжал бы до KDF.
      vi.stubEnv('EDUKATOR_PIN_PEPPER', 'короткий');
      await expect(
        runParentCommand(
          { action: 'pin', email: 'mama@example.com' },
          {
            control,
            // PIN не спрашивается вовсе: отказ по настройке обязан случиться до
            // двух вопросов, на которые всё равно нечем ответить.
            readSecret: () => Promise.reject(new Error('PIN спрашивать было не нужно')),
            out: (line) => printed.push(line),
            now: () => NOW,
          },
        ),
      ).rejects.toThrow(/EDUKATOR_PIN_PEPPER/u);

      await expect(run('pin', 'mama@example.com', ['12', '12'])).rejects.toThrow(/6-12 цифр/u);
      expect(findParentByEmail(control, 'mama@example.com')?.hasPin).toBe(false);
      vi.unstubAllEnvs();
    });
  });

  describe('disable', () => {
    it('закрывает вход и повторно отказывает', async () => {
      await run('create', 'mama@example.com');
      await run('password', 'mama@example.com', [PASSWORD, PASSWORD]);

      await run('disable', 'mama@example.com');

      expect(loginParent(control, 'mama@example.com', PASSWORD, NOW)).toEqual({
        ok: false,
        reason: 'disabled',
      });
      await expect(run('disable', 'mama@example.com')).rejects.toThrow(/уже отключён/u);
    });

    it('отказывается отключать неизвестного', async () => {
      await expect(run('disable', 'papa@example.com')).rejects.toThrow(/нет в управляющей базе/u);
    });
  });
});

/** Проверка среды: pepper теста обязан проходить порог, иначе тесты PIN пусты. */
describe('настройка теста', () => {
  describe('parent CLI', () => {
    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const parentCli = resolve(projectRoot, 'scripts/parent.ts');
    const tsxCli = resolve(projectRoot, 'node_modules/tsx/dist/cli.mjs');

    let cliRoot: string;

    beforeEach(() => {
      cliRoot = mkdtempSync(join(tmpdir(), 'edukator-parent-cli-'));
    });

    afterEach(() => {
      rmSync(cliRoot, { recursive: true, force: true });
    });

    /** Заводит родителя с известным паролем в отдельном каталоге данных CLI. */
    function seedCliParent(cliDir: string): void {
      const cliControl = openControlDatabase(controlDatabasePath(cliDir));
      try {
        const parentId = createParent(cliControl, 'cli@example.com', NOW);
        setParentPassword(cliControl, parentId, PASSWORD, NOW);
      } finally {
        cliControl.close();
      }
    }

    it('меняет пароль по трубе: секрет и повтор читаются одним интерфейсом', () => {
      const cliDir = ensureDataDir(join(cliRoot, 'данные'));
      seedCliParent(cliDir);

      // Ровно то, чем скрипт пользуются из скриптов заведения: две строки одним
      // куском. Отдельный `readline` на вопрос забирал бы обе разом, отдавал
      // первую и терял вторую — то есть документированный договор «секрет
      // читается со стандартного ввода» работал бы только с живого терминала.
      const result = spawnSync(
        process.execPath,
        [tsxCli, parentCli, 'password', '--email', 'cli@example.com', '--data-dir', cliDir],
        {
          encoding: 'utf8',
          input: 'новый-длинный-пароль\nновый-длинный-пароль\n',
          env: { ...process.env, PATH: '' },
        },
      );

      expect(result.stderr).not.toMatch(/стандартный ввод закрыт/u);
      expect(result.status).toBe(0);

      const after = openControlDatabase(controlDatabasePath(cliDir));
      try {
        expect(loginParent(after, 'cli@example.com', 'новый-длинный-пароль', NOW).ok).toBe(true);
        expect(loginParent(after, 'cli@example.com', PASSWORD, NOW).ok).toBe(false);
      } finally {
        after.close();
      }
    });

    it('не сверяет пароль с потерянным повтором', () => {
      const cliDir = ensureDataDir(join(cliRoot, 'данные'));
      seedCliParent(cliDir);

      const result = spawnSync(
        process.execPath,
        [tsxCli, parentCli, 'password', '--email', 'cli@example.com', '--data-dir', cliDir],
        {
          encoding: 'utf8',
          input: 'новый-длинный-пароль\nопечатка-в-повторе\n',
          env: { ...process.env, PATH: '' },
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/не совпал с повтором/u);

      const after = openControlDatabase(controlDatabasePath(cliDir));
      try {
        expect(loginParent(after, 'cli@example.com', PASSWORD, NOW).ok).toBe(true);
      } finally {
        after.close();
      }
    });

    it('называет каталог, а не адрес, когда управляющей базы нет', () => {
      const cliDir = join(cliRoot, 'не-тот-каталог');

      const result = spawnSync(
        process.execPath,
        [tsxCli, parentCli, 'invite', '--email', 'cli@example.com', '--data-dir', cliDir],
        { encoding: 'utf8', input: '', env: { ...process.env, PATH: '' } },
      );

      expect(result.status).toBe(1);
      // «Родителя нет в управляющей базе» назвало бы виноватым адрес, хотя
      // виноват каталог: пустая база завелась бы рядом с опечаткой.
      expect(result.stderr).toMatch(/нет управляющей базы/u);
      expect(existsSync(controlDatabasePath(cliDir))).toBe(false);
    });

    it('не считает смену пароля состоявшейся на закрытом вводе', () => {
      const cliDir = ensureDataDir(join(cliRoot, 'данные'));
      const cliControl = openControlDatabase(controlDatabasePath(cliDir));
      try {
        const parentId = createParent(cliControl, 'cli@example.com', NOW);
        setParentPassword(cliControl, parentId, PASSWORD, NOW);
      } finally {
        cliControl.close();
      }

      // Пустой stdin: `readline.question` обратный вызов не зовёт никогда, и без
      // разбора закрытия процесс выходил бы с кодом 0, не сменив ничего — в
      // цепочке `&&` это читается как «пароль сменён».
      const result = spawnSync(
        process.execPath,
        [tsxCli, parentCli, 'password', '--email', 'cli@example.com', '--data-dir', cliDir],
        { encoding: 'utf8', input: '', env: { ...process.env, PATH: '' } },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/стандартный ввод закрыт/u);

      const after = openControlDatabase(controlDatabasePath(cliDir));
      try {
        // Прежний пароль обязан работать: молчаливый выход 0 означал бы, что
        // пароль «сменён» на несуществующий.
        expect(loginParent(after, 'cli@example.com', PASSWORD, NOW).ok).toBe(true);
      } finally {
        after.close();
      }
    });
  });

  it('pepper длиннее порога', () => {
    expect(PEPPER.length).toBeGreaterThanOrEqual(16);
  });
});
