/**
 * HTTP-граница входа оператора: пароль и выход.
 *
 * Отдельный модуль от `server/routes/auth.ts` не ради порядка в файлах, а ради
 * шага второго фактора: он вставляется между сверкой пароля и выдачей cookie
 * ровно здесь, и в общем со входом родителя маршруте эту вставку пришлось бы
 * делать веткой по виду учётной записи.
 *
 * Политика cookie при этом общая (`serializeCookie`): разъехавшиеся атрибуты у
 * двух выдач — это две разные защиты у одного и того же входа.
 *
 * Причина отказа наружу не уходит вовсе: «нет такого оператора», «неверный
 * пароль», «пароль ещё не поставлен» и «оператор отключён» обязаны быть
 * неразличимы, иначе форма входа отвечает на вопрос, есть ли на этой машине
 * оператор с таким адресом.
 */
import type { Database } from 'better-sqlite3';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  checkLoginGate,
  clearLoginFailures,
  findAdminByEmail,
  loginAdmin,
  normalizeEmail,
  recordAdminAudit,
  recordLoginFailure,
  resolveAdminSession,
  revokeAdminSession,
  type LoginGate,
  type LoginTarget,
} from '../../control-db.js';
import {
  ADMIN_COOKIE,
  AUTH_MESSAGE,
  AUTH_STATUS,
  headerValue,
  isSameOrigin,
  parseCookies,
} from '../../auth.js';
import { clientAddress, readTrustedProxies } from '../../client-address.js';
import { LOGIN_REJECTED, readLoginBody, serializeCookie } from '../auth.js';

export interface AdminAuthRoutesOptions {
  control: Database;
  now?: () => Date;
  /** Кому верить в `X-Forwarded-For`: иначе счётчик считает присланный адрес. */
  trustedProxies?: Set<string>;
  /** Снять ли `Secure` с cookie. Только для разработки по голому http. */
  insecureCookies?: boolean;
}

export function registerAdminAuthRoutes(
  app: FastifyInstance,
  options: AdminAuthRoutesOptions,
): void {
  const now = options.now ?? ((): Date => new Date());
  const control = options.control;
  const trusted =
    options.trustedProxies ?? readTrustedProxies(process.env['EDUKATOR_TRUSTED_PROXIES']);
  const secure = options.insecureCookies !== true;

  function address(request: FastifyRequest): string {
    return clientAddress({
      socketAddress: request.socket.remoteAddress,
      forwardedFor: headerValue(request.headers, 'x-forwarded-for'),
      trusted,
    });
  }

  /**
   * Проверка источника. Она нужна и здесь, до всякой сессии: кросс-сайтовый
   * вход тихо сажает оператора в подставленную учётную запись, а выход с чужой
   * страницы — способ выкинуть его из собственной.
   */
  function crossOrigin(request: FastifyRequest, reply: FastifyReply): FastifyReply | undefined {
    if (isSameOrigin(request.headers)) return undefined;
    return reply.code(AUTH_STATUS['cross-origin']).send({ error: AUTH_MESSAGE['cross-origin'] });
  }

  /**
   * Ответ по закрытому счётчику перебора. `unavailable` — 503: снаружи вход
   * закрыт одинаково, но по коду видно, что сервер неисправен, а не что кто-то
   * подбирает пароль.
   */
  function refuseByGate(reply: FastifyReply, gate: LoginGate): FastifyReply {
    const retryAfter = Math.max(1, Math.ceil(gate.retryAfterMs / 1000));
    return reply
      .header('retry-after', retryAfter)
      .code(gate.reason === 'unavailable' ? 503 : 429)
      .send({
        error:
          gate.reason === 'unavailable'
            ? 'Вход временно недоступен'
            : 'Слишком много неудачных попыток входа, повторите позже',
      });
  }

  app.post('/api/auth/admin/login', (request, reply) => {
    const blocked = crossOrigin(request, reply);
    if (blocked !== undefined) return blocked;

    const body = readLoginBody(request.body);
    if (body === undefined) {
      return reply.code(400).send({ error: 'Нужны поля email и password' });
    }

    // Счётчик считает попытки по обоим ключам сразу, и вид `admin` держит их
    // отдельно от родительских: общий счётчик означал бы, что перебор чужого
    // родительского пароля запирает вход оператору.
    const target: LoginTarget = {
      kind: 'admin',
      email: body.email,
      address: address(request),
    };
    const email = normalizeEmail(body.email);
    const gate = checkLoginGate(control, target, now());
    if (!gate.allowed) return refuseByGate(reply, gate);

    const at = now();
    const result = email === undefined ? undefined : loginAdmin(control, email, body.password, at);
    if (result === undefined || !result.ok) {
      const counted = recordLoginFailure(control, target, at);
      // Отказ виден в журнале действий только тогда, когда есть чей: строка
      // `admin_audit` называет оператора, и перебор несуществующих адресов
      // иначе давал бы кому угодно возможность писать в этот журнал.
      const known = email === undefined ? undefined : findAdminByEmail(control, email);
      if (known !== undefined) {
        recordAdminAudit(
          control,
          { adminId: known.id, action: 'login-failed', ...(result === undefined ? {} : { detail: result.reason }) },
          at,
        );
      }
      // Незаписанная неудача — та же недоступность счётчика: он обязан быть
      // fail-closed на обоих концах, иначе попытки перестают считаться ровно
      // тогда, когда их считать и нужно.
      if (counted.reason === 'unavailable') return refuseByGate(reply, counted);
      return reply.code(401).send({ error: LOGIN_REJECTED });
    }
    clearLoginFailures(control, target);
    recordAdminAudit(control, { adminId: result.adminId, action: 'login' }, at);

    return reply
      .header('set-cookie', serializeCookie('admin', result.session.token, { secure }))
      .send({ kind: 'admin', email });
  });

  app.post('/api/auth/admin/logout', (request, reply) => {
    const blocked = crossOrigin(request, reply);
    if (blocked !== undefined) return blocked;

    const at = now();
    const token = parseCookies(request.headers.cookie).get(ADMIN_COOKIE);
    if (token !== undefined) {
      // Предъявитель читается **до** гашения: после него сессия уже не
      // разбирается, и записать в журнал было бы некого.
      const admin = resolveAdminSession(control, token, at);
      revokeAdminSession(control, token, at);
      if (admin !== undefined) {
        recordAdminAudit(control, { adminId: admin.adminId, action: 'logout' }, at);
      }
    }
    // Cookie гасится и тогда, когда сессии в базе не нашлось: иначе браузер
    // продолжал бы носить мёртвый токен на каждом запросе.
    return reply
      .header('set-cookie', serializeCookie('admin', '', { secure, maxAgeSeconds: 0 }))
      .send({ kind: 'anonymous' });
  });
}

/**
 * Заглушка входа оператора на сервере без управляющей базы или карты тем. 503,
 * а не 404: оператор, который не может войти, обязан увидеть поломку сервера, а
 * не пропавший маршрут — по 404 он полез бы искать ошибку в собственном адресе.
 */
export function registerUnavailableAdminAuth(app: FastifyInstance, reason: string): void {
  const send = (_request: unknown, reply: FastifyReply): FastifyReply =>
    reply.code(503).send({ error: `Вход недоступен: ${reason}` });
  app.post('/api/auth/admin/login', send);
  app.post('/api/auth/admin/logout', send);
}
