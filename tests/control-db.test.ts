import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import BetterSqlite3 from 'better-sqlite3';
import {
  CHILDREN_DIR,
  CONTROL_SCHEMA_VERSION,
  CONTROL_TABLES,
  DEVICE_INVITE_TTL_MS,
  MAX_CHILD_NAME_LENGTH,
  MAX_DEVICE_LABEL_LENGTH,
  MAX_EMAIL_LENGTH,
  MIN_PASSWORD_LENGTH,
  PARENT_INVITE_TTL_MS,
  PARENT_SESSION_IDLE_MS,
  PARENT_SESSION_MAX_MS,
  SESSION_TOUCH_MS,
  childDatabasePath,
  createChild,
  createParent,
  hashToken,
  issueDeviceInvite,
  issueParentInvite,
  listChildren,
  listDevices,
  loginParent,
  markChildFailed,
  markChildReady,
  migrateControl,
  normalizeEmail,
  openControlDatabase,
  readChild,
  readParentInvite,
  redeemDeviceInvite,
  redeemParentInvite,
  resolveChildDevice,
  resolveParentSession,
  retireChild,
  revokeDevice,
  revokeParentSession,
  validateControlSchema,
} from '../server/control-db.js';
import type { IssuedToken } from '../server/control-db.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Формат, в котором отметки времени пишет код: сравнение по колонке — строковое. */
const ISO_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Число открытых процессом дескрипторов. Утечку соединения иначе не увидеть:
 * объект базы наружу не возвращается. На системах без `/dev/fd` отдаёт 0 —
 * проверка вырождается в «не выросло», но не ломается.
 */
function openDescriptors(): number {
  return existsSync('/dev/fd') ? readdirSync('/dev/fd').length : 0;
}

function tableNames(db: Database): string[] {
  return db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
}

let dir: string;
let path: string;
const opened: Database[] = [];

function open(): Database {
  const db = openControlDatabase(path);
  opened.push(db);
  return db;
}

/** Родитель нужен почти всем таблицам: на него ссылаются дети, сессии и приглашения. */
function seedParent(db: Database, id = 'p1', email = 'mama@example.com'): string {
  db.prepare('INSERT INTO parents (id, email) VALUES (?, ?)').run(id, email);
  return id;
}

function seedChild(db: Database, parentId: string, id = 'abcdef01'): string {
  db.prepare('INSERT INTO children (id, parent_id, name) VALUES (?, ?, ?)').run(id, parentId, 'Сын');
  return id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'edukator-control-'));
  path = join(dir, 'control.db');
});

