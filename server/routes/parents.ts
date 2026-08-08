/** Read-only HTTP-граница единого снимка родительского дашборда. */
import type { Database } from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type { TopicGraph } from '../curriculum.js';
import { readParentsDashboard } from '../parents.js';

export interface ParentsRoutesOptions {
  db: Database;
  graph: TopicGraph;
  now?: () => Date;
  available?: () => boolean;
}

export function registerParentsRoutes(app: FastifyInstance, options: ParentsRoutesOptions): void {
  const now = options.now ?? ((): Date => new Date());
  app.get('/api/parents', (_request, reply) => {
    if (options.available?.() === false) {
      return reply.code(503).send({ error: 'Дашборд родителей недоступен: файл базы заменён, нужен перезапуск' });
    }
    return reply.send(readParentsDashboard(options.db, options.graph, now()));
  });
}

export function registerUnavailableParents(app: FastifyInstance, reason: string): void {
  app.get('/api/parents', (_request, reply) =>
    reply.code(503).send({ error: `Дашборд родителей недоступен: ${reason}` }));
}
