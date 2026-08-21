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
  disableAdmin,
  issueDeviceInvite,
  issueParentInvite,
  loginAdmin,
  redeemDeviceInvite,
  redeemParentInvite,
  openControlDatabase,
  setAdminPassword,
  setParentPin,
} from '../server/control-db.js';
import { controlDatabasePath, ensureDataDir, provisionChildDatabase } from '../server/data-dir.js';
import { ADMIN_COOKIE, CHILD_COOKIE, PARENT_COOKIE } from '../server/auth.js';
import { TenantRegistry } from '../server/tenant-registry.js';
import { hashParentPin } from '../server/parent-pin.js';
import { registerBossRoutes } from '../server/routes/boss.js';
import { registerGateRoutes } from '../server/routes/gate.js';
import { registerLearningRoutes } from '../server/routes/learning.js';
import { registerParentsRoutes } from '../server/routes/parents.js';
import { registerProfileRoutes } from '../server/routes/profile.js';
import { registerRunRoutes } from '../server/routes/run.js';
import { registerSessionRoutes } from '../server/routes/session.js';
import { registerTriageRoutes } from '../server/routes/triage.js';
import { registerIntegrityRoutes } from '../server/routes/integrity.js';
import {
  ROUTE_ACCESS,
  createAdminContext,
  createTenantContext,
  failAuth,
} from '../server/routes/tenant-context.js';
import { recordingFailureLog } from './server-harness.js';

const NOW = new Date('2026-08-19T09:00:00.000Z');
const PASSWORD = 'пароль-подлиннее';
/** Пароль оператора: `MIN_ADMIN_PASSWORD_LENGTH` — 16 знаков. */
const ADMIN_PASSWORD = 'пароль-оператора-подлиннее';
const PIN = '135790';
const PEPPER = 'серверный-pepper-подлиннее';

/** Изменяющий запрос обязан подтвердить источник: без этого он не пройдёт. */
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
}

/** Вид предъявителя вместе с заголовками, которыми он представляется. */
type BearerName = 'parent' | 'browser' | 'agent' | 'admin' | 'anonymous';

