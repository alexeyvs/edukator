/**
 * HTTP-граница входа: пароль родителя, приглашения и погашение детской ссылки.
 *
 * Здесь и только здесь открытый токен попадает в ответ или в `Set-Cookie`;
 * дальше по системе ходят уже разобранные предъявители (`server/auth.ts`).
 * Поэтому вся политика cookie собрана в одном месте: разъехавшиеся атрибуты у
 * двух выдач — это две разные защиты у одного и того же входа.
 *
 * Тексты отказов намеренно одинаковы для разных причин: «нет такого адреса»,
 * «неверный пароль» и «родитель отключён» снаружи обязаны быть неразличимы,
 * иначе форма входа превращается в справочник заведённых учётных записей.
 */
import type { Database } from 'better-sqlite3';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  MIN_PASSWORD_LENGTH,
  checkLoginGate,
  clearLoginFailures,
  PARENT_SESSION_MAX_MS,
  loginParent,
  normalizeEmail,
  recordLoginFailure,
  readParentInvite,
  redeemDeviceInvite,
  redeemParentInvite,
  revokeParentSession,
  type LoginTarget,
} from '../control-db.js';
import {
  AUTH_MESSAGE,
  AUTH_STATUS,
  CHILD_COOKIE,
  PARENT_COOKIE,
  headerValue,
  isSameOrigin,
  parseCookies,
  resolveBearer,
} from '../auth.js';
import { clientAddress, readTrustedProxies } from '../client-address.js';

/**
 * Срок детской cookie. Десять лет — это не «навсегда по невнимательности»:
 * выключателем служит `revoked_at` на сервере, а не срок в браузере, и
 * протухающая cookie означала бы, что ребёнок раз в месяц ждёт новую ссылку от
 * родителя.
 */
export const CHILD_COOKIE_MAX_AGE_SECONDS = 10 * 365 * 24 * 60 * 60;

/** Общий текст отказа входу: причина наружу не уходит. */
const LOGIN_REJECTED = 'Неверный адрес или пароль';

/** Общий текст отказа по ссылке: протухшую и чужую снаружи не различить. */
const LINK_REJECTED = 'Ссылка недействительна или уже использована';

export interface AuthRoutesOptions {
  control: Database;
  now?: () => Date;
  /**
   * Кому верить в `X-Forwarded-For`. По умолчанию — список из окружения: без
   * него счётчик по адресу считал бы адрес, присланный самим подбирающим.
   */
  trustedProxies?: Set<string>;
  /**
   * Снять ли `Secure` с cookie. Только для разработки по голому http на чужом
   * адресе: `localhost` браузер и так считает доверенным источником, так что
   * штатному запуску и e2e этот выключатель не нужен.
   */
  insecureCookies?: boolean;
}

/** Сторона, которой выдаётся cookie. От неё зависят `SameSite` и срок. */
type CookieAudience = 'parent' | 'child';

/**
 * Атрибуты cookie по стороне. `Strict` родителю потому, что его вход умеет
 * менять состав семьи, и переход по чужой ссылке не должен приносить с собой
 * его сессию. Ребёнку — `Lax`: он приходит на занятие по ссылке-приглашению и
 * по закладке, и `Strict` встретил бы его выходом.
 */
const COOKIE_SAME_SITE: Record<CookieAudience, 'Strict' | 'Lax'> = {
  parent: 'Strict',
  child: 'Lax',
};

const COOKIE_NAME: Record<CookieAudience, string> = {
  parent: PARENT_COOKIE,
  child: CHILD_COOKIE,
};

const COOKIE_MAX_AGE_SECONDS: Record<CookieAudience, number> = {
  parent: Math.floor(PARENT_SESSION_MAX_MS / 1000),
  child: CHILD_COOKIE_MAX_AGE_SECONDS,
};

/**
 * Собирает `Set-Cookie`. `Path=/` и отсутствие `Domain` — не оформление, а
 * условия префикса `__Host-`: без них браузер такую cookie просто не примет.
 */
