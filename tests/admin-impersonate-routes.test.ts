import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildTopicGraph, type Topic, type TopicGraph } from '../server/curriculum.js';
import {
  createAdmin,
  createChild,
  createParent,
  issueParentInvite,
  listAdminAudit,
  loginAdmin,
  openControlDatabase,
  redeemParentInvite,
  retireChild,
  setAdminPassword,
  type AdminAuditEntry,
} from '../server/control-db.js';
import { controlDatabasePath, ensureDataDir, provisionChildDatabase } from '../server/data-dir.js';
import { ADMIN_COOKIE, IMPERSONATION_COOKIE, PARENT_COOKIE } from '../server/auth.js';
import { ImpersonationRefusals } from '../server/admin/impersonation-refusals.js';
import { ImpersonationTenants } from '../server/admin/impersonation-tenants.js';
import { TenantRegistry } from '../server/tenant-registry.js';
import { createTenantOpener } from '../server/tenant-opener.js';
import { registerProfileRoutes } from '../server/routes/profile.js';
import {
  createAdminContext,
  createTenantContext,
  type TenantContextResolver,
} from '../server/routes/tenant-context.js';
import {
  registerAdminImpersonateRoutes,
  registerUnavailableAdminImpersonate,
} from '../server/routes/admin/impersonate.js';

const NOW = new Date('2026-08-21T09:00:00.000Z');
/** Нижняя граница пароля оператора — 16 знаков. */
const ADMIN_PASSWORD = 'пароль-оператора-подлиннее';
const PARENT_PASSWORD = 'пароль-родителя';
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };

function topic(id: string): Topic {
  return {
    id,
    subject: 'math',
    title: `Тема ${id}`,
    examWeight: 3,
    difficulty: 2,
    prereqs: [],
    answerFormat: 'number',
    promptSeed: `Спрашивай по теме ${id}.`,
  };
}

const GRAPH: TopicGraph = buildTopicGraph([topic('math.a')]);

interface Injected {
  statusCode: number;
  json: () => unknown;
  headers: Record<string, unknown>;
}

