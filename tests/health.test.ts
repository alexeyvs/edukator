import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer, checkDatabase, HOST, readVersion } from '../server/index.js';
import { DEFAULT_PROFILE, SCHEMA_VERSION, openDatabase, readProfile } from '../server/db.js';

describe('GET /api/health', () => {
  let app: FastifyInstance;
  let tempDir: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-health-'));
    process.env.EDUKATOR_DB = join(tempDir, 'health.db');
    app = buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.EDUKATOR_DB;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('поднимается и отвечает 200', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
  });

  it('слушает 0.0.0.0, чтобы быть доступным из домашней сети', async () => {
    expect(HOST).toBe('0.0.0.0');

    const listening = buildServer();
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
    };

    expect(body.status).toBe('ok');
    expect(body.version).toBe(readVersion());
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(body.database).toBe('ok');
  });

  it('сообщает об ошибке базы, если путь недоступен', () => {
    expect(checkDatabase(join(tempDir, 'нет-такого-каталога', 'x.db'))).toBe('error');
  });

  it('оставляет базу мигрированной после проверки', () => {
    const path = join(tempDir, 'свежая.db');

    expect(checkDatabase(path)).toBe('ok');

    const db = openDatabase(path);
    try {
      const [version] = db.pragma('user_version') as [{ user_version: number }];
      expect(version.user_version).toBe(SCHEMA_VERSION);
      expect(readProfile(db)).toEqual(DEFAULT_PROFILE);
    } finally {
      db.close();
    }
  });

  it('отдаёт 404 на неизвестный маршрут', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/nope' });

    expect(response.statusCode).toBe(404);
  });
});
