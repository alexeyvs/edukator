/** Read-only HTTP-граница состояния дневного доступа к компьютеру. */
import type { Database } from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { readDailyGate } from '../daily-gate.js';

export interface GateRoutesOptions {
  db: Database;
  now?: () => Date;
  available?: () => boolean;
}

export function registerGateRoutes(app: FastifyInstance, options: GateRoutesOptions): void {
  const now = options.now ?? ((): Date => new Date());
  app.get('/api/gate/status', (_request, reply) => {
    if (options.available?.() === false) {
      return reply.code(503).send({
        error: 'Состояние доступа недоступно: файл базы заменён, нужен перезапуск',
      });
    }
    return reply.send(readDailyGate(options.db, now()));
  });
}

export function registerUnavailableGate(app: FastifyInstance, reason: string): void {
  app.get('/api/gate/status', (_request, reply) =>
    reply.code(503).send({ error: `Состояние доступа недоступно: ${reason}` }));
}
