import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  ADMIN_SESSION_MAX_MS,
  LOGIN_EMAIL_FAILURE_LIMIT,
  LOGIN_LOCKOUT_MS,
  createAdmin,
  createChild,
  createParent,
  disableAdmin,
  issueParentInvite,
  listAdminAudit,
  openControlDatabase,
  redeemParentInvite,
  resolveImpersonation,
  setAdminPassword,
  startImpersonation,
} from '../server/control-db.js';
import { controlDatabasePath, ensureDataDir, provisionChildDatabase } from '../server/data-dir.js';
import { ADMIN_COOKIE, IMPERSONATION_COOKIE, resolveAdminBearer } from '../server/auth.js';
import { registerAuthRoutes } from '../server/routes/auth.js';
import {
  registerAdminAuthRoutes,
  registerUnavailableAdminAuth,
} from '../server/routes/admin/auth.js';
import { recordingFailureLog } from './server-harness.js';

const NOW = new Date('2026-08-21T09:00:00.000Z');
const EMAIL = 'Оператор@Example.COM';
const NORMALIZED = 'оператор@example.com';
/** Пароль оператора: нижняя граница `MIN_ADMIN_PASSWORD_LENGTH` — 16 знаков. */
const PASSWORD = 'пароль-оператора-подлиннее';
const PARENT_PASSWORD = 'пароль-родителя';

/** Изменяющий запрос обязан подтвердить источник: без этого он не пройдёт. */
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };

interface Injected {
  statusCode: number;
  headers: Record<string, unknown>;
  json: () => unknown;
}

