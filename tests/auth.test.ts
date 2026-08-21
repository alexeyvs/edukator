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
  hashToken,
  issueDeviceInvite,
  issueParentInvite,
  loginAdmin,
  redeemDeviceInvite,
  redeemParentInvite,
  retireChild,
  revokeDevice,
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

  function cookies(...pairs: [string, string][]): RequestHeaders {
    return { ...SAME_ORIGIN, cookie: pairs.map(([name, value]) => `${name}=${value}`).join('; ') };
  }

  /** Реестр, считающий открытия: изоляция обязана отказывать **до** открытия базы. */
  function counting(): TenantOpener & { opened: string[]; kinds: BearerKind[] } {
    const tenants = new TenantRegistry({ control, dataDir: tempDir, graph: GRAPH, log: () => {} });
    const opened: string[] = [];
    const kinds: BearerKind[] = [];
    return {
      opened,
      kinds,
      open(childId: string, bearer: BearerKind): Tenant {
        opened.push(childId);
        kinds.push(bearer);
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
      expect(byChild.tenant).toBe(byParent.tenant);
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

  describe('предъявитель админки', () => {
    /** Пароль оператора длиннее родительского: `MIN_ADMIN_PASSWORD_LENGTH` — 16. */
    const ADMIN_PASSWORD = 'пароль-оператора-подлиннее';
    /** Допуск админского маршрута. Ровно `ROUTE_ACCESS.admin`, выписанный руками. */
    const ALLOW_ADMIN: readonly BearerKind[] = ['admin'];

    /** Заводит оператора с паролем и возвращает его `id` и токен свежей сессии. */
    function operator(email = 'оператор@example.com'): { adminId: string; token: string } {
      const adminId = createAdmin(control, email);
      setAdminPassword(control, adminId, ADMIN_PASSWORD);
      const login = loginAdmin(control, email, ADMIN_PASSWORD);
      if (!login.ok) throw new Error(`оператор ${email} не вошёл: ${login.reason}`);
      return { adminId, token: login.session.token };
    }

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

  function bearerOf(headers: RequestHeaders): Bearer {
    const bearer = resolveBearer(control, headers);
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
