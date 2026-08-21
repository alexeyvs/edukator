/**
 * HTTP-граница журнала действий оператора.
 *
 * Журнал читается страницей «новые сверху» с курсором по `(at, id)`: по одному
 * времени порядок неоднозначен, и на границе страницы записи одной секунды либо
 * повторились бы, либо пропали. Обе половины курсора поэтому едут в запросе
 * отдельными параметрами, а обратно — готовым `next`, который клиент возвращает
 * не разбирая.
 *
 * Фильтр по действию проверяется тем же предикатом, которым закрыт список
 * действий: неизвестное значение — ошибка запроса, а не пустая лента. Пустой
 * ответ на опечатку в фильтре читался бы как «таких действий не было», то есть
 * скрывал бы ровно то, ради чего в журнал и смотрят.
 */
import type { Database } from 'better-sqlite3';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  ADMIN_AUDIT_PAGE,
  isAdminAuditAction,
  listAdminAudit,
  type AdminAuditCursor,
} from '../../control-db.js';
import { ROUTE_ACCESS, failAuth, type AdminContextResolver } from '../tenant-context.js';

export interface AdminAuditRoutesOptions {
  context: AdminContextResolver;
  control: Database;
}

export function registerAdminAuditRoutes(
  app: FastifyInstance,
  options: AdminAuditRoutesOptions,
): void {
  app.get('/api/admin/audit', (request, reply) => {
    try {
      options.context(request, { allow: ROUTE_ACCESS.admin });
    } catch (error) {
      return failAuth(reply, error);
    }
    const query = request.query as Record<string, unknown>;
    const action = typeof query['action'] === 'string' && query['action'] !== '' ? query['action'] : undefined;
    if (action !== undefined && !isAdminAuditAction(action)) {
      return reply.code(400).send({ error: 'Неизвестное действие' });
    }
    const before = typeof query['before'] === 'string' && query['before'] !== '' ? query['before'] : undefined;
    // Пустая строка разбирается отдельно: `Number('')` — это 0, а целый ноль
    // проходит проверку вида и даёт курсор `(at, 0)`, который выкидывает
    // **все** записи этой отметки. Потеря соседей по границе — ровно то, от
    // чего курсор и сделан парой.
    const rawId = query['beforeId'];
    const beforeId = typeof rawId === 'string' && rawId.trim() !== '' ? Number(rawId) : undefined;
    // Половина курсора — не курсор: по одному `at` страница поехала бы,
    // повторив или потеряв записи той же секунды, и молчаливое «читаю с
    // начала» пряталось бы за правдоподобным ответом. Половины проверяются
    // порознь: одним выражением «нет `before`, а `beforeId` испорчен» читалось
    // бы как исправная пара, и мусор в запросе давал бы первую страницу.
    if ((before === undefined) !== (beforeId === undefined)) {
      return reply.code(400).send({ error: 'Курсор задаётся парой before и beforeId' });
    }
    if (beforeId !== undefined && (!Number.isInteger(beforeId) || beforeId < 1)) {
      return reply.code(400).send({ error: 'beforeId — целое число записи' });
    }
    const cursor: AdminAuditCursor | undefined =
      before === undefined || beforeId === undefined ? undefined : { at: before, id: beforeId };

    return reply.send(
      listAdminAudit(options.control, {
        limit: ADMIN_AUDIT_PAGE,
        ...(action === undefined ? {} : { action }),
        ...(cursor === undefined ? {} : { before: cursor }),
      }),
    );
  });
}

/**
 * Заглушка на сервере без управляющей базы: журнал лежит в ней самой, и читать
 * его нечем. 503, а не 404, по той же причине, что и у прочей админки.
 */
export function registerUnavailableAdminAudit(app: FastifyInstance, reason: string): void {
  app.get('/api/admin/audit', (_request, reply: FastifyReply) =>
    reply.code(503).send({ error: `Журнал действий недоступен: ${reason}` }));
}
