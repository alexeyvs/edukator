import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import {
  buildServer,
  closeOnSignals,
  DEFAULT_PORT,
  HOST,
  readHost,
  readPort,
  readVersion,
} from '../server/index.js';
import { openDatabase } from '../server/db.js';
import { loadCurriculum } from '../server/curriculum.js';
import { controlDatabasePath } from '../server/data-dir.js';
import { openControlDatabase } from '../server/control-db.js';
import { childHeaders, startTenantServer, type TenantServer } from './server-harness.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsxCli = join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const serverCli = join(projectRoot, 'server', 'index.ts');

/** Версия из package.json напрямую: сверять ответ с `readVersion()` — сверять функцию с самой собой. */
function packageVersion(): string {
  const raw = readFileSync(join(projectRoot, 'package.json'), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

interface HealthBody {
  status: string;
  version: string;
  control: string;
  curriculum: string;
  children: { open: number; detached: string[] };
}

describe('GET /api/health', () => {
  let app: FastifyInstance;
  let tempDir: string;
  let dataDir: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-health-'));
    dataDir = join(tempDir, 'data');
    app = buildServer(undefined, { dataDir });
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

    const listening = buildServer(undefined, { dataDir: join(tempDir, 'слушает') });
    await listening.listen({ host: HOST, port: 0 });
    const bound = listening.server.address();

    expect(bound).not.toBeNull();
    expect(typeof bound === 'object' ? bound?.address : null).toBe('0.0.0.0');

    const response = await listening.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);

    await listening.close();
  });

  it('возвращает версию, состояние управляющей базы и карты тем', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    const body = response.json() as HealthBody;

    expect(body.status).toBe('ok');
    expect(body.version).toBe(packageVersion());
    expect(readVersion()).toBe(packageVersion());
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(body.control).toBe('ok');
    expect(body.curriculum).toBe('ok');
    // Ни одного обращения к детям не было — и ни одна база не открыта.
    expect(body.children).toEqual({ open: 0, detached: [] });
  });

  it('отвечает 503 и status error, когда управляющая база недоступна', async () => {
    // Зелёный status над «control: error» врал бы ровно в тот момент, ради
    // которого health и читают. Каталог данных подменён файлом: завести в нём
    // `children/` невозможно, то есть управляющей базы не будет.
    const busy = join(tempDir, 'не-каталог');
    writeFileSync(busy, 'не каталог, а файл');
    const unavailable = buildServer(undefined, { dataDir: busy });
    try {
      const response = await unavailable.inject({ method: 'GET', url: '/api/health' });
      const body = response.json() as HealthBody;

      expect(response.statusCode).toBe(503);
      expect(body.status).toBe('error');
      expect(body.control).toBe('error');
      // Версия обязана дойти и на сломанном сервере: health читают, чтобы
      // понять, какая сборка сломалась, и пустое поле версии тут бесполезно.
      expect(body.version).toBe(packageVersion());
    } finally {
      await unavailable.close();
    }
  });

  it('без управляющей базы отвечает 503 на маршруты, а не 404', async () => {
    // Незарегистрированный маршрут отвечает 404 от Fastify, и родитель прочитал
    // бы отказ по состоянию как опечатку в адресе.
    const busy = join(tempDir, 'не-каталог-2');
    writeFileSync(busy, 'не каталог, а файл');
    const unavailable = buildServer(undefined, { dataDir: busy });
    try {
      for (const url of ['/api/auth/me', '/api/family']) {
        const response = await unavailable.inject({ method: 'GET', url });
        expect(response.statusCode, url).toBe(503);
        expect((response.json() as { error: string }).error, url)
          .toMatch(/управляющая база недоступна/u);
      }
    } finally {
      await unavailable.close();
    }
  });

  it('отвечает 503 без раскрытия деталей карты, если предметы не загрузились', async () => {
    const failing = buildServer(join(tempDir, 'нет-карт'), { dataDir: join(tempDir, 'без-карты') });
    try {
      const response = await failing.inject({ method: 'GET', url: '/api/health' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ status: 'error', control: 'ok', curriculum: 'error' });
      expect(response.json()).not.toHaveProperty('curriculumError');
    } finally {
      await failing.close();
    }
  });

  it('краснеет, когда управляющую базу подменили под живым процессом', async () => {
    // Под WAL запись в отвязанный файл проходит без ошибки: данные остаются
    // там, где их уже никто не найдёт, а health отвечал бы «ok».
    const replacedDir = join(tempDir, 'подменённая-control');
    const replaced = buildServer(undefined, { dataDir: replacedDir });
    try {
      expect((await replaced.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);

      const path = controlDatabasePath(replacedDir);
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
      openControlDatabase(path).close();

      const response = await replaced.inject({ method: 'GET', url: '/api/health' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ status: 'error', control: 'error' });
    } finally {
      await replaced.close();
    }
  });

  it('заводит темы карты в topic_state при открытии базы ребёнка', async () => {
    // Спека: «при старте сервера отсутствующие темы заводятся с нулевыми
    // значениями». Баз у сервера столько, сколько детей, и заводятся темы при
    // открытии каждой: иначе планировщик поставит тему в план, а recordAttempt
    // упадёт на первом же ответе по ней.
    const server = await startTenantServer({ dataDir: join(tempDir, 'темы') });
    try {
      const db = openDatabase(server.dbPath);
      try {
        const row = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM topic_state').get();
        expect(row?.n).toBe(loadCurriculum().byId.size);
      } finally {
        db.close();
      }
    } finally {
      await server.close();
    }
  });

  describe('дети', () => {
    let server: TenantServer;

    beforeAll(async () => {
      server = await startTenantServer({ dataDir: join(tempDir, 'дети'), worker: false });
    });

    afterAll(async () => {
      await server.close();
    });

    it('не открывает базы тех детей, к которым не обращались', async () => {
      const untouched = server.addChild('Второй');

      const body = (await server.app.inject({ method: 'GET', url: '/api/health' }))
        .json() as HealthBody;

      // Открыт ровно тот, к кому обращались. Обход всех детей ради
      // `quick_check` заводил бы соединения, которых никто не просил.
      expect(body.children.open).toBe(1);
      expect(body.status).toBe('ok');
      expect(existsSync(untouched.dbPath)).toBe(true);
    });

    it('краснеет за подменённую базу ребёнка и называет его', async () => {
      const other = server.addChild('Третий');
      expect((await server.app.inject({
        method: 'GET',
        url: '/api/gate/status',
        headers: other.headers,
      })).statusCode).toBe(200);

      for (const suffix of ['', '-wal', '-shm']) rmSync(`${other.dbPath}${suffix}`, { force: true });
      openDatabase(other.dbPath).close();

      const response = await server.app.inject({ method: 'GET', url: '/api/health' });
      const body = response.json() as HealthBody;

      expect(response.statusCode).toBe(503);
      expect(body.status).toBe('error');
      expect(body.control).toBe('ok');
      expect(body.children.detached).toEqual([other.childId]);
      // Занятие второго ребёнка при этом работает: отказ точечный.
      expect((await server.app.inject({ method: 'GET', url: '/api/gate/status' })).statusCode)
        .toBe(200);
      expect((await server.app.inject({
        method: 'GET',
        url: '/api/gate/status',
        headers: other.headers,
      })).statusCode).toBe(503);
    });
  });

  it('испорченная база одного ребёнка не мешает остальным', async () => {
    const server = await startTenantServer({ dataDir: join(tempDir, 'испорченная'), worker: false });
    const logged: string[] = [];
    try {
      const broken = server.addChild('Сломанный');
      // Файл на месте, но это не база SQLite: открыть его нечем.
      writeFileSync(broken.dbPath, 'не база, а мусор');

      const stderr = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string) => {
        logged.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      let refused;
      try {
        refused = await server.app.inject({
          method: 'GET',
          url: '/api/gate/status',
          headers: broken.headers,
        });
      } finally {
        process.stderr.write = stderr;
      }

      expect(refused.statusCode).toBe(503);
      expect((refused.json() as { error: string }).error).toBe('База ребёнка недоступна');
      // Наружу уходит общий текст, а чья база испорчена — видно только в логе:
      // остальные дети при этом работают, и по одному 503 их не различить.
      expect(logged.join('')).toContain(broken.childId);

      const working = await server.app.inject({ method: 'GET', url: '/api/gate/status' });
      expect(working.statusCode).toBe(200);
      const health = await server.app.inject({ method: 'GET', url: '/api/health' });
      // Сервер здоров: испорченная база не открыта, и красить весь сервер за
      // одного ребёнка значило бы звать к перезапуску всю семью.
      expect(health.statusCode).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('отдаёт 404 на неизвестный маршрут', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/nope' });

    expect(response.statusCode).toBe(404);
  });

  it('переживает перезапуск: второй сервер поднимает того же ребёнка', async () => {
    const dir = join(tempDir, 'перезапуск');
    const first = await startTenantServer({ dataDir: dir, worker: false });
    const token = first.childToken;
    const childId = first.childId;
    await first.close();

    const second = buildServer(undefined, { dataDir: dir, worker: false });
    try {
      const response = await second.inject({
        method: 'GET',
        url: '/api/gate/status',
        headers: childHeaders(token),
      });
      expect(response.statusCode).toBe(200);
      const body = (await second.inject({ method: 'GET', url: '/api/health' }))
        .json() as HealthBody;
      expect(body.children).toEqual({ open: 1, detached: [] });
      expect(childId).toMatch(/^[0-9a-f]{8,64}$/u);
    } finally {
      await second.close();
    }
  });

  // Без обработчика сигнала `onClose` не срабатывает никогда: процесс снимают
  // по Ctrl-C, соединения баз остаются открытыми, и WAL закрывается не
  // переносом в основной файл, а восстановлением при следующем запуске.
  // Сигнал взят посторонний: настоящий SIGINT снял бы сам прогон тестов.
  it('закрывает сервер по сигналу', async () => {
    const closing = buildServer(undefined, { dataDir });
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
    const closing = buildServer(undefined, { dataDir });
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