afterEach(() => {
  for (const db of opened.splice(0)) {
    try {
      db.close();
    } catch {
      // База могла быть закрыта самим тестом.
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('openControlDatabase', () => {
  it('создаёт базу с полным составом таблиц и версией схемы', () => {
    const db = open();

    expect(tableNames(db)).toEqual([...CONTROL_TABLES].sort());
    const [version] = db.pragma('user_version') as [{ user_version: number }];
    expect(version.user_version).toBe(CONTROL_SCHEMA_VERSION);
  });

  it('включает WAL и внешние ключи на соединении', () => {
    const db = open();

    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);

    // Внешний ключ должен именно отказывать, а не оставаться украшением схемы.
    expect(() =>
      db.prepare('INSERT INTO children (id, parent_id, name) VALUES (?, ?, ?)').run(
        'abcdef01',
        'нет такого',
        'Сын',
      ),
    ).toThrow(/FOREIGN KEY/i);
  });

  it('повторное открытие идемпотентно и не трогает данные', () => {
    const first = open();
    seedParent(first);
    first.close();

    const second = open();
    expect(tableNames(second)).toEqual([...CONTROL_TABLES].sort());
    const [version] = second.pragma('user_version') as [{ user_version: number }];
    expect(version.user_version).toBe(CONTROL_SCHEMA_VERSION);
    const parent = second
      .prepare<[], { email: string }>('SELECT email FROM parents')
      .get();
    expect(parent?.email).toBe('mama@example.com');
  });

  it('пишет умолчания отметок времени в ISO', () => {
    const db = open();
    const parentId = seedParent(db);
    seedChild(db, parentId);

    const parent = db.prepare<[], { created_at: string }>('SELECT created_at FROM parents').get();
    const child = db.prepare<[], { created_at: string }>('SELECT created_at FROM children').get();
    expect(parent?.created_at).toMatch(ISO_STAMP);
    expect(child?.created_at).toMatch(ISO_STAMP);
  });

  it('держит константы спеки: номер версии и состав таблиц', () => {
    expect(CONTROL_SCHEMA_VERSION).toBe(1);
    expect([...CONTROL_TABLES]).toEqual([
      'parents',
      'parent_invites',
      'parent_sessions',
      'children',
      'child_devices',
      'codex_quota',
      'login_attempts',
    ]);
  });
});

describe('ограничения схемы', () => {
  it('не принимает `id` ребёнка с разделителем пути или точками', () => {
    const db = open();
    const parentId = seedParent(db);

    for (const bad of ['../secret', 'a/b/c12345', '..', 'ABCDEF01']) {
      expect(() =>
        db
          .prepare('INSERT INTO children (id, parent_id, name) VALUES (?, ?, ?)')
          .run(bad, parentId, 'Сын'),
      ).toThrow(/CHECK/i);
    }
  });

  it('не принимает email в верхнем регистре и неизвестный статус ребёнка', () => {
    const db = open();
    const parentId = seedParent(db);

    expect(() =>
      db.prepare('INSERT INTO parents (id, email) VALUES (?, ?)').run('p2', 'Papa@Example.com'),
    ).toThrow(/CHECK/i);
    expect(() =>
      db
        .prepare('INSERT INTO children (id, parent_id, name, status) VALUES (?, ?, ?, ?)')
        .run('abcdef02', parentId, 'Сын', 'active'),
    ).toThrow(/CHECK/i);
  });

  it('не даёт погасить приглашение устройства без выдачи токена', () => {
    const db = open();
    const childId = seedChild(db, seedParent(db));
    const insert = db.prepare(
      `INSERT INTO child_devices (child_id, kind, invite_hash, invite_expires_at, claimed_at, token_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    expect(() =>
      insert.run(childId, 'browser', 'hash-1', '2026-08-21T00:00:00.000Z', '2026-08-20T00:00:00.000Z', null),
    ).toThrow(/CHECK/i);
    expect(() =>
      insert.run(childId, 'agent', 'hash-2', '2026-08-21T00:00:00.000Z', null, 'token-2'),
    ).toThrow(/CHECK/i);
    expect(() =>
      insert.run(childId, 'browser', 'hash-3', '2026-08-21T00:00:00.000Z', null, null),
    ).not.toThrow();
  });

  it('держит квоту уникальной по ребёнку и суткам и запрещает отрицательный счётчик', () => {
    const db = open();
    const childId = seedChild(db, seedParent(db));
    const insert = db.prepare('INSERT INTO codex_quota (child_id, day, calls) VALUES (?, ?, ?)');
    insert.run(childId, '2026-08-19', 1);

    expect(() => insert.run(childId, '2026-08-19', 2)).toThrow(/UNIQUE/i);
    expect(() => insert.run(childId, '2026-08-20', -1)).toThrow(/CHECK/i);
  });
});

describe('ошибочные пути', () => {
  it('отвергает базу новее приложения', () => {
    const raw = new BetterSqlite3(path);
    raw.pragma(`user_version = ${CONTROL_SCHEMA_VERSION + 1}`);
    raw.close();

    expect(() => open()).toThrow(/более новой версией схемы/);
  });

  it('отвергает базу без версии с посторонним объектом', () => {
    const raw = new BetterSqlite3(path);
    raw.exec('CREATE TABLE stranger (id INTEGER PRIMARY KEY)');
    raw.close();

    expect(() => open()).toThrow(/содержит объект «stranger»/);
  });

  it('не утекает дескриптором при отказе открытия', () => {
    const raw = new BetterSqlite3(path);
    raw.pragma(`user_version = ${CONTROL_SCHEMA_VERSION + 1}`);
    raw.close();

    const before = openDescriptors();
    for (let i = 0; i < 10; i += 1) {
      expect(() => openControlDatabase(path)).toThrow();
    }
    expect(openDescriptors()).toBeLessThanOrEqual(before);
  });

  it('отвергает базу с актуальной версией, но потерянной таблицей', () => {
    const db = open();
    db.close();
    const raw = new BetterSqlite3(path);
    raw.exec('DROP TABLE login_attempts');
    raw.close();

    expect(() => open()).toThrow(/Схема управляющей базы повреждена/);
  });

  it('отвергает базу с потерянным индексом и с ослабленным ограничением', () => {
    const db = open();
    db.close();
    const raw = new BetterSqlite3(path);
    raw.exec('DROP INDEX children_parent');
    raw.close();
    expect(() => open()).toThrow(/отсутствуют children_parent/);

    const relaxed = new BetterSqlite3(join(dir, 'relaxed.db'));
    relaxed.exec(`
      CREATE TABLE parents (id TEXT PRIMARY KEY, email TEXT, password_hash TEXT, pin_hash TEXT,
        credentials_changed_at TEXT, disabled_at TEXT, created_at TEXT);
    `);
    expect(() => validateControlSchema(relaxed)).toThrow(/Схема управляющей базы повреждена/);
    relaxed.close();
  });

  it('не мигрирует базу с неизвестной прошлой версией вслепую', () => {
    const raw = new BetterSqlite3(path);
    raw.exec('CREATE TABLE parents (id TEXT PRIMARY KEY)');
    raw.pragma('user_version = 0');
    raw.close();

    // Версия 0 с чужим объектом — отказ; а версия из будущего прошлого (когда
    // переходы появятся) не должна проходить молча.
    const other = new BetterSqlite3(join(dir, 'other.db'));
    other.pragma(`user_version = ${CONTROL_SCHEMA_VERSION - 1}`);
    if (CONTROL_SCHEMA_VERSION > 1) {
      expect(() => migrateControl(other)).toThrow(/не имеет перехода/);
    }
    other.close();

    expect(() => open()).toThrow(/содержит объект «parents»/);
  });
});

describe('родители, приглашения и сессии', () => {
  const NOW = new Date('2026-08-19T10:00:00.000Z');
  const PASSWORD = 'пароль-подлиннее';

  function at(ms: number): Date {
    return new Date(NOW.getTime() + ms);
  }

  /** Родитель с погашенным приглашением: с него начинается всё, кроме отказов. */
  function parentWithPassword(db: Database): { parentId: string; session: IssuedToken } {
    const parentId = createParent(db, 'Mama@Example.COM', NOW);
    const invite = issueParentInvite(db, parentId, NOW);
    const redeemed = redeemParentInvite(db, invite.token, PASSWORD, NOW);
    if (!redeemed.ok) throw new Error(`приглашение не погасилось: ${redeemed.reason}`);
    return { parentId, session: redeemed.session };
  }

  it('ведёт полный путь: приглашение → пароль → сессия', () => {
    const db = open();
    const { parentId, session } = parentWithPassword(db);

    expect(session.expiresAt).toBe(at(PARENT_SESSION_MAX_MS).toISOString());
    expect(resolveParentSession(db, session.token, at(HOUR_MS))).toEqual({
      parentId,
      email: 'mama@example.com',
    });

    // Пароль после погашения работает и сам по себе: вход даёт новую сессию.
    const login = loginParent(db, ' MAMA@example.com ', PASSWORD, at(HOUR_MS));
    expect(login.ok).toBe(true);
    if (!login.ok) return;
    expect(login.parentId).toBe(parentId);
    expect(login.session.token).not.toBe(session.token);
    expect(resolveParentSession(db, login.session.token, at(HOUR_MS))?.parentId).toBe(parentId);
  });

  it('хранит только отпечатки токенов', () => {
    const db = open();
    const parentId = createParent(db, 'papa@example.com', NOW);
    const invite = issueParentInvite(db, parentId, NOW);
    const redeemed = redeemParentInvite(db, invite.token, PASSWORD, NOW);
    expect(redeemed.ok).toBe(true);
    if (!redeemed.ok) return;

    // 256 бит в base64url — 43 знака; открытым токен не лежит ни в одной строке.
    expect(invite.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const dump = JSON.stringify([
      db.prepare('SELECT * FROM parent_invites').all(),
      db.prepare('SELECT * FROM parent_sessions').all(),
      db.prepare('SELECT * FROM parents').all(),
    ]);
    expect(dump).not.toContain(invite.token);
    expect(dump).not.toContain(redeemed.session.token);
    expect(dump).not.toContain(PASSWORD);
    expect(dump).toContain(hashToken(invite.token));
  });

  it('не гасит приглашение чтением, но гасит погашением', () => {
    const db = open();
    const parentId = createParent(db, 'mama@example.com', NOW);
    const invite = issueParentInvite(db, parentId, NOW);

    expect(readParentInvite(db, invite.token, NOW)).toEqual({
      ok: true,
      parentId,
      email: 'mama@example.com',
    });
    // Второе чтение обязано быть таким же: предпросмотр ссылки в мессенджере
    // не должен сжигать единственный вход родителя.
    expect(readParentInvite(db, invite.token, NOW).ok).toBe(true);

    expect(redeemParentInvite(db, invite.token, PASSWORD, NOW).ok).toBe(true);
    expect(readParentInvite(db, invite.token, NOW)).toEqual({ ok: false, reason: 'used' });
  });

  it('два одновременных погашения дают одну сессию', () => {
    const first = open();
    const parentId = createParent(first, 'mama@example.com', NOW);
    const invite = issueParentInvite(first, parentId, NOW);
    const second = open();

    const winner = redeemParentInvite(first, invite.token, PASSWORD, NOW);
    const loser = redeemParentInvite(second, invite.token, 'другой-пароль-длинный', NOW);

    expect(winner.ok).toBe(true);
    expect(loser).toEqual({ ok: false, reason: 'used' });
    expect(
      first.prepare<[], { n: number }>('SELECT count(*) AS n FROM parent_sessions').get()?.n,
    ).toBe(1);
    // Пароль остался от победителя: проигравший не должен переписать чужой.
    expect(loginParent(first, 'mama@example.com', PASSWORD, NOW).ok).toBe(true);
    expect(loginParent(first, 'mama@example.com', 'другой-пароль-длинный', NOW)).toEqual({
      ok: false,
      reason: 'bad-password',
    });
  });

  it('отказывает по протухшему, чужому и уже погашенному приглашению', () => {
    const db = open();
    const parentId = createParent(db, 'mama@example.com', NOW);
    const stale = issueParentInvite(db, parentId, NOW);
    const fresh = issueParentInvite(db, parentId, NOW);

    expect(redeemParentInvite(db, 'нет такого токена', PASSWORD, NOW)).toEqual({
      ok: false,
      reason: 'unknown-token',
    });
    expect(redeemParentInvite(db, stale.token, PASSWORD, at(PARENT_INVITE_TTL_MS))).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(redeemParentInvite(db, fresh.token, 'короткий', NOW)).toEqual({
      ok: false,
      reason: 'weak-password',
    });
    // Отказ по паролю не должен сжигать ссылку: она ещё нужна.
    expect(redeemParentInvite(db, fresh.token, PASSWORD, NOW).ok).toBe(true);
    expect(redeemParentInvite(db, fresh.token, PASSWORD, NOW)).toEqual({
      ok: false,
      reason: 'used',
    });
  });

  it('не выпускает приглашение отключённому и несуществующему родителю', () => {
    const db = open();
    const parentId = createParent(db, 'mama@example.com', NOW);
    const invite = issueParentInvite(db, parentId, NOW);
    db.prepare('UPDATE parents SET disabled_at = ? WHERE id = ?').run(NOW.toISOString(), parentId);

    expect(() => issueParentInvite(db, parentId, NOW)).toThrow(/отключён/);
    expect(() => issueParentInvite(db, 'нет такого', NOW)).toThrow(/нет в управляющей базе/);
    // Выпущенное до отключения тоже перестаёт работать.
    expect(redeemParentInvite(db, invite.token, PASSWORD, NOW)).toEqual({
      ok: false,
      reason: 'disabled',
    });
  });

  it('различает причины отказа во входе по паролю', () => {
    const db = open();
    const withoutPassword = createParent(db, 'papa@example.com', NOW);
    const { parentId } = parentWithPassword(db);

    expect(loginParent(db, 'mama@example.com', 'не тот пароль', NOW)).toEqual({
      ok: false,
      reason: 'bad-password',
    });
    expect(loginParent(db, 'никого@example.com', PASSWORD, NOW)).toEqual({
      ok: false,
      reason: 'unknown-email',
    });
    expect(loginParent(db, 'не адрес', PASSWORD, NOW)).toEqual({
      ok: false,
      reason: 'unknown-email',
    });
    expect(loginParent(db, 'papa@example.com', PASSWORD, NOW)).toEqual({
      ok: false,
      reason: 'no-password',
    });

    db.prepare('UPDATE parents SET disabled_at = ? WHERE id = ?').run(NOW.toISOString(), parentId);
    expect(loginParent(db, 'mama@example.com', PASSWORD, NOW)).toEqual({
      ok: false,
      reason: 'disabled',
    });
    expect(withoutPassword).not.toBe(parentId);
  });

  it('гасит сессию по бездействию', () => {
    const db = open();
    const { session } = parentWithPassword(db);

    expect(resolveParentSession(db, session.token, at(PARENT_SESSION_IDLE_MS - HOUR_MS))).toBeDefined();
    // Отметка обновилась предыдущим обращением, поэтому отсчёт идёт от него.
    expect(
      resolveParentSession(db, session.token, at(2 * PARENT_SESSION_IDLE_MS)),
    ).toBeUndefined();
  });

  it('гасит сессию по абсолютному потолку даже при ежедневной активности', () => {
    const db = open();
    const { session } = parentWithPassword(db);

    for (let day = 10; day <= 80; day += 10) {
      expect(resolveParentSession(db, session.token, at(day * DAY_MS))).toBeDefined();
    }
    expect(resolveParentSession(db, session.token, at(89 * DAY_MS))).toBeDefined();
    expect(resolveParentSession(db, session.token, at(91 * DAY_MS))).toBeUndefined();
  });

  it('пишет last_seen_at не чаще раза в пять минут', () => {
    const db = open();
    const { session } = parentWithPassword(db);
    const lastSeen = (): string =>
      db.prepare<[], { last_seen_at: string }>('SELECT last_seen_at FROM parent_sessions').get()
        ?.last_seen_at ?? '';

    expect(lastSeen()).toBe(NOW.toISOString());
    resolveParentSession(db, session.token, at(SESSION_TOUCH_MS - 1000));
    expect(lastSeen()).toBe(NOW.toISOString());

    resolveParentSession(db, session.token, at(SESSION_TOUCH_MS));
    expect(lastSeen()).toBe(at(SESSION_TOUCH_MS).toISOString());
  });

  it('гасит сессию выходом, отключением родителя и сменой пароля', () => {
    const db = open();
    const { parentId, session } = parentWithPassword(db);

    expect(revokeParentSession(db, session.token, at(HOUR_MS))).toBe(true);
    // Повторный выход ничего не меняет: строка уже отозвана.
    expect(revokeParentSession(db, session.token, at(HOUR_MS))).toBe(false);
    expect(resolveParentSession(db, session.token, at(HOUR_MS))).toBeUndefined();
    expect(resolveParentSession(db, 'нет такого токена', at(HOUR_MS))).toBeUndefined();

    const login = loginParent(db, 'mama@example.com', PASSWORD, at(HOUR_MS));
    expect(login.ok).toBe(true);
    if (!login.ok) return;
    db.prepare('UPDATE parents SET disabled_at = ? WHERE id = ?').run(NOW.toISOString(), parentId);
    expect(resolveParentSession(db, login.session.token, at(2 * HOUR_MS))).toBeUndefined();

    // Смена пароля по новому приглашению гасит всё, что выдано до неё.
    db.prepare('UPDATE parents SET disabled_at = NULL WHERE id = ?').run(parentId);
    const invite = issueParentInvite(db, parentId, at(2 * HOUR_MS));
    const changed = redeemParentInvite(db, invite.token, 'совсем-другой-пароль', at(3 * HOUR_MS));
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(resolveParentSession(db, login.session.token, at(4 * HOUR_MS))).toBeUndefined();
    // А выданная тем же погашением — работает: она не старше смены.
    expect(resolveParentSession(db, changed.session.token, at(4 * HOUR_MS))?.parentId).toBe(parentId);
  });

  it('заводит родителя по адресу и не заводит его дважды', () => {
    const db = open();
    createParent(db, ' Mama@Example.com ', NOW);

    expect(
      db.prepare<[], { email: string; created_at: string }>('SELECT email, created_at FROM parents').get(),
    ).toEqual({ email: 'mama@example.com', created_at: NOW.toISOString() });
    expect(() => createParent(db, 'MAMA@example.com', NOW)).toThrow(/уже заведён/);
    expect(() => createParent(db, 'не адрес', NOW)).toThrow(/не похож на электронную почту/);
    expect(normalizeEmail('a@b.c')).toBe('a@b.c');
    expect(normalizeEmail(`${'a'.repeat(MAX_EMAIL_LENGTH)}@b.c`)).toBeUndefined();
    expect(normalizeEmail('два@адреса@example.com')).toBeUndefined();
  });

  it('держит калибровочные константы спеки: сроки приглашения и сессии', () => {
    expect(PARENT_INVITE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(PARENT_SESSION_IDLE_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(PARENT_SESSION_MAX_MS).toBe(90 * 24 * 60 * 60 * 1000);
    expect(SESSION_TOUCH_MS).toBe(5 * 60 * 1000);
    expect(MIN_PASSWORD_LENGTH).toBe(10);
    expect(MAX_EMAIL_LENGTH).toBe(254);
  });
});

describe('дети и устройства', () => {
  const NOW = new Date('2026-08-19T10:00:00.000Z');
  const PASSWORD = 'пароль-подлиннее';

  function at(ms: number): Date {
    return new Date(NOW.getTime() + ms);
  }

  /** Родитель с паролем: без него у ребёнка нет ни владельца, ни отметки смены. */
  function parentWithPassword(db: Database, email = 'mama@example.com'): string {
    const parentId = createParent(db, email, NOW);
    const invite = issueParentInvite(db, parentId, NOW);
    const redeemed = redeemParentInvite(db, invite.token, PASSWORD, NOW);
    if (!redeemed.ok) throw new Error(`приглашение не погасилось: ${redeemed.reason}`);
    return parentId;
  }

  /** Готовый ребёнок: заведение всегда начинается с `provisioning`. */
  function readyChild(db: Database, parentId: string, name = 'Петя', now: Date = NOW): string {
    const childId = createChild(db, parentId, name, now);
    markChildReady(db, childId);
    return childId;
  }

  /** Устройство с погашенным приглашением: дальше проверяется уже его токен. */
  function claimedDevice(
    db: Database,
    childId: string,
    kind: 'browser' | 'agent' = 'browser',
    now: Date = NOW,
  ): { token: string; deviceId: number } {
    const invite = issueDeviceInvite(db, childId, kind, 'ноутбук', now);
    const claimed = redeemDeviceInvite(db, invite.token, now);
    if (!claimed.ok) throw new Error(`приглашение устройства не погасилось: ${claimed.reason}`);
    return { token: claimed.token, deviceId: claimed.deviceId };
  }

  it('ведёт полный путь: ребёнок → готовность → устройство → предъявитель', () => {
    const db = open();
    const parentId = parentWithPassword(db);
    const childId = createChild(db, parentId, '  Петя  ', NOW);

    expect(readChild(db, childId)).toEqual({
      id: childId,
      parentId,
      name: 'Петя',
      status: 'provisioning',
      createdAt: NOW.toISOString(),
    });
    // Пока базы нет, приглашать устройство некуда.
    expect(() => issueDeviceInvite(db, childId, 'browser', '', NOW)).toThrow(/ещё не готов/);

    markChildReady(db, childId);
    const invite = issueDeviceInvite(db, childId, 'browser', ' ноутбук ', NOW);
    expect(invite.expiresAt).toBe(at(DEVICE_INVITE_TTL_MS).toISOString());

    const claimed = redeemDeviceInvite(db, invite.token, at(HOUR_MS));
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    expect(claimed.childId).toBe(childId);
    expect(claimed.kind).toBe('browser');
    expect(claimed.token).not.toBe(invite.token);

    expect(resolveChildDevice(db, claimed.token, at(2 * HOUR_MS))).toEqual({
      childId,
      parentId,
      deviceId: claimed.deviceId,
      kind: 'browser',
      name: 'Петя',
    });
    expect(listDevices(db, childId)).toEqual([
      {
        id: claimed.deviceId,
        childId,
        kind: 'browser',
        label: 'ноутбук',
        inviteExpiresAt: at(DEVICE_INVITE_TTL_MS).toISOString(),
        claimedAt: at(HOUR_MS).toISOString(),
        createdAt: NOW.toISOString(),
      },
    ]);
  });

  it('хранит только отпечатки токенов устройства', () => {
    const db = open();
    const childId = readyChild(db, parentWithPassword(db));
    const invite = issueDeviceInvite(db, childId, 'agent', '', NOW);
    const claimed = redeemDeviceInvite(db, invite.token, NOW);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;

    const row = db
      .prepare<[], { invite_hash: string; token_hash: string | null }>(
        'SELECT invite_hash, token_hash FROM child_devices',
      )
      .get();
    expect(row?.invite_hash).toBe(hashToken(invite.token));
    expect(row?.token_hash).toBe(hashToken(claimed.token));
    expect(JSON.stringify(row)).not.toContain(invite.token);
    expect(JSON.stringify(row)).not.toContain(claimed.token);
  });

  it('два одновременных погашения заводят ровно одно устройство', () => {
    const first = open();
    const parentId = parentWithPassword(first);
    const childId = readyChild(first, parentId);
    const invite = issueDeviceInvite(first, childId, 'browser', '', NOW);
    const second = open();

    const winner = redeemDeviceInvite(first, invite.token, NOW);
    const loser = redeemDeviceInvite(second, invite.token, NOW);

    expect(winner.ok).toBe(true);
    expect(loser).toEqual({ ok: false, reason: 'used' });
    expect(
      first.prepare<[], { n: number }>('SELECT count(*) AS n FROM child_devices').get()?.n,
    ).toBe(1);
    if (!winner.ok) return;
    // Токен победителя работает: проигравший не переписал его своим.
    expect(resolveChildDevice(first, winner.token, NOW)?.childId).toBe(childId);
  });

  it('отказывает по чужому, протухшему и уже погашенному приглашению устройства', () => {
    const db = open();
    const childId = readyChild(db, parentWithPassword(db));
    const stale = issueDeviceInvite(db, childId, 'browser', '', NOW);
    const fresh = issueDeviceInvite(db, childId, 'browser', '', NOW);

    expect(redeemDeviceInvite(db, 'нет такого токена', NOW)).toEqual({
      ok: false,
      reason: 'unknown-token',
    });
    expect(redeemDeviceInvite(db, stale.token, at(DEVICE_INVITE_TTL_MS))).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(redeemDeviceInvite(db, fresh.token, NOW).ok).toBe(true);
    expect(redeemDeviceInvite(db, fresh.token, NOW)).toEqual({ ok: false, reason: 'used' });
    // Протухшее приглашение так и не завело устройства.
    expect(
      db.prepare<[], { n: number }>('SELECT count(*) AS n FROM child_devices WHERE claimed_at IS NOT NULL').get()?.n,
    ).toBe(1);
  });

  it('отзыв устройства гасит только его', () => {
    const db = open();
    const childId = readyChild(db, parentWithPassword(db));
    const laptop = claimedDevice(db, childId);
    const agent = claimedDevice(db, childId, 'agent');

    expect(revokeDevice(db, laptop.deviceId, at(HOUR_MS))).toBe(true);
    // Повторный отзыв уже ничего не меняет: строка помечена один раз.
    expect(revokeDevice(db, laptop.deviceId, at(2 * HOUR_MS))).toBe(false);

    expect(resolveChildDevice(db, laptop.token, at(2 * HOUR_MS))).toBeUndefined();
    expect(resolveChildDevice(db, agent.token, at(2 * HOUR_MS))?.deviceId).toBe(agent.deviceId);
    expect(listDevices(db, childId).find((device) => device.id === laptop.deviceId)?.revokedAt).toBe(
      at(HOUR_MS).toISOString(),
    );
  });

  it('вывод ребёнка гасит его устройства и не трогает соседа', () => {
    const db = open();
    const parentId = parentWithPassword(db);
    // Разные отметки заведения: список упорядочен по ним, и совпадающие
    // отметки свели бы проверку порядка к сравнению случайных id.
    const petya = readyChild(db, parentId, 'Петя', NOW);
    const vasya = readyChild(db, parentId, 'Вася', at(1000));
    const petyaDevice = claimedDevice(db, petya);
    const vasyaDevice = claimedDevice(db, vasya);

    expect(retireChild(db, petya, at(HOUR_MS))).toBe(true);
    expect(retireChild(db, petya, at(2 * HOUR_MS))).toBe(false);

    expect(resolveChildDevice(db, petyaDevice.token, at(2 * HOUR_MS))).toBeUndefined();
    expect(resolveChildDevice(db, vasyaDevice.token, at(2 * HOUR_MS))?.childId).toBe(vasya);
    expect(listChildren(db, parentId).map((child) => child.id)).toEqual([vasya]);
    expect(listChildren(db, parentId, { includeRetired: true }).map((child) => child.id)).toEqual([
      petya,
      vasya,
    ]);
    // Выведенному ребёнку новых устройств не выпускают.
    expect(() => issueDeviceInvite(db, petya, 'browser', '', at(2 * HOUR_MS))).toThrow(/выведен/);
  });

  it('отключение родителя гасит устройства его детей и не трогает чужих', () => {
    const db = open();
    const mama = parentWithPassword(db, 'mama@example.com');
    const papa = parentWithPassword(db, 'papa@example.com');
    const petya = readyChild(db, mama, 'Петя');
    const alien = readyChild(db, papa, 'Соня');
    const petyaDevice = claimedDevice(db, petya);
    const alienDevice = claimedDevice(db, alien);

    db.prepare('UPDATE parents SET disabled_at = ? WHERE id = ?').run(at(HOUR_MS).toISOString(), mama);

    expect(resolveChildDevice(db, petyaDevice.token, at(2 * HOUR_MS))).toBeUndefined();
    expect(resolveChildDevice(db, alienDevice.token, at(2 * HOUR_MS))?.childId).toBe(alien);
    expect(() => createChild(db, mama, 'Новый', at(2 * HOUR_MS))).toThrow(/отключён/);
    expect(() => issueDeviceInvite(db, petya, 'browser', '', at(2 * HOUR_MS))).toThrow(/отключён/);
  });

  it('смена пароля родителя гасит устройства, выданные до неё, и не гасит выданные после', () => {
    const db = open();
    const parentId = parentWithPassword(db);
    const childId = readyChild(db, parentId);
    const before = claimedDevice(db, childId, 'browser', at(HOUR_MS));

    db.prepare('UPDATE parents SET credentials_changed_at = ? WHERE id = ?').run(
      at(2 * HOUR_MS).toISOString(),
      parentId,
    );
    const after = claimedDevice(db, childId, 'browser', at(3 * HOUR_MS));

    expect(resolveChildDevice(db, before.token, at(4 * HOUR_MS))).toBeUndefined();
    expect(resolveChildDevice(db, after.token, at(4 * HOUR_MS))?.deviceId).toBe(after.deviceId);
  });

  it('пишет last_activity_at не чаще раза в пять минут', () => {
    const db = open();
    const childId = readyChild(db, parentWithPassword(db));
    const device = claimedDevice(db, childId);

    function lastActivity(): string | null {
      return (
        db
          .prepare<[string], { last_activity_at: string | null }>(
            'SELECT last_activity_at FROM children WHERE id = ?',
          )
          .get(childId)?.last_activity_at ?? null
      );
    }

    expect(resolveChildDevice(db, device.token, at(HOUR_MS))?.childId).toBe(childId);
    expect(lastActivity()).toBe(at(HOUR_MS).toISOString());

    // Занятие бьёт в управляющую базу на каждом задании: запись глушится.
    resolveChildDevice(db, device.token, at(HOUR_MS + SESSION_TOUCH_MS - 1));
    expect(lastActivity()).toBe(at(HOUR_MS).toISOString());

    resolveChildDevice(db, device.token, at(HOUR_MS + SESSION_TOUCH_MS));
    expect(lastActivity()).toBe(at(HOUR_MS + SESSION_TOUCH_MS).toISOString());
    expect(readChild(db, childId)?.lastActivityAt).toBe(at(HOUR_MS + SESSION_TOUCH_MS).toISOString());
  });

  it('не пускает ребёнка без готовой базы и не заводит его с пустым именем', () => {
    const db = open();
    const parentId = parentWithPassword(db);
    const childId = readyChild(db, parentId);
    const device = claimedDevice(db, childId);

    markChildFailed(db, childId);
    expect(resolveChildDevice(db, device.token, at(HOUR_MS))).toBeUndefined();
    expect(readChild(db, childId)?.status).toBe('failed');

    expect(() => createChild(db, parentId, '   ', NOW)).toThrow(/от 1 до/);
    expect(() => createChild(db, parentId, 'и'.repeat(MAX_CHILD_NAME_LENGTH + 1), NOW)).toThrow(/от 1 до/);
    expect(() => createChild(db, 'нет такого родителя', 'Петя', NOW)).toThrow(/нет в управляющей базе/);
    expect(() => issueDeviceInvite(db, 'нет такого ребёнка', 'browser', '', NOW)).toThrow(
      /нет в управляющей базе/,
    );
    expect(readChild(db, 'нет такого ребёнка')).toBeUndefined();

    // Выведенного ребёнка нельзя ни оживить, ни пометить неудачей.
    retireChild(db, childId, at(HOUR_MS));
    expect(() => markChildReady(db, childId)).toThrow(/уже выведен/);
  });

  it('не принимает подпись устройства длиннее предела', () => {
    const db = open();
    const childId = readyChild(db, parentWithPassword(db));
    expect(() =>
      issueDeviceInvite(db, childId, 'browser', 'п'.repeat(MAX_DEVICE_LABEL_LENGTH + 1), NOW),
    ).toThrow(/Подпись устройства/);
    expect(listDevices(db, childId)).toEqual([]);
  });

  it('считает путь базы ребёнка из id и не выпускает его из каталога children', () => {
    const childId = 'a'.repeat(32);
    expect(childDatabasePath('/данные', childId)).toBe(join('/данные', CHILDREN_DIR, `${childId}.db`));
    // Относительный каталог данных тоже канонизируется.
    expect(childDatabasePath('данные', childId)).toBe(
      join(process.cwd(), 'данные', CHILDREN_DIR, `${childId}.db`),
    );

    for (const bad of ['..', '../../etc/passwd', 'a/../../b', 'ab/cd', 'ab\\cd', 'AB12', 'abc', '']) {
      expect(() => childDatabasePath('/данные', bad)).toThrow(/не годится в имя файла базы/);
    }
  });

  it('не даёт завести ребёнка с id, выводящим за каталог', () => {
    const db = open();
    const parentId = parentWithPassword(db);
    // Заведение выдаёт id само, но схема обязана держать и прямую запись.
    expect(() =>
      db.prepare('INSERT INTO children (id, parent_id, name) VALUES (?, ?, ?)').run(
        '../../etc/passwd',
        parentId,
        'Петя',
      ),
    ).toThrow(/CHECK/);
    expect(createChild(db, parentId, 'Петя', NOW)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('держит калибровочные константы спеки: срок приглашения устройства и пределы подписей', () => {
    expect(DEVICE_INVITE_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(MAX_CHILD_NAME_LENGTH).toBe(64);
    expect(MAX_DEVICE_LABEL_LENGTH).toBe(64);
    expect(CHILDREN_DIR).toBe('children');
  });
});
