import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { buildTopicGraph, type Topic, type TopicGraph } from '../server/curriculum.js';
import {
  createAdmin,
  createChild,
  createParent,
  disableAdmin,
  disableParent,
  hashToken,
  IMPERSONATION_TTL_MS,
  issueDeviceInvite,
  issueParentInvite,
  loginAdmin,
  redeemDeviceInvite,
  redeemParentInvite,
  retireChild,
  revokeDevice,
  revokeImpersonation,
  startImpersonation,
  openControlDatabase,
  setAdminPassword,
} from '../server/control-db.js';
import { controlDatabasePath, ensureDataDir, provisionChildDatabase } from '../server/data-dir.js';
import { TenantError, TenantRegistry, type Tenant } from '../server/tenant-registry.js';
import {
  AUTH_MESSAGE,
  AUTH_STATUS,
  AuthError,
  AGENT_HEADER,
  ACTOR_COOKIE,
  ADMIN_COOKIE,
  CHILD_COOKIE,
  IMPERSONATION_COOKIE,
  PARENT_COOKIE,
  assertSameOrigin,
  authorizeChild,
  headerValue,
  isMutating,
  isSameOrigin,
  parseCookies,
  readAgentToken,
  resolveAdmin,
  resolveAdminBearer,
  resolveBearer,
  resolveTenant,
  type Bearer,
  type BearerKind,
  type RequestHeaders,
  type TenantOpener,
  type TenantRequester,
} from '../server/auth.js';

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

const HOST = 'edukator.local:3000';
/** Опорный момент времени: сроки захода отмеряются от него, а не от «сейчас». */
const NOW = new Date('2026-08-21T10:00:00.000Z');
/** Допуск, при котором проверяется всё, кроме самого допуска: он проверяется отдельно. */
const ALLOW_ALL: readonly BearerKind[] = ['parent', 'browser', 'agent'];

/** Заголовки своей же страницы: изменяющий запрос без них не проходит. */
const SAME_ORIGIN: RequestHeaders = {
  host: HOST,
  origin: `https://${HOST}`,
};