describe('маршруты захода оператора в семью', () => {
  let dir: string;
  let control: Database;
  let tenants: TenantRegistry;
  let impersonations: ImpersonationTenants;
  let refusals: ImpersonationRefusals;
  let app: FastifyInstance;
  let adminId: string;
  let otherAdminId: string;
  let parentId: string;
  let childId: string;
  let adminCookie: string;
  let otherAdminCookie: string;
  let parentCookie: string;
  let context: TenantContextResolver;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'edukator-admin-impersonate-'));
    ensureDataDir(dir);
    const seedDir = join(dir, 'посев');
    mkdirSync(seedDir, { recursive: true });
    writeFileSync(join(seedDir, 'math.json'), JSON.stringify({ subject: 'math', topics: [] }));
    control = openControlDatabase(controlDatabasePath(dir));

    adminId = createAdmin(control, 'оператор@example.com', NOW);
    setAdminPassword(control, adminId, ADMIN_PASSWORD, NOW);
    adminCookie = `${ADMIN_COOKIE}=${enter('оператор@example.com')}`;
    otherAdminId = createAdmin(control, 'второй@example.com', NOW);
    setAdminPassword(control, otherAdminId, ADMIN_PASSWORD, NOW);
    otherAdminCookie = `${ADMIN_COOKIE}=${enter('второй@example.com')}`;

    parentId = createParent(control, 'родитель@example.com', NOW);
    const invite = issueParentInvite(control, parentId, NOW);
    const redeemed = redeemParentInvite(control, invite.token, PARENT_PASSWORD, NOW);
    if (!redeemed.ok) throw new Error('родитель не вошёл');
    parentCookie = `${PARENT_COOKIE}=${redeemed.session.token}`;

    childId = createChild(control, parentId, 'Ученик', NOW);
    provisionChildDatabase(control, childId, dir);

    tenants = new TenantRegistry({ control, dataDir: dir, graph: GRAPH, seedDir, log: () => undefined });
    impersonations = new ImpersonationTenants({ now: () => NOW, log: () => undefined });
    refusals = new ImpersonationRefusals();
    const opener = createTenantOpener({ tenants, impersonations });
    context = createTenantContext({
      control,
      tenants: opener,
      onReadOnly: (impersonation) => refusals.record(impersonation.adminId),
      now: () => NOW,
    });

    app = Fastify();
    registerAdminImpersonateRoutes(app, {
      context: createAdminContext({ control, now: () => NOW }),
      control,
      refusals,
      impersonations,
      now: () => NOW,
    });
    // Настоящий детский маршрут рядом: счётчик отказов считает первый замок, и
    // проверять его на выдуманном отказе значило бы проверять сам тест.
    registerProfileRoutes(app, { context });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    impersonations.closeAll();
    await tenants.closeAll();
    control.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function enter(email: string): string {
    const login = loginAdmin(control, email, ADMIN_PASSWORD, NOW);
    if (!login.ok) throw new Error(`оператор ${email} не вошёл: ${login.reason}`);
    return login.session.token;
  }

  function start(payload: Record<string, unknown>, cookie: string = adminCookie): Promise<Injected> {
    return app.inject({
      method: 'POST',
      url: '/api/admin/impersonate',
      headers: { ...SAME_ORIGIN, cookie },
      payload,
    });
  }

  function leave(cookie: string): Promise<Injected> {
    return app.inject({
      method: 'DELETE',
      url: '/api/admin/impersonate',
      headers: { ...SAME_ORIGIN, cookie },
    });
  }

  /** Значение cookie из `Set-Cookie` ответа. Пустое — гашение. */
  function cookieValue(response: Injected): string {
    const raw = String(response.headers['set-cookie'] ?? '');
    const match = /__Host-edu_impersonation=([^;]*)/u.exec(raw);
    if (match === null) throw new Error(`в ответе нет cookie захода: ${raw}`);
    return match[1] ?? '';
  }

  function audit(): AdminAuditEntry[] {
    return listAdminAudit(control, { limit: 50 }).entries;
  }

  it('начинает заход и ставит cookie рядом с админской', async () => {
    const response = await start({ childId, role: 'browser' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      childId,
      role: 'browser',
      expiresAt: new Date(NOW.getTime() + 15 * 60 * 1000).toISOString(),
    });

    const raw = String(response.headers['set-cookie']);
    expect(raw).toContain('SameSite=Strict');
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('Path=/');
    // Срок cookie равен сроку самого захода: 15 минут, число вписано руками.
    expect(raw).toContain('Max-Age=900');
    // Админская cookie не гасится и не переставляется: выход обязан вернуть
    // оператора в админку, а не на экран входа.
    expect(raw).not.toContain(ADMIN_COOKIE);

    const token = cookieValue(response);
    const profile = await app.inject({
      method: 'GET',
      url: '/api/profile',
      headers: { ...SAME_ORIGIN, cookie: `${IMPERSONATION_COOKIE}=${token}` },
    });
    expect(profile.statusCode).toBe(200);
  });

  it('пишет начало захода в журнал действий', async () => {
    await start({ childId, role: 'parent' });
    expect(audit()).toEqual([
      expect.objectContaining({
        adminId,
        action: 'impersonation-start',
        childId,
        parentId,
        detail: 'parent',
      }),
    ]);
  });

  it('выход гасит заход, cookie и пишет конец в журнал', async () => {
    const started = await start({ childId, role: 'browser' });
    const token = cookieValue(started);

    const response = await leave(`${adminCookie}; ${IMPERSONATION_COOKIE}=${token}`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ kind: 'admin' });
    expect(cookieValue(response)).toBe('');
    expect(String(response.headers['set-cookie'])).toContain('Max-Age=0');

    expect(audit()[0]).toMatchObject({
      adminId,
      action: 'impersonation-end',
      childId,
      detail: 'browser, отказов записи: 0',
    });

    // Погашенный заход больше не предъявитель: цена ошибки здесь — чужая семья
    // под собственной вкладкой оператора.
    const profile = await app.inject({
      method: 'GET',
      url: '/api/profile',
      headers: { ...SAME_ORIGIN, cookie: `${IMPERSONATION_COOKIE}=${token}` },
    });
    expect(profile.statusCode).toBe(401);
  });

  it('доносит счётчик отказанных попыток записи до записи о конце', async () => {
    const started = await start({ childId, role: 'browser' });
    const token = cookieValue(started);
    const cookie = `${IMPERSONATION_COOKIE}=${token}`;

    for (const attempt of [1, 2, 3]) {
      const refused = await app.inject({
        method: 'PUT',
        url: '/api/profile',
        headers: { ...SAME_ORIGIN, cookie },
        payload: { interests: [`попытка ${attempt}`] },
      });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toEqual({ error: 'Только просмотр: вы в чужой семье', code: 'read-only' });
    }
    // Чтение отказом не считается: иначе счётчик показывал бы усердие
    // оператора, а не его попытки писать.
    await app.inject({ method: 'GET', url: '/api/profile', headers: { ...SAME_ORIGIN, cookie } });

    await leave(`${adminCookie}; ${cookie}`);
    expect(audit()[0]).toMatchObject({
      action: 'impersonation-end',
      detail: 'browser, отказов записи: 3',
    });
  });

  it('обнуляет счётчик к следующему заходу', async () => {
    const first = await start({ childId, role: 'browser' });
    await app.inject({
      method: 'PUT',
      url: '/api/profile',
      headers: { ...SAME_ORIGIN, cookie: `${IMPERSONATION_COOKIE}=${cookieValue(first)}` },
      payload: { interests: ['раз'] },
    });
    await leave(`${adminCookie}; ${IMPERSONATION_COOKIE}=${cookieValue(first)}`);

    const second = await start({ childId, role: 'browser' });
    await leave(`${adminCookie}; ${IMPERSONATION_COOKIE}=${cookieValue(second)}`);
    expect(audit()[0]).toMatchObject({ action: 'impersonation-end', detail: 'browser, отказов записи: 0' });
  });

  it('повторный старт гасит первый заход и закрывает его записью', async () => {
    const first = await start({ childId, role: 'browser' });
    const firstToken = cookieValue(first);

    const second = await start(
      { childId, role: 'parent' },
      `${adminCookie}; ${IMPERSONATION_COOKIE}=${firstToken}`,
    );
    expect(second.statusCode).toBe(200);
    expect(cookieValue(second)).not.toBe(firstToken);

    // Порядок в журнале: старт первого, конец первого, старт второго.
    expect(audit().map((entry) => entry.action)).toEqual([
      'impersonation-start',
      'impersonation-end',
      'impersonation-start',
    ]);

    const profile = await app.inject({
      method: 'GET',
      url: '/api/profile',
      headers: { ...SAME_ORIGIN, cookie: `${IMPERSONATION_COOKIE}=${firstToken}` },
    });
    expect(profile.statusCode).toBe(401);
  });

  it('не приписывает чужой заход себе', async () => {
    const foreign = await start({ childId, role: 'browser' }, otherAdminCookie);
    // Оператор пришёл со своей админской cookie, но с чужой cookie захода:
    // конец чужого захода пишется его же оператору, а не тому, кто пришёл.
    await start(
      { childId, role: 'browser' },
      `${adminCookie}; ${IMPERSONATION_COOKIE}=${cookieValue(foreign)}`,
    );
    expect(audit().map((entry) => [entry.action, entry.adminId])).toEqual([
      ['impersonation-start', adminId],
      ['impersonation-start', otherAdminId],
    ]);
  });

  it('закрывает соединение только для чтения на выходе', async () => {
    const started = await start({ childId, role: 'browser' });
    const cookie = `${IMPERSONATION_COOKIE}=${cookieValue(started)}`;
    await app.inject({ method: 'GET', url: '/api/profile', headers: { ...SAME_ORIGIN, cookie } });
    expect(impersonations.size).toBe(1);

    await leave(`${adminCookie}; ${cookie}`);
    expect(impersonations.size).toBe(0);
  });

  it('отвечает `no-child` на чужой и на необслуживаемого ребёнка', async () => {
    retireChild(control, childId, NOW);
    const retired = await start({ childId, role: 'browser' });
    expect(retired.statusCode).toBe(404);
    expect(retired.json()).toEqual({ error: 'Ребёнок не найден' });

    const unknown = await start({ childId: 'deadbeef', role: 'browser' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'Ребёнок не найден' });
    // Отказ ничего не пишет и в журнал: заход не состоялся.
    expect(audit()).toEqual([]);
  });

  it('отказывает на роли `agent` и на кривом теле', async () => {
    const agent = await start({ childId, role: 'agent' });
    expect(agent.statusCode).toBe(400);
    expect(agent.json()).toEqual({ error: 'Роль захода — одна из: browser, parent' });

    for (const payload of [{ childId }, { childId, role: 'browser', extra: 1 }, { childId, role: 7 }]) {
      const response = await start(payload);
      expect([JSON.stringify(payload), response.statusCode]).toEqual([JSON.stringify(payload), 400]);
      expect(response.json()).toEqual({ error: 'Нужны поля childId и role' });
    }
  });

  it('не пускает никого, кроме оператора', async () => {
    const anonymous = await start({ childId, role: 'browser' }, '');
    expect(anonymous.statusCode).toBe(401);

    const parent = await start({ childId, role: 'browser' }, parentCookie);
    expect(parent.statusCode).toBe(401);

    const parentExit = await leave(parentCookie);
    expect(parentExit.statusCode).toBe(401);
    expect(audit()).toEqual([]);
  });

  it('требует подтверждённого источника', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/impersonate',
      headers: { cookie: adminCookie, origin: 'https://чужой.example', host: 'свой.example' },
      payload: { childId, role: 'browser' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Запрос пришёл не со страницы приложения', code: 'cross-origin' });
  });

  it('гасит cookie и без живого захода', async () => {
    const response = await leave(adminCookie);
    expect(response.statusCode).toBe(200);
    expect(cookieValue(response)).toBe('');
    // Записи о конце нет: заканчивать было нечего.
    expect(audit()).toEqual([]);
  });
});

describe('заглушка захода на сервере без управляющей базы', () => {
  it('отвечает 503 на оба маршрута', async () => {
    const app = Fastify();
    registerUnavailableAdminImpersonate(app, 'управляющая база недоступна');
    await app.ready();
    for (const method of ['POST', 'DELETE'] as const) {
      const response = await app.inject({ method, url: '/api/admin/impersonate', payload: {} });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: 'Заход в семью недоступен: управляющая база недоступна',
      });
    }
    await app.close();
  });
});
