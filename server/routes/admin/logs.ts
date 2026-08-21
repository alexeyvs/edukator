/**
 * HTTP-граница ленты аварий.
 *
 * Управляющая база этому маршруту не нужна вовсе: журнал лежит файлом ровно для
 * тех случаев, когда с базами беда, и маршрут, спрашивающий у `control.db`
 * разрешения показать запись о её же недоступности, был бы бесполезен в
 * единственный момент, ради которого заведён. Оператора, впрочем, узнаёт всё
 * тот же `createAdminContext` — по cookie, а cookie проверяется по базе; если
 * недоступна и она, ленту не покажут, и это правильно: журнал говорит о чужих
 * семьях.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  ADMIN_LOG_PAGE,
  isLogEvent,
  readFailureLog,
  type LogQuery,
} from '../../log.js';
import { ROUTE_ACCESS, failAuth, type AdminContextResolver } from '../tenant-context.js';

export interface AdminLogsRoutesOptions {
  context: AdminContextResolver;
  dataDir: string;
}

export function registerAdminLogsRoutes(
  app: FastifyInstance,
  options: AdminLogsRoutesOptions,
): void {
  app.get('/api/admin/logs', (request, reply) => {
    try {
      options.context(request, { allow: ROUTE_ACCESS.admin });
    } catch (error) {
      return failAuth(reply, error);
    }
    const query = request.query as Record<string, unknown>;
    const event = typeof query['event'] === 'string' ? query['event'] : undefined;
    // Неизвестное событие — не пустая лента, а ошибка запроса: пустой ответ на
    // опечатку в фильтре читался бы как «аварий такого рода не было».
    if (event !== undefined && !isLogEvent(event)) {
      return reply.code(400).send({ error: 'Неизвестное событие' });
    }
    const child = typeof query['child'] === 'string' ? query['child'] : undefined;
    const before = typeof query['before'] === 'string' ? query['before'] : undefined;
    const params: LogQuery = {
      limit: ADMIN_LOG_PAGE,
      ...(event === undefined ? {} : { event }),
      ...(child === undefined || child === '' ? {} : { childId: child }),
      ...(before === undefined || before === '' ? {} : { before }),
    };
    return reply.send(readFailureLog(options.dataDir, params));
  });
}

/**
 * Заглушка на сервере без управляющей базы: предъявителя проверить нечем, и
 * лента чужих аварий в этом состоянии открытой быть не может.
 */
export function registerUnavailableAdminLogs(app: FastifyInstance, reason: string): void {
  app.get('/api/admin/logs', (_request, reply: FastifyReply) =>
    reply.code(503).send({ error: `Журнал недоступен: ${reason}` }));
}