describe('разрешение предъявителя и аренды', () => {
  let tempDir: string;
  let control: Database;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-auth-'));
    ensureDataDir(tempDir);
    control = openControlDatabase(controlDatabasePath(tempDir));
  });

  afterEach(() => {
    control.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  interface Family {
    parentId: string;
    childId: string;
    /** Cookie родительской сессии. */
    parentToken: string;
    /** Токен детского устройства `browser`. */
    childToken: string;
  }

  /** Заводит родителя с одним готовым ребёнком, сессией и погашённым устройством. */
  function family(name: string): Family {
    const parentId = createParent(control, `${name}@example.com`);
    const childId = createChild(control, parentId, name);
    provisionChildDatabase(control, childId, tempDir);
    const parentToken = parentSession(parentId);
    return { parentId, childId, parentToken, childToken: deviceToken(childId, 'browser') };
  }

  /** Ставит родителю пароль по приглашению: в ответ приходит токен его сессии. */
  function parentSession(parentId: string): string {
    const invite = issueParentInvite(control, parentId);
    const result = redeemParentInvite(control, invite.token, 'пароль-подлиннее');
    if (!result.ok) throw new Error(`приглашение родителя не погашено: ${result.reason}`);
    return result.session.token;
  }

  /** Выпускает и сразу гасит приглашение устройства: наружу уходит его токен. */
  function deviceToken(childId: string, kind: 'browser' | 'agent'): string {
    const invite = issueDeviceInvite(control, childId, kind);
    const claim = redeemDeviceInvite(control, invite.token);
    if (!claim.ok) throw new Error(`приглашение устройства не погашено: ${claim.reason}`);
    return claim.token;
  }

  /** Отметка «ребёнок был за экраном»; `null`, пока он ни разу не заходил. */
  function activityOf(childId: string): string | null {
    const row = control
      .prepare<[string], { last_activity_at: string | null }>(
        'SELECT last_activity_at FROM children WHERE id = ?',
      )
      .get(childId);
    if (row === undefined) throw new Error(`ребёнка ${childId} нет в управляющей базе`);
    return row.last_activity_at;
  }

  /** Самая свежая отметка живой родительской сессии; `null`, если их нет. */
  function parentSeenOf(parentId: string): string | null {
    const row = control
      .prepare<[string], { last_seen_at: string | null }>(
        'SELECT MAX(last_seen_at) AS last_seen_at FROM parent_sessions WHERE parent_id = ?',
      )
      .get(parentId);
    return row?.last_seen_at ?? null;
  }

  function cookies(...pairs: [string, string][]): RequestHeaders {
    return { ...SAME_ORIGIN, cookie: pairs.map(([name, value]) => `${name}=${value}`).join('; ') };
  }

  /** Реестр, считающий открытия: изоляция обязана отказывать **до** открытия базы. */
  function counting(): TenantOpener & {
    opened: string[];
    kinds: BearerKind[];
    impersonated: boolean[];
  } {
    const tenants = new TenantRegistry({ control, dataDir: tempDir, graph: GRAPH, log: () => {} });
    const opened: string[] = [];
    const kinds: BearerKind[] = [];
    const impersonated: boolean[] = [];
    return {
      opened,
      kinds,
      impersonated,
      open(childId: string, bearer: TenantRequester): Tenant {
        opened.push(childId);
        kinds.push(bearer.kind);
        impersonated.push(bearer.impersonated);
        return tenants.open(childId);
      },
    };
  }

  describe('разбор заголовков', () => {
    it('склеивает повторённый заголовок, а не теряет половину', () => {
      expect(headerValue({ cookie: ['a=1', 'b=2'] }, 'Cookie')).toBe('a=1; b=2');
      expect(headerValue({}, 'cookie')).toBeUndefined();
    });

    // `; ` — шов `Cookie` и только его. Сшитый им `X-Forwarded-For` не
    // разбирается `clientAddress` (тот режет цепочку по запятой), и вся цепочка
    // становится одним неразобранным адресом — то есть ключом счётчика перебора,
    // который клиент меняет по своему желанию.
    it('склеивает всё, кроме cookie, запятой', () => {
      expect(headerValue({ 'x-forwarded-for': ['203.0.113.7', '198.51.100.4'] }, 'X-Forwarded-For'))
        .toBe('203.0.113.7, 198.51.100.4');
    });

    it('разбирает cookie и оставляет первую из одноимённых', () => {
      const jar = parseCookies(' a=1;  b = два ; a=подмена; =пусто; мусор');
      expect(jar.get('a')).toBe('1');
      expect(jar.get('b')).toBe('два');
      expect(jar.has('')).toBe(false);
      expect(jar.has('мусор')).toBe(false);
      expect(parseCookies(undefined).size).toBe(0);
    });

    it('берёт агентский токен только из схемы Bearer', () => {
      expect(readAgentToken({ [AGENT_HEADER]: 'Bearer  токен ' })).toBe('токен');
      expect(readAgentToken({ [AGENT_HEADER]: 'Basic токен' })).toBeUndefined();
      expect(readAgentToken({ [AGENT_HEADER]: 'Bearer' })).toBeUndefined();
      expect(readAgentToken({ [AGENT_HEADER]: 'Bearer  ' })).toBeUndefined();
      expect(readAgentToken({})).toBeUndefined();
    });
  });

  describe('предъявитель', () => {
    it('разбирает родительскую cookie', () => {
      const alpha = family('alpha');

      const bearer = resolveBearer(control, cookies([PARENT_COOKIE, alpha.parentToken]));

      expect(bearer?.kind).toBe('parent');
      expect(bearer?.kind === 'parent' && bearer.parent.parentId).toBe(alpha.parentId);
    });

    it('разбирает детскую cookie', () => {
      const alpha = family('alpha');

      const bearer = resolveBearer(control, cookies([CHILD_COOKIE, alpha.childToken]));

      expect(bearer?.kind).toBe('browser');
      expect(bearer?.kind === 'browser' && bearer.child.childId).toBe(alpha.childId);
    });

    it('выбирает детский принципал, если пришли обе cookie сразу', () => {
      const alpha = family('alpha');

      const bearer = resolveBearer(
        control,
        cookies([PARENT_COOKIE, alpha.parentToken], [CHILD_COOKIE, alpha.childToken]),
      );

      expect(bearer?.kind).toBe('browser');
    });

    it('выбирает родителя только по явной preference-cookie при двух сессиях', () => {
      const alpha = family('alpha');

      const bearer = resolveBearer(
        control,
        cookies(
          [PARENT_COOKIE, alpha.parentToken],
          [CHILD_COOKIE, alpha.childToken],
          [ACTOR_COOKIE, 'parent'],
        ),
      );

      expect(bearer?.kind).toBe('parent');
    });

    it('разбирает агентский токен заголовком', () => {
      const alpha = family('alpha');
      const agent = deviceToken(alpha.childId, 'agent');

      const bearer = resolveBearer(control, { ...SAME_ORIGIN, [AGENT_HEADER]: `Bearer ${agent}` });

      expect(bearer?.kind).toBe('agent');
      expect(bearer?.kind === 'agent' && bearer.child.childId).toBe(alpha.childId);
    });

    it('не принимает агентский токен в детской cookie и детский — в заголовке', () => {
      const alpha = family('alpha');
      const agent = deviceToken(alpha.childId, 'agent');

      expect(resolveBearer(control, cookies([CHILD_COOKIE, agent]))).toBeUndefined();
      expect(
        resolveBearer(control, { ...SAME_ORIGIN, [AGENT_HEADER]: `Bearer ${alpha.childToken}` }),
      ).toBeUndefined();
    });

    it('отказывает без предъявителя и по отозванному устройству', () => {
      const alpha = family('alpha');
      const claimed = control
        .prepare<[string], { id: number }>('SELECT id FROM child_devices WHERE child_id = ?')
        .get(alpha.childId);
      revokeDevice(control, claimed?.id ?? 0);

      expect(resolveBearer(control, SAME_ORIGIN)).toBeUndefined();
      expect(resolveBearer(control, cookies([CHILD_COOKIE, alpha.childToken]))).toBeUndefined();
      expect(resolveBearer(control, cookies([PARENT_COOKIE, 'чужой']))).toBeUndefined();
    });

    it('недействительная детская cookie не отменяет родительскую сессию', () => {
      const alpha = family('alpha');

      const bearer = resolveBearer(
        control,
        cookies([CHILD_COOKIE, 'протухший'], [PARENT_COOKIE, alpha.parentToken]),
      );

      expect(bearer?.kind).toBe('parent');
    });
  });

  describe('источник изменяющего запроса', () => {
    it('спрашивает подтверждение только у изменяющих методов', () => {
      expect(isMutating('get')).toBe(false);
      expect(isMutating('HEAD')).toBe(false);
      expect(isMutating('OPTIONS')).toBe(false);
      expect(isMutating('POST')).toBe(true);
      expect(() => assertSameOrigin('GET', { host: HOST })).not.toThrow();
    });

    it('принимает совпавший Origin и Sec-Fetch-Site: same-origin', () => {
      expect(isSameOrigin({ host: HOST, origin: `https://${HOST}` })).toBe(true);
      expect(isSameOrigin({ host: HOST, 'sec-fetch-site': 'same-origin' })).toBe(true);
    });

    it('отклоняет чужой, непрозрачный и битый Origin даже при same-origin', () => {
      expect(
        isSameOrigin({ host: HOST, origin: 'https://зло.example', 'sec-fetch-site': 'same-origin' }),
      ).toBe(false);
      expect(isSameOrigin({ host: HOST, origin: 'null' })).toBe(false);
      expect(isSameOrigin({ host: HOST, origin: 'не адрес' })).toBe(false);
      expect(isSameOrigin({ origin: `https://${HOST}` })).toBe(false);
    });

    it('отклоняет тот же хост по голому http: схема — часть источника', () => {
      // `Host` схемы не содержит, поэтому страница, отданная по http под тем же
      // именем, иначе выглядела бы своей — а изменяющий запрос она шлёт по
      // https, и cookie с ним уезжают.
      expect(isSameOrigin({ host: HOST, origin: `http://${HOST}` })).toBe(false);
      expect(
        isSameOrigin({ host: HOST, origin: `http://${HOST}`, 'sec-fetch-site': 'same-origin' }),
      ).toBe(false);
      const error = catchAuth(() => {
        assertSameOrigin('POST', { host: HOST, origin: `http://${HOST}` });
      });
      expect(error.code).toBe('cross-origin');
    });

    it('принимает голый http на петле и по явному разрешению', () => {
      // Дев-сервер отдаёт страницу с `http://localhost:5173`, и браузер сам
      // считает петлю защищённым источником.
      expect(isSameOrigin({ host: 'localhost:3000', origin: 'http://localhost:5173' })).toBe(false);
      expect(isSameOrigin({ host: 'localhost:5173', origin: 'http://localhost:5173' })).toBe(true);
      expect(isSameOrigin({ host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' })).toBe(true);
      expect(isSameOrigin({ host: '[::1]:3000', origin: 'http://[::1]:3000' })).toBe(true);
      // Не петля — только явным выключателем, тем же, что снимает `Secure`.
      expect(isSameOrigin({ host: HOST, origin: `http://${HOST}` }, true)).toBe(true);
      expect(() => {
        assertSameOrigin('POST', { host: HOST, origin: `http://${HOST}` }, false, true);
      }).not.toThrow();
    });

    it('отклоняет чужую схему целиком, а не только http', () => {
      expect(isSameOrigin({ host: HOST, origin: `ftp://${HOST}` })).toBe(false);
      expect(isSameOrigin({ host: 'localhost:3000', origin: 'ftp://localhost:3000' })).toBe(false);
    });

    it('отклоняет изменяющий запрос без обоих заголовков', () => {
      expect(isSameOrigin({ host: HOST })).toBe(false);
      expect(isSameOrigin({ host: HOST, 'sec-fetch-site': 'cross-site' })).toBe(false);
      const error = catchAuth(() => {
        assertSameOrigin('POST', { host: HOST });
      });
      expect(error.code).toBe('cross-origin');
      expect(AUTH_STATUS[error.code]).toBe(403);
    });

    it('не трогает управляющую базу до проверки источника', () => {
      const alpha = family('alpha');
      // Обычный разбор отметку ставит — иначе её отсутствие ниже ничего не значило бы.
      resolveBearer(control, cookies([CHILD_COOKIE, alpha.childToken]));
      expect(lastActivity(alpha.childId)).not.toBeNull();
      control.prepare('UPDATE children SET last_activity_at = NULL WHERE id = ?').run(alpha.childId);
      const tenants = counting();

      const error = catchAuth(() =>
        resolveTenant({
          allow: ALLOW_ALL,
          control,
          tenants,
          method: 'POST',
          headers: { host: HOST, cookie: `${CHILD_COOKIE}=${alpha.childToken}` },
        }),
      );

      expect(error.code).toBe('cross-origin');
      // Разбор предъявителя подновляет отметку активности, то есть пишет:
      // чужая страница не должна уметь заставить нас это сделать.
      expect(lastActivity(alpha.childId)).toBeNull();
      expect(tenants.opened).toEqual([]);
    });
  });

  describe('принадлежность ребёнка', () => {
    it('отдаёт своего ребёнка родителю и самому ребёнку', () => {
      const alpha = family('alpha');
      const parent = bearerOf(cookies([PARENT_COOKIE, alpha.parentToken]));
      const child = bearerOf(cookies([CHILD_COOKIE, alpha.childToken]));

      expect(authorizeChild(control, parent, alpha.childId).id).toBe(alpha.childId);
      expect(authorizeChild(control, child).id).toBe(alpha.childId);
      expect(authorizeChild(control, child, alpha.childId).id).toBe(alpha.childId);
    });

    it('родительскому запросу без ребёнка в адресе отказывает', () => {
      const alpha = family('alpha');
      const parent = bearerOf(cookies([PARENT_COOKIE, alpha.parentToken]));

      expect(catchAuth(() => authorizeChild(control, parent)).code).toBe('no-child');
    });

    it('«не ваш ребёнок» и «нет такого ребёнка» отвечают одним кодом и текстом', () => {
      const alpha = family('alpha');
      const beta = family('beta');
      const parent = bearerOf(cookies([PARENT_COOKIE, alpha.parentToken]));

      const foreign = catchAuth(() => authorizeChild(control, parent, beta.childId));
      const missing = catchAuth(() => authorizeChild(control, parent, 'a'.repeat(32)));

      expect(foreign.code).toBe('no-child');
      expect(missing.code).toBe('no-child');
      expect(AUTH_STATUS[foreign.code]).toBe(404);
      expect(AUTH_MESSAGE[foreign.code]).toBe(AUTH_MESSAGE[missing.code]);
    });

    it('отказывает по недопустимому id, незаведённой базе и выведенному ребёнку', () => {
      const alpha = family('alpha');
      const parent = bearerOf(cookies([PARENT_COOKIE, alpha.parentToken]));
      const provisioning = createChild(control, alpha.parentId, 'младший');

      expect(catchAuth(() => authorizeChild(control, parent, '../control')).code).toBe('no-child');
      expect(catchAuth(() => authorizeChild(control, parent, 'ABC')).code).toBe('no-child');
      expect(catchAuth(() => authorizeChild(control, parent, provisioning)).code).toBe('no-child');

      retireChild(control, alpha.childId);
      expect(catchAuth(() => authorizeChild(control, parent, alpha.childId)).code).toBe('no-child');
    });
  });

  describe('полный путь допуска', () => {
    it('открывает базу своего ребёнка и родителю, и самому ребёнку', () => {
      const alpha = family('alpha');
      const tenants = counting();

      const byChild = resolveTenant({
        control,
        tenants,
        method: 'POST',
        headers: cookies([CHILD_COOKIE, alpha.childToken]),
        allow: ALLOW_ALL,
      });
      const byParent = resolveTenant({
        control,
        tenants,
        method: 'GET',
        headers: cookies([PARENT_COOKIE, alpha.parentToken]),
        childId: alpha.childId,
        allow: ALLOW_ALL,
      });

      expect(byChild.bearer.kind).toBe('browser');
      expect(byParent.bearer.kind).toBe('parent');
      expect(byChild.tenant).not.toBe(byParent.tenant);
      expect(byChild.tenant.db).toBe(byParent.tenant.db);
      expect(tenants.opened).toEqual([alpha.childId, alpha.childId]);
    });

    // Вид предъявителя доезжает до реестра ради будильника прогрева: «ребёнок
    // вернулся» — это только `browser`, а опрос агента раз в двадцать секунд
    // активностью не считается (см. `resolveChildDevice`).
    it('называет реестру вид предъявителя, а не только ребёнка', () => {
      const alpha = family('alpha');
      const tenants = counting();
      const agent = deviceToken(alpha.childId, 'agent');

      resolveTenant({
        control,
        tenants,
        method: 'GET',
        headers: cookies([CHILD_COOKIE, alpha.childToken]),
        allow: ALLOW_ALL,
      });
      resolveTenant({
        control,
        tenants,
        method: 'GET',
        headers: { ...SAME_ORIGIN, [AGENT_HEADER]: `Bearer ${agent}` },
        allow: ALLOW_ALL,
      });
      resolveTenant({
        control,
        tenants,
        method: 'GET',
        headers: cookies([PARENT_COOKIE, alpha.parentToken]),
        childId: alpha.childId,
        allow: ALLOW_ALL,
      });

      expect(tenants.kinds).toEqual(['browser', 'agent', 'parent']);
    });

    it('родитель A → ребёнок B и ребёнок A → ребёнок B отказываются, база не открывается', () => {
      const alpha = family('alpha');
      const beta = family('beta');
      const tenants = counting();

      const byParent = catchAuth(() =>
        resolveTenant({
          allow: ALLOW_ALL,
          control,
          tenants,
          method: 'GET',
          headers: cookies([PARENT_COOKIE, alpha.parentToken]),
          childId: beta.childId,
        }),
      );
      const byChild = catchAuth(() =>
        resolveTenant({
          allow: ALLOW_ALL,
          control,
          tenants,
          method: 'GET',
          headers: cookies([CHILD_COOKIE, alpha.childToken]),
          childId: beta.childId,
        }),
      );

      expect(byParent.code).toBe('no-child');
      expect(byChild.code).toBe('no-child');
      expect(tenants.opened).toEqual([]);
    });

    it('без предъявителя отвечает 401 и базу не открывает', () => {
      family('alpha');
      const tenants = counting();

      const error = catchAuth(() =>
        resolveTenant({ control, tenants, method: 'GET', headers: SAME_ORIGIN, allow: ALLOW_ALL }),
      );

      expect(error.code).toBe('unauthenticated');
      expect(AUTH_STATUS[error.code]).toBe(401);
      expect(tenants.opened).toEqual([]);
    });

    it('агент не проходит на обычные детские маршруты, но проходит там, где назван', () => {
      const alpha = family('alpha');
      const agent = deviceToken(alpha.childId, 'agent');
      const headers: RequestHeaders = { ...SAME_ORIGIN, [AGENT_HEADER]: `Bearer ${agent}` };
      const tenants = counting();

      const closed = catchAuth(() =>
        resolveTenant({ control, tenants, method: 'GET', headers, allow: ['parent', 'browser'] }),
      );
      const open = resolveTenant({
        control,
        tenants,
        method: 'GET',
        headers,
        allow: ['agent'],
      });

      expect(closed.code).toBe('forbidden');
      expect(AUTH_STATUS[closed.code]).toBe(403);
      expect(open.bearer.kind).toBe('agent');
      expect(open.tenant.childId).toBe(alpha.childId);
      // Отказ агенту случился до открытия базы: открытие ровно одно.
      expect(tenants.opened).toEqual([alpha.childId]);
    });

    it('переводит отказ реестра в отказ допуска, пряча гонку с выводом ребёнка', () => {
      const alpha = family('alpha');
      const headers = cookies([CHILD_COOKIE, alpha.childToken]);
      const failing = (code: 'not-serviceable' | 'too-many-open' | 'unavailable'): TenantOpener => ({
        open(childId: string): Tenant {
          throw new TenantError(code, `отказ ${childId}`);
        },
      });

      const raced = catchAuth(() =>
        resolveTenant({ control, tenants: failing('not-serviceable'), method: 'GET', headers, allow: ALLOW_ALL }),
      );
      const busy = catchAuth(() =>
        resolveTenant({ control, tenants: failing('too-many-open'), method: 'GET', headers, allow: ALLOW_ALL }),
      );
      const broken = catchAuth(() =>
        resolveTenant({ control, tenants: failing('unavailable'), method: 'GET', headers, allow: ALLOW_ALL }),
      );

      expect(raced.code).toBe('no-child');
      expect(AUTH_STATUS[busy.code]).toBe(503);
      expect(busy.code).toBe('too-many-open');
      expect(broken.code).toBe('unavailable');
    });

    it('не подменяет собой поломку кода', () => {
      const alpha = family('alpha');
      const tenants: TenantOpener = {
        open(): Tenant {
          throw new Error('соединение не открылось');
        },
      };

      expect(() =>
        resolveTenant({
          allow: ALLOW_ALL,
          control,
          tenants,
          method: 'GET',
          headers: cookies([CHILD_COOKIE, alpha.childToken]),
        }),
      ).toThrow('соединение не открылось');
    });
  });

  /** Пароль оператора длиннее родительского: `MIN_ADMIN_PASSWORD_LENGTH` — 16. */
  const ADMIN_PASSWORD = 'пароль-оператора-подлиннее';

  /**
   * Заводит оператора с паролем и возвращает его `id` и токен свежей сессии.
   *
   * Часы передаются насквозь и по умолчанию настоящие. Смешивать их с
   * зафиксированным `NOW` нельзя: `credentials_changed_at` гасит всё, что
   * заведено раньше него, — и оператор, чей пароль поставлен «сейчас», отменял
   * бы заход, начатый в `NOW`, ровно с того момента настоящих суток, когда
   * настоящее время обгонит `NOW`.
   */
  function operator(
    email = 'оператор@example.com',
    now: Date = new Date(),
  ): { adminId: string; token: string } {
    const adminId = createAdmin(control, email, now);
    setAdminPassword(control, adminId, ADMIN_PASSWORD, now);
    const login = loginAdmin(control, email, ADMIN_PASSWORD, now);
    if (!login.ok) throw new Error(`оператор ${email} не вошёл: ${login.reason}`);
    return { adminId, token: login.session.token };
  }

  describe('предъявитель админки', () => {
    /** Допуск админского маршрута. Ровно `ROUTE_ACCESS.admin`, выписанный руками. */
    const ALLOW_ADMIN: readonly BearerKind[] = ['admin'];

    it('разбирает cookie оператора в предъявителя', () => {
      const { adminId, token } = operator();
      // Имя cookie вписано руками: это межмодульный инвариант с клиентом.
      expect(ADMIN_COOKIE).toBe('__Host-edu_admin');

      const bearer = resolveAdminBearer(control, cookies([ADMIN_COOKIE, token]));

      expect(bearer).toEqual({ kind: 'admin', admin: { adminId, email: 'оператор@example.com' } });
    });

    it('не считает оператором ни родительскую, ни детскую cookie', () => {
      const alpha = family('alpha');
      operator();

      expect(resolveAdminBearer(control, cookies([PARENT_COOKIE, alpha.parentToken]))).toBeUndefined();
      expect(resolveAdminBearer(control, cookies([CHILD_COOKIE, alpha.childToken]))).toBeUndefined();
      expect(
        catchAuth(() =>
          resolveAdmin({
            control,
            method: 'GET',
            headers: cookies([PARENT_COOKIE, alpha.parentToken]),
            allow: ALLOW_ADMIN,
          }),
        ).code,
      ).toBe('unauthenticated');
    });

    // Обратная сторона того же: админская cookie не должна давать доступа к
    // детским и родительским маршрутам — их допуск разбирает `resolveBearer`.
    it('не превращает cookie оператора в детского или родительского предъявителя', () => {
      const { token } = operator();

      expect(resolveBearer(control, cookies([ADMIN_COOKIE, token]))).toBeUndefined();
    });

    it('не пускает без cookie вовсе', () => {
      const error = catchAuth(() =>
        resolveAdmin({ control, method: 'GET', headers: SAME_ORIGIN, allow: ALLOW_ADMIN }),
      );

      expect(error.code).toBe('unauthenticated');
      expect(AUTH_STATUS[error.code]).toBe(401);
    });

    it('не пускает отключённого оператора: сессию гасит тот же признак', () => {
      const { adminId, token } = operator();
      disableAdmin(control, adminId);

      expect(
        catchAuth(() =>
          resolveAdmin({
            control,
            method: 'GET',
            headers: cookies([ADMIN_COOKIE, token]),
            allow: ALLOW_ADMIN,
          }),
        ).code,
      ).toBe('unauthenticated');
    });

    it('не пускает оператора туда, где его нет в строке матрицы', () => {
      const { token } = operator();

      const error = catchAuth(() =>
        resolveAdmin({
          control,
          method: 'GET',
          headers: cookies([ADMIN_COOKIE, token]),
          allow: ALLOW_ALL,
        }),
      );

      expect(error.code).toBe('forbidden');
    });

    // Проверка источника идёт до разбора сессии: разбор подновляет
    // `last_seen_at`, то есть пишет, и чужая страница не должна уметь заставить
    // нас это сделать.
    it('отказывает изменяющему запросу без подтверждённого источника, не тронув сессию', () => {
      const { token } = operator();
      const before = lastSeen(token);
      expect(before).toBeDefined();

      const error = catchAuth(() =>
        resolveAdmin({
          control,
          method: 'POST',
          headers: { host: HOST, origin: 'https://чужой.example', cookie: `${ADMIN_COOKIE}=${token}` },
          allow: ALLOW_ADMIN,
        }),
      );

      expect(error.code).toBe('cross-origin');
      expect(lastSeen(token)).toBe(before);
    });

    it('пропускает изменяющий запрос со своей же страницы', () => {
      const { adminId, token } = operator();

      const bearer = resolveAdmin({
        control,
        method: 'POST',
        headers: cookies([ADMIN_COOKIE, token]),
        allow: ALLOW_ADMIN,
      });

      expect(bearer.admin.adminId).toBe(adminId);
    });
  });

  describe('предъявитель имперсонации и первый замок', () => {
    /** Заводит оператору живой заход в чужую семью и отдаёт токен его cookie. */
    function enter(
      adminId: string,
      childId: string,
      role: 'browser' | 'parent',
      now: Date = NOW,
    ): string {
      const started = startImpersonation(control, { adminId, childId, role }, now);
      if (!started.ok) throw new Error(`заход не начался: ${started.reason}`);
      return started.session.token;
    }

    it('отдаёт детского предъявителя целевой семьи, а не новый вид', () => {
      const alpha = family('alpha');
      const { adminId } = operator('оператор@example.com', NOW);
      // Имя cookie вписано руками: это межмодульный инвариант с клиентом.
      expect(IMPERSONATION_COOKIE).toBe('__Host-edu_impersonation');
      const token = enter(adminId, alpha.childId, 'browser');

      const bearer = bearerOf(cookies([IMPERSONATION_COOKIE, token]), NOW);

      expect(bearer.kind).toBe('browser');
      // Отметка несёт всё, что рисует несъёмная полоса: адрес оператора, имя
      // ребёнка и роль. Без них баннер называл бы семью непрозрачным `id`.
      expect(bearer.impersonation).toEqual({
        adminId,
        adminEmail: 'оператор@example.com',
        childName: 'alpha',
        role: 'browser',
        expiresAt: new Date(NOW.getTime() + IMPERSONATION_TTL_MS).toISOString(),
      });
      if (bearer.kind !== 'browser') throw new Error('ожидался детский предъявитель');
      expect(bearer.child.childId).toBe(alpha.childId);
      expect(bearer.child.parentId).toBe(alpha.parentId);
      expect(bearer.child.name).toBe('alpha');
      // Устройства у захода нет: оператор смотрит из админки, а не с детской машины.
      expect(bearer.child.deviceId).toBeUndefined();
    });

    it('отдаёт родительского предъявителя целевой семьи в роли `parent`', () => {
      const alpha = family('alpha');
      const { adminId } = operator('оператор@example.com', NOW);
      const token = enter(adminId, alpha.childId, 'parent');

      const bearer = bearerOf(cookies([IMPERSONATION_COOKIE, token]), NOW);

      expect(bearer.kind).toBe('parent');
      if (bearer.kind !== 'parent') throw new Error('ожидался родительский предъявитель');
      expect(bearer.parent).toEqual({ parentId: alpha.parentId, email: 'alpha@example.com' });
      expect(bearer.impersonation?.adminId).toBe(adminId);
    });

    // Оператор заходит в чужую семью со своей же машины, где живы и его
    // собственные входы. Проиграв им, заход показывал бы ему собственные данные
    // под баннером чужой семьи.
    it('выигрывает у собственных cookie оператора', () => {
      const alpha = family('alpha');
      const beta = family('beta');
      const { adminId } = operator('оператор@example.com', NOW);
      const token = enter(adminId, alpha.childId, 'browser');

      const bearer = bearerOf(
        cookies(
          [IMPERSONATION_COOKIE, token],
          [PARENT_COOKIE, beta.parentToken],
          [CHILD_COOKIE, beta.childToken],
          [ACTOR_COOKIE, 'parent'],
        ),
        NOW,
      );

      if (bearer.kind !== 'browser') throw new Error('ожидался детский предъявитель');
      expect(bearer.child.childId).toBe(alpha.childId);
    });

    it('не пускает истёкший заход: остаются собственные cookie оператора', () => {
      const alpha = family('alpha');
      const beta = family('beta');
      const { adminId } = operator('оператор@example.com', NOW);
      const token = enter(adminId, alpha.childId, 'browser');
      const late = new Date(NOW.getTime() + IMPERSONATION_TTL_MS);

      const alone = resolveBearer(control, cookies([IMPERSONATION_COOKIE, token]), late);
      const withOwn = resolveBearer(
        control,
        cookies([IMPERSONATION_COOKIE, token], [PARENT_COOKIE, beta.parentToken]),
        late,
      );

      expect(alone).toBeUndefined();
      expect(withOwn?.kind).toBe('parent');
      expect(withOwn?.impersonation).toBeUndefined();
    });

    it('не пускает закрытый заход', () => {
      const alpha = family('alpha');
      const { adminId } = operator('оператор@example.com', NOW);
      const token = enter(adminId, alpha.childId, 'browser');
      expect(revokeImpersonation(control, token, NOW)).toBe(true);

      expect(resolveBearer(control, cookies([IMPERSONATION_COOKIE, token]), NOW)).toBeUndefined();
    });

    it('пропускает чтение чужой семьи и открывает её базу', () => {
      const alpha = family('alpha');
      const { adminId } = operator('оператор@example.com', NOW);
      const token = enter(adminId, alpha.childId, 'browser');
      const tenants = counting();

      const resolved = resolveTenant({
        allow: ALLOW_ALL,
        control,
        tenants,
        method: 'GET',
        headers: cookies([IMPERSONATION_COOKIE, token]),
        now: NOW,
      });

      expect(resolved.child.id).toBe(alpha.childId);
      expect(resolved.bearer.impersonation?.adminId).toBe(adminId);
      expect(tenants.opened).toEqual([alpha.childId]);
      // Признак доезжает до реестра отдельным полем: вид у захода `browser`, и
      // по одному ему реестр отдал бы пишущее соединение и разбудил бы прогрев.
      expect(tenants.kinds).toEqual(['browser']);
      expect(tenants.impersonated).toEqual([true]);
    });

    // Заход оператора — не «ребёнок вернулся за экран». Отметка активности
    // ставит его в очередь прогрева и держит там, пока он «за экраном»: обход
    // диспетчера начинался бы с семьи, в которую оператор просто заглянул.
    it('не двигает ни отметку активности ребёнка, ни сессию целевого родителя', () => {
      const alpha = family('alpha');
      const { adminId } = operator('оператор@example.com', NOW);
      const asChild = enter(adminId, alpha.childId, 'browser');
      // Второй заход того же оператора погасил бы первый — берём его отдельным.
      const asParent = enter(operator('второй@example.com', NOW).adminId, alpha.childId, 'parent');
      const activityBefore = activityOf(alpha.childId);
      const seenBefore = parentSeenOf(alpha.parentId);
      const later = new Date(NOW.getTime() + 60_000);

      for (const token of [asChild, asParent]) {
        resolveTenant({
          allow: ALLOW_ALL,
          control,
          tenants: counting(),
          method: 'GET',
          // Родительский заход называет ребёнка в адресе, как и обычный
          // родитель: ребёнка у такого предъявителя своего нет.
          childId: alpha.childId,
          headers: cookies([IMPERSONATION_COOKIE, token]),
          now: later,
        });
      }

      expect(activityOf(alpha.childId)).toBe(activityBefore);
      expect(parentSeenOf(alpha.parentId)).toBe(seenBefore);
    });

    // Тот же запрос от самого ребёнка отметку двигает: иначе проверка выше
    // проходила бы и на предъявителе, который её вовсе не умеет ставить.
    it('отметку активности по-прежнему двигает сам ребёнок', () => {
      const alpha = family('alpha');
      const before = activityOf(alpha.childId);

      resolveTenant({
        allow: ALLOW_ALL,
        control,
        tenants: counting(),
        method: 'GET',
        headers: cookies([CHILD_COOKIE, alpha.childToken]),
        now: new Date(NOW.getTime() + 60_000),
      });

      expect(activityOf(alpha.childId)).not.toBe(before);
    });

    it('отказывает изменяющему запросу и не открывает базу', () => {
      const alpha = family('alpha');
      const { adminId } = operator('оператор@example.com', NOW);
      const token = enter(adminId, alpha.childId, 'browser');
      const tenants = counting();

      const error = catchAuth(() =>
        resolveTenant({
          allow: ALLOW_ALL,
          control,
          tenants,
          method: 'POST',
          headers: cookies([IMPERSONATION_COOKIE, token]),
          now: NOW,
        }),
      );

      expect(error.code).toBe('read-only');
      expect(AUTH_STATUS[error.code]).toBe(403);
      expect(AUTH_MESSAGE[error.code]).toBe('Только просмотр: вы в чужой семье');
      expect(tenants.opened).toEqual([]);
    });

    // `GET /api/session/next` списывает задание из банка безвозвратно и потому
    // помечен `mutating`. Решает не метод, а то, что маршрут делает: заход
    // оператора не имеет права жечь чужой банк.
    it('отказывает помеченному `mutating` безопасному по методу запросу', () => {
      const alpha = family('alpha');
      const { adminId } = operator('оператор@example.com', NOW);
      const token = enter(adminId, alpha.childId, 'browser');
      const tenants = counting();

      const error = catchAuth(() =>
        resolveTenant({
          allow: ALLOW_ALL,
          control,
          tenants,
          method: 'GET',
          mutating: true,
          headers: cookies([IMPERSONATION_COOKIE, token]),
          now: NOW,
        }),
      );

      expect(error.code).toBe('read-only');
      expect(tenants.opened).toEqual([]);
    });

    // Счётчик отказов живёт снаружи запроса: `resolveTenant` между запросами
    // не помнит ничего, а запись `impersonation-end` обязана назвать число.
    it('сообщает об отказе тому, кто считает отказы', () => {
      const alpha = family('alpha');
      const { adminId } = operator('оператор@example.com', NOW);
      const token = enter(adminId, alpha.childId, 'browser');
      const refused: string[] = [];

      catchAuth(() =>
        resolveTenant({
          allow: ALLOW_ALL,
          control,
          tenants: counting(),
          method: 'POST',
          headers: cookies([IMPERSONATION_COOKIE, token]),
          onReadOnly: (impersonation) => refused.push(impersonation.adminId),
          now: NOW,
        }),
      );
      expect(refused).toEqual([adminId]);

      // Чтение отказом не считается: иначе счётчик показывал бы усердие
      // оператора, а не его попытки писать.
      resolveTenant({
        allow: ALLOW_ALL,
        control,
        tenants: counting(),
        method: 'GET',
        headers: cookies([IMPERSONATION_COOKIE, token]),
        onReadOnly: (impersonation) => refused.push(impersonation.adminId),
        now: NOW,
      });
      expect(refused).toEqual([adminId]);
    });

    // Тот же запрос без захода проходит: иначе отказ выше ничего не доказывал бы.
    it('своего же ребёнка изменяющий запрос по-прежнему меняет', () => {
      const alpha = family('alpha');
      const tenants = counting();

      const resolved = resolveTenant({
        allow: ALLOW_ALL,
        control,
        tenants,
        method: 'POST',
        headers: cookies([CHILD_COOKIE, alpha.childToken]),
        now: NOW,
      });

      expect(resolved.bearer.impersonation).toBeUndefined();
      expect(tenants.opened).toEqual([alpha.childId]);
      expect(tenants.impersonated).toEqual([false]);
    });

    it('не пускает заход к выведенному ребёнку и в семью отключённого родителя', () => {
      const alpha = family('alpha');
      const beta = family('beta');
      const { adminId } = operator('оператор@example.com', NOW);
      const toAlpha = enter(adminId, alpha.childId, 'parent');
      // Второй заход того же оператора гасит первый — берём его отдельным.
      const other = operator('второй@example.com', NOW);
      const toBeta = enter(other.adminId, beta.childId, 'browser');

      disableParent(control, alpha.parentId);
      retireChild(control, beta.childId);

      expect(resolveBearer(control, cookies([IMPERSONATION_COOKIE, toAlpha]), NOW)).toBeUndefined();
      expect(resolveBearer(control, cookies([IMPERSONATION_COOKIE, toBeta]), NOW)).toBeUndefined();
    });
  });

  function bearerOf(headers: RequestHeaders, now: Date = new Date()): Bearer {
    const bearer = resolveBearer(control, headers, now);
    if (bearer === undefined) throw new Error('предъявитель не разобран');
    return bearer;
  }

  /** Отметка подновления сессии оператора: по ней видно, читали ли её вовсе. */
  function lastSeen(token: string): string | undefined {
    return control
      .prepare<[string], { last_seen_at: string }>(
        'SELECT last_seen_at FROM admin_sessions WHERE token_hash = ?',
      )
      .get(hashToken(token))?.last_seen_at;
  }

  function lastActivity(childId: string): string | null {
    const row = control
      .prepare<[string], { last_activity_at: string | null }>(
        'SELECT last_activity_at FROM children WHERE id = ?',
      )
      .get(childId);
    return row?.last_activity_at ?? null;
  }
});

/** Ловит именно отказ допуска: любая другая ошибка — поломка, а не отказ. */
function catchAuth(run: () => unknown): AuthError {
  try {
    run();
  } catch (error) {
    if (error instanceof AuthError) return error;
    throw error;
  }
  throw new Error('ожидался отказ допуска, но его не было');
}
