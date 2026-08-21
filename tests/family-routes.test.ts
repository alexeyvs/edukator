import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  MAX_CHILD_NAME_LENGTH,
  MAX_DEVICE_LABEL_LENGTH,
  childDatabasePath,
  createAdmin,
  createChild,
  createParent,
  issueParentInvite,
  listDevices,
  openControlDatabase,
  readChild,
  readParentPinHash,
  redeemParentInvite,
  resolveChildDevice,
  startImpersonation,
} from '../server/control-db.js';
import { controlDatabasePath, ensureDataDir } from '../server/data-dir.js';
import { CHILD_COOKIE, IMPERSONATION_COOKIE, PARENT_COOKIE } from '../server/auth.js';
import { registerAuthRoutes } from '../server/routes/auth.js';
import { registerFamilyRoutes } from '../server/routes/family.js';
import { recordingFailureLog } from './server-harness.js';

const NOW = new Date('2026-08-19T09:00:00.000Z');
const PASSWORD = 'пароль-подлиннее';
const PEPPER = 'серверный-pepper-подлиннее';

/** Изменяющий запрос обязан подтвердить источник: без этого он не пройдёт. */
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };

interface Injected {
  statusCode: number;
  headers: Record<string, unknown>;
  json: () => unknown;
}

describe('маршруты семьи', () => {
  let dir: string;
  let control: Database;
  let app: FastifyInstance;
  let current: Date;
  let refusals: string[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'edukator-family-routes-'));
    ensureDataDir(dir);
    control = openControlDatabase(controlDatabasePath(dir));
    current = NOW;
    app = Fastify();
    refusals = [];
    registerFamilyRoutes(app, {
      control,
      dataDir: dir,
      pinPepper: PEPPER,
      onReadOnly: (impersonation) => refusals.push(impersonation.adminId),
      now: () => current,
    });
    // Маршруты входа поднимаются рядом: полный путь семьи кончается погашением
    // детской ссылки, а его умеет только вход.
    registerAuthRoutes(app, { control, failures: recordingFailureLog(), now: () => current });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    control.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function setCookie(headers: Record<string, unknown>): string {
    const raw = headers['set-cookie'];
    return Array.isArray(raw) ? String(raw[0]) : String(raw);
  }

  function cookieValue(header: string): string {
    return (header.split(';')[0] ?? '').split('=').slice(1).join('=');
  }

  /** Вошедший родитель: наружу нужна только его cookie. */
  async function parentSession(email: string): Promise<string> {
    const parentId = createParent(control, email, current);
    const invite = issueParentInvite(control, parentId, current);
    const redeemed = redeemParentInvite(control, invite.token, PASSWORD, current);
    expect(redeemed.ok).toBe(true);
    return redeemed.ok ? redeemed.session.token : '';
  }

  function asParent(token: string): Record<string, string> {
    return { ...SAME_ORIGIN, cookie: `${PARENT_COOKIE}=${token}` };
  }

  function get(url: string, headers: Record<string, string>): Promise<Injected> {
    return app.inject({ method: 'GET', url, headers });
  }

  function post(
    url: string,
    headers: Record<string, string>,
    payload?: Record<string, unknown>,
  ): Promise<Injected> {
    return app.inject({ method: 'POST', url, headers, ...(payload === undefined ? {} : { payload }) });
  }

  /** Заводит ребёнка родительским маршрутом и отдаёт его `id`. */
  async function addChild(token: string, name = 'Ученик'): Promise<string> {
    const response = await post('/api/family/children', asParent(token), { name });
    expect(response.statusCode).toBe(201);
    return (response.json() as { child: { id: string } }).child.id;
  }

  describe('успешные пути', () => {
    it('проводит родителя весь путь: ребёнок, ссылка, погашение, отзыв', async () => {
      const parent = await parentSession('родитель@example.com');

      const childId = await addChild(parent);
      // База ребёнка заводится тем же запросом: без неё ссылку не выпустить.
      expect(existsSync(childDatabasePath(dir, childId))).toBe(true);

      const issued = await post(`/api/family/children/${childId}/devices`, asParent(parent), {
        kind: 'browser',
        label: 'Ноутбук',
      });
      expect(issued.statusCode).toBe(201);
      const invite = issued.json() as {
        device: { id: number; kind: string; label: string };
        invite: { token: string; expiresAt: string; path: string };
      };
      expect(invite.device.kind).toBe('browser');
      expect(invite.device.label).toBe('Ноутбук');
      expect(invite.invite.path).toBe(`/join/${invite.invite.token}`);

      const claimed = await post(`/api/auth/child/claim/${invite.invite.token}`, SAME_ORIGIN);
      expect(claimed.statusCode).toBe(200);
      const childToken = cookieValue(setCookie(claimed.headers));
      expect(resolveChildDevice(control, childToken, current)).toBeDefined();

      const revoked = await post(`/api/family/devices/${invite.device.id}/revoke`, asParent(parent));
      expect(revoked.statusCode).toBe(200);
      expect((revoked.json() as { revoked: boolean }).revoked).toBe(true);
      // Отзыв действует со следующего же запроса: токен перестаёт быть
      // предъявителем, а не доживает до конца суток.
      expect(resolveChildDevice(control, childToken, current)).toBeUndefined();
      expect((await get('/api/auth/me', { cookie: `${CHILD_COOKIE}=${childToken}` })).json()).toEqual({
        kind: 'anonymous',
      });
    });

    it('показывает состав семьи с устройствами и без единого токена', async () => {
      const parent = await parentSession('родитель@example.com');
      const childId = await addChild(parent, 'Пётр');
      const issued = await post(`/api/family/children/${childId}/devices`, asParent(parent), {
        kind: 'agent',
      });
      const token = (issued.json() as { invite: { token: string } }).invite.token;

      const response = await get('/api/family', asParent(parent));

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        email: string;
        pinConfigured: boolean;
        children: { id: string; name: string; status: string; devices: { kind: string }[] }[];
      };
      expect(body.email).toBe('родитель@example.com');
      expect(body.pinConfigured).toBe(false);
      expect(body.children).toHaveLength(1);
      expect(body.children[0]?.id).toBe(childId);
      expect(body.children[0]?.name).toBe('Пётр');
      expect(body.children[0]?.status).toBe('ready');
      expect(body.children[0]?.devices).toHaveLength(1);
      expect(body.children[0]?.devices[0]?.kind).toBe('agent');
      // Ссылка видна ровно один раз, в ответе на её выпуск: в базе лежит только
      // отпечаток, и список показать её уже не может.
      expect(JSON.stringify(body)).not.toContain(token);
    });

    it('ставит PIN хешем и отмечает его в составе семьи', async () => {
      const parent = await parentSession('родитель@example.com');

      const response = await post('/api/family/pin', asParent(parent), { pin: '135790' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ pinConfigured: true });
      const stored = readParentPinHash(control, (control
        .prepare<[], { id: string }>('SELECT id FROM parents')
        .get() as { id: string }).id);
      expect(stored).toBeDefined();
      // Открытого PIN в базе нет ни в каком виде.
      expect(stored).not.toContain('135790');
      expect((await get('/api/family', asParent(parent))).json()).toMatchObject({
        pinConfigured: true,
      });
    });

    it('смена PIN не гасит ни родительскую сессию, ни детское устройство', async () => {
      const parent = await parentSession('родитель@example.com');
      const childId = await addChild(parent);
      const issued = await post(`/api/family/children/${childId}/devices`, asParent(parent), {
        kind: 'browser',
      });
      const claimed = await post(
        `/api/auth/child/claim/${(issued.json() as { invite: { token: string } }).invite.token}`,
        SAME_ORIGIN,
      );
      const childToken = cookieValue(setCookie(claimed.headers));

      expect((await post('/api/family/pin', asParent(parent), { pin: '246800' })).statusCode).toBe(200);

      // PIN — подтверждение действия, а не учётные данные: раздавать после его
      // смены новые ссылки всем детям родителю не придётся.
      expect((await get('/api/family', asParent(parent))).statusCode).toBe(200);
      expect(resolveChildDevice(control, childToken, current)).toBeDefined();
    });

    it('повторный отзыв не ошибка, но и не срабатывает второй раз', async () => {
      const parent = await parentSession('родитель@example.com');
      const childId = await addChild(parent);
      const issued = await post(`/api/family/children/${childId}/devices`, asParent(parent), {
        kind: 'browser',
      });
      const deviceId = (issued.json() as { device: { id: number } }).device.id;

      const first = await post(`/api/family/devices/${deviceId}/revoke`, asParent(parent));
      const second = await post(`/api/family/devices/${deviceId}/revoke`, asParent(parent));

      expect(first.json()).toMatchObject({ revoked: true });
      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({ revoked: false });
    });

    it('повторно заводит базу сорвавшегося ребёнка без дубликата', async () => {
      const token = await parentSession('родитель@example.com');
      const parent = control.prepare<[], { id: string }>('SELECT id FROM parents').get();
      const childId = createChild(control, parent?.id ?? '', 'Марта', current);

      // Имитируем временный отказ диска: каталог детей на первой попытке нельзя
      // создать, но после устранения причины должна продолжиться та же строка.
      const childrenDir = join(dir, 'children');
      rmSync(childrenDir, { recursive: true });
      writeFileSync(childrenDir, 'временно не каталог');
      const failed = await post(
        `/api/family/children/${childId}/provision`,
        asParent(token),
      );
      expect(failed.statusCode).toBe(503);
      expect(readChild(control, childId)?.status).toBe('failed');

      rmSync(childrenDir);
      ensureDataDir(dir);

      const response = await post(
        `/api/family/children/${childId}/provision`,
        asParent(token),
      );

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ child: { id: childId, status: 'ready' } });
      expect(existsSync(childDatabasePath(dir, childId))).toBe(true);
      expect(readChild(control, childId)?.status).toBe('ready');
      expect((control.prepare<[], { count: number }>('SELECT count(*) AS count FROM children').get())?.count)
        .toBe(1);

      // Потерянный ответ не делает повтор опасным и не заводит второго ребёнка.
      const repeated = await post(
        `/api/family/children/${childId}/provision`,
        asParent(token),
      );
      expect(repeated.statusCode).toBe(200);
      expect(repeated.json()).toMatchObject({ child: { id: childId, status: 'ready' } });
    });
  });

  describe('допуск', () => {
    /** Все маршруты семьи одним списком: матрица проверяется на каждом. */
    function everyRoute(
      childId: string,
      deviceId: number,
    ): { method: 'GET' | 'POST'; url: string; payload?: Record<string, unknown> }[] {
      return [
        { method: 'GET', url: '/api/family' },
        { method: 'POST', url: '/api/family/children', payload: { name: 'Чужой' } },
        { method: 'POST', url: `/api/family/children/${childId}/provision` },
        { method: 'POST', url: `/api/family/children/${childId}/devices`, payload: { kind: 'browser' } },
        { method: 'POST', url: `/api/family/devices/${deviceId}/revoke` },
        { method: 'POST', url: '/api/family/pin', payload: { pin: '111111' } },
      ];
    }

    async function family(): Promise<{ parent: string; childId: string; deviceId: number; childToken: string; agentToken: string }> {
      const parent = await parentSession('родитель@example.com');
      const childId = await addChild(parent);
      const browser = await post(`/api/family/children/${childId}/devices`, asParent(parent), {
        kind: 'browser',
      });
      const browserBody = browser.json() as { device: { id: number }; invite: { token: string } };
      const claimed = await post(`/api/auth/child/claim/${browserBody.invite.token}`, SAME_ORIGIN);
      const childToken = cookieValue(setCookie(claimed.headers));
      const agent = await post(`/api/family/children/${childId}/devices`, asParent(parent), {
        kind: 'agent',
      });
      const agentClaim = await post(
        `/api/auth/child/claim/${(agent.json() as { invite: { token: string } }).invite.token}`,
        SAME_ORIGIN,
      );
      return {
        parent,
        childId,
        deviceId: browserBody.device.id,
        childToken,
        agentToken: (agentClaim.json() as { token: string }).token,
      };
    }

    it('пускает родительскую сессию на каждый маршрут', async () => {
      const state = await family();

      for (const route of everyRoute(state.childId, state.deviceId)) {
        const response = await app.inject({
          method: route.method,
          url: route.url,
          headers: asParent(state.parent),
          ...(route.payload === undefined ? {} : { payload: route.payload }),
        });
        expect([200, 201]).toContain(response.statusCode);
      }
    });

    it('не пускает ни детскую сессию, ни агента, ни анонима', async () => {
      const state = await family();
      const strangers: { name: string; headers: Record<string, string>; status: number }[] = [
        { name: 'ребёнок', headers: { ...SAME_ORIGIN, cookie: `${CHILD_COOKIE}=${state.childToken}` }, status: 403 },
        { name: 'агент', headers: { ...SAME_ORIGIN, authorization: `Bearer ${state.agentToken}` }, status: 403 },
        { name: 'аноним', headers: { ...SAME_ORIGIN }, status: 401 },
      ];

      for (const stranger of strangers) {
        for (const route of everyRoute(state.childId, state.deviceId)) {
          const response = await app.inject({
            method: route.method,
            url: route.url,
            headers: stranger.headers,
            ...(route.payload === undefined ? {} : { payload: route.payload }),
          });
          expect(
            response.statusCode,
            `${stranger.name} на ${route.method} ${route.url}`,
          ).toBe(stranger.status);
        }
      }
      // И ничего из этого не изменило состав семьи.
      const body = (await get('/api/family', asParent(state.parent))).json() as {
        children: { devices: { revokedAt?: string }[] }[];
      };
      expect(body.children).toHaveLength(1);
      expect(body.children[0]?.devices.every((device) => device.revokedAt === undefined)).toBe(true);
    });

    it('изменяющий запрос без подтверждённого источника не проходит', async () => {
      const parent = await parentSession('родитель@example.com');

      const response = await post('/api/family/children', { cookie: `${PARENT_COOKIE}=${parent}` }, {
        name: 'Ученик',
      });

      expect(response.statusCode).toBe(403);
      expect((await get('/api/family', asParent(parent))).json()).toMatchObject({ children: [] });
    });

    it('родитель не видит и не трогает чужих детей', async () => {
      const first = await parentSession('первый@example.com');
      const second = await parentSession('второй@example.com');
      const childId = await addChild(first, 'Свой');
      const issued = await post(`/api/family/children/${childId}/devices`, asParent(first), {
        kind: 'browser',
      });
      const deviceId = (issued.json() as { device: { id: number } }).device.id;

      const listed = await get('/api/family', asParent(second));
      const foreignDevice = await post(`/api/family/children/${childId}/devices`, asParent(second), {
        kind: 'browser',
      });
      const foreignProvision = await post(
        `/api/family/children/${childId}/provision`,
        asParent(second),
      );
      const foreignRevoke = await post(`/api/family/devices/${deviceId}/revoke`, asParent(second));

      expect((listed.json() as { children: unknown[] }).children).toEqual([]);
      expect(foreignDevice.statusCode).toBe(404);
      expect(foreignProvision.statusCode).toBe(404);
      expect(foreignRevoke.statusCode).toBe(404);
      // Чужое устройство осталось действующим: отказ был отказом, а не тихим
      // успехом над соседней семьёй.
      const own = (await get('/api/family', asParent(first))).json() as {
        children: { devices: { revokedAt?: string }[] }[];
      };
      expect(own.children[0]?.devices[0]?.revokedAt).toBeUndefined();
    });

    it('отвечает про чужого ребёнка тем же, что и про несуществующего', async () => {
      const first = await parentSession('первый@example.com');
      const second = await parentSession('второй@example.com');
      const childId = await addChild(first);

      const foreign = await post(`/api/family/children/${childId}/devices`, asParent(second), {
        kind: 'browser',
      });
      const missing = await post(
        '/api/family/children/00000000000000000000000000000000/devices',
        asParent(second),
        { kind: 'browser' },
      );

      expect(foreign.statusCode).toBe(missing.statusCode);
      expect(foreign.json()).toEqual(missing.json());

      const foreignProvision = await post(
        `/api/family/children/${childId}/provision`,
        asParent(second),
      );
      const missingProvision = await post(
        '/api/family/children/00000000000000000000000000000000/provision',
        asParent(second),
      );
      expect(foreignProvision.statusCode).toBe(missingProvision.statusCode);
      expect(foreignProvision.json()).toEqual(missingProvision.json());
    });
  });

  describe('ошибочные пути', () => {
    it('отвергает пустое и слишком длинное имя ребёнка', async () => {
      const parent = await parentSession('родитель@example.com');

      const empty = await post('/api/family/children', asParent(parent), { name: '   ' });
      const long = await post('/api/family/children', asParent(parent), {
        name: 'я'.repeat(MAX_CHILD_NAME_LENGTH + 1),
      });
      const missing = await post('/api/family/children', asParent(parent), {});

      expect(empty.statusCode).toBe(400);
      expect(long.statusCode).toBe(400);
      expect(missing.statusCode).toBe(400);
      expect((await get('/api/family', asParent(parent))).json()).toMatchObject({ children: [] });
    });

    it('отвергает неизвестный вид устройства', async () => {
      const parent = await parentSession('родитель@example.com');
      const childId = await addChild(parent);

      const response = await post(`/api/family/children/${childId}/devices`, asParent(parent), {
        kind: 'смартфон',
      });

      expect(response.statusCode).toBe(400);
      const body = (await get('/api/family', asParent(parent))).json() as {
        children: { devices: unknown[] }[];
      };
      expect(body.children[0]?.devices).toEqual([]);
    });

    it('отвергает слишком длинную подпись устройства', async () => {
      const parent = await parentSession('родитель@example.com');
      const childId = await addChild(parent);

      const response = await post(`/api/family/children/${childId}/devices`, asParent(parent), {
        kind: 'browser',
        label: 'п'.repeat(MAX_DEVICE_LABEL_LENGTH + 1),
      });

      expect(response.statusCode).toBe(400);
      const body = (await get('/api/family', asParent(parent))).json() as {
        children: { devices: unknown[] }[];
      };
      expect(body.children[0]?.devices).toEqual([]);
    });

    it('отвергает номер устройства, который не номер', async () => {
      const parent = await parentSession('родитель@example.com');

      // `Number` принял бы и шестнадцатеричное, и экспоненту, и число в
      // пробелах: одно устройство адресовалось бы несколькими написаниями.
      for (const raw of ['12abc', '0x4', '1e3', '%20%2012%20', '+4', '4.0']) {
        const response = await post(`/api/family/devices/${raw}/revoke`, asParent(parent));
        expect(response.statusCode).toBe(404);
      }
    });

    it('отвергает PIN не из шести-двенадцати цифр', async () => {
      const parent = await parentSession('родитель@example.com');

      const short = await post('/api/family/pin', asParent(parent), { pin: '12345' });
      const letters = await post('/api/family/pin', asParent(parent), { pin: 'абвгде' });
      const missing = await post('/api/family/pin', asParent(parent), {});

      expect(short.statusCode).toBe(400);
      expect(letters.statusCode).toBe(400);
      expect(missing.statusCode).toBe(400);
      expect((await get('/api/family', asParent(parent))).json()).toMatchObject({
        pinConfigured: false,
      });
    });

    it('без серверного pepper PIN не ставится вовсе', async () => {
      const bare = Fastify();
      registerFamilyRoutes(bare, { control, dataDir: dir, now: () => current });
      await bare.ready();
      const parent = await parentSession('родитель@example.com');

      const response = await bare.inject({
        method: 'POST',
        url: '/api/family/pin',
        headers: asParent(parent),
        payload: { pin: '135790' },
      });

      // Fail-closed: посчитать хеш «как-нибудь» значило бы завести PIN, который
      // перебирается по дампу базы за секунды.
      expect(response.statusCode).toBe(503);
      expect((await get('/api/family', asParent(parent))).json()).toMatchObject({
        pinConfigured: false,
      });
      await bare.close();
    });
  });

  describe('заход оператора', () => {
    /**
     * Заход в семью с ролью родителя. Второй замок (`PRAGMA query_only`) сюда
     * не достаёт вовсе: состав семьи, устройства и PIN лежат в `control.db`, а
     * не в базе ребёнка, — значит проверять первый замок надо именно здесь и
     * отдельно от аренды.
     */
    async function impersonatedParent(email: string): Promise<{
      headers: Record<string, string>;
      childId: string;
      parentToken: string;
    }> {
      const parentToken = await parentSession(email);
      const childId = await addChild(parentToken);
      const adminId = createAdmin(control, 'оператор@example.com', current);
      const started = startImpersonation(control, { adminId, childId, role: 'parent' }, current);
      expect(started.ok).toBe(true);
      const token = started.ok ? started.session.token : '';
      return {
        headers: { ...SAME_ORIGIN, cookie: `${IMPERSONATION_COOKIE}=${token}` },
        childId,
        parentToken,
      };
    }

    it('читать чужую семью оператору можно', async () => {
      const { headers, parentToken } = await impersonatedParent('семья@example.com');

      const response = await get('/api/family', headers);

      expect(response.statusCode).toBe(200);
      expect((response.json() as { email: string }).email).toBe('семья@example.com');
      expect(refusals).toEqual([]);
      expect(parentToken).not.toBe('');
    });

    it('заводить чужого ребёнка — нет', async () => {
      const { headers, parentToken } = await impersonatedParent('семья@example.com');

      const response = await post('/api/family/children', headers, { name: 'Подложенный' });

      expect(response.statusCode).toBe(403);
      // Код едет рядом с текстом: по одному 403 клиент не отличит работающий
      // замок от закрытого доступа и показал бы экран поломки.
      expect((response.json() as { code: string }).code).toBe('read-only');
      expect(refusals).toHaveLength(1);
      // В семье остаётся ровно тот ребёнок, которого завёл сам родитель.
      const family = (await get('/api/family', asParent(parentToken))).json() as {
        children: { name: string }[];
      };
      expect(family.children.map((child) => child.name)).toEqual(['Ученик']);
    });

    it('выпускать ссылку на чужое устройство — нет', async () => {
      const { headers, childId } = await impersonatedParent('семья@example.com');

      const response = await post(`/api/family/children/${childId}/devices`, headers, {
        kind: 'browser',
        label: 'Подложенный',
      });

      // Ссылка тут была бы хуже прочего: она гасится в постоянный токен
      // устройства и пережила бы пятнадцатиминутный срок захода.
      expect(response.statusCode).toBe(403);
      expect((response.json() as { code: string }).code).toBe('read-only');
      expect(listDevices(control, childId)).toEqual([]);
      expect(refusals).toHaveLength(1);
    });

    it('менять чужой PIN — нет', async () => {
      const { headers, parentToken } = await impersonatedParent('семья@example.com');

      const response = await post('/api/family/pin', headers, { pin: '135790' });

      expect(response.statusCode).toBe(403);
      expect((response.json() as { code: string }).code).toBe('read-only');
      expect((await get('/api/family', asParent(parentToken))).json()).toMatchObject({
        pinConfigured: false,
      });
      expect(refusals).toHaveLength(1);
    });

    it('повторять заведение чужой базы — нет', async () => {
      const { headers, childId } = await impersonatedParent('семья@example.com');

      const response = await post(`/api/family/children/${childId}/provision`, headers);

      expect(response.statusCode).toBe(403);
      expect((response.json() as { code: string }).code).toBe('read-only');
      expect(refusals).toHaveLength(1);
    });
  });
});
