import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  createParent,
  issueParentInvite,
  openControlDatabase,
} from '../server/control-db.js';
import { controlDatabasePath, ensureDataDir } from '../server/data-dir.js';
import { registerAuthRoutes } from '../server/routes/auth.js';
import {
  TOKEN_PATH_PREFIXES,
  isTokenPath,
  redactTokenUrl,
  registerTokenPrivacy,
} from '../server/routes/token-privacy.js';
import { buildServer, registerErrorHandler } from '../server/index.js';

const TOKEN = 'НЕ-должен-попасть-в-лог-0123456789';
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };

describe('адреса с токеном', () => {
  it('держит список адресов погашения буквально', () => {
    // Список — межмодульный уговор: по нему прячется токен в логе и по нему же
    // ставятся заголовки. Молчаливая правка одного из адресов оставила бы
    // ссылку защищённой наполовину.
    expect([...TOKEN_PATH_PREFIXES]).toEqual([
      '/join/',
      '/invite/',
      '/api/auth/parent/invite/',
      '/api/auth/child/claim/',
    ]);
  });

  it('прячет токен на каждом адресе погашения', () => {
    for (const prefix of TOKEN_PATH_PREFIXES) {
      expect(redactTokenUrl(`${prefix}${TOKEN}`)).toBe(`${prefix}<token>`);
      expect(isTokenPath(`${prefix}${TOKEN}`)).toBe(true);
    }
  });

  it('не оставляет ничего от лишних сегментов пути', () => {
    expect(redactTokenUrl(`/join/${TOKEN}/дальше`)).toBe('/join/<token>');
  });

  it('сохраняет строку запроса: по ней различают отказы', () => {
    expect(redactTokenUrl(`/join/${TOKEN}?retry=1`)).toBe('/join/<token>?retry=1');
  });

  it('не трогает адрес без токена', () => {
    expect(redactTokenUrl('/api/run/plan?kind=normal')).toBe('/api/run/plan?kind=normal');
    expect(isTokenPath('/api/run/plan')).toBe(false);
    // Сам `/join` без сегмента токена не содержит: подстановка тут выдумала бы
    // секрет там, где его не было.
    expect(redactTokenUrl('/join/')).toBe('/join/');
    expect(isTokenPath('/join/')).toBe(false);
  });
});

describe('обработчик отказов не пишет токен', () => {
  let app: FastifyInstance;
  let written: string[];

  beforeEach(async () => {
    written = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
      written.push(String(chunk));
      return true;
    });
    app = Fastify();
    registerErrorHandler(app);
    app.get('/join/:token', () => {
      throw new Error('база недоступна');
    });
    app.get('/api/auth/parent/invite/:token', () => {
      throw new Error('база недоступна');
    });
    app.get('/api/run/plan', () => {
      throw new Error('база недоступна');
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  for (const url of ['/join', '/api/auth/parent/invite']) {
    it(`подменяет токен в тексте отказа ${url}/:token`, async () => {
      const response = await app.inject({ method: 'GET', url: `${url}/${TOKEN}` });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: 'Внутренняя ошибка сервера' });
      expect(written.join('')).toContain(`GET ${url}/<token>: база недоступна`);
      expect(written.join('')).not.toContain(TOKEN);
    });
  }

  it('оставляет обычный адрес как есть', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/run/plan?kind=normal' });

    expect(response.statusCode).toBe(500);
    expect(written.join('')).toContain('GET /api/run/plan?kind=normal: база недоступна');
  });
});

describe('заголовки приватности на маршрутах погашения', () => {
  let dir: string;
  let control: Database;
  let app: FastifyInstance;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'edukator-token-privacy-'));
    ensureDataDir(dir);
    control = openControlDatabase(controlDatabasePath(dir));
    app = Fastify();
    registerTokenPrivacy(app);
    registerAuthRoutes(app, { control });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    control.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Живое приглашение родителя: открытый токен уходит в адрес запроса. */
  function parentInvite(): string {
    const parentId = createParent(control, 'родитель@example.com', new Date());
    return issueParentInvite(control, parentId, new Date()).token;
  }

  it('ставит заголовки на чтение приглашения', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/auth/parent/invite/${parentInvite()}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('ставит заголовки на погашение приглашения', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/auth/parent/invite/${parentInvite()}`,
      headers: SAME_ORIGIN,
      payload: { password: 'пароль-подлиннее' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('ставит заголовки и на отказ по детской ссылке: адрес утекает одинаково', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/auth/child/claim/${TOKEN}`,
      headers: SAME_ORIGIN,
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('не трогает ответы без токена в адресе', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auth/me' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['referrer-policy']).toBeUndefined();
    expect(response.headers['cache-control']).toBeUndefined();
  });
});

describe('заголовки приватности в собранном сервере', () => {
  let tempDir: string;
  let app: FastifyInstance | undefined;
  let webDist: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-token-page-'));
    webDist = join(tempDir, 'dist');
    mkdirSync(join(webDist, 'join'), { recursive: true });
    writeFileSync(join(webDist, 'index.html'), '<h1>Собранный интерфейс</h1>');
    // Файл по адресу с токеном заведён нарочно: статика ставит свой
    // `cache-control`, и заголовок приватности обязан оказаться поверх него.
    writeFileSync(join(webDist, 'join', 'страница.html'), '<h1>Ссылка</h1>');
  });

  afterEach(async () => {
    await app?.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('перебивает кэширование статики на странице по ссылке', async () => {
    app = buildServer(undefined, { dbPath: join(tempDir, 'page.db'), worker: false, webDist });

    const response = await app.inject({ method: 'GET', url: '/join/страница.html' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('не ставит заголовки на обычные страницы', async () => {
    app = buildServer(undefined, { dbPath: join(tempDir, 'page.db'), worker: false, webDist });

    const response = await app.inject({ method: 'GET', url: '/parents' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['referrer-policy']).toBeUndefined();
  });
});
