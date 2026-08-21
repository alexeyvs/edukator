/**
 * HTTP-граница захода оператора в чужую семью: начать и выйти.
 *
 * Cookie захода ставится **рядом** с админской, а не вместо неё. Оператор, из
 * захода вышедший, обязан оказаться снова в админке, а не на экране входа: иначе
 * каждый взгляд в чужую семью стоил бы ему повторного пароля, и заходы стали бы
 * длиннее, а не короче.
 *
 * Разрешает оба маршрута `createAdminContext`, а не `resolveTenant`: под живым
 * заходом `resolveBearer` возвращает предъявителя целевой семьи, и разрешение
 * через аренду закрывало бы выход ровно тогда, когда он и нужен.
 *
 * Начало и конец пишутся в `admin_audit`, и в записи о конце стоит счётчик
 * отказанных попыток записи. Без него конец захода выглядит одинаково и там,
 * где оператор посмотрел и вышел, и там, где он пробовал ответить за чужого
 * ребёнка, пока не упёрся в замок.
 */
import type { Database } from 'better-sqlite3';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  IMPERSONATION_ROLES,
  recordAdminAudit,
  resolveImpersonation,
  revokeImpersonation,
  startImpersonation,
  type ImpersonationPrincipal,
} from '../../control-db.js';
import { finishImpersonation } from '../../admin/impersonation-finish.js';
import { AUTH_MESSAGE, AUTH_STATUS, IMPERSONATION_COOKIE, parseCookies } from '../../auth.js';
import type { ImpersonationRefusals } from '../../admin/impersonation-refusals.js';
import { ROUTE_ACCESS, failAuth, type AdminContextResolver } from '../tenant-context.js';
import { serializeCookie } from '../auth.js';

export interface AdminImpersonateRoutesOptions {
  context: AdminContextResolver;
  control: Database;
  /** Счётчик отказов первого замка: он и попадает в запись о конце захода. */
  refusals: ImpersonationRefusals;
  /**
   * Соединения только для чтения. Необязательны: маршрутным тестам второй
   * замок не нужен, а на живом сервере закрывать соединение выхода обязан
   * именно выход — иначе оно доживало бы до общего закрытия.
   */
  impersonations?: { close(childId: string): void };
  /** Снять ли `Secure` с cookie. Только для разработки по голому http. */
  insecureCookies?: boolean;
  now?: () => Date;
}

/** Что читает старт из тела запроса. Лишнее поле — повод отказать, как и на входе. */
function readStartBody(body: unknown): { childId: string; role: string } | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const fields = body as Record<string, unknown>;
  if (Object.keys(fields).length !== 2) return undefined;
  const childId = fields['childId'];
  const role = fields['role'];
  if (typeof childId !== 'string' || typeof role !== 'string') return undefined;
  return { childId, role };
}

export function registerAdminImpersonateRoutes(
  app: FastifyInstance,
  options: AdminImpersonateRoutesOptions,
): void {
  const now = options.now ?? ((): Date => new Date());
  const control = options.control;
  const secure = options.insecureCookies !== true;

  /** Живой заход из cookie запроса. Им закрывают прежний и выходят из текущего. */
  function currentSession(request: FastifyRequest, at: Date): ImpersonationPrincipal | undefined {
    const token = parseCookies(request.headers.cookie).get(IMPERSONATION_COOKIE);
    return token === undefined ? undefined : resolveImpersonation(control, token, at);
  }

  /**
   * Закрывает заход: запись о конце со счётчиком и своё соединение. Общая с
   * выходом из самой админки: он закрывает живой заход тем же порядком.
   */
  function finish(session: ImpersonationPrincipal, at: Date): void {
    finishImpersonation(
      {
        control,
        refusals: options.refusals,
        ...(options.impersonations === undefined ? {} : { impersonations: options.impersonations }),
      },
      session,
      at,
    );
  }

  app.post('/api/admin/impersonate', (request, reply) => {
    let admin;
    try {
      admin = options.context(request, { allow: ROUTE_ACCESS.admin });
    } catch (error) {
      return failAuth(reply, error);
    }

    const body = readStartBody(request.body);
    if (body === undefined) {
      return reply.code(400).send({ error: 'Нужны поля childId и role' });
    }

    const at = now();
    // Прежний заход читается **до** старта: старт гасит его строку тем же
    // `UPDATE`, и после него сказать, из какой семьи оператор только что
    // вышел, было бы уже нечем.
    const previous = currentSession(request, at);

    const started = startImpersonation(
      control,
      { adminId: admin.admin.adminId, childId: body.childId, role: body.role },
      at,
    );
    if (!started.ok) {
      if (started.reason === 'bad-role') {
        return reply.code(400).send({ error: `Роль захода — одна из: ${IMPERSONATION_ROLES.join(', ')}` });
      }
      // Тот же ответ, что и у аренды: «не тот ребёнок» и «нет такого» снаружи
      // неразличимы, и перебор `id` не должен превращаться в список семей.
      return reply.code(AUTH_STATUS['no-child']).send({ error: AUTH_MESSAGE['no-child'] });
    }

    // Конец прежнего захода пишется только у своего же оператора: чужая cookie
    // в браузере оператора его заходом не является, и запись о её конце
    // приписала бы отказы не тому.
    if (previous !== undefined && previous.adminId === admin.admin.adminId) {
      finish(previous, at);
    } else {
      // Счётчик отказов процессный и переживает истёкший заход: закрывать его
      // было некому, потому что `resolveImpersonation` просроченную строку уже
      // не отдаёт. Не сброшенный здесь, он приписал бы попытки записи в прошлой
      // семье записи о конце захода в **следующей**.
      options.refusals.take(admin.admin.adminId);
    }
    recordAdminAudit(
      control,
      {
        adminId: admin.admin.adminId,
        action: 'impersonation-start',
        childId: started.childId,
        parentId: started.parentId,
        detail: started.role,
      },
      at,
    );

    return reply
      .header('set-cookie', serializeCookie('impersonation', started.session.token, { secure }))
      .send({
        childId: started.childId,
        role: started.role,
        expiresAt: started.session.expiresAt,
      });
  });

  app.delete('/api/admin/impersonate', (request, reply) => {
    try {
      options.context(request, { allow: ROUTE_ACCESS.admin });
    } catch (error) {
      return failAuth(reply, error);
    }

    const at = now();
    const session = currentSession(request, at);
    if (session !== undefined) {
      const token = parseCookies(request.headers.cookie).get(IMPERSONATION_COOKIE) ?? '';
      revokeImpersonation(control, token, at);
      finish(session, at);
    }
    // Cookie гасится и тогда, когда живого захода не нашлось: иначе браузер
    // носил бы мёртвый токен на каждом запросе, а тот выигрывает у собственных
    // cookie оператора первым же разбором предъявителя.
    return reply
      .header('set-cookie', serializeCookie('impersonation', '', { secure, maxAgeSeconds: 0 }))
      .send({ kind: 'admin' });
  });
}

/**
 * Заглушка на сервере без управляющей базы. 503, а не 404: заходов нет потому,
 * что сломан сервер, и по пропавшему адресу оператор искал бы ошибку у себя.
 */
export function registerUnavailableAdminImpersonate(app: FastifyInstance, reason: string): void {
  const send = (_request: unknown, reply: FastifyReply): FastifyReply =>
    reply.code(503).send({ error: `Заход в семью недоступен: ${reason}` });
  app.post('/api/admin/impersonate', send);
  app.delete('/api/admin/impersonate', send);
}
