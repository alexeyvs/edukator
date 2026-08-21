/**
 * HTTP-граница первого экрана админки: одна сводка из `control.db`.
 *
 * Реестра арендаторов у этого маршрута нет намеренно — как и у разрешения
 * оператора. Главный экран обязан открываться и тогда, когда детские базы
 * недоступны все разом: именно в этот момент по нему и смотрят, что случилось.
 */
import type { Database } from 'better-sqlite3';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { buildAdminOverview } from '../../admin/overview.js';
import { ROUTE_ACCESS, failAuth, type AdminContextResolver } from '../tenant-context.js';

export interface AdminOverviewRoutesOptions {
  context: AdminContextResolver;
  control: Database;
  dataDir: string;
  now?: () => Date;
}

export function registerAdminOverviewRoutes(
  app: FastifyInstance,
  options: AdminOverviewRoutesOptions,
): void {
  const now = options.now ?? ((): Date => new Date());
  app.get('/api/admin/overview', (request, reply) => {
    try {
      options.context(request, { allow: ROUTE_ACCESS.admin });
      return reply.send(buildAdminOverview(options.control, { dataDir: options.dataDir, now: now() }));
    } catch (error) {
      return failAuth(reply, error);
    }
  });
}

/**
 * Заглушка на сервере без управляющей базы. 503, а не 404: сводки нет потому,
 * что сломан сервер, и по пропавшему адресу оператор искал бы ошибку у себя.
 */
export function registerUnavailableAdminOverview(app: FastifyInstance, reason: string): void {
  app.get('/api/admin/overview', (_request, reply: FastifyReply) =>
    reply.code(503).send({ error: `Сводка недоступна: ${reason}` }));
}
