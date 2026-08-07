import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { databasePath, openDatabase } from './db.js';

export { databasePath };

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

/** Версия приложения из package.json — отдаётся в /api/health. */
export function readVersion(): string {
  const raw = readFileSync(resolve(projectRoot, 'package.json'), 'utf8');
  const parsed = JSON.parse(raw) as { version?: string };
  return parsed.version ?? '0.0.0';
}

export type DatabaseStatus = 'ok' | 'error';

/**
 * Проверка живости базы: открыть, домигрировать до текущей схемы и выполнить
 * тривиальный запрос. Миграция на уже актуальной базе — чтение одной прагмы,
 * так что health остаётся дешёвым.
 */
export function checkDatabase(path: string = databasePath()): DatabaseStatus {
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    db = openDatabase(path);
    db.prepare('SELECT 1').get();
    return 'ok';
  } catch {
    return 'error';
  } finally {
    db?.close();
  }
}

/** Слушаем все интерфейсы — чтобы заходить с других устройств домашней сети. */
export const HOST = '0.0.0.0';

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/api/health', () => ({
    status: 'ok',
    version: readVersion(),
    database: checkDatabase(),
  }));

  return app;
}

const isDirectRun = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const app = buildServer();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ host: HOST, port });
  console.log(`edukator слушает http://${HOST}:${port}`);
}