describe('маршруты входа оператора', () => {
  let dir: string;
  let control: Database;
  let app: FastifyInstance;
  let current: Date;
  let failures: ReturnType<typeof recordingFailureLog>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'edukator-admin-auth-'));
    ensureDataDir(dir);
    control = openControlDatabase(controlDatabasePath(dir));
    current = NOW;
    failures = recordingFailureLog();
    app = Fastify();
    registerAdminAuthRoutes(app, { control, failures, now: () => current });
    // Родительский вход поднимается рядом намеренно: счётчики перебора у двух
    // входов обязаны быть раздельными, и проверить это можно только вдвоём.
    registerAuthRoutes(app, { control, failures, now: () => current });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    control.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Оператор с уже поставленным паролем: приглашений по ссылке у админки нет. */
  function admin(email = EMAIL): string {
    const id = createAdmin(control, email, current);
    setAdminPassword(control, id, PASSWORD, current);
    return id;
  }

  function login(email = EMAIL, password = PASSWORD): Promise<Injected> {
    return app.inject({
      method: 'POST',
      url: '/api/auth/admin/login',
      headers: SAME_ORIGIN,
      payload: { email, password },
    });
  }

  function logout(headers: Record<string, string> = {}): Promise<Injected> {
    return app.inject({
      method: 'POST',
      url: '/api/auth/admin/logout',
      headers: { ...SAME_ORIGIN, ...headers },
      payload: {},
    });
  }

  function setCookie(headers: Record<string, unknown>): string {
    const raw = headers['set-cookie'];
    return Array.isArray(raw) ? String(raw[0]) : String(raw);
  }

  function cookieValue(header: string): string {
    return (header.split(';')[0] ?? '').split('=').slice(1).join('=');
  }

  /** Действия из журнала, новые сверху: страницы здесь всегда короткие. */
  function audit(): { action: string; adminId: string; detail?: string }[] {
    return listAdminAudit(control, { limit: 50 }).entries.map((entry) => ({
      action: entry.action,
      adminId: entry.adminId,
      ...(entry.detail === undefined ? {} : { detail: entry.detail }),
    }));
  }

  describe('успешные пути', () => {
    it('пускает по паролю и выдаёт cookie оператора с полным набором атрибутов', async () => {
      admin();

      const response = await login();

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ kind: 'admin', email: NORMALIZED });
      const cookie = setCookie(response.headers);
      expect(cookie).toContain(`${ADMIN_COOKIE}=`);
      expect(cookie).toContain('Path=/');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).toContain(`Max-Age=${Math.floor(ADMIN_SESSION_MAX_MS / 1000)}`);
      expect(cookie).not.toContain('Domain=');
    });

    it('выданная cookie разбирается в предъявителя оператора', async () => {
      const adminId = admin();

      const cookie = setCookie((await login()).headers);
      const bearer = resolveAdminBearer(control, { cookie: `${ADMIN_COOKIE}=${cookieValue(cookie)}` }, current);

      expect(bearer).toEqual({ kind: 'admin', admin: { adminId, email: NORMALIZED } });
    });

    it('пишет вход в журнал действий', async () => {
      const adminId = admin();

      await login();

      expect(audit()).toEqual([{ action: 'login', adminId }]);
    });

    it('выход гасит и сессию, и cookie, и пишет это в журнал', async () => {
      const adminId = admin();
      const token = cookieValue(setCookie((await login()).headers));

      const response = await logout({ cookie: `${ADMIN_COOKIE}=${token}` });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ kind: 'anonymous' });
      const cookie = setCookie(response.headers);
      expect(cookie).toContain(`${ADMIN_COOKIE}=;`);
      expect(cookie).toContain('Max-Age=0');
      expect(resolveAdminBearer(control, { cookie: `${ADMIN_COOKIE}=${token}` }, current)).toBeUndefined();
      expect(audit()).toEqual([
        { action: 'logout', adminId },
        { action: 'login', adminId },
      ]);
    });

    it('выход из админки закрывает и живой заход в семью', async () => {
      const adminId = admin();
      const token = cookieValue(setCookie((await login()).headers));
      const parentId = createParent(control, 'семья@example.com', current);
      const childId = createChild(control, parentId, 'Ученик', current);
      // Заход пускают только к обслуживаемому ребёнку: без готовой базы
      // `startImpersonation` отказывает, и тест проверял бы не тот отказ.
      provisionChildDatabase(control, childId, dir);
      const started = startImpersonation(control, { adminId, childId, role: 'browser' }, current);
      expect(started.ok).toBe(true);
      const impersonation = started.ok ? started.session.token : '';

      const response = await logout({
        cookie: `${ADMIN_COOKIE}=${token}; ${IMPERSONATION_COOKIE}=${impersonation}`,
      });

      expect(response.statusCode).toBe(200);
      // Заход, переживший выход, был бы хуже незакрытой сессии: `resolveBearer`
      // проверяет его первым, так что собственное приложение оператора молча
      // показывало бы чужую семью, а снять заход стало бы нечем — явный выход
      // требует админской cookie, которую этот же выход и погасил.
      expect(resolveImpersonation(control, impersonation, current)).toBeUndefined();
      const cookies = response.headers['set-cookie'] as string[];
      expect(cookies.some((value) => value.includes(`${IMPERSONATION_COOKIE}=;`))).toBe(true);
      expect(cookies.every((value) => value.includes('Max-Age=0'))).toBe(true);
      expect(audit()).toEqual([
        { action: 'impersonation-end', adminId, detail: 'browser, отказов записи: 0' },
        { action: 'logout', adminId },
        { action: 'login', adminId },
      ]);
    });

    it('гасит cookie и без живой сессии: мёртвый токен браузер носить не должен', async () => {
      const response = await logout({ cookie: `${ADMIN_COOKIE}=нет-такого-токена` });

      expect(response.statusCode).toBe(200);
      expect(setCookie(response.headers)).toContain('Max-Age=0');
      // Записывать некого: сессия не разобралась, а `admin_audit` называет оператора.
      expect(audit()).toEqual([]);
    });

    it('снимает `Secure` только явным выключателем', async () => {
      const insecure = Fastify();
      registerAdminAuthRoutes(insecure, { control, failures, now: () => current, insecureCookies: true });
      await insecure.ready();
      try {
        admin();
        const response: Injected = await insecure.inject({
          method: 'POST',
          url: '/api/auth/admin/login',
          headers: SAME_ORIGIN,
          payload: { email: EMAIL, password: PASSWORD },
        });
        expect(response.statusCode).toBe(200);
        const cookie = setCookie(response.headers);
        expect(cookie).not.toContain('Secure');
        expect(cookie).toContain('SameSite=Strict');
      } finally {
        await insecure.close();
      }
    });
  });

  describe('отказы', () => {
    it('отвечает одинаково несуществующему и существующему адресу', async () => {
      admin();

      const unknown = await login('никого@example.com');
      const wrong = await login(EMAIL, 'другой-пароль-подлиннее');

      expect(unknown.statusCode).toBe(401);
      expect(wrong.statusCode).toBe(401);
      expect(unknown.json()).toEqual({ error: 'Неверный адрес или пароль' });
      expect(wrong.json()).toEqual(unknown.json());
      expect(unknown.headers['set-cookie']).toBeUndefined();
      expect(wrong.headers['set-cookie']).toBeUndefined();
    });

    it('отказывает отключённому оператору тем же ответом', async () => {
      const adminId = admin();
      disableAdmin(control, adminId, current);

      const response = await login();

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'Неверный адрес или пароль' });
    });

    it('отказывает оператору без пароля', async () => {
      createAdmin(control, EMAIL, current);

      const response = await login();

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'Неверный адрес или пароль' });
    });

    it('отказывает адресу, не похожему на адрес, до всякого пароля', async () => {
      const response = await login('не-адрес');

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'Неверный адрес или пароль' });
    });

    it('пишет отказ в журнал, когда есть чей', async () => {
      const adminId = admin();

      await login(EMAIL, 'другой-пароль-подлиннее');

      expect(audit()).toEqual([{ action: 'login-failed', adminId, detail: 'bad-password' }]);
    });

    it('не пишет в журнал отказ по несуществующему адресу', async () => {
      admin();

      await login('никого@example.com');

      // Иначе перебор адресов означал бы, что журнал действий оператора растит
      // кто угодно снаружи.
      expect(audit()).toEqual([]);
    });

    it('требует ровно два поля в теле', async () => {
      for (const payload of [{}, { email: EMAIL }, { email: EMAIL, password: PASSWORD, роль: 'оператор' }, [EMAIL, PASSWORD]]) {
        const response: Injected = await app.inject({
          method: 'POST',
          url: '/api/auth/admin/login',
          headers: SAME_ORIGIN,
          payload,
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: 'Нужны поля email и password' });
      }
    });
  });

  describe('перебор', () => {
    it('запирает вход после предела неудач и отвечает 429 с retry-after', async () => {
      admin();

      for (let attempt = 0; attempt < LOGIN_EMAIL_FAILURE_LIMIT; attempt += 1) {
        expect((await login(EMAIL, 'другой-пароль-подлиннее')).statusCode).toBe(401);
      }

      const locked = await login();
      expect(locked.statusCode).toBe(429);
      expect(locked.json()).toEqual({
        error: 'Слишком много неудачных попыток входа, повторите позже',
      });
      expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
      expect(locked.headers['set-cookie']).toBeUndefined();
      // Верный пароль под запретом до `scrypt` не доходит: строк отказа в
      // журнале ровно столько, сколько попыток счётчик пропустил.
      expect(audit().filter((entry) => entry.action === 'login-failed')).toHaveLength(
        LOGIN_EMAIL_FAILURE_LIMIT,
      );
    });

    it('отпускает вход, когда счётчик остыл', async () => {
      admin();
      for (let attempt = 0; attempt < LOGIN_EMAIL_FAILURE_LIMIT; attempt += 1) {
        await login(EMAIL, 'другой-пароль-подлиннее');
      }
      expect((await login()).statusCode).toBe(429);

      current = new Date(NOW.getTime() + LOGIN_LOCKOUT_MS + 1000);

      expect((await login()).statusCode).toBe(200);
    });

    it('не запирает родительский вход перебором админского', async () => {
      admin();
      // Адрес намеренно тот же самый: разделяет счётчики только вид
      // `kind = 'admin'`, и на разных адресах общий счётчик выглядел бы
      // раздельным — почтовый ключ у них и так разный.
      const parentId = createParent(control, EMAIL, current);
      const invite = issueParentInvite(control, parentId, current);
      const redeemed = redeemParentInvite(control, invite.token, PARENT_PASSWORD, current);
      expect(redeemed.ok).toBe(true);

      for (let attempt = 0; attempt < LOGIN_EMAIL_FAILURE_LIMIT; attempt += 1) {
        await login(EMAIL, 'другой-пароль-подлиннее');
      }
      expect((await login()).statusCode).toBe(429);

      const parent: Injected = await app.inject({
        method: 'POST',
        url: '/api/auth/parent/login',
        headers: SAME_ORIGIN,
        payload: { email: EMAIL, password: PARENT_PASSWORD },
      });
      expect(parent.statusCode).toBe(200);
    });

    it('считает неудачу и по адресу клиента, и по почте', async () => {
      admin();

      await login(EMAIL, 'другой-пароль-подлиннее');

      const rows = control
        .prepare<[], { scope: string; kind: string; failures: number }>(
          'SELECT scope, kind, failures FROM login_attempts ORDER BY scope',
        )
        .all();
      expect(rows).toEqual([
        { scope: 'address', kind: 'admin', failures: 1 },
        { scope: 'email', kind: 'admin', failures: 1 },
      ]);
    });

    it('закрывает вход, когда счётчик неудач не читается', async () => {
      admin();
      // Fail-closed проверяется на сломанном счётчике, а не на подменённом
      // модуле: пускать при недоступной защите — ровно то, ради чего её завели.
      control.exec('DROP TABLE login_attempts');

      const response = await login();

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: 'Вход временно недоступен' });
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('закрывает вход, когда неудачу не удалось записать', async () => {
      admin();
      // Счётчик читается, но не пишется: так выглядит `SQLITE_BUSY` под самым
      // перебором, ради которого счётчик и заведён. Обычный 401 на это значил
      // бы, что попытки перестают считаться ровно тогда, когда их надо считать.
      control.exec(
        `CREATE TRIGGER login_attempts_readonly BEFORE INSERT ON login_attempts
           BEGIN SELECT RAISE(ABORT, 'счётчик недоступен'); END;`,
      );

      const response = await login(EMAIL, 'другой-пароль-подлиннее');

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: 'Вход временно недоступен' });
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('гасит почтовый счётчик после верного пароля', async () => {
      admin();
      await login(EMAIL, 'другой-пароль-подлиннее');

      expect((await login()).statusCode).toBe(200);

      const emailRows = control
        .prepare<[], { failures: number }>("SELECT failures FROM login_attempts WHERE scope = 'email'")
        .all();
      expect(emailRows).toEqual([]);
    });
  });

  describe('источник запроса', () => {
    it('отклоняет вход без подтверждённого источника', async () => {
      admin();

      const response: Injected = await app.inject({
        method: 'POST',
        url: '/api/auth/admin/login',
        payload: { email: EMAIL, password: PASSWORD },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'Запрос пришёл не со страницы приложения' });
      expect(response.headers['set-cookie']).toBeUndefined();
      // Ни счётчика, ни журнала: до пароля запрос не дошёл вовсе.
      expect(audit()).toEqual([]);
    });

    it('отклоняет вход с чужого источника', async () => {
      admin();

      const response: Injected = await app.inject({
        method: 'POST',
        url: '/api/auth/admin/login',
        headers: { origin: 'https://чужая.example', host: 'edukator.ru' },
        payload: { email: EMAIL, password: PASSWORD },
      });

      expect(response.statusCode).toBe(403);
    });

    it('отклоняет выход с чужой страницы: это способ выкинуть оператора', async () => {
      admin();
      const token = cookieValue(setCookie((await login()).headers));

      const response: Injected = await app.inject({
        method: 'POST',
        url: '/api/auth/admin/logout',
        headers: { cookie: `${ADMIN_COOKIE}=${token}` },
        payload: {},
      });

      expect(response.statusCode).toBe(403);
      expect(resolveAdminBearer(control, { cookie: `${ADMIN_COOKIE}=${token}` }, current)).toBeDefined();
    });
  });

  describe('сервер без управляющей базы', () => {
    it('отвечает 503, а не 404: оператор обязан видеть поломку сервера', async () => {
      const broken = Fastify();
      registerUnavailableAdminAuth(broken, 'управляющая база недоступна');
      await broken.ready();
      try {
        for (const url of ['/api/auth/admin/login', '/api/auth/admin/logout']) {
          const response: Injected = await broken.inject({
            method: 'POST',
            url,
            headers: SAME_ORIGIN,
            payload: {},
          });
          expect(response.statusCode).toBe(503);
          expect(response.json()).toEqual({
            error: 'Вход недоступен: управляющая база недоступна',
          });
        }
      } finally {
        await broken.close();
      }
    });
  });
});