describe('контекст арендатора', () => {
  let dir: string;
  let seedDir: string;
  let control: Database;
  let tenants: TenantRegistry;
  let app: FastifyInstance;
  let childId: string;
  let otherChildId: string;
  let adminId: string;
  let headers: Record<BearerName, Record<string, string>>;
  /** Всё, что маршруты действительно зарегистрировали: таблица ниже сверяется с этим. */
  const registered: { method: string; url: string }[] = [];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'edukator-tenant-context-'));
    ensureDataDir(dir);
    seedDir = join(dir, 'посев');
    mkdirSync(seedDir, { recursive: true });
    writeFileSync(join(seedDir, 'math.json'), JSON.stringify({ subject: 'math', topics: [] }));
    control = openControlDatabase(controlDatabasePath(dir));
    tenants = new TenantRegistry({
      control,
      dataDir: dir,
      graph: GRAPH,
      seedDir,
      log: () => undefined,
    });

    const parentId = createParent(control, 'родитель@example.com', NOW);
    const invite = issueParentInvite(control, parentId, NOW);
    const redeemed = redeemParentInvite(control, invite.token, PASSWORD, NOW);
    if (!redeemed.ok) throw new Error('приглашение родителя не погашено');

    childId = createChild(control, parentId, 'Ученик', NOW);
    provisionChildDatabase(control, childId, dir);
    otherChildId = createChild(control, parentId, 'Второй', NOW);
    provisionChildDatabase(control, otherChildId, dir);

    adminId = createAdmin(control, 'оператор@example.com', NOW);
    setAdminPassword(control, adminId, ADMIN_PASSWORD, NOW);
    const login = loginAdmin(control, 'оператор@example.com', ADMIN_PASSWORD, NOW);
    if (!login.ok) throw new Error(`оператор не вошёл: ${login.reason}`);

    headers = {
      parent: { ...SAME_ORIGIN, cookie: `${PARENT_COOKIE}=${redeemed.session.token}` },
      browser: { ...SAME_ORIGIN, cookie: `${CHILD_COOKIE}=${claim('browser')}` },
      agent: { ...SAME_ORIGIN, authorization: `Bearer ${claim('agent')}` },
      admin: { ...SAME_ORIGIN, cookie: `${ADMIN_COOKIE}=${login.session.token}` },
      anonymous: { ...SAME_ORIGIN },
    };

    // PIN живёт в `control.db` и свой у каждой семьи: маршрут читает его
    // оттуда, а не из настроек процесса.
    setParentPin(control, parentId, hashParentPin(PIN, PEPPER));

    const context = createTenantContext({ control, tenants, now: () => NOW });
    app = Fastify();
    registered.length = 0;
    app.addHook('onRoute', (route) => {
      for (const method of [route.method].flat()) {
        if (method === 'HEAD' || method === 'OPTIONS') continue;
        registered.push({ method, url: route.url });
      }
    });
    registerSessionRoutes(app, { context, graph: GRAPH, now: () => NOW, log: () => undefined });
    registerRunRoutes(app, { context, graph: GRAPH, now: () => NOW });
    registerTriageRoutes(app, { context, graph: GRAPH, now: () => NOW });
    registerIntegrityRoutes(app, { context });
    registerBossRoutes(app, { context, graph: GRAPH, now: () => NOW });
    registerLearningRoutes(app, { context, graph: GRAPH, now: () => NOW });
    registerProfileRoutes(app, { context });
    registerGateRoutes(app, { context, now: () => NOW });
    registerParentsRoutes(app, {
      context,
      graph: GRAPH,
      control,
      failures: recordingFailureLog(),
      pinPepper: PEPPER,
      now: () => NOW,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await tenants.closeAll();
    control.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Погашенное устройство ребёнка: наружу нужен только его постоянный токен. */
  function claim(kind: 'browser' | 'agent'): string {
    const invite = issueDeviceInvite(control, childId, kind, '', NOW);
    const claimed = redeemDeviceInvite(control, invite.token, NOW);
    if (!claimed.ok) throw new Error(`устройство ${kind} не погашено`);
    return claimed.token;
  }

  function get(url: string, bearer: BearerName): Promise<Injected> {
    return app.inject({ method: 'GET', url, headers: headers[bearer] });
  }

  function put(
    url: string,
    bearer: BearerName,
    payload: Record<string, unknown>,
  ): Promise<Injected> {
    return app.inject({ method: 'PUT', url, headers: headers[bearer], payload });
  }

  describe('матрица допуска', () => {
    // Ожидание выписано руками, а не выведено из `ROUTE_ACCESS`: тест, который
    // строит его из той же таблицы, переживёт любую её подмену.
    const MATRIX = [
      { group: 'child', url: '/api/profile', parent: false, browser: true, agent: false },
      { group: 'gate', url: '/api/gate/status', parent: false, browser: true, agent: true },
      { group: 'dashboard', url: null, parent: true, browser: true, agent: false },
    ] as const;

    for (const row of MATRIX) {
      for (const bearer of ['parent', 'browser', 'agent'] as const) {
        const allowed = row[bearer];
        it(`${row.group}: предъявителя ${bearer} ${allowed ? 'пускает' : 'не пускает'}`, async () => {
          const response = await get(row.url ?? `/api/parents/${childId}`, bearer);
          if (allowed) expect(response.statusCode).toBe(200);
          else expect(response.statusCode).not.toBe(200);
        });
      }
    }

    // Поимённо каждый маршрут: три URL выше проверяли три строки матрицы, но
    // `allow` передаёт **каждый** обработчик отдельно, и подмена его у одного
    // модуля (скажем, `child` → `gate` во всех маршрутах босса) не меняла ни
    // одного ожидания. Ожидание выписано руками — из `ROUTE_ACCESS` его выводить
    // нельзя по той же причине.
    const ROUTES: ReadonlyArray<{
      method: 'GET' | 'POST' | 'PUT';
      url: string;
      allow: ReadonlyArray<'parent' | 'browser' | 'agent'>;
      /** `GET`, который списывает задание: источник он подтверждает наравне с `POST`. */
      mutating?: true;
    }> = [
      { method: 'GET', url: '/api/session/next', allow: ['browser'], mutating: true },
      { method: 'POST', url: '/api/session/answer', allow: ['browser'] },
      { method: 'POST', url: '/api/session/dispute', allow: ['browser'] },
      { method: 'POST', url: '/api/session/retry/skip', allow: ['browser'] },
      { method: 'GET', url: '/api/run/plan', allow: ['browser'] },
      { method: 'POST', url: '/api/run/start', allow: ['browser'] },
      { method: 'POST', url: '/api/run/:id/finish', allow: ['browser'] },
      { method: 'POST', url: '/api/triage/start', allow: ['browser'] },
      { method: 'GET', url: '/api/triage/:id/next', allow: ['browser'], mutating: true },
      { method: 'GET', url: '/api/integrity/:runId', allow: ['browser'], mutating: true },
      { method: 'POST', url: '/api/integrity/:runId/retry/:itemId', allow: ['browser'] },
      { method: 'GET', url: '/api/boss/topics', allow: ['browser'] },
      { method: 'GET', url: '/api/boss/:id/state', allow: ['browser'] },
      { method: 'GET', url: '/api/boss/:id/next', allow: ['browser'] },
      { method: 'POST', url: '/api/boss/start', allow: ['browser'] },
      { method: 'POST', url: '/api/boss/:id/answer', allow: ['browser'] },
      { method: 'POST', url: '/api/boss/:id/concede', allow: ['browser'] },
      { method: 'GET', url: '/api/learning/:id', allow: ['browser'] },
      { method: 'POST', url: '/api/learning/:id/open', allow: ['browser'] },
      { method: 'POST', url: '/api/learning/:id/test', allow: ['browser'] },
      { method: 'POST', url: '/api/learning/run/:runId/finish', allow: ['browser'] },
      { method: 'GET', url: '/api/profile', allow: ['browser'] },
      { method: 'PUT', url: '/api/profile', allow: ['browser'] },
      { method: 'GET', url: '/api/gate/status', allow: ['browser', 'agent'] },
      { method: 'GET', url: '/api/parents/:childId', allow: ['parent', 'browser'] },
      { method: 'GET', url: '/api/parents/:childId/runs/:runId', allow: ['parent', 'browser'] },
      { method: 'PUT', url: '/api/parents/:childId/computer-access', allow: ['parent', 'browser'] },
      { method: 'PUT', url: '/api/parents/:childId/runs/:runId/integrity/:itemId/approve', allow: ['parent', 'browser'] },
    ];

    /** Адрес с подставленными параметрами. Существование строк роли не играет: проверяется допуск. */
    function fill(url: string): string {
      return url.replace(':childId', childId).replace(':runId', '1').replace(':itemId', '1').replace(':id', '1');
    }

    it('перечисляет в таблице каждый зарегистрированный маршрут', () => {
      // Новый маршрут без строки в таблице — маршрут, чей допуск никто не
      // проверял: без этой сверки он молча проходил бы мимо всего теста.
      const table = new Set(ROUTES.map((route) => `${route.method} ${route.url}`));
      const actual = registered.map((route) => `${route.method} ${route.url}`).sort();
      expect(actual.filter((route) => !table.has(route))).toEqual([]);
      expect([...table].filter((route) => !actual.includes(route)).sort()).toEqual([]);
    });

    for (const route of ROUTES) {
      for (const bearer of ['parent', 'browser', 'agent'] as const) {
        const allowed = route.allow.includes(bearer);
        it(`${route.method} ${route.url}: ${bearer} ${allowed ? 'проходит допуск' : 'получает 403'}`, async () => {
          const response = await app.inject({
            method: route.method,
            url: fill(route.url),
            headers: headers[bearer],
            ...(route.method === 'GET' ? {} : { payload: {} }),
          });
          // Сравнивается именно 403: остальные коды маршрут выдаёт по своему
          // состоянию (нет забега, нет задания), и «не 200» было бы верно и на
          // пятисотке.
          if (allowed) expect(response.statusCode).not.toBe(403);
          else expect(response.statusCode).toBe(403);
        });
      }
    }

    // Детская cookie `SameSite=Lax` уезжает и на переходе с чужой страницы, а
    // безопасный метод у выдачи только по названию: `takeTask` списывает
    // задание безвозвратно. Поэтому подтверждение источника у таких `GET`
    // требуется наравне с `POST`, и ожидание выписано руками, маршрут за
    // маршрутом: разъезд флага с тем, что маршрут делает, иначе не заметить.
    for (const route of ROUTES.filter((candidate) => candidate.method === 'GET')) {
      const kind = route.mutating === true ? 'требует' : 'не требует';
      it(`GET ${route.url} ${kind} подтверждения источника`, async () => {
        const bearer = route.allow.includes('browser') ? 'browser' : 'parent';
        // Ровно предъявитель, без `sec-fetch-site` и `origin`: источник не
        // подтверждён ничем.
        const blind = Object.fromEntries(
          Object.entries(headers[bearer]).filter(([name]) => name !== 'sec-fetch-site'),
        );
        const response = await app.inject({ method: 'GET', url: fill(route.url), headers: blind });
        if (route.mutating === true) {
          expect(response.statusCode).toBe(403);
          expect(response.json()).toEqual({ error: 'Запрос пришёл не со страницы приложения', code: 'cross-origin' });
        } else {
          expect(response.statusCode).not.toBe(403);
        }
      });
    }

    // Строка оператора добавлена рядом с тремя прежними, а не внутрь них.
    // Пополнение любой из трёх значением `admin` открыло бы cookie оператора
    // прямой доступ к чужой семье мимо обоих замков имперсонации, и заметить
    // это по маршрутам было бы уже поздно.
    it('держит `admin` единственной строкой оператора', () => {
      expect(ROUTE_ACCESS.admin).toEqual(['admin']);
      expect(ROUTE_ACCESS.child).toEqual(['browser']);
      expect(ROUTE_ACCESS.gate).toEqual(['browser', 'agent']);
      expect(ROUTE_ACCESS.dashboard).toEqual(['parent', 'browser']);
      for (const [group, allow] of Object.entries(ROUTE_ACCESS)) {
        if (group === 'admin') continue;
        expect(allow).not.toContain('admin');
      }
    });

    it('не пускает cookie оператора ни на один существующий маршрут', async () => {
      for (const route of ROUTES) {
        const response = await app.inject({
          method: route.method,
          url: fill(route.url),
          headers: headers.admin,
          ...(route.method === 'GET' ? {} : { payload: {} }),
        });
        // Ровно 401: `resolveBearer` про админскую cookie не знает вовсе, то
        // есть предъявителя нет — а не «есть, но не тот».
        expect([route.url, response.statusCode]).toEqual([route.url, 401]);
      }
    });

    it('не пускает никуда без предъявителя', async () => {
      for (const url of ['/api/profile', '/api/gate/status', `/api/parents/${childId}`]) {
        expect((await get(url, 'anonymous')).statusCode).toBe(401);
      }
    });

    it('отвечает агенту 403, а не молчаливым 404, на детских маршрутах', async () => {
      const response = await get('/api/profile', 'agent');
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'Доступ закрыт', code: 'forbidden' });
    });

    it('отвечает родителю на детском маршруте 403: ребёнка он там не называл', async () => {
      const response = await get('/api/run/plan', 'parent');
      expect(response.statusCode).toBe(403);
    });

    it('не пускает ребёнка в сводку соседа: она неотличима от несуществующей', async () => {
      const response = await get(`/api/parents/${otherChildId}`, 'browser');
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'Ребёнок не найден', code: 'no-child' });
    });

    it('пускает родителя в сводку каждого своего ребёнка', async () => {
      expect((await get(`/api/parents/${childId}`, 'parent')).statusCode).toBe(200);
      expect((await get(`/api/parents/${otherChildId}`, 'parent')).statusCode).toBe(200);
    });
  });

  describe('админский контекст', () => {
    /**
     * Пробный админский маршрут: настоящие появятся в задаче 5, а проверять
     * `createAdminContext` надо уже сейчас — и именно через Fastify, потому что
     * его смысл в переводе заголовков запроса в предъявителя.
     */
    async function adminApp(): Promise<FastifyInstance> {
      const context = createAdminContext({ control, now: () => NOW });
      const own = Fastify();
      own.get('/api/admin/проба', async (request, reply) => {
        try {
          return { adminId: context(request, { allow: ROUTE_ACCESS.admin }).admin.adminId };
        } catch (error) {
          return failAuth(reply, error);
        }
      });
      own.post('/api/admin/проба', async (request, reply) => {
        try {
          return { adminId: context(request, { allow: ROUTE_ACCESS.admin }).admin.adminId };
        } catch (error) {
          return failAuth(reply, error);
        }
      });
      await own.ready();
      return own;
    }

    it('пускает оператора и не пускает остальных', async () => {
      const own = await adminApp();
      try {
        const ok = await own.inject({
          method: 'GET',
          url: '/api/admin/проба',
          headers: headers.admin,
        });
        expect(ok.statusCode).toBe(200);
        expect(ok.json()).toEqual({ adminId });

        for (const bearer of ['parent', 'browser', 'agent', 'anonymous'] as const) {
          const response = await own.inject({
            method: 'GET',
            url: '/api/admin/проба',
            headers: headers[bearer],
          });
          expect([bearer, response.statusCode]).toEqual([bearer, 401]);
          expect(response.json()).toEqual({ error: 'Нужно войти', code: 'unauthenticated' });
        }
      } finally {
        await own.close();
      }
    });

    it('не пускает отключённого оператора', async () => {
      const own = await adminApp();
      try {
        disableAdmin(control, adminId, NOW);
        const response = await own.inject({
          method: 'GET',
          url: '/api/admin/проба',
          headers: headers.admin,
        });
        expect(response.statusCode).toBe(401);
      } finally {
        await own.close();
      }
    });

    it('требует подтверждённого источника у изменяющего админского запроса', async () => {
      const own = await adminApp();
      try {
        const blind = await own.inject({
          method: 'POST',
          url: '/api/admin/проба',
          headers: { cookie: headers.admin['cookie'] ?? '', origin: 'https://чужой.example' },
        });
        expect(blind.statusCode).toBe(403);
        expect(blind.json()).toEqual({ error: 'Запрос пришёл не со страницы приложения', code: 'cross-origin' });

        const same = await own.inject({
          method: 'POST',
          url: '/api/admin/проба',
          headers: headers.admin,
        });
        expect(same.statusCode).toBe(200);
      } finally {
        await own.close();
      }
    });

    // `mutating` поднимает до изменяющего и безопасный по методу запрос: у
    // админки такими будут выдачи, списывающие что-то на стороне оператора.
    it('требует источник и у безопасного метода, помеченного изменяющим', async () => {
      const context = createAdminContext({ control, now: () => NOW });
      const own = Fastify();
      own.get('/api/admin/проба', async (request, reply) => {
        try {
          return {
            adminId: context(request, { allow: ROUTE_ACCESS.admin, mutating: true }).admin.adminId,
          };
        } catch (error) {
          return failAuth(reply, error);
        }
      });
      await own.ready();
      try {
        const blind = await own.inject({
          method: 'GET',
          url: '/api/admin/проба',
          headers: { cookie: headers.admin['cookie'] ?? '' },
        });
        expect(blind.statusCode).toBe(403);
        expect(blind.json()).toEqual({ error: 'Запрос пришёл не со страницы приложения', code: 'cross-origin' });

        const same = await own.inject({
          method: 'GET',
          url: '/api/admin/проба',
          headers: headers.admin,
        });
        expect(same.statusCode).toBe(200);
      } finally {
        await own.close();
      }
    });

    it('берёт время сам, когда его не подменили', async () => {
      // Сессия заводится настоящим временем: сроки бездействия и потолка
      // считаются от него же, и выданная на `NOW` cookie здесь уже просрочена.
      const fresh = loginAdmin(control, 'оператор@example.com', ADMIN_PASSWORD);
      if (!fresh.ok) throw new Error(`оператор не вошёл: ${fresh.reason}`);
      const context = createAdminContext({ control });
      const own = Fastify();
      own.get('/api/admin/проба', async (request, reply) => {
        try {
          return { adminId: context(request, { allow: ROUTE_ACCESS.admin }).admin.adminId };
        } catch (error) {
          return failAuth(reply, error);
        }
      });
      await own.ready();
      try {
        const response = await own.inject({
          method: 'GET',
          url: '/api/admin/проба',
          headers: { ...SAME_ORIGIN, cookie: `${ADMIN_COOKIE}=${fresh.session.token}` },
        });
        expect(response.statusCode).toBe(200);
      } finally {
        await own.close();
      }
    });
  });

  describe('PIN на изменяющих родительских маршрутах', () => {
    const url = (id: string): string => `/api/parents/${id}/computer-access`;

    it('даёт ребёнку читать свою сводку без PIN', async () => {
      const response = await get(`/api/parents/${childId}`, 'browser');
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ computerAccess: { configured: true } });
    });

    it('не даёт ребёнку без PIN менять доступ к компьютеру', async () => {
      const response = await put(url(childId), 'browser', { mode: 'unlocked' });
      expect(response.statusCode).toBe(401);
      // Неприложенный PIN закрыт тем же 401, что и неверный, но неудачной
      // попыткой не считается: счёт по нему сажал бы всю семью в паузу.
      expect(response.json()).toEqual({ error: 'Нужен PIN родителя' });
    });

    it('пускает ребёнка с верным PIN', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: url(childId),
        headers: { ...headers.browser, authorization: `Bearer ${PIN}` },
        payload: { mode: 'unlocked' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ unlocked: true });
    });

    it('не спрашивает PIN у родительской сессии', async () => {
      const response = await put(url(childId), 'parent', { mode: 'blocked' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ unlocked: false });
    });

    it('не даёт агенту менять доступ к компьютеру даже с верным PIN', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: url(childId),
        headers: { ...headers.agent, authorization: `Bearer ${PIN}` },
        payload: { mode: 'unlocked' },
      });
      // Токен агента ушёл из заголовка вместе с PIN: предъявителя нет вовсе.
      expect(response.statusCode).toBe(401);
    });
  });

  describe('база выбирается по предъявителю', () => {
    it('пишет профиль в базу своего ребёнка, а не соседа', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/profile',
        headers: headers.browser,
        payload: { name: 'Тимофей' },
      });
      expect(response.statusCode).toBe(200);

      expect(tenants.peek(childId)?.db.prepare<[], { name: string }>(
        'SELECT name FROM profile',
      ).get()?.name).toBe('Тимофей');
      // База соседа даже не открывалась: чужой ребёнок отсекается до реестра.
      expect(tenants.peek(otherChildId)).toBeUndefined();
    });

    it('не открывает базу, когда изменяющий запрос пришёл не со своей страницы', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/profile',
        headers: { cookie: headers.browser['cookie'] ?? '', origin: 'https://чужой.example' },
        payload: { name: 'Тимофей' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'Запрос пришёл не со страницы приложения', code: 'cross-origin' });
      expect(tenants.peek(childId)).toBeUndefined();
    });
  });

  describe('перевод отказа в ответ', () => {
    it('не глотает чужую ошибку: она обязана остаться пятисоткой', () => {
      const broken = new Error('это поломка кода');
      expect(() => failAuth({} as never, broken)).toThrow(broken);
    });
  });

  it('берёт время сам, когда его не подменили', async () => {
    const context = createTenantContext({ control, tenants });
    const own = Fastify();
    registerGateRoutes(own, { context });
    await own.ready();
    try {
      expect((await own.inject({
        method: 'GET',
        url: '/api/gate/status',
        headers: headers.browser,
      })).statusCode).toBe(200);
    } finally {
      await own.close();
    }
  });
});
