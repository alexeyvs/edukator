import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import {
  buildServer,
  checkDatabase,
  closeOnSignals,
  DEFAULT_PORT,
  HOST,
  readHost,
  readPort,
  readVersion,
  syncCurriculumState,
} from '../server/index.js';
import { DEFAULT_PROFILE, SCHEMA_VERSION, openDatabase, readProfile } from '../server/db.js';
import { loadCurriculum } from '../server/curriculum.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsxCli = join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const serverCli = join(projectRoot, 'server', 'index.ts');

/** Версия из package.json напрямую: сверять ответ с `readVersion()` — сверять функцию с самой собой. */
function packageVersion(): string {
  const raw = readFileSync(join(projectRoot, 'package.json'), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

describe('GET /api/health', () => {
  let app: FastifyInstance;
  let tempDir: string;
  let dbPath: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-health-'));
    dbPath = join(tempDir, 'health.db');
    app = buildServer(undefined, { dbPath });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('поднимается и отвечает 200', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
  });

  it('слушает 0.0.0.0, чтобы быть доступным из домашней сети', async () => {
    expect(HOST).toBe('0.0.0.0');

    const listening = buildServer(undefined, { dbPath });
    await listening.listen({ host: HOST, port: 0 });
    const bound = listening.server.address();

    expect(bound).not.toBeNull();
    expect(typeof bound === 'object' ? bound?.address : null).toBe('0.0.0.0');

    const response = await listening.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);

    await listening.close();
  });

  it('возвращает версию и статус базы данных', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    const body = response.json() as {
      status: string;
      version: string;
      database: string;
      curriculum: string;
      session: string;
    };

    expect(body.status).toBe('ok');
    expect(body.version).toBe(packageVersion());
    expect(readVersion()).toBe(packageVersion());
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(body.database).toBe('ok');
    expect(body.curriculum).toBe('ok');
    expect(body.session).toBe('ok');
  });

  it('отвечает 503 и status error, когда база недоступна', async () => {
    // Зелёный status над «database: error» врал бы ровно в тот момент, ради
    // которого health и читают.
    const unavailable = buildServer(undefined, {
      dbPath: join(tempDir, 'нет-такого-каталога', 'x.db'),
    });
    try {
      const response = await unavailable.inject({ method: 'GET', url: '/api/health' });
      const body = response.json() as { status: string; database: string; version: string };

      expect(response.statusCode).toBe(503);
      expect(body.status).toBe('error');
      expect(body.database).toBe('error');
      // Версия обязана дойти и на сломанной базе: health читают, чтобы понять,
      // какая сборка сломалась, и пустое поле версии тут бесполезно.
      expect(body.version).toBe(packageVersion());
    } finally {
      await unavailable.close();
    }
  });

  it('заводит темы карты в topic_state при старте сервера', () => {
    // Спека: «при старте сервера отсутствующие темы заводятся с нулевыми
    // значениями». Иначе планировщик поставит тему в план, а recordAttempt
    // упадёт на первом же ответе по ней.
    const path = join(tempDir, 'синхронизация.db');
    const known = [...loadCurriculum().byId.keys()];

    const first = syncCurriculumState(path);
    expect(first.added).toEqual(known);
    expect(first.stale).toEqual([]);

    // Повторный старт ничего не заводит заново.
    expect(syncCurriculumState(path).added).toEqual([]);

    const db = openDatabase(path);
    try {
      const rows = db
        .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM topic_state')
        .get();
      expect(rows?.n).toBe(known.length);
    } finally {
      db.close();
    }
  });

  it('отвечает 503 без раскрытия деталей карты, если предметы не загрузились', async () => {
    const failing = buildServer(join(tempDir, 'нет-карт'), { dbPath });
    try {
      const response = await failing.inject({ method: 'GET', url: '/api/health' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ status: 'error', database: 'ok', curriculum: 'error' });
      expect(response.json()).not.toHaveProperty('curriculumError');
    } finally {
      await failing.close();
    }
  });

  it('сообщает в stderr о состояниях без темы в карте', () => {
    // Строка topic_state без темы в карте — обычно опечатка или переименование
    // `id`, то есть потерянный прогресс. Молчание здесь скрыло бы единственный
    // сигнал об этом: удалять такие строки синхронизация сознательно не будет.
    const path = join(tempDir, 'осиротевшие.db');
    syncCurriculumState(path);

    const db = openDatabase(path);
    try {
      db.prepare('INSERT INTO topic_state (topic_id) VALUES (?)').run('math.переименованная');
    } finally {
      db.close();
    }

    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(syncCurriculumState(path).stale).toEqual(['math.переименованная']);
    } finally {
      process.stderr.write = original;
    }

    expect(written.join('')).toContain('math.переименованная');
  });

  it('buildServer синхронизирует topic_state, а не только поднимает маршруты', async () => {
    const path = join(tempDir, 'через-buildServer.db');
    // Соединение занятия закрывается хуком `onClose`: без `app.close()` оно и
    // файлы `-wal`/`-shm` живут до конца прогона.
    const app = buildServer(undefined, { dbPath: path });
    try {
      const db = openDatabase(path);
      try {
        const rows = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM topic_state').get();
        expect(rows?.n).toBe(loadCurriculum().byId.size);
      } finally {
        db.close();
      }
    } finally {
      await app.close();
    }
  });

  it('поднимает сервер и отвечает 503, когда синхронизация карты при старте падает', async () => {
    // Причина остаётся в stderr, а health обязан остаться доступным и показать
    // стабильный статус, не раскрывая клиенту локальные пути и детали схемы.
    const startPath = join(tempDir, 'нет-такого-каталога', 'старт.db');
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    let failing: FastifyInstance | undefined;
    try {
      failing = buildServer(undefined, { dbPath: startPath });
      const response = await failing.inject({ method: 'GET', url: '/api/health' });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ status: 'error', database: 'error' });
    } finally {
      process.stderr.write = original;
      await failing?.close();
    }

    expect(written.join('')).toContain('синхронизация карты тем');
  });

  it('повторяет синхронизацию карты после восстановления базы', async () => {
    const parent = join(tempDir, 'временно-недоступно');
    const path = join(parent, 'восстановилась.db');

    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    let recovering: FastifyInstance | undefined;
    try {
      recovering = buildServer(undefined, { dbPath: path });
      const unavailable = await recovering.inject({ method: 'GET', url: '/api/health' });
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json()).toMatchObject({ database: 'error', curriculum: 'ok' });

      mkdirSync(parent);
      const restored = await recovering.inject({ method: 'GET', url: '/api/health' });
      // База поднялась и карта синхронизирована, но занятие осталось на
      // заглушке: маршруты выбраны один раз при старте. Зелёный статус здесь
      // означал бы «занимайся», а `/api/session/*` до перезапуска отдаёт 503.
      expect(restored.statusCode).toBe(503);
      expect(restored.json()).toMatchObject({
        status: 'error',
        database: 'ok',
        curriculum: 'ok',
        session: 'error',
      });
      const lesson = await recovering.inject({ method: 'GET', url: '/api/session/next' });
      expect(lesson.statusCode).toBe(503);

      const db = openDatabase(path);
      try {
        const row = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM topic_state').get();
        expect(row?.n).toBe(loadCurriculum().byId.size);
      } finally {
        db.close();
      }
    } finally {
      process.stderr.write = original;
      await recovering?.close();
    }

    expect(written.join('')).toContain('синхронизация карты тем');
  });

  it('повторяет синхронизацию после замены уже исправной базы, но краснеет за занятие', async () => {
    const path = join(tempDir, 'заменённая.db');
    const replacing = buildServer(undefined, { dbPath: path });

    try {
      expect((await replacing.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);

      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
      openDatabase(path).close();

      // Карта синхронизирована с новым файлом, но занятие держит соединение со
      // старым, уже отвязанным. Само оно об этом не сообщит: под WAL по нему
      // проходят и чтение, и запись, только записанное остаётся в файле,
      // которого по пути базы больше нет. Зелёный health здесь означал бы
      // «занимайся», а ответы ученика уходили бы в никуда.
      const restored = await replacing.inject({ method: 'GET', url: '/api/health' });
      expect(restored.statusCode).toBe(503);
      expect(restored.json()).toMatchObject({
        status: 'error',
        database: 'ok',
        curriculum: 'ok',
        session: 'error',
      });
      // Красный health недостаточен: клиент может не опросить его перед
      // ответом. Сам маршрут обязан не писать в отвязанный старый inode.
      expect(
        (await replacing.inject({ method: 'GET', url: '/api/session/next' })).statusCode,
      ).toBe(503);
      expect(
        (await replacing.inject({ method: 'GET', url: '/api/gate/status' })).statusCode,
      ).toBe(503);

      const db = openDatabase(path);
      try {
        const row = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM topic_state').get();
        expect(row?.n).toBe(loadCurriculum().byId.size);
      } finally {
        db.close();
      }
    } finally {
      await replacing.close();
    }
  });

  it('не создаёт заново базу, которая пропала после успешного старта', async () => {
    const path = join(tempDir, 'пропала-после-старта.db');
    const watching = buildServer(undefined, { dbPath: path });

    try {
      expect((await watching.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });

      const missing = await watching.inject({ method: 'GET', url: '/api/health' });
      expect(missing.statusCode).toBe(503);
      // Занятие тоже красное: его соединение осталось на удалённом файле.
      expect(missing.json()).toMatchObject({ status: 'error', database: 'error', session: 'error' });
      expect(existsSync(path)).toBe(false);
    } finally {
      await watching.close();
    }
  });

  it('сообщает об ошибке базы, если путь недоступен', () => {
    expect(checkDatabase(join(tempDir, 'нет-такого-каталога', 'x.db'))).toBe('error');
  });

  it('не заводит базу на месте пропавшей, а сообщает об ошибке', () => {
    // Открытие несуществующего файла создало бы пустую базу и отчиталось «ok»:
    // потеря всего прогресса выглядела бы здоровьем.
    const path = join(tempDir, 'пропала.db');

    expect(checkDatabase(path)).toBe('error');
    expect(existsSync(path)).toBe(false);
  });

  it('оставляет базу мигрированной после проверки', () => {
    const path = join(tempDir, 'свежая.db');
    openDatabase(path).close();

    expect(checkDatabase(path)).toBe('ok');

    const db = openDatabase(path);
    try {
      const [version] = db.pragma('user_version') as [{ user_version: number }];
      expect(version.user_version).toBe(SCHEMA_VERSION);
      expect(readProfile(db)).toEqual({ ...DEFAULT_PROFILE, partnerName: '' });
    } finally {
      db.close();
    }
  });

  it('считает повреждённую схему ошибкой даже при актуальном user_version', () => {
    const path = join(tempDir, 'повреждена.db');
    const db = openDatabase(path);
    db.exec('DROP TABLE attempts');
    db.close();

    expect(checkDatabase(path)).toBe('error');
  });

  it('отдаёт 404 на неизвестный маршрут', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/nope' });

    expect(response.statusCode).toBe(404);
  });

  // Без обработчика сигнала `onClose` не срабатывает никогда: процесс снимают
  // по Ctrl-C, соединение занятия остаётся открытым, и WAL закрывается не
  // переносом в основной файл, а восстановлением при следующем запуске.
  // Сигнал взят посторонний: настоящий SIGINT снял бы сам прогон тестов.
  it('закрывает сервер по сигналу', async () => {
    const closing = buildServer(undefined, { dbPath });
    // Ожидание закрытия ставится до сигнала и разрешается самим `onClose`:
    // явный `close()` в конце теста поднял бы флаг и без единого обработчика
    // сигнала, то есть проверка проходила бы и на пустой `closeOnSignals`.
    const closed = new Promise<void>((resolve) => {
      closing.addHook('onClose', () => {
        resolve();
      });
    });
    await closing.ready();

    closeOnSignals(closing, ['SIGUSR2']);
    // Обработчик действительно повешен, иначе ждать нечего.
    expect(process.listenerCount('SIGUSR2')).toBe(1);
    process.emit('SIGUSR2');
    await closed;

    await closing.close();
    // `once`: повторный тот же сигнал обязан убивать процесс по-обычному, иначе
    // зависшее закрытие нечем прервать.
    expect(process.listenerCount('SIGUSR2')).toBe(0);
  });

  // Список обязан совпадать с `DEATH_SIGNALS` из `run-child.ts`: там на каждом
  // из этих сигналов снимается группа потомка, а смерть родителя досылается
  // руками ровно тогда, когда сигнал до нас никто не слушал. Пропусти здесь
  // `SIGHUP` — и закрытие терминала посреди разбора спора убивало бы процесс
  // из-под незакрытой базы, то есть ровно то, ради чего заводился `onClose`.
  it('по умолчанию слушает те же сигналы, что снимают потомков', async () => {
    const signals: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const closing = buildServer(undefined, { dbPath });
    await closing.ready();
    const before = signals.map((signal) => process.listenerCount(signal));

    closeOnSignals(closing);

    try {
      signals.forEach((signal, index) => {
        expect(process.listenerCount(signal)).toBe((before[index] ?? 0) + 1);
      });
    } finally {
      // Подписки снимаются руками: `once` снимет их только по самому сигналу, а
      // послать настоящий SIGINT значит убить прогон тестов.
      for (const signal of signals) {
        const listeners = process.listeners(signal);
        const last = listeners[listeners.length - 1];
        if (last !== undefined) process.removeListener(signal, last as () => void);
      }
      await closing.close();
    }
  });

  // `Number(process.env.PORT ?? 3000)` ловил только незаданную переменную:
  // `PORT=` давало 0 — Fastify слушал случайный порт, а в баннере стояло `:0`,
  // то есть единственная строка, по которой на планшете открывают приложение,
  // вела в никуда. `PORT=abc` давало NaN и необработанный отказ.
  describe('readPort', () => {
    it('берёт умолчание на незаданной и пустой переменной', () => {
      expect(readPort(undefined)).toBe(DEFAULT_PORT);
      expect(readPort('')).toBe(DEFAULT_PORT);
      expect(readPort('   ')).toBe(DEFAULT_PORT);
      expect(DEFAULT_PORT).toBe(3000);
    });

    it('принимает заданный порт', () => {
      expect(readPort('8080')).toBe(8080);
      expect(readPort(' 1 ')).toBe(1);
      expect(readPort('65535')).toBe(65535);
    });

    it('падает внятно на значении, которое портом быть не может', () => {
      for (const value of ['abc', '0', '-1', '65536', '3000.5', 'Infinity']) {
        expect(() => readPort(value), value).toThrow(/PORT должен быть целым числом от 1 до 65535/u);
      }
    });
  });

  describe('readHost', () => {
    it('берёт адрес по умолчанию на незаданной и пустой переменной', () => {
      expect(readHost(undefined)).toBe(HOST);
      expect(readHost('')).toBe(HOST);
      expect(readHost('   ')).toBe(HOST);
    });

    it('принимает заданный адрес и убирает пробелы по краям', () => {
      expect(readHost(' 192.168.100.141 ')).toBe('192.168.100.141');
    });
  });

  it('прямой CLI-запуск возвращает код 1 на битом PORT до открытия базы', () => {
    const dir = join(tempDir, 'cli-invalid-port');
    const result = spawnSync(process.execPath, [tsxCli, serverCli], {
      encoding: 'utf8',
      env: { ...process.env, PORT: 'не-порт', EDUKATOR_DATA_DIR: dir },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/edukator не поднялся:.*PORT/u);
    // Каталог данных не заведён: битый PORT обязан отсекаться до всякой работы
    // с диском, иначе ошибка запуска оставляла бы за собой полупустой каталог.
    expect(existsSync(dir)).toBe(false);
  });
});
