import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  DEVICE_INVITE_TTL_MS,
  IMPERSONATION_TTL_MS,
  LOGIN_EMAIL_FAILURE_LIMIT,
  LOGIN_LOCKOUT_MS,
  MIN_PASSWORD_LENGTH,
  PARENT_INVITE_TTL_MS,
  createAdmin,
  createChild,
  createParent,
  issueDeviceInvite,
  issueParentInvite,
  openControlDatabase,
  startImpersonation,
} from '../server/control-db.js';
import { controlDatabasePath, ensureDataDir, provisionChildDatabase } from '../server/data-dir.js';
import {
  ACTOR_COOKIE,
  CHILD_COOKIE,
  IMPERSONATION_COOKIE,
  PARENT_COOKIE,
} from '../server/auth.js';
import { CHILD_COOKIE_MAX_AGE_SECONDS, registerAuthRoutes } from '../server/routes/auth.js';
import { recordingFailureLog } from './server-harness.js';

const NOW = new Date('2026-08-19T09:00:00.000Z');
const EMAIL = 'Родитель@Example.COM';
const PASSWORD = 'пароль-подлиннее';

/** Изменяющий запрос обязан подтвердить источник: без этого он не пройдёт. */
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };

describe('маршруты входа', () => {
  let dir: string;
  let control: Database;
  let app: FastifyInstance;
  let current: Date;
  let failures: ReturnType<typeof recordingFailureLog>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'edukator-auth-routes-'));
    ensureDataDir(dir);
    control = openControlDatabase(controlDatabasePath(dir));
    current = NOW;
    failures = recordingFailureLog();
    app = Fastify();
    registerAuthRoutes(app, { control, failures, now: () => current });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    control.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Заводит родителя с приглашением: наружу уходит открытый токен ссылки. */
  function parentInvite(email = EMAIL): { parentId: string; token: string } {
    const parentId = createParent(control, email, current);
    return { parentId, token: issueParentInvite(control, parentId, current).token };
  }

  /** Родитель с уже поставленным паролем. */
  async function parentWithPassword(email = EMAIL): Promise<string> {
    const invite = parentInvite(email);
    const response = await app.inject({
      method: 'POST',
      url: `/api/auth/parent/invite/${invite.token}`,
      headers: SAME_ORIGIN,
      payload: { password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    return invite.parentId;
  }

  /** Готовый ребёнок с приглашением устройства. */
  function deviceInvite(parentId: string, kind: 'browser' | 'agent'): { childId: string; token: string } {
    const childId = createChild(control, parentId, 'Ученик', current);
    provisionChildDatabase(control, childId, dir);
    return { childId, token: issueDeviceInvite(control, childId, kind, '', current).token };
  }

  function login(email = EMAIL, password = PASSWORD): Promise<{ statusCode: number; headers: Record<string, unknown>; json: () => unknown }> {
    return app.inject({
      method: 'POST',
      url: '/api/auth/parent/login',
      headers: SAME_ORIGIN,
      payload: { email, password },
    });
  }

  /** Значение выданной cookie: тесты проверяют и её атрибуты, и сам токен. */
  function setCookie(headers: Record<string, unknown>): string {
    const raw = headers['set-cookie'];
    return Array.isArray(raw) ? String(raw[0]) : String(raw);
  }

  function cookieValue(header: string): string {
    return (header.split(';')[0] ?? '').split('=').slice(1).join('=');
  }

  function me(headers: Record<string, string>): Promise<{ statusCode: number; json: () => unknown }> {
    return app.inject({ method: 'GET', url: '/api/auth/me', headers });
  }

  describe('успешные пути', () => {
    it('пускает по паролю и выдаёт родительскую cookie с полным набором атрибутов', async () => {
      await parentWithPassword();

      const response = await login();

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ kind: 'parent', email: 'родитель@example.com' });
      const cookie = setCookie(response.headers);
      expect(cookie).toContain(`${PARENT_COOKIE}=`);
      expect(cookie).toContain('Path=/');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).not.toContain('Domain=');
    });

    it('выход гасит и сессию, и cookie', async () => {
      await parentWithPassword();
      const token = cookieValue(setCookie((await login()).headers));

      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/parent/logout',
        headers: { ...SAME_ORIGIN, cookie: `${PARENT_COOKIE}=${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(setCookie(response.headers)).toContain('Max-Age=0');
      // Токен обязан перестать работать и на сервере, а не только в браузере.
      expect((await me({ cookie: `${PARENT_COOKIE}=${token}` })).json()).toEqual({ kind: 'anonymous' });
    });

    it('установка пароля по приглашению сразу даёт рабочую сессию', async () => {
      const invite = parentInvite();

      const response = await app.inject({
        method: 'POST',
        url: `/api/auth/parent/invite/${invite.token}`,
        headers: SAME_ORIGIN,
        payload: { password: PASSWORD },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ kind: 'parent', email: 'родитель@example.com' });
      const token = cookieValue(setCookie(response.headers));
      expect((await me({ cookie: `${PARENT_COOKIE}=${token}` })).json()).toEqual({
        kind: 'parent',
        email: 'родитель@example.com',
      });
    });

    it('чтение приглашения не гасит его: предпросмотр ссылки не сжигает вход', async () => {
      const invite = parentInvite();

      const first = await app.inject({ method: 'GET', url: `/api/auth/parent/invite/${invite.token}` });
      const second = await app.inject({ method: 'GET', url: `/api/auth/parent/invite/${invite.token}` });

      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ email: 'родитель@example.com' });
      expect(second.statusCode).toBe(200);
      const redeemed = await app.inject({
        method: 'POST',
        url: `/api/auth/parent/invite/${invite.token}`,
        headers: SAME_ORIGIN,
        payload: { password: PASSWORD },
      });
      expect(redeemed.statusCode).toBe(200);
    });

    it('погашение детской ссылки выдаёт cookie Lax на десять лет', async () => {
      const parentId = await parentWithPassword();
      const device = deviceInvite(parentId, 'browser');

      const response = await app.inject({
        method: 'POST',
        url: `/api/auth/child/claim/${device.token}`,
        headers: SAME_ORIGIN,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ kind: 'child', childId: device.childId });
      const cookie = setCookie(response.headers);
      expect(cookie).toContain(`${CHILD_COOKIE}=`);
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain(`Max-Age=${CHILD_COOKIE_MAX_AGE_SECONDS}`);
    });

    it('погашение детской ссылки переключает ранее выбранного родителя на ученика', async () => {
      const parentId = await parentWithPassword();
      const parentToken = cookieValue(setCookie((await login()).headers));
      const device = deviceInvite(parentId, 'browser');

      const response = await app.inject({
        method: 'POST',
        url: `/api/auth/child/claim/${device.token}`,
        headers: {
          ...SAME_ORIGIN,
          cookie: `${PARENT_COOKIE}=${parentToken}; ${ACTOR_COOKIE}=parent`,
        },
      });

      expect(response.statusCode).toBe(200);
      const raw = response.headers['set-cookie'];
      expect(Array.isArray(raw)).toBe(true);
      const cookies = Array.isArray(raw) ? raw.map(String) : [];
      const childCookie = cookies.find((cookie) => cookie.startsWith(`${CHILD_COOKIE}=`));
      expect(childCookie).toBeDefined();
      expect(cookies).toContainEqual(expect.stringContaining(`${ACTOR_COOKIE}=child`));
      const childToken = cookieValue(childCookie ?? '');
      expect((await me({
        cookie: `${PARENT_COOKIE}=${parentToken}; ${CHILD_COOKIE}=${childToken}; ${ACTOR_COOKIE}=child`,
      })).json()).toMatchObject({ kind: 'both', active: 'child' });
    });

    it('агентское устройство получает токен телом и не получает cookie', async () => {
      const parentId = await parentWithPassword();
      const device = deviceInvite(parentId, 'agent');

      const response = await app.inject({
        method: 'POST',
        url: `/api/auth/child/claim/${device.token}`,
        headers: SAME_ORIGIN,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['set-cookie']).toBeUndefined();
      const body = response.json() as { kind: string; childId: string; token: string };
      expect(body.kind).toBe('agent');
      expect(body.childId).toBe(device.childId);
      expect((await me({ authorization: `Bearer ${body.token}` })).json()).toEqual({
        kind: 'agent',
        childId: device.childId,
      });
    });

    it('отвечает на me во всех четырёх состояниях', async () => {
      const parentId = await parentWithPassword();
      const parentToken = cookieValue(setCookie((await login()).headers));
      const browser = deviceInvite(parentId, 'browser');
      const childToken = cookieValue(
        setCookie(
          (await app.inject({
            method: 'POST',
            url: `/api/auth/child/claim/${browser.token}`,
            headers: SAME_ORIGIN,
          })).headers,
        ),
      );
      const agent = deviceInvite(parentId, 'agent');
      const agentToken = (
        (await app.inject({
          method: 'POST',
          url: `/api/auth/child/claim/${agent.token}`,
          headers: SAME_ORIGIN,
        })).json() as { token: string }
      ).token;

      expect((await me({})).json()).toEqual({ kind: 'anonymous' });
      expect((await me({ cookie: `${PARENT_COOKIE}=${parentToken}` })).json()).toEqual({
        kind: 'parent',
        email: 'родитель@example.com',
      });
      expect((await me({ cookie: `${CHILD_COOKIE}=${childToken}` })).json()).toEqual({
        kind: 'child',
        childId: browser.childId,
        name: 'Ученик',
      });
      expect((await me({ authorization: `Bearer ${agentToken}` })).json()).toEqual({
        kind: 'agent',
        childId: agent.childId,
      });
    });

    it('не отдаёт детскому предъявителю ни токенов, ни адреса родителя', async () => {
      const parentId = await parentWithPassword();
      const browser = deviceInvite(parentId, 'browser');
      const claimed = await app.inject({
        method: 'POST',
        url: `/api/auth/child/claim/${browser.token}`,
        headers: SAME_ORIGIN,
      });
      const childToken = cookieValue(setCookie(claimed.headers));

      const response = await me({ cookie: `${CHILD_COOKIE}=${childToken}` });

      expect(response.statusCode).toBe(200);
      const body = JSON.stringify(response.json());
      expect(body).not.toContain('example.com');
      expect(body).not.toContain(childToken);
    });

    it('сообщает обе сессии и переключает роль только явным POST', async () => {
      const parentId = await parentWithPassword();
      const parentToken = cookieValue(setCookie((await login()).headers));
      const browser = deviceInvite(parentId, 'browser');
      const childToken = cookieValue(setCookie((await app.inject({
        method: 'POST',
        url: `/api/auth/child/claim/${browser.token}`,
        headers: SAME_ORIGIN,
      })).headers));
      const cookie = `${PARENT_COOKIE}=${parentToken}; ${CHILD_COOKIE}=${childToken}`;

      expect((await me({ cookie })).json()).toEqual({
        kind: 'both',
        active: 'child',
        parent: { email: 'родитель@example.com' },
        child: { childId: browser.childId, name: 'Ученик' },
      });

      const switched = await app.inject({
        method: 'POST',
        url: '/api/auth/persona',
        headers: { ...SAME_ORIGIN, cookie },
        payload: { kind: 'parent', password: PASSWORD },
      });
      expect(switched.statusCode).toBe(200);
      expect(setCookie(switched.headers)).toContain(`${ACTOR_COOKIE}=parent`);
      expect(switched.json()).toMatchObject({ kind: 'both', active: 'parent' });
      expect((await me({ cookie: `${cookie}; ${ACTOR_COOKIE}=parent` })).json())
        .toMatchObject({ kind: 'both', active: 'parent' });
    });

    it('не повышает детскую роль до родительской без свежего пароля', async () => {
      const parentId = await parentWithPassword();
      const parentToken = cookieValue(setCookie((await login()).headers));
      const browser = deviceInvite(parentId, 'browser');
      const childToken = cookieValue(setCookie((await app.inject({
        method: 'POST',
        url: `/api/auth/child/claim/${browser.token}`,
        headers: SAME_ORIGIN,
      })).headers));
      const cookie = `${PARENT_COOKIE}=${parentToken}; ${CHILD_COOKIE}=${childToken}`;

      const missing = await app.inject({
        method: 'POST', url: '/api/auth/persona', headers: { ...SAME_ORIGIN, cookie }, payload: { kind: 'parent' },
      });
      const wrong = await app.inject({
        method: 'POST',
        url: '/api/auth/persona',
        headers: { ...SAME_ORIGIN, cookie },
        payload: { kind: 'parent', password: 'неверный-пароль' },
      });

      expect(missing.statusCode).toBe(400);
      expect(wrong.statusCode).toBe(401);
      expect(missing.headers['set-cookie']).toBeUndefined();
      expect(wrong.headers['set-cookie']).toBeUndefined();
      expect((await me({ cookie })).json()).toMatchObject({ kind: 'both', active: 'child' });
    });

    it('снимает Secure только явным выключателем', async () => {
      const insecure = Fastify();
      // Ни `now`, ни списка прокси: заодно проверяется, что умолчания живые.
      registerAuthRoutes(insecure, { control, failures, insecureCookies: true });
      await insecure.ready();
      const parentId = createParent(control, 'второй@example.com');
      const invite = { token: issueParentInvite(control, parentId).token };

      const response = await insecure.inject({
        method: 'POST',
        url: `/api/auth/parent/invite/${invite.token}`,
        headers: SAME_ORIGIN,
        payload: { password: PASSWORD },
      });

      expect(setCookie(response.headers)).not.toContain('Secure');
      await insecure.close();
    });
  });

  describe('заход оператора в чужую семью', () => {
    /** Заход в готовую семью: наружу уходит открытый токен cookie захода. */
    function enter(childId: string, role: 'browser' | 'parent'): string {
      const adminId = createAdmin(control, 'оператор@example.com', current);
      const started = startImpersonation(control, { adminId, childId, role }, current);
      if (!started.ok) throw new Error(`заход не начался: ${started.reason}`);
      return started.session.token;
    }

    it('называет оператора, семью и срок в роли ребёнка', async () => {
      const parentId = await parentWithPassword();
      const browser = deviceInvite(parentId, 'browser');
      const token = enter(browser.childId, 'browser');

      const response = await me({ cookie: `${IMPERSONATION_COOKIE}=${token}` });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        kind: 'child',
        childId: browser.childId,
        name: 'Ученик',
        impersonation: {
          adminEmail: 'оператор@example.com',
          childName: 'Ученик',
          role: 'browser',
          expiresAt: new Date(current.getTime() + IMPERSONATION_TTL_MS).toISOString(),
        },
      });
    });

    it('называет заход и в роли родителя целевой семьи', async () => {
      const parentId = await parentWithPassword();
      const browser = deviceInvite(parentId, 'browser');
      const token = enter(browser.childId, 'parent');

      expect((await me({ cookie: `${IMPERSONATION_COOKIE}=${token}` })).json()).toEqual({
        kind: 'parent',
        email: 'родитель@example.com',
        impersonation: {
          adminEmail: 'оператор@example.com',
          childName: 'Ученик',
          role: 'parent',
          expiresAt: new Date(current.getTime() + IMPERSONATION_TTL_MS).toISOString(),
        },
      });
    });

    it('выигрывает у собственных живых cookie оператора', async () => {
      const own = await parentWithPassword();
      const ownToken = cookieValue(setCookie((await login()).headers));
      const ownDevice = deviceInvite(own, 'browser');
      const ownChildToken = cookieValue(setCookie((await app.inject({
        method: 'POST',
        url: `/api/auth/child/claim/${ownDevice.token}`,
        headers: SAME_ORIGIN,
      })).headers));
      const strangerParent = await parentWithPassword('чужой@example.com');
      const stranger = deviceInvite(strangerParent, 'browser');
      const token = enter(stranger.childId, 'browser');

      // Обе собственные cookie живы, то есть без захода `me` вернул бы `both`.
      const body = (await me({
        cookie: `${PARENT_COOKIE}=${ownToken}; ${CHILD_COOKIE}=${ownChildToken}; ${IMPERSONATION_COOKIE}=${token}`,
      })).json() as { kind: string; childId?: string };

      expect(body.kind).toBe('child');
      expect(body.childId).toBe(stranger.childId);
      expect(body.childId).not.toBe(ownDevice.childId);
    });

    it('не называет захода, когда его cookie уже не действует', async () => {
      const parentId = await parentWithPassword();
      const browser = deviceInvite(parentId, 'browser');
      const token = enter(browser.childId, 'browser');
      current = new Date(NOW.getTime() + IMPERSONATION_TTL_MS + 1000);

      expect((await me({ cookie: `${IMPERSONATION_COOKIE}=${token}` })).json())
        .toEqual({ kind: 'anonymous' });
    });
  });

  describe('ошибочные пути', () => {
    it('отвечает одним текстом и на неверный пароль, и на незаведённый адрес', async () => {
      await parentWithPassword();

      const wrongPassword = await login(EMAIL, 'совсем-другой-пароль');
      const unknownEmail = await login('никто@example.com', PASSWORD);

      expect(wrongPassword.statusCode).toBe(401);
      expect(unknownEmail.statusCode).toBe(401);
      expect(wrongPassword.json()).toEqual(unknownEmail.json());
      expect(wrongPassword.headers['set-cookie']).toBeUndefined();
    });

    it('отвергает адрес, не похожий на адрес, не заводя сессии', async () => {
      const response = await login('никакой-не-адрес', PASSWORD);

      expect(response.statusCode).toBe(401);
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('закрывает вход, когда счётчик неудач не читается', async () => {
      await parentWithPassword();
      // Fail-closed проверяется на сломанном счётчике, а не на подменённом
      // модуле: пускать при недоступной защите — ровно то, ради чего её завели.
      control.exec('DROP TABLE login_attempts');

      const response = await login();

      expect(response.statusCode).toBe(503);
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('закрывает вход, когда неудачу не удалось записать', async () => {
      await parentWithPassword();
      // Счётчик читается, но не пишется: так выглядит `SQLITE_BUSY` под самым
      // перебором, ради которого счётчик и заведён. Отдать на это обычный 401
      // значило бы не считать попытки ровно тогда, когда их надо считать.
      control.exec(
        `CREATE TRIGGER login_attempts_readonly BEFORE INSERT ON login_attempts
           BEGIN SELECT RAISE(ABORT, 'счётчик недоступен'); END;`,
      );

      const response = await login(EMAIL, 'неверный пароль');

      expect(response.statusCode).toBe(503);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(response.headers['retry-after']).toBeDefined();
    });

    it('требует тела объектом на входе и на приглашении', async () => {
      const invite = parentInvite('третий@example.com');

      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/parent/login',
        headers: SAME_ORIGIN,
        payload: [EMAIL, PASSWORD],
      });
      const redeem = await app.inject({
        method: 'POST',
        url: `/api/auth/parent/invite/${invite.token}`,
        headers: SAME_ORIGIN,
        payload: [PASSWORD],
      });
      const numeric = await app.inject({
        method: 'POST',
        url: `/api/auth/parent/invite/${invite.token}`,
        headers: SAME_ORIGIN,
        payload: { password: 12345678901 },
      });

      expect(login.statusCode).toBe(400);
      expect(redeem.statusCode).toBe(400);
      expect(numeric.statusCode).toBe(400);
    });

    it('требует полей email и password', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/parent/login',
        headers: SAME_ORIGIN,
        payload: { email: EMAIL },
      });

      expect(response.statusCode).toBe(400);
    });

    // Тело входа собирает наш же клиент, и третье поле в нём значит не «клиент
    // стал богаче», а что запрос пришёл не оттуда, откуда мы думаем. Так же
    // строг `readMode` в родительских маршрутах.
    it('отказывает телу входа с лишним полем', async () => {
      await parentWithPassword();

      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/parent/login',
        headers: SAME_ORIGIN,
        payload: { email: EMAIL, password: PASSWORD, pin: '123456' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('не пускает изменяющий запрос без подтверждённого источника', async () => {
      await parentWithPassword();

      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/parent/login',
        headers: { host: 'edukator.local', origin: 'https://зло.example' },
        payload: { email: EMAIL, password: PASSWORD },
      });

      expect(response.statusCode).toBe(403);
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('не пускает без подтверждённого источника ни один изменяющий маршрут', async () => {
      const parentId = await parentWithPassword();
      const invite = parentInvite('четвёртый@example.com');
      const device = deviceInvite(parentId, 'browser');
      const foreign = { host: 'edukator.local', origin: 'https://зло.example' };

      const responses = await Promise.all([
        app.inject({ method: 'POST', url: '/api/auth/parent/logout', headers: foreign }),
        app.inject({
          method: 'POST',
          url: `/api/auth/parent/invite/${invite.token}`,
          headers: foreign,
          payload: { password: PASSWORD },
        }),
        app.inject({ method: 'POST', url: `/api/auth/child/claim/${device.token}`, headers: foreign }),
        app.inject({ method: 'POST', url: '/api/auth/persona', headers: foreign, payload: { kind: 'parent' } }),
      ]);

      expect(responses.map((response) => response.statusCode)).toEqual([403, 403, 403, 403]);
      // Ни одна ссылка не должна сгореть на отказе по источнику.
      expect((await app.inject({
        method: 'POST',
        url: `/api/auth/child/claim/${device.token}`,
        headers: SAME_ORIGIN,
      })).statusCode).toBe(200);
    });

    it('не различает чужой токен приглашения и отсутствующий', async () => {
      parentInvite();

      const read = await app.inject({ method: 'GET', url: '/api/auth/parent/invite/чужой-токен' });
      const redeemed = await app.inject({
        method: 'POST',
        url: '/api/auth/parent/invite/чужой-токен',
        headers: SAME_ORIGIN,
        payload: { password: PASSWORD },
      });

      expect(read.statusCode).toBe(404);
      expect(redeemed.statusCode).toBe(404);
      expect(read.json()).toEqual(redeemed.json());
    });

    it('отказывает по протухшему приглашению родителя и устройства', async () => {
      const parentId = await parentWithPassword('первый@example.com');
      const invite = issueParentInvite(control, createParent(control, 'второй@example.com', current), current);
      const device = deviceInvite(parentId, 'browser');
      current = new Date(NOW.getTime() + PARENT_INVITE_TTL_MS + DEVICE_INVITE_TTL_MS);

      const parentRedeem = await app.inject({
        method: 'POST',
        url: `/api/auth/parent/invite/${invite.token}`,
        headers: SAME_ORIGIN,
        payload: { password: PASSWORD },
      });
      const claim = await app.inject({
        method: 'POST',
        url: `/api/auth/child/claim/${device.token}`,
        headers: SAME_ORIGIN,
      });

      expect(parentRedeem.statusCode).toBe(404);
      expect(claim.statusCode).toBe(404);
    });

    it('не даёт погасить приглашение дважды', async () => {
      const invite = parentInvite();
      const first = await app.inject({
        method: 'POST',
        url: `/api/auth/parent/invite/${invite.token}`,
        headers: SAME_ORIGIN,
        payload: { password: PASSWORD },
      });

      const second = await app.inject({
        method: 'POST',
        url: `/api/auth/parent/invite/${invite.token}`,
        headers: SAME_ORIGIN,
        payload: { password: 'другой-длинный-пароль' },
      });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(404);
    });

    it('не даёт погасить детскую ссылку дважды', async () => {
      const parentId = await parentWithPassword();
      const device = deviceInvite(parentId, 'browser');
      const url = `/api/auth/child/claim/${device.token}`;

      const first = await app.inject({ method: 'POST', url, headers: SAME_ORIGIN });
      const second = await app.inject({ method: 'POST', url, headers: SAME_ORIGIN });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(404);
    });

    it('через GET ничего не гасит: детской ссылке такого маршрута нет вовсе', async () => {
      const parentId = await parentWithPassword();
      const device = deviceInvite(parentId, 'browser');

      const read = await app.inject({ method: 'GET', url: `/api/auth/child/claim/${device.token}` });

      expect(read.statusCode).toBe(404);
      expect(read.headers['set-cookie']).toBeUndefined();
      const claim = await app.inject({
        method: 'POST',
        url: `/api/auth/child/claim/${device.token}`,
        headers: SAME_ORIGIN,
      });
      expect(claim.statusCode).toBe(200);
    });

    it('называет короткий пароль и оставляет приглашение целым', async () => {
      const invite = parentInvite();

      const short = await app.inject({
        method: 'POST',
        url: `/api/auth/parent/invite/${invite.token}`,
        headers: SAME_ORIGIN,
        payload: { password: 'коротко' },
      });

      expect(short.statusCode).toBe(400);
      expect(String((short.json() as { error: string }).error)).toContain(String(MIN_PASSWORD_LENGTH));
      const redeemed = await app.inject({
        method: 'POST',
        url: `/api/auth/parent/invite/${invite.token}`,
        headers: SAME_ORIGIN,
        payload: { password: PASSWORD },
      });
      expect(redeemed.statusCode).toBe(200);
    });

    it('после серии неудач держит паузу и пускает верный пароль только после неё', async () => {
      await parentWithPassword();
      for (let attempt = 0; attempt < LOGIN_EMAIL_FAILURE_LIMIT; attempt += 1) {
        expect((await login(EMAIL, 'не тот пароль')).statusCode).toBe(401);
      }

      const locked = await login();

      expect(locked.statusCode).toBe(429);
      expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
      expect(locked.headers['set-cookie']).toBeUndefined();
      current = new Date(NOW.getTime() + LOGIN_LOCKOUT_MS + 1000);
      expect((await login()).statusCode).toBe(200);
    });

    it('пишет в журнал переход в запрет, а не каждый отказ', async () => {
      await parentWithPassword();
      for (let attempt = 0; attempt < LOGIN_EMAIL_FAILURE_LIMIT; attempt += 1) {
        await login(EMAIL, 'не тот пароль');
      }
      // Ещё три отказа под уже действующим запретом: `checkLoginGate`
      // отказывает раньше счётчика, и записи они не добавляют. Строка на каждый
      // отказ была бы не диагностикой, а её уничтожением — подбирающий выдавил
      // бы из хвоста журнала всё остальное.
      for (let attempt = 0; attempt < 3; attempt += 1) await login(EMAIL, 'не тот пароль');

      const locked = failures.records.filter((record) => record.event === 'login-lockout');
      expect(locked).toHaveLength(1);
      expect(locked[0]?.message).toContain('пароль родителя');
      expect(locked[0]?.detail).toContain(EMAIL.toLowerCase());
      // Секрета в журнале нет ни в каком виде.
      expect(JSON.stringify(failures.records)).not.toContain(PASSWORD);
      expect(JSON.stringify(failures.records)).not.toContain('не тот пароль');
    });

    it('выход без cookie отвечает тем же, что и с ней: сессии наружу не видно', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/parent/logout',
        headers: SAME_ORIGIN,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ kind: 'anonymous' });
    });
  });
});
