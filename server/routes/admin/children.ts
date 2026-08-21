/**
 * HTTP-граница слоя 3: карточка одного названного ребёнка.
 *
 * Кеша у неё нет намеренно (см. `server/admin/child-detail.ts`): по жалобе
 * смотрят состояние сейчас. Реестра арендаторов — тоже: база открывается
 * `readonly` на один запрос, и потолок в 32 аренды к карточке не относится.
 */
import type { Database } from 'better-sqlite3';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { AuthError } from '../../auth.js';
import { readChildDetail } from '../../admin/child-detail.js';
import type { TopicGraph } from '../../curriculum.js';
import {
  ROUTE_ACCESS,
  childIdParam,
  failAuth,
  type AdminContextResolver,
} from '../tenant-context.js';

export interface AdminChildrenRoutesOptions {
  context: AdminContextResolver;
  control: Database;
  dataDir: string;
  graph: TopicGraph;
  now?: () => Date;
}

export function registerAdminChildrenRoutes(
  app: FastifyInstance,
  options: AdminChildrenRoutesOptions,
): void {
  const now = options.now ?? ((): Date => new Date());
  app.get('/api/admin/children/:childId', (request, reply) => {
    try {
      options.context(request, { allow: ROUTE_ACCESS.admin });
      const childId = childIdParam(request.params);
      const detail = readChildDetail(options.control, {
        dataDir: options.dataDir,
        graph: options.graph,
        childId,
        now: now(),
      });
      // Чужой формат идентификатора и незаведённый ребёнок отвечают одинаково:
      // оператор всё равно ничего не выбирает по имени файла, а два разных
      // ответа рассказывали бы о содержимом каталога данных.
      if (detail === undefined) {
        throw new AuthError('no-child', `Ребёнка ${childId} нет в управляющей базе`);
      }
      return reply.send(detail);
    } catch (error) {
      return failAuth(reply, error);
    }
  });
}

/** Заглушка на сервере без управляющей базы: ребёнка не в чем найти. */
export function registerUnavailableAdminChildren(app: FastifyInstance, reason: string): void {
  app.get('/api/admin/children/:childId', (_request, reply: FastifyReply) =>
    reply.code(503).send({ error: `Карточка ребёнка недоступна: ${reason}` }));
}
