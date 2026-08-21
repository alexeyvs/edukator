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
  ADMIN_SESSION_MAX_MS,
  IMPERSONATION_TTL_MS,
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
  verifyParentPassword,
  type LoginTarget,
} from '../control-db.js';
import type { FailureLog } from '../log.js';
import { noteLoginCounter, noteLoginGate } from './login-lockout.js';
import {
  ADMIN_COOKIE,
  AUTH_MESSAGE,
  AUTH_STATUS,
  ACTOR_COOKIE,
  CHILD_COOKIE,
  IMPERSONATION_COOKIE,
  PARENT_COOKIE,
  headerValue,
  isSameOrigin,
  parseCookies,
  resolveBearer,
  resolveBrowserPrincipals,
} from '../auth.js';
import { clientAddress, readTrustedProxies } from '../client-address.js';
import { MAX_SECRET_LENGTH } from '../secrets.js';

/**
 * Срок детской cookie. Десять лет — это не «навсегда по невнимательности»:
 * выключателем служит `revoked_at` на сервере, а не срок в браузере, и
 * протухающая cookie означала бы, что ребёнок раз в месяц ждёт новую ссылку от
 * родителя.
 */
export const CHILD_COOKIE_MAX_AGE_SECONDS = 10 * 365 * 24 * 60 * 60;

/**
 * Общий текст отказа входу: причина наружу не уходит. Экспортируется, потому
 * что тем же текстом отказывает вход оператора: две копии одной строки
 * разъехались бы, и по разнице текстов стало бы видно, какой вход какой.
 */
export const LOGIN_REJECTED = 'Неверный адрес или пароль';

/** Общий текст отказа по ссылке: протухшую и чужую снаружи не различить. */
const LINK_REJECTED = 'Ссылка недействительна или уже использована';

