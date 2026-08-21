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
  readAdminImpersonation,
  readCarriedImpersonation,
  recordAdminAudit,
  revokeImpersonation,
  revokeImpersonationRow,
  startImpersonation,
  type ImpersonationPrincipal,
} from '../../control-db.js';
import {
  finishExpiredImpersonation,
  finishImpersonation,
  mutateImpersonationFinish,
  type ImpersonationFinishCleanup,
} from '../../admin/impersonation-finish.js';
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

  /**
   * Заход из cookie запроса — тот, который предстоит закрыть. Берётся
   * `readCarriedImpersonation`, а не разбор предъявителя: истёкший срок конца
   * захода не отменяет, а только лишает его записи в `admin_audit` вместе со
   * счётчиком отказов записи.
   */
  function currentSession(request: FastifyRequest): ImpersonationPrincipal | undefined {
    const token = parseCookies(request.headers.cookie).get(IMPERSONATION_COOKIE);
    return token === undefined ? undefined : readCarriedImpersonation(control, token);
  }

  /**
   * Закрывает заход: запись о конце со счётчиком и своё соединение. Общая с
   * выходом из самой админки: он закрывает живой заход тем же порядком.
   */
  function deps(): Parameters<typeof finishImpersonation>[0] {
    return {
      control,
      refusals: options.refusals,
      ...(options.impersonations === undefined ? {} : { impersonations: options.impersonations }),
    };
  }

  function finish(
    session: ImpersonationPrincipal,
    at: Date,
    revoke: (control: Database) => void,
  ): void {
    finishImpersonation(deps(), session, at, revoke);
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
    //
    // Ищется он по `admin_id`, а не по cookie: `Max-Age` cookie захода равен
    // его сроку, так что вкладка, брошенная дольше чем на пятнадцать минут,
    // возвращается уже без неё — а строку старт всё равно гасит, и без записи
    // о конце в ленте оставалось бы начало без пары. Тот же ответ и там, где
    // прежний заход начат в другом браузере: гасит его старт, значит и
    // закрывать его записью — ему.
    const outcome = control.transaction((): {
      started: ReturnType<typeof startImpersonation>;
      cleanup?: ImpersonationFinishCleanup;
    } => {
      const previous = readAdminImpersonation(control, admin.admin.adminId);
      const started = startImpersonation(
        control,
        { adminId: admin.admin.adminId, childId: body.childId, role: body.role },
        at,
      );
      if (!started.ok) return { started };

      let cleanup: ImpersonationFinishCleanup;
      if (previous !== undefined) {
        cleanup = mutateImpersonationFinish(deps(), previous.session, at, (db) => {
          revokeImpersonationRow(db, previous.id, at);
        });
      } else {
        cleanup = () => { options.refusals.take(admin.admin.adminId); };
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
      return { started, cleanup };
    }).immediate();
    const { started, cleanup } = outcome;
    if (!started.ok) {
      if (started.reason === 'bad-role') {
        return reply.code(400).send({ error: `Роль захода — одна из: ${IMPERSONATION_ROLES.join(', ')}` });
      }
      // Тот же ответ, что и у аренды: «не тот ребёнок» и «нет такого» снаружи
      // неразличимы, и перебор `id` не должен превращаться в список семей.
      return reply.code(AUTH_STATUS['no-child']).send({ error: AUTH_MESSAGE['no-child'] });
    }
    cleanup?.();

    return reply
      .header('set-cookie', serializeCookie('impersonation', started.session.token, { secure }))
      .send({
        childId: started.childId,
        role: started.role,
        expiresAt: started.session.expiresAt,
      });
  });

  app.delete('/api/admin/impersonate', (request, reply) => {
    let admin;
    try {
      admin = options.context(request, { allow: ROUTE_ACCESS.admin });
    } catch (error) {
      return failAuth(reply, error);
    }

    const at = now();
    const session = currentSession(request);
    if (session !== undefined) {
      const token = parseCookies(request.headers.cookie).get(IMPERSONATION_COOKIE) ?? '';
      finish(session, at, (db) => {
        revokeImpersonation(db, token, at);
      });
    }
    // Cookie захода живёт ровно столько же, сколько сам заход, и «выйти» после
    // истечения срока приходит уже без неё. Свой брошенный заход оператор
    // закрывает и в этом случае — по `admin_id`. Свой же, но живой и пришедший
    // с cookie, закрыт строкой выше и вторым концом в ленте не удвоится:
    // погашенную строку `readAdminImpersonation` не отдаёт.
    finishExpiredImpersonation(deps(), admin.admin.adminId, at);
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
