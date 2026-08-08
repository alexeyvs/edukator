import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../server/index.js';

describe('статика интерфейса', () => {
  let app: FastifyInstance | undefined;
  let tempDir: string;
  let webDist: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-web-'));
    process.env.EDUKATOR_DB = join(tempDir, 'web.db');
    webDist = join(tempDir, 'dist');
    mkdirSync(webDist);
    writeFileSync(join(webDist, 'index.html'), '<h1>Собранный интерфейс</h1>');
  });

  afterEach(async () => {
    await app?.close();
    delete process.env.EDUKATOR_DB;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('отдаёт сборку с корня и не перехватывает API', async () => {
    app = buildServer(undefined, { worker: false, webDist });

    const page = await app.inject({ method: 'GET', url: '/' });
    const health = await app.inject({ method: 'GET', url: '/api/health' });

    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('Собранный интерфейс');
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: 'ok' });
  });

  it('объясняет ошибку запуска, когда интерфейс не собран', () => {
    const missing = join(tempDir, 'нет-сборки');

    expect(() => buildServer(undefined, { worker: false, webDist: missing })).toThrow(
      `интерфейс не собран в ${missing}; выполните npm run build:web`,
    );
  });
});