export interface AuthRoutesOptions {
  control: Database;
  /**
   * Куда писать сработавший запрет входа. Обязателен намеренно: забытая
   * передача обязана падать на сборке, а не молча оставлять перебор без следа.
   */
  failures: FailureLog;
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
export type CookieAudience = 'parent' | 'child' | 'admin' | 'impersonation';

/**
 * Атрибуты cookie по стороне. `Strict` родителю потому, что его вход умеет
 * менять состав семьи, и переход по чужой ссылке не должен приносить с собой
 * его сессию. Ребёнку — `Lax`: он приходит на занятие по ссылке-приглашению и
 * по закладке, и `Strict` встретил бы его выходом.
 */
const COOKIE_SAME_SITE: Record<CookieAudience, 'Strict' | 'Lax'> = {
  parent: 'Strict',
  child: 'Lax',
  admin: 'Strict',
  // Заход в чужую семью начинается только со страницы админки: переходом со
  // стороны сюда попадать неоткуда, и `Lax` был бы здесь послаблением без
  // единого сценария, ради которого его делают ребёнку.
  impersonation: 'Strict',
};

const COOKIE_NAME: Record<CookieAudience, string> = {
  parent: PARENT_COOKIE,
  child: CHILD_COOKIE,
  admin: ADMIN_COOKIE,
  impersonation: IMPERSONATION_COOKIE,
};

const COOKIE_MAX_AGE_SECONDS: Record<CookieAudience, number> = {
  parent: Math.floor(PARENT_SESSION_MAX_MS / 1000),
  child: CHILD_COOKIE_MAX_AGE_SECONDS,
  // Срок в браузере равен потолку сессии, а не сроку бездействия: cookie,
  // протухающая через полчаса, унесла бы с собой и возможность выйти, а
  // выключателем всё равно служит `revoked_at` на сервере.
  admin: Math.floor(ADMIN_SESSION_MAX_MS / 1000),
  // Ровно срок самого захода: cookie, живущая дольше строки в базе, каждый раз
  // приносила бы отказ вместо того, чтобы просто исчезнуть.
  impersonation: Math.floor(IMPERSONATION_TTL_MS / 1000),
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

/** Выбор роли — HttpOnly cookie, а не доверенный параметр каждого запроса. */
function serializeActorCookie(value: 'parent' | 'child', secure: boolean): string {
  const parts = [
    `${ACTOR_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${CHILD_COOKIE_MAX_AGE_SECONDS}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Что читает вход из тела запроса. Лишние поля — повод отказать, а не молчать:
 * тело входа собирает наш же клиент, и появление в нём третьего поля означает не
 * «клиент стал богаче», а что запрос пришёл не оттуда, откуда мы думаем. Так же
 * строг `readMode` в родительских маршрутах.
 */
export function readLoginBody(body: unknown): { email: string; password: string } | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const fields = body as Record<string, unknown>;
  const names = Object.keys(fields);
  if (names.length !== 2) return undefined;
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

type PersonaRequest = { kind: 'child' } | { kind: 'parent'; password: string };

function readPersonaBody(body: unknown): PersonaRequest | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const fields = body as Record<string, unknown>;
  if (fields['kind'] === 'child' && Object.keys(fields).length === 1) return { kind: 'child' };
  if (
    fields['kind'] === 'parent'
    && typeof fields['password'] === 'string'
    && Object.keys(fields).length === 2
  ) {
    return { kind: 'parent', password: fields['password'] };
  }
  return undefined;
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
      noteLoginCounter(options.failures, target, gate);
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
      // Незаписанная неудача — та же недоступность счётчика, что и на входе в
      // маршрут: `recordLoginFailure` возвращает её `reason === 'unavailable'`,
      // и молча отдать на неё обычный 401 значило бы не считать попытки ровно
      // тогда, когда их считать и нужно, — счётчик обязан быть fail-closed на
      // обоих концах.
      const counted = recordLoginFailure(control, target, now());
      noteLoginGate(options.failures, target, counted);
      if (counted.reason === 'unavailable') {
        const retryAfter = Math.max(1, Math.ceil(counted.retryAfterMs / 1000));
        return reply.header('retry-after', retryAfter).code(503).send({
          error: 'Вход временно недоступен',
        });
      }
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
      // Про негодный пароль сказать можно и нужно: это свойство присланного, а
      // не признак существования ссылки, и молчание здесь оставило бы родителя
      // гадать, почему приглашение «не работает». Названы обе границы:
      // `weak-password` означает и слишком короткий, и слишком длинный, и текст
      // про одну только длину отправлял бы удлинять пароль, который уже длинен.
      if (result.reason === 'weak-password') {
        return reply.code(400).send({
          error: `Пароль должен быть от ${MIN_PASSWORD_LENGTH} до ${MAX_SECRET_LENGTH} знаков`,
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
      // Погашение ссылки — явный выбор режима ученика. Без второй cookie
      // ранее выбранный родитель оставался активным, хотя экран подтверждения
      // обещает сразу перейти к ученику.
      .header('set-cookie', [
        serializeCookie('child', claim.token, { secure }),
        serializeActorCookie('child', secure),
      ])
      .send({ kind: 'child', childId: claim.childId });
  });

  app.post('/api/auth/persona', (request, reply) => {
    const blocked = crossOrigin(request, reply);
    if (blocked !== undefined) return blocked;

    const persona = readPersonaBody(request.body);
    if (persona === undefined) {
      return reply.code(400).send({ error: 'Для родителя нужны kind и password, для ученика — kind' });
    }
    const browser = resolveBrowserPrincipals(control, request.headers, now());
    // Переключатель существует только между двумя уже действительными
    // сессиями. Значение тела и preference-cookie новых прав не создают.
    if (browser.parent === undefined || browser.child === undefined) {
      return reply.code(409).send({ error: 'Переключение недоступно' });
    }
    if (persona.kind === 'parent') {
      const target: LoginTarget = {
        kind: 'password',
        email: browser.parent.email,
        address: address(request),
      };
      const gate = checkLoginGate(control, target, now());
      if (!gate.allowed) {
        noteLoginCounter(options.failures, target, gate);
        const retryAfter = Math.max(1, Math.ceil(gate.retryAfterMs / 1000));
        return reply.header('retry-after', retryAfter).code(gate.reason === 'unavailable' ? 503 : 429).send({
          error: gate.reason === 'unavailable'
            ? 'Вход временно недоступен'
            : 'Слишком много неудачных попыток входа, повторите позже',
        });
      }
      if (!verifyParentPassword(control, browser.parent.parentId, persona.password)) {
        const counted = recordLoginFailure(control, target, now());
        noteLoginGate(options.failures, target, counted);
        if (counted.reason === 'unavailable') {
          const retryAfter = Math.max(1, Math.ceil(counted.retryAfterMs / 1000));
          return reply.header('retry-after', retryAfter).code(503).send({ error: 'Вход временно недоступен' });
        }
        return reply.code(401).send({ error: LOGIN_REJECTED });
      }
      clearLoginFailures(control, target);
    }
    return reply
      .header('set-cookie', serializeActorCookie(persona.kind, secure))
      .send({
        kind: 'both',
        active: persona.kind,
        parent: { email: browser.parent.email },
        child: { childId: browser.child.childId, name: browser.child.name },
      });
  });

  // `me` отвечает 200 и на «никого нет»: 401 здесь заставил бы клиент считать
  // ошибкой обычное состояние незалогиненной страницы входа.
  app.get('/api/auth/me', (request, reply) => {
    const at = now();
    const bearer = resolveBearer(control, request.headers, at);

    // Заход оператора в чужую семью проверяется **раньше** собственных cookie:
    // оператор заходит со своей машины, где живы и его родительский, и его
    // детский вход, и ветка `both` вернула бы ему свою же семью — то есть
    // баннер не появился бы ровно там, где он и нужен.
    if (bearer?.impersonation !== undefined) {
      const { adminEmail, childName, role, expiresAt } = bearer.impersonation;
      const impersonation = { adminEmail, childName, role, expiresAt };
      return reply.send(bearer.kind === 'parent'
        ? { kind: 'parent', email: bearer.parent.email, impersonation }
        : { kind: 'child', childId: bearer.child.childId, name: bearer.child.name, impersonation });
    }

    const browser = resolveBrowserPrincipals(control, request.headers, at);
    if (browser.parent !== undefined && browser.child !== undefined) {
      const selected = parseCookies(request.headers.cookie).get(ACTOR_COOKIE);
      return reply.send({
        kind: 'both',
        active: selected === 'parent' ? 'parent' : 'child',
        parent: { email: browser.parent.email },
        child: { childId: browser.child.childId, name: browser.child.name },
      });
    }
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

/**
 * Заглушка входа на сервере без управляющей базы или карты тем. 503, а не 404:
 * родитель, который не может войти, обязан увидеть поломку сервера, а не
 * пропавший маршрут — по 404 он полез бы искать ошибку в собственной ссылке.
 */
export function registerUnavailableAuth(app: FastifyInstance, reason: string): void {
  const send = (_request: unknown, reply: FastifyReply): FastifyReply =>
    reply.code(503).send({ error: `Вход недоступен: ${reason}` });
  app.post('/api/auth/parent/login', send);
  app.post('/api/auth/parent/logout', send);
  app.get('/api/auth/parent/invite/:token', send);
  app.post('/api/auth/parent/invite/:token', send);
  app.post('/api/auth/child/claim/:token', send);
  app.post('/api/auth/persona', send);
  app.get('/api/auth/me', send);
}
