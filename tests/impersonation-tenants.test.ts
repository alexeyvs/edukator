import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { buildTopicGraph, type Topic, type TopicGraph } from '../server/curriculum.js';
import {
  createChild,
  createParent,
  IMPERSONATION_TTL_MS,
  openControlDatabase,
} from '../server/control-db.js';
import { controlDatabasePath, ensureDataDir, provisionChildDatabase } from '../server/data-dir.js';
import {
  openSessionDatabase,
  TenantError,
  TenantRegistry,
  type SessionDatabase,
  type Tenant,
} from '../server/tenant-registry.js';
import { ImpersonationTenants } from '../server/admin/impersonation-tenants.js';
import { createTenantOpener } from '../server/tenant-opener.js';

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

/** Опорный момент: срок соединения отмеряется от него, а не от «сейчас». */
const NOW = new Date('2026-08-21T10:00:00.000Z');

describe('соединение имперсонации только для чтения', () => {
  let tempDir: string;
  let control: Database;
  let registry: TenantRegistry;
  let handles: ImpersonationTenants[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-impersonation-'));
    ensureDataDir(tempDir);
    control = openControlDatabase(controlDatabasePath(tempDir));
    registry = new TenantRegistry({ control, dataDir: tempDir, graph: GRAPH, log: () => {} });
    handles = [];
  });

  afterEach(async () => {
    for (const opened of handles) opened.closeAll();
    await registry.closeAll();
    control.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Заводит ребёнка с готовой базой и открывает его аренду обычным путём. */
  function tenantOf(name: string): Tenant {
    const parentId = createParent(control, `${name}@example.com`);
    const childId = createChild(control, parentId, name);
    provisionChildDatabase(control, childId, tempDir);
    return registry.open(childId);
  }

  /** Соединения имперсонации, которые тест закроет за собой сам. */
  function tracked(
    options: Partial<ConstructorParameters<typeof ImpersonationTenants>[0]> = {},
  ): ImpersonationTenants {
    const opened = new ImpersonationTenants({ graph: GRAPH, log: () => {}, ...options });
    handles.push(opened);
    return opened;
  }

  it('отдаёт ту же аренду, но другим соединением', () => {
    const tenant = tenantOf('alpha');
    const impersonations = tracked();

    const view = impersonations.view(tenant);

    expect(view.childId).toBe(tenant.childId);
    expect(view.path).toBe(tenant.path);
    expect(view.file).toBe(tenant.file);
    // Координаторы аренды — **не** те же: они носят пишущее соединение
    // реестра, и `query_only` до них не достаёт.
    expect(view.disputes).not.toBe(tenant.disputes);
    expect(view.integrity).not.toBe(tenant.integrity);
    expect(view.db).not.toBe(tenant.db);
    expect(view.db.pragma('query_only', { simple: true })).toBe(1);
  });

  // Ровно один замок и ничего больше: настройка соединения обязана совпасть с
  // той, что получает настоящий вход, иначе оператор смотрит не на то, что
  // видит семья.
  it('повторяет настройку обычного соединения: WAL и внешние ключи', () => {
    const tenant = tenantOf('alpha');
    const view = tracked().view(tenant);

    expect(view.db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(view.db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(view.db.pragma('user_version', { simple: true }))
      .toBe(tenant.db.pragma('user_version', { simple: true }));
  });

  // **Второй замок отдельно.** Первого (отказа `read-only` в `resolveTenant`)
  // здесь нет вовсе: запись идёт прямо по соединению, мимо всякого допуска.
  // Тест, зелёный после снятия `query_only`, не держит ничего.
  it('отказывает прямой записи на движке, без всякого допуска', () => {
    const tenant = tenantOf('alpha');
    const view = tracked().view(tenant);

    expect(() => view.db.prepare('UPDATE topic_state SET mastery = 0.9').run())
      .toThrow(/readonly|query_only/i);
    expect(() => view.db.prepare(
      `INSERT INTO runs (kind, started_at) VALUES ('run', '2026-08-21T10:00:00.000Z')`,
    ).run()).toThrow(/readonly|query_only/i);
    // Чтение при этом проходит: заперта запись, а не база.
    expect(view.db.prepare(`SELECT mastery FROM topic_state WHERE topic_id = 'math.a'`).get())
      .toEqual({ mastery: 0 });
  });

  // **Третья половина второго замка.** `query_only` стоит на соединении, а
  // координаторы аренды носят своё, пишущее: оставленные как есть, они дают
  // обычному `GET` записать в чужую базу мимо обоих замков. Проверять это надо
  // отдельно от прагмы — тест, зелёный после возврата координаторов реестра,
  // не держит ничего.
  it('отказывает координаторам аренды писать под заходом', () => {
    const tenant = tenantOf('alpha');
    const view = tracked().view(tenant);

    // `status` у настоящего координатора не безобиден: незакрытую проверку он
    // тут же ставит на разбор, а тот пишет и тратит слот codex.
    expect(view.integrity.status(999)).toBeNull();
    expect(() => view.integrity.begin(1)).toThrow(/чужую семью/u);
    expect(() => view.integrity.retry(1, 1, 'ответ', 0, false)).toThrow(/чужую семью/u);
    expect(() => view.integrity.approve(1, 1)).toThrow(/чужую семью/u);
    expect(() => view.disputes.schedule(1)).toThrow(/чужую семью/u);
    expect(() => view.disputes.restore()).toThrow(/чужую семью/u);
  });

  // `query_only` — свойство соединения. Включённый на общем handle реестра он
  // запер бы запись самому ребёнку, который в это время занимается.
  it('не запирает соединение самого ребёнка', () => {
    const tenant = tenantOf('alpha');
    tracked().view(tenant);

    tenant.db.prepare(`UPDATE topic_state SET mastery = 0.5 WHERE topic_id = 'math.a'`).run();

    expect(tenant.db.pragma('query_only', { simple: true })).toBe(0);
    expect(tenant.db.prepare(`SELECT mastery FROM topic_state WHERE topic_id = 'math.a'`).get())
      .toEqual({ mastery: 0.5 });
  });

  it('держит одно соединение на ребёнка, а не по одному на запрос', () => {
    const tenant = tenantOf('alpha');
    const impersonations = tracked();

    const first = impersonations.view(tenant);
    const second = impersonations.view(tenant);

    expect(second.db).toBe(first.db);
    expect(impersonations.size).toBe(1);
  });

  it('закрывает соединение на выходе из захода', () => {
    const tenant = tenantOf('alpha');
    const impersonations = tracked();
    const view = impersonations.view(tenant);

    impersonations.close(tenant.childId);

    expect(view.db.open).toBe(false);
    expect(impersonations.size).toBe(0);
    // Выход из захода — не отказ ребёнку: его собственное соединение живо.
    expect(tenant.db.open).toBe(true);
    // Повторный выход — не ошибка: cookie можно снять дважды.
    expect(() => impersonations.close(tenant.childId)).not.toThrow();
  });

  it('закрывает все соединения при закрытии сервера', () => {
    const alpha = tenantOf('alpha');
    const beta = tenantOf('beta');
    const impersonations = tracked();
    const first = impersonations.view(alpha);
    const second = impersonations.view(beta);

    impersonations.closeAll();

    expect(first.db.open).toBe(false);
    expect(second.db.open).toBe(false);
    expect(impersonations.size).toBe(0);
  });

  // Истёкший заход до `view` не доезжает: его отвергает разбор предъявителя.
  // Значит снять просроченное соединение может только подметание — иначе оно
  // держало бы дескриптор чужой базы до самой остановки сервера.
  it('снимает соединение, не тронутое дольше срока захода', () => {
    const alpha = tenantOf('alpha');
    const beta = tenantOf('beta');
    let now = NOW;
    const impersonations = tracked({ now: () => now });
    const stale = impersonations.view(alpha);

    now = new Date(NOW.getTime() + IMPERSONATION_TTL_MS);
    impersonations.view(beta);

    expect(stale.db.open).toBe(false);
    expect(impersonations.size).toBe(1);
  });

  it('не снимает соединение, которое трогали внутри срока', () => {
    const alpha = tenantOf('alpha');
    let now = NOW;
    const impersonations = tracked({ now: () => now });
    const view = impersonations.view(alpha);

    now = new Date(NOW.getTime() + IMPERSONATION_TTL_MS - 1);
    expect(impersonations.view(alpha).db).toBe(view.db);
    now = new Date(NOW.getTime() + IMPERSONATION_TTL_MS + 1);
    expect(impersonations.view(alpha).db).toBe(view.db);
    expect(view.db.open).toBe(true);
  });

  // Реестр заводит новый объект аренды на каждое открытие базы. Прежний handle
  // привязан к соединению закрытой аренды, и переиспользовать его — значит
  // читать базу, которой на этом пути может уже не быть.
  it('переоткрывает соединение, когда аренду закрывали и открывали заново', async () => {
    const tenant = tenantOf('alpha');
    const impersonations = tracked();
    const first = impersonations.view(tenant);

    await registry.close(tenant.childId);
    const reopened = registry.open(tenant.childId);
    const second = impersonations.view(reopened);

    expect(second.db).not.toBe(first.db);
    expect(first.db.open).toBe(false);
    expect(impersonations.size).toBe(1);
  });

  it('переводит неоткрывшееся соединение в `unavailable`', () => {
    const tenant = tenantOf('alpha');
    const impersonations = tracked({ openSession: () => undefined });

    const error = catchTenant(() => impersonations.view(tenant));

    expect(error.code).toBe('unavailable');
    expect(impersonations.size).toBe(0);
  });

  // Второй handle открывается позже первого, и подмена файла между открытиями
  // дала бы оператору чужой файл под именем этого ребёнка.
  it('отказывает, если файл базы сменился между открытиями', () => {
    const tenant = tenantOf('alpha');
    let opened: Database | undefined;
    const impersonations = tracked({
      openSession: (path: string): SessionDatabase => {
        const session = openSessionForTest(path);
        opened = session.db;
        return { db: session.db, file: 'подменённый:отпечаток' };
      },
    });

    const error = catchTenant(() => impersonations.view(tenant));

    expect(error.code).toBe('unavailable');
    expect(opened?.open).toBe(false);
    expect(impersonations.size).toBe(0);
  });

  // Установка прагмы ничего не возвращает, и молча не включившийся `query_only`
  // оставил бы оператора с обычным пишущим соединением — то есть снял бы второй
  // замок, не сказав об этом ни слова.
  it('отказывает и закрывает соединение, если `query_only` не включился', () => {
    const tenant = tenantOf('alpha');
    let closed = false;
    const deaf = {
      pragma: (statement: string): unknown => (statement === 'query_only' ? 0 : undefined),
      close: (): void => {
        closed = true;
      },
    } as unknown as Database;
    const impersonations = tracked({
      openSession: (): SessionDatabase => ({ db: deaf, file: tenant.file }),
    });

    expect(() => impersonations.view(tenant)).toThrow(/query_only/);
    expect(closed).toBe(true);
    expect(impersonations.size).toBe(0);
  });

  it('не собирается со сроком, который снимает соединение раньше запроса', () => {
    expect(() => new ImpersonationTenants({ graph: GRAPH, ttlMs: 0 })).toThrow(/положительным/);
    expect(() => new ImpersonationTenants({ graph: GRAPH, ttlMs: -1 })).toThrow(/положительным/);
    expect(() => new ImpersonationTenants({ graph: GRAPH, ttlMs: Number.NaN }))
      .toThrow(/положительным/);
  });

  describe('выбор соединения по предъявителю', () => {
    it('отдаёт заходу оператора соединение только для чтения и не будит прогрев', () => {
      const tenant = tenantOf('alpha');
      const impersonations = tracked();
      const woken: string[] = [];
      const opener = createTenantOpener({
        tenants: registry,
        impersonations,
        wake: (childId) => woken.push(childId),
      });

      const view = opener.open(tenant.childId, { kind: 'browser', impersonated: true });

      expect(view.db).not.toBe(tenant.db);
      expect(view.db.pragma('query_only', { simple: true })).toBe(1);
      expect(woken).toEqual([]);
    });

    it('отдаёт ученику за экраном обычное соединение и будит прогрев', () => {
      const tenant = tenantOf('alpha');
      const impersonations = tracked();
      const woken: string[] = [];
      const opener = createTenantOpener({
        tenants: registry,
        impersonations,
        wake: (childId) => woken.push(childId),
      });

      const opened = opener.open(tenant.childId, { kind: 'browser', impersonated: false });

      expect(opened.db).toBe(tenant.db);
      expect(opened.db.pragma('query_only', { simple: true })).toBe(0);
      expect(woken).toEqual([tenant.childId]);
      expect(impersonations.size).toBe(0);
    });

    it('не будит прогрев по родителю и по агенту', () => {
      const tenant = tenantOf('alpha');
      const woken: string[] = [];
      const opener = createTenantOpener({
        tenants: registry,
        impersonations: tracked(),
        wake: (childId) => woken.push(childId),
      });

      opener.open(tenant.childId, { kind: 'parent', impersonated: false });
      opener.open(tenant.childId, { kind: 'agent', impersonated: false });

      expect(woken).toEqual([]);
    });

    it('работает без будильника: воркер отключается опцией сервера', () => {
      const tenant = tenantOf('alpha');
      const opener = createTenantOpener({ tenants: registry, impersonations: tracked() });

      expect(opener.open(tenant.childId, { kind: 'browser', impersonated: false }).db)
        .toBe(tenant.db);
    });
  });
});

/** Отказ реестра как значение: `expect(...).toThrow` не даёт посмотреть код. */
function catchTenant(action: () => unknown): TenantError {
  try {
    action();
  } catch (error) {
    if (error instanceof TenantError) return error;
    throw error;
  }
  throw new Error('ожидался отказ реестра, а его не было');
}

/** Настоящее соединение занятия: тесту подмены важен только его `db`. */
function openSessionForTest(path: string): SessionDatabase {
  const session = openSessionDatabase(path);
  if (session === undefined) throw new Error(`база ${path} не открылась`);
  return session;
}
