/**
 * Read-only HTTP-граница состояния дневного доступа к компьютеру.
 *
 * Единственный маршрут, открытый агенту: за ним стоит контроллер Family Safety,
 * которому нужно знать, пускать ли ребёнка за компьютер, — и больше ничего.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { readDailyGate } from '../daily-gate.js';
import {
  ROUTE_ACCESS,
  failAuth,
  type TenantContextResolver,
} from './tenant-context.js';

export interface GateRoutesOptions {
  context: TenantContextResolver;
  now?: () => Date;
}

export function registerGateRoutes(app: FastifyInstance, options: GateRoutesOptions): void {
  const now = options.now ?? ((): Date => new Date());
  app.get('/api/gate/status', (request, reply) => {
    try {
      const { tenant } = options.context(request, { allow: ROUTE_ACCESS.gate });
      if (!tenant.available()) {
        return reply.code(503).send({
          error: 'Состояние доступа недоступно: файл базы заменён, нужен перезапуск',
        });
      }
      return reply.send(readDailyGate(tenant.db, now()));
    } catch (error) {
      return failAuth(reply, error);
    }
  });
}

export function registerUnavailableGate(app: FastifyInstance, reason: string): void {
  app.get('/api/gate/status', (_request, reply: FastifyReply) =>
    reply.code(503).send({ error: `Состояние доступа недоступно: ${reason}` }));
}
