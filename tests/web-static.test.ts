import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APP_PAGES, buildServer } from '../server/index.js';

describe('статика интерфейса', () => {
  let dataDir: string;
  let app: FastifyInstance | undefined;
  let tempDir: string;
  let webDist: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-web-'));
    dataDir = join(tempDir, 'data');
    webDist = join(tempDir, 'dist');
    mkdirSync(webDist);
    writeFileSync(join(webDist, 'index.html'), '<h1>Собранный интерфейс</h1>');
  });

  afterEach(async () => {
    await app?.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('отдаёт сборку с корня и не перехватывает API', async () => {
    app = buildServer(undefined, { dataDir, worker: false, webDist });

    const page = await app.inject({ method: 'GET', url: '/' });
    const health = await app.inject({ method: 'GET', url: '/api/health' });

    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('Собранный интерфейс');
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: 'ok' });
  });

  // Забытый в `APP_PAGES` адрес виден ребёнку не как ошибка сборки, а как
  // мёртвая ссылка: он перешёл по приглашению и получил 404 от Fastify.
  // Поэтому проверяется весь список разом, а не один знакомый адрес.
  it('отдаёт страницу приложения по каждому пользовательскому адресу', async () => {
    app = buildServer(undefined, { dataDir, worker: false, webDist });

    expect(APP_PAGES).toEqual(['/', '/parents', '/admin', '/join/:token', '/invite/:token']);
    for (const page of APP_PAGES) {
      // Шаблон адреса превращается в настоящий: токен — часть пути, и именно по
      // такому адресу ребёнок открывает приложение.
      const url = page.replace(':token', 'токен-приглашения');
      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode, url).toBe(200);
      expect(response.headers['content-type'], url).toContain('text/html');
      expect(response.body, url).toContain('Собранный интерфейс');
    }
  });

  it('объясняет ошибку запуска, когда интерфейс не собран', () => {
    const missing = join(tempDir, 'нет-сборки');

    expect(() => buildServer(undefined, { dataDir, worker: false, webDist: missing })).toThrow(
      `интерфейс не собран в ${missing}; выполните npm run build:web`,
    );
  });
});