export function serializeCookie(
  audience: CookieAudience,
  value: string,
  options: { secure: boolean; maxAgeSeconds?: number },
): string {
  const parts = [
    `${COOKIE_NAME[audience]}=${value}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${COOKIE_SAME_SITE[audience]}`,
    `Max-Age=${options.maxAgeSeconds ?? COOKIE_MAX_AGE_SECONDS[audience]}`,
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/** Что читает вход из тела запроса. Лишние поля — повод отказать, а не молчать. */
function readLoginBody(body: unknown): { email: string; password: string } | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const fields = body as Record<string, unknown>;
  const email = fields['email'];
  const password = fields['password'];
  if (typeof email !== 'string' || typeof password !== 'string') return undefined;
  return { email, password };
}

function readPasswordBody(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const password = (body as Record<string, unknown>)['password'];
  return typeof password === 'string' ? password : undefined;
}

/**
 * Токен из адреса. Пустого сегмента маршрутизатор сюда не доводит, а любая
 * присланная строка всё равно превращается в отпечаток и ни с чем не совпадает:
 * проверять здесь нечего.
 */
function tokenParam(params: unknown): string {
  return (params as { token: string }).token;
}

export function registerAuthRoutes(app: FastifyInstance, options: AuthRoutesOptions): void {
  const now = options.now ?? ((): Date => new Date());
  const control = options.control;
  const trusted = options.trustedProxies ?? readTrustedProxies(process.env['EDUKATOR_TRUSTED_PROXIES']);
  const secure = options.insecureCookies !== true;

  /** Адрес клиента для счётчиков: заголовку верим только от доверенного прокси. */
  function address(request: FastifyRequest): string {
    return clientAddress({
      socketAddress: request.socket.remoteAddress,
      forwardedFor: headerValue(request.headers, 'x-forwarded-for'),
      trusted,
    });
  }

  /**
   * Проверка источника. Она нужна и здесь, хотя сессии ещё нет: кросс-сайтовый
   * вход тихо сажает жертву в чужую учётную запись, а выход с чужой страницы —
   * способ выкинуть родителя из его собственной. `isMutating` не спрашивается:
   * через эту проверку проходят только POST, и вопрос имел бы один ответ.
   */
  function crossOrigin(request: FastifyRequest, reply: FastifyReply): FastifyReply | undefined {
    if (isSameOrigin(request.headers)) return undefined;
    return reply
      .code(AUTH_STATUS['cross-origin'])
      .send({ error: AUTH_MESSAGE['cross-origin'] });
  }

  app.post('/api/auth/parent/login', (request, reply) => {
    const blocked = crossOrigin(request, reply);
    if (blocked !== undefined) return blocked;

    const body = readLoginBody(request.body);
    if (body === undefined) {
      return reply.code(400).send({ error: 'Нужны поля email и password' });
    }

    const target: LoginTarget = {
      kind: 'password',
      email: body.email,
      address: address(request),
    };
    // Адрес, не похожий на адрес, отвергается до `scrypt`: учётной записи с
    // таким ключом быть не может, а его вид виден и так, из любого ответа.
    const email = normalizeEmail(body.email);
    const gate = checkLoginGate(control, target, now());
    if (!gate.allowed) {
      const retryAfter = Math.max(1, Math.ceil(gate.retryAfterMs / 1000));
      // Сломанный счётчик — это 503: снаружи вход закрыт одинаково, но по коду
      // видно, что сервер неисправен, а не что кто-то перебирает пароли.
      const status = gate.reason === 'unavailable' ? 503 : 429;
      return reply.header('retry-after', retryAfter).code(status).send({
        error:
          gate.reason === 'unavailable'
            ? 'Вход временно недоступен'
            : 'Слишком много неудачных попыток входа, повторите позже',
      });
    }

    const result = email === undefined ? undefined : loginParent(control, email, body.password, now());
    if (result === undefined || !result.ok) {
      recordLoginFailure(control, target, now());
      return reply.code(401).send({ error: LOGIN_REJECTED });
    }
    clearLoginFailures(control, target);

    return reply
      .header('set-cookie', serializeCookie('parent', result.session.token, { secure }))
      .send({ kind: 'parent', email });
  });

  app.post('/api/auth/parent/logout', (request, reply) => {
    const blocked = crossOrigin(request, reply);
    if (blocked !== undefined) return blocked;

    const token = parseCookies(request.headers.cookie).get(PARENT_COOKIE);
    if (token !== undefined) revokeParentSession(control, token, now());
    // Cookie гасится и тогда, когда сессии в базе не нашлось: иначе браузер
    // продолжал бы носить мёртвый токен на каждом запросе.
    return reply
      .header('set-cookie', serializeCookie('parent', '', { secure, maxAgeSeconds: 0 }))
      .send({ kind: 'anonymous' });
  });

  // Чтение приглашения намеренно **не** гасит его: предпросмотр ссылки в
  // мессенджере ходит GET-ом, и сжигание входа предпросмотром означало бы, что
  // родитель не может воспользоваться собственным приглашением.
  app.get('/api/auth/parent/invite/:token', (request, reply) => {
    const invite = readParentInvite(control, tokenParam(request.params), now());
    if (!invite.ok) return reply.code(404).send({ error: LINK_REJECTED });
    return reply.send({ email: invite.email });
  });

  app.post('/api/auth/parent/invite/:token', (request, reply) => {
    const blocked = crossOrigin(request, reply);
    if (blocked !== undefined) return blocked;

    const token = tokenParam(request.params);
    const password = readPasswordBody(request.body);
    if (password === undefined) return reply.code(400).send({ error: 'Нужно поле password' });

    // Адрес читается до погашения: после него строка помечена использованной и
    // ответить родителю тем, куда он только что вошёл, было бы уже нечем.
    const invite = readParentInvite(control, token, now());
    if (!invite.ok) return reply.code(404).send({ error: LINK_REJECTED });

    const result = redeemParentInvite(control, token, password, now());
    if (!result.ok) {
      // Про короткий пароль сказать можно и нужно: это свойство присланного, а
      // не признак существования ссылки, и молчание здесь оставило бы родителя
      // гадать, почему приглашение «не работает».
      if (result.reason === 'weak-password') {
        return reply.code(400).send({
          error: `Пароль короче ${MIN_PASSWORD_LENGTH} знаков`,
        });
      }
      return reply.code(404).send({ error: LINK_REJECTED });
    }

    return reply
      .header('set-cookie', serializeCookie('parent', result.session.token, { secure }))
      .send({ kind: 'parent', email: invite.email });
  });

  app.post('/api/auth/child/claim/:token', (request, reply) => {
    const blocked = crossOrigin(request, reply);
    if (blocked !== undefined) return blocked;

    const claim = redeemDeviceInvite(control, tokenParam(request.params), now());
    if (!claim.ok) return reply.code(404).send({ error: LINK_REJECTED });

    // Агент cookie не получает: за ним стоит контроллер на Python, и токен ему
    // нужен строкой в файле настройки. Это единственный ответ, где постоянный
    // токен виден вообще, — поэтому и отдаётся он ровно один раз, при погашении.
    if (claim.kind === 'agent') {
      return reply.send({ kind: 'agent', childId: claim.childId, token: claim.token });
    }
    // Имени ребёнка здесь нет намеренно: устройство спрашивает его у `me` тем
    // же запросом, каким проверяет, что cookie действительно приняли.
    return reply
      .header('set-cookie', serializeCookie('child', claim.token, { secure }))
      .send({ kind: 'child', childId: claim.childId });
  });

  // `me` отвечает 200 и на «никого нет»: 401 здесь заставил бы клиент считать
  // ошибкой обычное состояние незалогиненной страницы входа.
  app.get('/api/auth/me', (request, reply) => {
    const bearer = resolveBearer(control, request.headers, now());
    if (bearer === undefined) return reply.send({ kind: 'anonymous' });
    if (bearer.kind === 'parent') {
      return reply.send({ kind: 'parent', email: bearer.parent.email });
    }
    // Ни родительского адреса, ни токенов детскому предъявителю не видно: за
    // детской машиной сидит ученик, и учётная запись родителя — не его дело.
    if (bearer.kind === 'agent') {
      return reply.send({ kind: 'agent', childId: bearer.child.childId });
    }
    return reply.send({
      kind: 'child',
      childId: bearer.child.childId,
      name: bearer.child.name,
    });
  });
}
