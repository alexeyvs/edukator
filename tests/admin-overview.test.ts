import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import {
  CODEX_DAILY_QUOTA,
  LOGIN_EMAIL_FAILURE_LIMIT,
  childDatabasePath,
  createAdmin,
  createChild,
  createParent,
  disableParent,
  issueDeviceInvite,
  loginAdmin,
  loginParent,
  markChildFailed,
  markChildReady,
  openControlDatabase,
  redeemDeviceInvite,
  recordLoginFailure,
  reserveCodexCall,
  retireChild,
  revokeDevice,
  setAdminPassword,
  setParentPassword,
} from '../server/control-db.js';
import { controlDatabasePath, ensureDataDir } from '../server/data-dir.js';
import { openDatabase } from '../server/db.js';
import {
  OVERVIEW_WINDOW_DAYS,
  STUCK_PROVISIONING_MS,
  buildAdminOverview,
} from '../server/admin/overview.js';

const NOW = new Date('2026-08-21T09:00:00.000Z');
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const PARENT_PASSWORD = 'пароль-родителя';
/** Нижняя граница пароля оператора — 16 знаков. */
const ADMIN_PASSWORD = 'пароль-оператора-подлиннее';

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

describe('сводка оператора по управляющей базе', () => {
  let dir: string;
  let control: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'edukator-admin-overview-'));
    ensureDataDir(dir);
    control = openControlDatabase(controlDatabasePath(dir));
  });

  afterEach(() => {
    control.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Родитель с паролем: без него не войти, а вход нужен половине проверок. */
  function parent(email: string, at: Date = NOW): string {
    const id = createParent(control, email, at);
    setParentPassword(control, id, PARENT_PASSWORD, at);
    return id;
  }

  /** Ребёнок с файлом базы. Настоящая база здесь не нужна: сводка её не открывает. */
  function child(parentId: string, name: string, at: Date = NOW, bytes = 4096): string {
    const id = createChild(control, parentId, name, at);
    writeFileSync(childDatabasePath(dir, id), Buffer.alloc(bytes));
    return id;
  }

  function overview(now: Date = NOW): ReturnType<typeof buildAdminOverview> {
    return buildAdminOverview(control, { dataDir: dir, now });
  }

  it('считает родителей и детей всего и за оба окна', () => {
    const свежий = parent('свежий@example.com', ago(2 * DAY));
    const месячный = parent('месячный@example.com', ago(20 * DAY));
    const давний = parent('давний@example.com', ago(200 * DAY));
    child(свежий, 'Свежая', ago(2 * DAY));
    child(месячный, 'Месячная', ago(20 * DAY));
    child(давний, 'Давняя', ago(200 * DAY));

    const summary = overview();
    expect(summary.parents).toEqual({ total: 3, last7Days: 1, last30Days: 2, disabled: 0 });
    expect(summary.children.total).toBe(3);
    expect(summary.children.last7Days).toBe(1);
    expect(summary.children.last30Days).toBe(2);
    expect(summary.generatedAt).toBe(NOW.toISOString());
  });

  it('считает отключённых родителей и статусы детей', () => {
    const живой = parent('живой@example.com');
    const выключенный = parent('выключенный@example.com');
    disableParent(control, выключенный, NOW);
    const готовый = child(живой, 'Готовая');
    control.prepare('UPDATE children SET status = ? WHERE id = ?').run('ready', готовый);
    const сломанный = child(живой, 'Сломанная');
    markChildFailed(control, сломанный);
    const ушедший = child(живой, 'Ушедшая');
    retireChild(control, ушедший, NOW);

    const summary = overview();
    expect(summary.parents.disabled).toBe(1);
    // Выведенный ребёнок заведён и остался `provisioning`, но в этой строке он
    // считается ровно один раз — выведенным. Иначе главный экран вечно показывал
    // бы заведение, которое никто не чинит (в списке застрявших его законно нет),
    // а четыре числа перестали бы разбивать `total`.
    expect(summary.children).toMatchObject({
      total: 3,
      ready: 1,
      provisioning: 0,
      failed: 1,
      retired: 1,
    });
    const { ready, provisioning, failed, retired, total } = summary.children;
    expect(ready + provisioning + failed + retired).toBe(total);
  });

  it('выведенный ребёнок не считается готовым, каким бы ни был его статус', () => {
    const родитель = parent('родитель@example.com');
    const ушедший = child(родитель, 'Ушедшая');
    control.prepare('UPDATE children SET status = ? WHERE id = ?').run('ready', ушедший);
    retireChild(control, ушедший, NOW);

    // `retireChild` трогает только `retired_at`, и без оговорки в запросе
    // выведенный попадал бы и в `ready`, и в `retired` разом — а клиент по
    // `status === 'ready'` предлагал бы заход, который `isChildServiceable`
    // отвергает.
    expect(overview().children).toMatchObject({ total: 1, ready: 0, retired: 1 });
  });

  it('называет застрявших: `failed` и `provisioning` дольше часа', () => {
    const родитель = parent('родитель@example.com');
    const свежий = child(родитель, 'Только что', ago(MINUTE));
    const застрявший = child(родитель, 'Час назад', ago(STUCK_PROVISIONING_MS + MINUTE));
    const сломанный = child(родитель, 'Отказавшая', ago(MINUTE));
    markChildFailed(control, сломанный);

    const summary = overview();
    expect(summary.stuck.map((row) => row.childId).sort()).toEqual(
      [застрявший, сломанный].sort(),
    );
    expect(summary.stuck.map((row) => row.childId)).not.toContain(свежий);
    const failed = summary.stuck.find((row) => row.childId === сломанный);
    expect(failed).toMatchObject({ status: 'failed', parentId: родитель, name: 'Отказавшая' });
  });

  it('не считает застрявшим выведенного ребёнка', () => {
    const родитель = parent('родитель@example.com');
    const ушедший = child(родитель, 'Ушедшая', ago(2 * STUCK_PROVISIONING_MS));
    retireChild(control, ушедший, NOW);
    expect(overview().stuck).toEqual([]);
  });

  it('собирает семьи с детьми, статусами и последней активностью', () => {
    const первый = parent('первый@example.com', ago(2 * DAY));
    const второй = parent('второй@example.com', ago(DAY));
    const старший = child(первый, 'Старший', ago(2 * DAY));
    markChildReady(control, старший);
    control
      .prepare('UPDATE children SET last_activity_at = ? WHERE id = ?')
      .run(ago(MINUTE).toISOString(), старший);
    const младший = child(первый, 'Младшая', ago(DAY));
    child(второй, 'Один', ago(DAY));

    const families = overview().families;

    // Порядок устойчив и там, и там: семьи по времени заведения, дети внутри —
    // тоже. Перестановка равных строк меняла бы список у оператора на каждом
    // обновлении экрана.
    expect(families.map((family) => family.email)).toEqual([
      'первый@example.com',
      'второй@example.com',
    ]);
    expect(families[0]?.children.map((кто) => кто.name)).toEqual(['Старший', 'Младшая']);
    expect(families[0]?.children[0]).toMatchObject({
      childId: старший,
      status: 'ready',
      lastActivityAt: ago(MINUTE).toISOString(),
    });
    // Ни разу не занимавшийся ребёнок не притворяется занимавшимся: поля нет.
    expect(families[0]?.children[1]).toMatchObject({ childId: младший, status: 'provisioning' });
    expect(families[0]?.children[1]?.lastActivityAt).toBeUndefined();
    expect(families[0]?.disabledAt).toBeUndefined();
  });

  it('называет отключённого родителя и оставляет выведенных детей в семье', () => {
    const родитель = parent('родитель@example.com');
    const ушедший = child(родитель, 'Ушедшая');
    retireChild(control, ушедший, NOW);
    disableParent(control, родитель, NOW);
    // Родитель без детей: приглашение выпустили, ребёнка не завели — это
    // состояние, а не пустота, и в списке оно обязано быть видно.
    parent('пустой@example.com', new Date(NOW.getTime() + MINUTE));

    const families = overview().families;

    expect(families[0]).toMatchObject({ email: 'родитель@example.com', disabledAt: NOW.toISOString() });
    expect(families[0]?.children).toMatchObject([{ childId: ушедший, retiredAt: NOW.toISOString() }]);
    expect(families[1]).toMatchObject({ email: 'пустой@example.com', children: [] });
  });

  it('складывает расход квоты за московские сутки по каждому ребёнку', () => {
    const родитель = parent('родитель@example.com');
    const первый = child(родитель, 'Первая');
    const второй = child(родитель, 'Вторая');
    reserveCodexCall(control, первый, NOW);
    reserveCodexCall(control, первый, NOW);
    reserveCodexCall(control, второй, NOW);
    // Вчерашний расход в сегодняшнюю сводку не входит: квота суточная.
    reserveCodexCall(control, второй, ago(DAY));

    const summary = overview();
    expect(summary.quota.day).toBe('2026-08-21');
    expect(summary.quota.limit).toBe(CODEX_DAILY_QUOTA);
    expect(summary.quota.used).toBe(3);
    expect(summary.quota.children).toEqual([
      { childId: первый, used: 2 },
      { childId: второй, used: 1 },
    ]);
  });

  it('считает живые сессии родителей и операторов', () => {
    const родитель = parent('родитель@example.com');
    const вход = loginParent(control, 'родитель@example.com', PARENT_PASSWORD, NOW);
    expect(вход.ok).toBe(true);
    const оператор = createAdmin(control, 'оператор@example.com', NOW);
    setAdminPassword(control, оператор, ADMIN_PASSWORD, NOW);
    const вошёл = loginAdmin(control, 'оператор@example.com', ADMIN_PASSWORD, NOW);
    expect(вошёл.ok).toBe(true);

    expect(overview().sessions).toEqual({ parents: 1, admins: 1 });

    // Отключённый родитель гасит свою сессию, не переписывая её строку: сводка
    // обязана считать тем же условием, что и разрешение cookie.
    disableParent(control, родитель, NOW);
    expect(overview().sessions).toEqual({ parents: 0, admins: 1 });
  });

  it('не считает живой сессию, у которой вышел срок бездействия', () => {
    parent('родитель@example.com');
    loginParent(control, 'родитель@example.com', PARENT_PASSWORD, ago(60 * DAY));
    expect(overview().sessions.parents).toBe(0);
  });

  it('считает погашенные устройства по видам и непогашенные приглашения', () => {
    const родитель = parent('родитель@example.com');
    const ребёнок = child(родитель, 'Ребёнок');
    // Приглашение выдаётся только готовому ребёнку: до этого базы у него нет.
    markChildReady(control, ребёнок);
    for (const kind of ['browser', 'agent'] as const) {
      const invite = issueDeviceInvite(control, ребёнок, kind, '', NOW);
      const claimed = redeemDeviceInvite(control, invite.token, NOW);
      expect(claimed.ok).toBe(true);
    }
    const отозванное = issueDeviceInvite(control, ребёнок, 'browser', '', NOW);
    const claimed = redeemDeviceInvite(control, отозванное.token, NOW);
    if (!claimed.ok) throw new Error('устройство не погашено');
    revokeDevice(control, claimed.deviceId, NOW);
    // Приглашение, за которым никто не пришёл, и просроченное — разные вещи.
    issueDeviceInvite(control, ребёнок, 'browser', '', NOW);
    issueDeviceInvite(control, ребёнок, 'browser', '', ago(30 * DAY));

    expect(overview().devices).toEqual({ browser: 1, agent: 1, pendingInvites: 1 });
  });

  it('показывает действующие локауты входа и забывает остывшие', () => {
    for (let attempt = 0; attempt < LOGIN_EMAIL_FAILURE_LIMIT; attempt += 1) {
      recordLoginFailure(control, { kind: 'password', email: 'жертва@example.com', address: '10.0.0.1' }, NOW);
    }
    const locked = overview().lockouts;
    expect(locked.map((row) => `${row.scope}/${row.kind}/${row.key}`)).toEqual([
      'email/password/жертва@example.com',
    ]);
    expect(locked[0]?.failures).toBe(LOGIN_EMAIL_FAILURE_LIMIT);
    expect(locked[0]?.retryAfterMs).toBeGreaterThan(0);

    // Через час пауза остыла: строка есть, а запрета уже нет.
    expect(overview(new Date(NOW.getTime() + 60 * MINUTE)).lockouts).toEqual([]);
  });

  it('меряет размеры баз и свободное место, не открывая ни одной детской', () => {
    const родитель = parent('родитель@example.com');
    // Время заведения у всех троих разное: порядок в сводке — это порядок
    // заведения, и на одинаковой отметке он определялся бы случайным `id`.
    const первый = child(родитель, 'Первая', ago(3 * MINUTE), 8192);
    const второй = child(родитель, 'Вторая', ago(2 * MINUTE), 2048);
    const безбазы = createChild(control, родитель, 'Без базы', ago(MINUTE));

    const summary = overview();
    expect(summary.storage.children).toEqual([
      { childId: первый, bytes: 8192, present: true },
      { childId: второй, bytes: 2048, present: true },
      { childId: безбазы, bytes: 0, present: false },
    ]);
    expect(summary.storage.childrenBytes).toBe(8192 + 2048);
    expect(summary.storage.controlBytes).toBeGreaterThanOrEqual(
      statSync(controlDatabasePath(dir)).size,
    );
    expect(summary.storage.totalBytes).toBe(
      summary.storage.controlBytes + summary.storage.childrenBytes,
    );
    expect(summary.storage.freeBytes).toBeGreaterThan(0);
  });

  it('считает спутники WAL частью размера базы', () => {
    const родитель = parent('родитель@example.com');
    const ребёнок = child(родитель, 'Ребёнок', NOW, 1024);
    writeFileSync(`${childDatabasePath(dir, ребёнок)}-wal`, Buffer.alloc(512));

    expect(overview().storage.children).toEqual([
      { childId: ребёнок, bytes: 1024 + 512, present: true },
    ]);
  });

  it('отвечает, когда детские базы недоступны все разом', () => {
    const родитель = parent('родитель@example.com');
    const битый = child(родитель, 'Битая', ago(3 * MINUTE), 0);
    writeFileSync(childDatabasePath(dir, битый), 'это не база SQLite');
    const пропавший = createChild(control, родитель, 'Пропавшая', ago(2 * MINUTE));
    const чужой = child(родитель, 'Чужая', ago(MINUTE));
    // База новее приложения: открытие её отвергло бы, `stat` — нет.
    writeFileSync(childDatabasePath(dir, чужой), Buffer.alloc(64));

    const summary = overview();
    expect(summary.children.total).toBe(3);
    expect(summary.storage.children.map((row) => row.present)).toEqual([true, false, true]);
    expect(summary.storage.children.find((row) => row.childId === пропавший)?.bytes).toBe(0);
  });

  it('не открывает детскую базу: ни спутников WAL, ни правок файла', () => {
    const родитель = parent('родитель@example.com');
    const ребёнок = createChild(control, родитель, 'Настоящая', NOW);
    const path = childDatabasePath(dir, ребёнок);
    const db = openDatabase(path);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    const before = statSync(path);

    const summary = overview();
    expect(summary.storage.children).toEqual([
      { childId: ребёнок, bytes: before.size, present: true },
    ]);
    // Спутники WAL появляются от самого открытия соединения, а `mtime` — от
    // первой же записи миграции: и то и другое здесь означало бы, что сводка
    // всё-таки полезла в детскую базу.
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
    expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
  });

  it('отвечает и по пропавшему каталогу данных', () => {
    const родитель = parent('родитель@example.com');
    createChild(control, родитель, 'Ребёнок', NOW);
    // Каталога нет вовсе: ни размеров, ни свободного места. Сводка при этом
    // обязана дойти до конца — по ней как раз и видно, что каталог пропал.
    const summary = buildAdminOverview(control, {
      dataDir: join(dir, 'пропавший'),
      now: NOW,
    });
    expect(summary.children.total).toBe(1);
    expect(summary.storage).toMatchObject({
      controlBytes: 0,
      childrenBytes: 0,
      totalBytes: 0,
    });
    expect(summary.storage.freeBytes).toBeUndefined();
  });

  it('держит калибровочные константы спеки', () => {
    // Числа вписаны руками: ожидание, выведенное из самой константы, её подмену
    // не поймает.
    expect(STUCK_PROVISIONING_MS).toBe(60 * 60 * 1000);
    expect(OVERVIEW_WINDOW_DAYS).toEqual([7, 30]);
  });
});
