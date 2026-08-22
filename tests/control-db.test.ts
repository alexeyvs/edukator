import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import BetterSqlite3 from 'better-sqlite3';
import { MAX_SECRET_LENGTH } from '../server/secrets.js';
import {
  ADMIN_AUDIT_ACTIONS,
  ADMIN_SESSION_IDLE_MS,
  ADMIN_SESSION_MAX_MS,
  CHILDREN_DIR,
  CODEX_DAILY_QUOTA,
  CONTROL_SCHEMA_VERSION,
  CONTROL_TABLES,
  DEVICE_INVITE_TTL_MS,
  IMPERSONATION_ROLES,
  IMPERSONATION_TTL_MS,
  MAX_CHILD_NAME_LENGTH,
  MAX_DEVICE_LABEL_LENGTH,
  MAX_EMAIL_LENGTH,
  MIN_ADMIN_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  PARENT_INVITE_TTL_MS,
  PARENT_SESSION_IDLE_MS,
  PARENT_SESSION_MAX_MS,
  SESSION_TOUCH_MS,
  LOGIN_ADDRESS_FAILURE_LIMIT,
  LOGIN_EMAIL_FAILURE_LIMIT,
  LOGIN_LOCKOUT_MS,
  changeParentPassword,
  checkLoginGate,
  childDatabasePath,
  clearLoginFailures,
  createAdmin,
  createChild,
  createParent,
  disableAdmin,
  disableParent,
  findAdminByEmail,
  findParentByEmail,
  hashToken,
  isAdminAuditAction,
  isImpersonationRole,
  issueDeviceInvite,
  issueParentInvite,
  ADMIN_AUDIT_PAGE,
  listAdminAudit,
  listAllChildren,
  listServiceableChildren,
  listChildren,
  listDevices,
  loginAdmin,
  loginParent,
  markChildFailed,
  markChildReady,
  migrateControl,
  normalizeEmail,
  openControlDatabase,
  readChild,
  readCodexQuota,
  readDevice,
  readParent,
  readParentEmail,
  readParentInvite,
  readParentPinHash,
  recordAdminAudit,
  recordLoginFailure,
  redeemDeviceInvite,
  redeemParentInvite,
  reserveCodexCall,
  resolveAdminSession,
  resolveChildDevice,
  resolveImpersonation,
  revokeImpersonation,
  startImpersonation,
  setAdminPassword,
  setParentPassword,
  setParentPin,
  resolveParentSession,
  retireChild,
  revokeAdminSession,
  revokeDevice,
  revokeParentSession,
  validateControlSchema,
} from '../server/control-db.js';
import type {
  AdminAuditAction,
  IssuedToken,
  LoginGate,
  LoginTarget,
} from '../server/control-db.js';
import { UNKNOWN_ADDRESS } from '../server/client-address.js';

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
    expect(CONTROL_SCHEMA_VERSION).toBe(3);
    expect([...CONTROL_TABLES]).toEqual([
      'parents',
      'parent_invites',
      'parent_sessions',
      'children',
      'child_devices',
      'codex_quota',
      'login_attempts',
      'admins',
      'admin_sessions',
      'admin_impersonations',
      'admin_audit',
      'courses',
      'course_revisions',
      'topics',
      'revision_topics',
      'topic_prereqs',
      'revision_topic_sources',
      'course_sources',
      'source_pages',
      'source_chunks',
      'source_chunks_fts',
      'source_chunks_fts_data',
      'source_chunks_fts_idx',
      'source_chunks_fts_docsize',
      'source_chunks_fts_config',
      'catalog_jobs',
      'child_courses',
      'child_topic_exclusions',
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

  it('индексирует фрагменты источников в contentless FTS5', () => {
    const db = open();
    db.prepare("INSERT INTO courses (id, title, grade) VALUES ('science-7', 'Наука', '7 класс')").run();
    const revisionId = Number(db.prepare(
      "INSERT INTO course_revisions (course_id, revision_number, status) VALUES ('science-7', 1, 'draft')",
    ).run().lastInsertRowid);
    const sourceId = Number(db.prepare(
      `INSERT INTO course_sources
         (course_id, revision_id, upload_name, sha256, artifact_path)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('science-7', revisionId, 'book.pdf', 'a'.repeat(64), 'sources/a.pdf').lastInsertRowid);
    db.prepare('INSERT INTO source_pages (source_id, page_number) VALUES (?, 1)').run(sourceId);
    const chunkId = Number(db.prepare(
      'INSERT INTO source_chunks (source_id, page_number, chunk_number, text) VALUES (?, 1, 0, ?)',
    ).run(sourceId, 'клеточное строение организмов').lastInsertRowid);

    expect(db.prepare(
      "SELECT rowid FROM source_chunks_fts WHERE source_chunks_fts MATCH 'клеточное'",
    ).all()).toEqual([{ rowid: chunkId }]);
    db.prepare('DELETE FROM source_chunks WHERE id = ?').run(chunkId);
    expect(db.prepare(
      "SELECT rowid FROM source_chunks_fts WHERE source_chunks_fts MATCH 'клеточное'",
    ).all()).toEqual([]);
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

    // Ослабленное ограничение проверяется на **целой** схеме: база, в которой
    // не хватает и таблиц, покраснела бы на первой же из них, и проверка
    // фрагментов CHECK не выполнилась бы ни разу.
    const relaxedPath = join(dir, 'relaxed.db');
    // Схема берётся с целой базы, а не с той, у которой выше уронили индекс:
    // иначе отказ пришёл бы по индексу и про ограничение не сказал бы ничего.
    const wholePath = join(dir, 'whole.db');
    openControlDatabase(wholePath).close();
    const source = new BetterSqlite3(wholePath);
    const statements = source
      .prepare<[], { sql: string | null }>(
        `SELECT sql FROM sqlite_master
          WHERE sql IS NOT NULL
            AND name NOT LIKE 'sqlite_%'
            AND NOT (type = 'table' AND name GLOB 'source_chunks_fts_*')`,
      )
      .all()
      .map((row) => row.sql ?? '');
    source.close();
    // Текст ограничения вписан руками: собранный из самой константы, он молча
    // остался бы верным и после её подмены.
    const childIdCheck = "id NOT GLOB '*[^0-9a-f]*' AND length(id) BETWEEN 8 AND 64";
    const relaxed = new BetterSqlite3(relaxedPath);
    let relaxations = 0;
    for (const statement of statements) {
      // Снимаем ровно одно ограничение: `id` ребёнка перестаёт проверяться на
      // разделитель пути. Всё остальное на месте — иначе отказ ничего не значит.
      const weakened = statement.replace(childIdCheck, "id <> ''");
      if (weakened !== statement) relaxations += 1;
      relaxed.exec(weakened);
    }
    expect(relaxations).toBe(1);
    expect(() => validateControlSchema(relaxed)).toThrow(
      /children не содержит обязательные ограничения/,
    );
    relaxed.close();
  });

  it('не мигрирует базу с неизвестной прошлой версией вслепую', () => {
    const raw = new BetterSqlite3(path);
    raw.exec('CREATE TABLE parents (id TEXT PRIMARY KEY)');
    raw.pragma('user_version = 0');
    raw.close();

    // База новее приложения отвергается, а не мигрируется вслепую. Прежнее
    // условие «если версий больше одной» было утверждением, которое при
    // `CONTROL_SCHEMA_VERSION = 1` не выполнялось ни разу — то есть база
    // `other.db` создавалась, настраивалась и закрывалась без единой проверки.
    const other = new BetterSqlite3(join(dir, 'other.db'));
    other.pragma(`user_version = ${CONTROL_SCHEMA_VERSION + 1}`);
    expect(() => migrateControl(other)).toThrow(/собрана более новой версией схемы/);
    other.close();

    expect(() => open()).toThrow(/содержит объект «parents»/);
  });
});

/**
 * База версии 1: управляющая база без админских таблиц и со старым `CHECK` у
 * счётчиков перебора. Админские объекты вычитаются из актуальной схемы, а DDL
 * счётчиков вписан руками — ровно тем текстом, который стоял в версии 1: копия,
 * собранная из нынешней константы, приняла бы `kind = 'admin'` ещё до миграции
 * и проверять было бы нечего.
 */
function dropCatalogSchema(legacy: Database): void {
  legacy.exec(`
    DROP TABLE child_topic_exclusions;
    DROP TABLE child_courses;
    DROP TABLE source_chunks_fts;
    DROP TABLE catalog_jobs;
    DROP TABLE revision_topic_sources;
    DROP TABLE source_chunks;
    DROP TABLE source_pages;
    DROP TABLE course_sources;
    DROP TABLE topic_prereqs;
    DROP TABLE revision_topics;
    DROP TABLE topics;
    DROP TABLE course_revisions;
    DROP TABLE courses;
  `);
}

function createVersionOneDatabase(target: string): Database {
  openControlDatabase(target).close();
  const legacy = new BetterSqlite3(target);
  dropCatalogSchema(legacy);
  legacy.exec(`
    DROP TABLE admin_audit;
    DROP TABLE admin_impersonations;
    DROP TABLE admin_sessions;
    DROP TABLE admins;
    DROP TABLE login_attempts;
    CREATE TABLE login_attempts (
      scope           TEXT    NOT NULL CHECK (scope IN ('email', 'address')),
      kind            TEXT    NOT NULL CHECK (kind IN ('password', 'pin')),
      key             TEXT    NOT NULL,
      failures        INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
      first_failed_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      last_failed_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (scope, kind, key)
    );
  `);
  legacy.pragma('user_version = 1');
  return legacy;
}

describe('обновление управляющей базы до версии 3', () => {
  it('заводит админские таблицы и сохраняет счётчики перебора', () => {
    const legacy = createVersionOneDatabase(path);
    legacy
      .prepare(
        `INSERT INTO login_attempts (scope, kind, key, failures, first_failed_at, last_failed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('email', 'password', 'mama@example.com', 3, '2026-08-20T10:00:00.000Z', '2026-08-20T10:05:00.000Z');
    // Версия 1 третьего вида не знала: без миграции запись оператора отвергалась.
    expect(() =>
      legacy
        .prepare('INSERT INTO login_attempts (scope, kind, key) VALUES (?, ?, ?)')
        .run('email', 'admin', 'operator@example.com'),
    ).toThrow(/CHECK/i);
    legacy.close();

    const db = open();

    const [version] = db.pragma('user_version') as [{ user_version: number }];
    expect(version.user_version).toBe(3);
    expect(tableNames(db)).toEqual([...CONTROL_TABLES].sort());

    // Обнулить счётчики миграцией значит открыть окно перебора в предсказуемое
    // время — в момент обновления, поэтому строки обязаны доехать целиком.
    const attempt = db
      .prepare<[string], { failures: number; first_failed_at: string; last_failed_at: string }>(
        'SELECT failures, first_failed_at, last_failed_at FROM login_attempts WHERE key = ?',
      )
      .get('mama@example.com');
    expect(attempt).toEqual({
      failures: 3,
      first_failed_at: '2026-08-20T10:00:00.000Z',
      last_failed_at: '2026-08-20T10:05:00.000Z',
    });

    // Третий вид счётчика теперь принимается, а посторонний — по-прежнему нет.
    db.prepare('INSERT INTO login_attempts (scope, kind, key) VALUES (?, ?, ?)').run(
      'email',
      'admin',
      'operator@example.com',
    );
    expect(() =>
      db
        .prepare('INSERT INTO login_attempts (scope, kind, key) VALUES (?, ?, ?)')
        .run('email', 'totp', 'operator@example.com'),
    ).toThrow(/CHECK/i);

    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('добавляет нормализованный каталог, FTS и перезапускаемые задания', () => {
    createVersionOneDatabase(path).close();
    const db = open();

    for (const table of ['courses', 'course_revisions', 'topics', 'revision_topics',
      'topic_prereqs', 'course_sources', 'source_pages', 'source_chunks', 'catalog_jobs']) {
      expect(tableNames(db)).toContain(table);
    }
    const ftsSql = db
      .prepare<[string], { sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get('source_chunks_fts')?.sql;
    expect(ftsSql).toContain("content=''");
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('достраивает каталог у ранней базы версии 2 без каталожных объектов', () => {
    open().close();
    const legacy = new BetterSqlite3(path);
    dropCatalogSchema(legacy);
    legacy.pragma('user_version = 2');
    expect(legacy.pragma('user_version', { simple: true })).toBe(2);
    legacy.close();

    const migrated = open();
    expect(tableNames(migrated)).toEqual([...CONTROL_TABLES].sort());
    expect(migrated.pragma('foreign_key_check')).toEqual([]);
  });

  it('мигрирует назначения из версии 2 и сохраняет существующие данные', () => {
    open().close();
    const legacy = new BetterSqlite3(path);
    legacy.exec('DROP TABLE child_topic_exclusions; DROP TABLE child_courses;');
    legacy.pragma('user_version = 2');
    legacy.close();

    const migrated = open();
    expect(tableNames(migrated)).toEqual([...CONTROL_TABLES].sort());
    expect(migrated.pragma('user_version', { simple: true })).toBe(3);
    expect(migrated.pragma('foreign_key_check')).toEqual([]);
  });

  it('ставит на админские таблицы ограничения и ISO-умолчания', () => {
    createVersionOneDatabase(path).close();
    const db = open();
    const parentId = seedParent(db);
    const childId = seedChild(db, parentId);

    db.prepare('INSERT INTO admins (id, email) VALUES (?, ?)').run('a1', 'operator@example.com');
    // Адрес хранится приведённым к нижнему регистру: сравнение точное.
    expect(() =>
      db.prepare('INSERT INTO admins (id, email) VALUES (?, ?)').run('a2', 'Operator@Example.com'),
    ).toThrow(/CHECK/i);

    db.prepare(
      'INSERT INTO admin_sessions (admin_id, token_hash, expires_at) VALUES (?, ?, ?)',
    ).run('a1', 'хеш-сессии', '2026-08-21T12:00:00.000Z');
    db.prepare(
      `INSERT INTO admin_impersonations (admin_id, child_id, role, token_hash, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('a1', childId, 'browser', 'хеш-имперсонации', '2026-08-21T12:15:00.000Z');
    // Роль имперсонации закрыта схемой: чужое значение не должно доехать до кода.
    expect(() =>
      db
        .prepare(
          `INSERT INTO admin_impersonations (admin_id, child_id, role, token_hash, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('a1', childId, 'agent', 'другой хеш', '2026-08-21T12:15:00.000Z'),
    ).toThrow(/CHECK/i);

    db.prepare(
      'INSERT INTO admin_audit (admin_id, action, child_id, parent_id) VALUES (?, ?, ?, ?)',
    ).run('a1', 'impersonation-start', childId, parentId);

    for (const table of ['admins', 'admin_sessions', 'admin_impersonations']) {
      const row = db
        .prepare<[], { created_at: string }>(`SELECT created_at FROM ${table}`)
        .get();
      expect(row?.created_at).toMatch(ISO_STAMP);
    }
    const audit = db.prepare<[], { at: string }>('SELECT at FROM admin_audit').get();
    expect(audit?.at).toMatch(ISO_STAMP);
  });

  it('оставляет след в журнале, когда семья уходит, но не даёт удалить оператора', () => {
    createVersionOneDatabase(path).close();
    const db = open();
    const parentId = seedParent(db);
    const childId = seedChild(db, parentId);
    db.prepare('INSERT INTO admins (id, email) VALUES (?, ?)').run('a1', 'operator@example.com');
    db.prepare(
      'INSERT INTO admin_audit (admin_id, action, child_id, parent_id) VALUES (?, ?, ?, ?)',
    ).run('a1', 'impersonation-start', childId, parentId);

    // Семья названа значениями: запись о заходе обязана пережить её удаление.
    db.prepare('DELETE FROM parents WHERE id = ?').run(parentId);
    const rows = db.prepare<[], { child_id: string | null }>('SELECT child_id FROM admin_audit').all();
    expect(rows).toEqual([{ child_id: childId }]);

    // А сам оператор из-под собственного журнала не удаляется.
    expect(() => db.prepare('DELETE FROM admins WHERE id = ?').run('a1')).toThrow(/FOREIGN KEY/i);
  });

  it('повторная миграция версии 1 идемпотентна', () => {
    createVersionOneDatabase(path).close();
    const db = open();
    db.prepare('INSERT INTO admins (id, email) VALUES (?, ?)').run('a1', 'operator@example.com');

    expect(() => migrateControl(db)).not.toThrow();

    const [version] = db.pragma('user_version') as [{ user_version: number }];
    expect(version.user_version).toBe(CONTROL_SCHEMA_VERSION);
    const admins = db.prepare<[], { email: string }>('SELECT email FROM admins').all();
    expect(admins).toEqual([{ email: 'operator@example.com' }]);
  });

  it('отвергает управляющую базу версии 4', () => {
    const legacy = createVersionOneDatabase(path);
    legacy.pragma('user_version = 4');
    legacy.close();

    expect(() => open()).toThrow(/более новой версией схемы \(4 > 3\)/);
  });

  it('отвергает базу версии 2 без админской таблицы и без её индекса', () => {
    open().close();
    const raw = new BetterSqlite3(path);
    raw.exec('DROP TABLE admin_sessions');
    raw.close();
    expect(() => open()).toThrow(/admin_sessions не содержит/);

    const other = join(dir, 'без-индекса.db');
    openControlDatabase(other).close();
    const rawOther = new BetterSqlite3(other);
    rawOther.exec('DROP INDEX admin_audit_at');
    rawOther.close();
    expect(() => openControlDatabase(other)).toThrow(/отсутствуют admin_audit_at/);
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

  // Отпечаток вписан руками: ожидание, посчитанное тем же `hashToken`, сходится
  // и с md5, и с любой другой подменой — то есть подмену алгоритма не ловит, а
  // вместе с ней проходит мимо и укорочение отпечатка.
  it('считает отпечаток токена именно SHA-256 в base64url', () => {
    expect(hashToken('одноразовый-токен')).toBe('FXH5a8Jp2pRKGjB8MrKMs_HoB_AbLjLJvqcYxlQ9f1M');
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

  it('отключённость родителя решает погашающий `UPDATE`, а не снимок до него', () => {
    // Между чтением приглашения и его погашением лежит `scrypt` — десятки
    // миллисекунд, которых `disable` хватает с запасом. Решай отключённость
    // снимок до KDF, погашение прошло бы по устаревшему состоянию; решай её
    // возврат **после** удачного `UPDATE` — отказ зафиксировался бы вместе с
    // погашением: ссылка сгорела бы, пароль остался бы незаданным, а нового
    // приглашения отключённому родителю не выписать.
    const db = open();
    const parentId = createParent(db, 'mama@example.com', NOW);
    const invite = issueParentInvite(db, parentId, NOW);
    disableParent(db, parentId, NOW);

    expect(redeemParentInvite(db, invite.token, PASSWORD, NOW)).toEqual({
      ok: false,
      reason: 'disabled',
    });
    // Ни сессии, ни пароля, ни погашенной ссылки: она заработает, как только
    // родителя включат обратно.
    expect(
      db.prepare<[], { used_at: string | null }>('SELECT used_at FROM parent_invites').get()?.used_at,
    ).toBeNull();
    expect(db.prepare<[], { n: number }>('SELECT count(*) AS n FROM parent_sessions').get()?.n).toBe(0);
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

  it('одинаково проводит дорогую ветку для пустого и слишком длинного пароля известного адреса', () => {
    const db = open();
    parentWithPassword(db);

    expect(loginParent(db, 'mama@example.com', '', NOW)).toEqual({
      ok: false,
      reason: 'bad-password',
    });
    expect(loginParent(db, 'mama@example.com', 'x'.repeat(MAX_SECRET_LENGTH + 1), NOW)).toEqual({
      ok: false,
      reason: 'bad-password',
    });
    expect(loginParent(db, 'никого@example.com', 'x'.repeat(MAX_SECRET_LENGTH + 1), NOW)).toEqual({
      ok: false,
      reason: 'unknown-email',
    });
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

  it('меняет пароль по текущему, выдаёт сессию взамен и гасит устройства детей', () => {
    const db = open();
    const { parentId, session } = parentWithPassword(db);
    const childId = createChild(db, parentId, 'Ученик', NOW);
    markChildReady(db, childId);
    const deviceInvite = issueDeviceInvite(db, childId, 'browser', 'Компьютер', NOW);
    const claimed = redeemDeviceInvite(db, deviceInvite.token, NOW);
    expect(claimed.ok).toBe(true);

    const changed = changeParentPassword(db, parentId, PASSWORD, 'совсем-другой-пароль', at(HOUR_MS));
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.parentId).toBe(parentId);

    // Прежняя сессия мертва, выданная взамен — жива: без неё родитель менял бы
    // пароль ценой собственного выхода на том же запросе.
    expect(resolveParentSession(db, session.token, at(2 * HOUR_MS))).toBeUndefined();
    expect(resolveParentSession(db, changed.session.token, at(2 * HOUR_MS))?.parentId).toBe(parentId);

    // Устройства детей отзываются той же сменой: смысл смены пароля после
    // кражи в том и состоит, что уже выданные токены перестают работать.
    expect(listDevices(db, childId)[0]?.revokedAt).toBe(at(HOUR_MS).toISOString());

    expect(loginParent(db, 'mama@example.com', PASSWORD, at(2 * HOUR_MS)).ok).toBe(false);
    expect(loginParent(db, 'mama@example.com', 'совсем-другой-пароль', at(2 * HOUR_MS)).ok).toBe(true);
  });

  it('не меняет пароль по неверному текущему, слабому новому и у отключённого родителя', () => {
    const db = open();
    const { parentId, session } = parentWithPassword(db);

    expect(changeParentPassword(db, parentId, 'не тот пароль', 'совсем-другой-пароль', at(HOUR_MS)))
      .toEqual({ ok: false, reason: 'bad-password' });
    expect(changeParentPassword(db, parentId, PASSWORD, 'к'.repeat(MIN_PASSWORD_LENGTH - 1), at(HOUR_MS)))
      .toEqual({ ok: false, reason: 'weak-password' });
    expect(changeParentPassword(db, parentId, PASSWORD, 'к'.repeat(MAX_SECRET_LENGTH + 1), at(HOUR_MS)))
      .toEqual({ ok: false, reason: 'weak-password' });
    // Ни один отказ не тронул ни пароль, ни сессию: иначе неудачная попытка
    // выкидывала бы родителя из его же учётной записи.
    expect(resolveParentSession(db, session.token, at(HOUR_MS))?.parentId).toBe(parentId);
    expect(loginParent(db, 'mama@example.com', PASSWORD, at(HOUR_MS)).ok).toBe(true);

    disableParent(db, parentId, at(HOUR_MS));
    expect(changeParentPassword(db, parentId, PASSWORD, 'совсем-другой-пароль', at(2 * HOUR_MS)))
      .toEqual({ ok: false, reason: 'disabled' });
    expect(changeParentPassword(db, 'нет такого родителя', PASSWORD, 'совсем-другой-пароль', at(2 * HOUR_MS)))
      .toEqual({ ok: false, reason: 'unknown-email' });
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

  it('читает родителя по id, называя отключённого отключённым', () => {
    const db = open();
    const { parentId } = parentWithPassword(db);

    expect(readParent(db, parentId)).toEqual({
      id: parentId,
      email: 'mama@example.com',
      hasPassword: true,
      hasPin: false,
      createdAt: NOW.toISOString(),
    });
    expect(readParent(db, 'нет такого родителя')).toBeUndefined();

    // Отключённый читается, но отмеченным: `readParentEmail` возвращает на нём
    // `undefined`, и по одному этому ответу «нет такого» и «отключён»
    // неразличимы — а оператору это два разных отказа.
    disableParent(db, parentId, at(HOUR_MS));
    expect(readParent(db, parentId)?.disabledAt).toBe(at(HOUR_MS).toISOString());
    expect(readParentEmail(db, parentId)).toBeUndefined();
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

describe('PIN родителя', () => {
  const NOW = new Date('2026-08-19T10:00:00.000Z');
  const PASSWORD = 'пароль-подлиннее';
  const PIN_HASH = 'scrypt$16384$8$1$соль$хеш';

  function parentWithSession(db: Database): { parentId: string; token: string } {
    const parentId = createParent(db, 'mama@example.com', NOW);
    const invite = issueParentInvite(db, parentId, NOW);
    const redeemed = redeemParentInvite(db, invite.token, PASSWORD, NOW);
    if (!redeemed.ok) throw new Error(`приглашение не погасилось: ${redeemed.reason}`);
    return { parentId, token: redeemed.session.token };
  }

  it('ставит и читает эталон PIN', () => {
    const db = open();
    const { parentId } = parentWithSession(db);

    expect(readParentPinHash(db, parentId)).toBeUndefined();
    setParentPin(db, parentId, PIN_HASH);

    expect(readParentPinHash(db, parentId)).toBe(PIN_HASH);
  });

  it('не двигает отметку смены учётных данных: сессии и устройства живы', () => {
    const db = open();
    const { parentId, token } = parentWithSession(db);
    const childId = createChild(db, parentId, 'Петя', NOW);
    markChildReady(db, childId);
    const invite = issueDeviceInvite(db, childId, 'browser', '', NOW);
    const claimed = redeemDeviceInvite(db, invite.token, NOW);
    if (!claimed.ok) throw new Error('устройство не заведено');

    setParentPin(db, parentId, PIN_HASH);

    // PIN подтверждает действие уже вошедшего родителя, а не служит входом:
    // гасить им сессии и токены устройств значило бы заново раздавать ссылки.
    const later = new Date(NOW.getTime() + HOUR_MS);
    expect(resolveParentSession(db, token, later)?.parentId).toBe(parentId);
    expect(resolveChildDevice(db, claimed.token, later)?.childId).toBe(childId);
  });

  it('отключённому родителю PIN не поставить и эталона у него нет', () => {
    const db = open();
    const { parentId } = parentWithSession(db);
    setParentPin(db, parentId, PIN_HASH);
    db.prepare('UPDATE parents SET disabled_at = ? WHERE id = ?').run(NOW.toISOString(), parentId);

    expect(() => setParentPin(db, parentId, PIN_HASH)).toThrow(/отключён/u);
    expect(readParentPinHash(db, parentId)).toBeUndefined();
    expect(() => setParentPin(db, 'нет-такого', PIN_HASH)).toThrow(/нет в управляющей базе/u);
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

  it('отдаёт номер выпущенного устройства и читает его по номеру', () => {
    const db = open();
    const parentId = parentWithPassword(db);
    const childId = readyChild(db, parentId);

    const invite = issueDeviceInvite(db, childId, 'agent', 'контроллер', NOW);

    // Номер приходит вместе с токеном: без него выпустивший ссылку искал бы
    // своё же устройство перебором списка.
    expect(readDevice(db, invite.deviceId)).toEqual({
      id: invite.deviceId,
      childId,
      kind: 'agent',
      label: 'контроллер',
      inviteExpiresAt: at(DEVICE_INVITE_TTL_MS).toISOString(),
      createdAt: NOW.toISOString(),
    });
    expect(listDevices(db, childId)).toEqual([readDevice(db, invite.deviceId)]);
    expect(readDevice(db, invite.deviceId + 1)).toBeUndefined();
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

  it('отозванное непогашенное приглашение больше не гасится', () => {
    const db = open();
    const childId = readyChild(db, parentWithPassword(db));
    const invite = issueDeviceInvite(db, childId, 'browser', '', NOW);
    const pending = listDevices(db, childId).find((device) => device.claimedAt === undefined);

    expect(revokeDevice(db, pending?.id ?? -1, at(HOUR_MS))).toBe(true);
    // Родитель отозвал утёкшую ссылку — она обязана перестать работать. Иначе
    // перехвативший её погашает приглашение (и запись становится «подключено»),
    // а выданный ему токен не разрешается никогда: «работает и не работает»
    // разом, вместо честного отказа.
    expect(redeemDeviceInvite(db, invite.token, at(2 * HOUR_MS))).toEqual({
      ok: false,
      reason: 'revoked',
    });
    expect(
      db
        .prepare<[], { n: number }>(
          'SELECT count(*) AS n FROM child_devices WHERE claimed_at IS NOT NULL',
        )
        .get()?.n,
    ).toBe(0);
  });

  it('опрос агента не считается активностью ребёнка', () => {
    const db = open();
    const childId = readyChild(db, parentWithPassword(db));
    const agent = claimedDevice(db, childId, 'agent');
    const laptop = claimedDevice(db, childId);
    db.prepare('UPDATE children SET last_activity_at = NULL WHERE id = ?').run(childId);

    // Контроллер доступа опрашивает `gate/status` раз в двадцать секунд и сам
    // по себе не значит, что за компьютером кто-то сидит: считая его
    // активностью, диспетчер держал бы ребёнка вечно «за экраном».
    expect(resolveChildDevice(db, agent.token, at(HOUR_MS))?.kind).toBe('agent');
    expect(
      db.prepare<[string], { at: string | null }>(
        'SELECT last_activity_at AS at FROM children WHERE id = ?',
      ).get(childId)?.at,
    ).toBeNull();

    expect(resolveChildDevice(db, laptop.token, at(HOUR_MS))?.kind).toBe('browser');
    expect(
      db.prepare<[string], { at: string | null }>(
        'SELECT last_activity_at AS at FROM children WHERE id = ?',
      ).get(childId)?.at,
    ).toBe(at(HOUR_MS).toISOString());
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

describe('суточная квота codex', () => {
  const NOW = new Date('2026-08-19T10:00:00.000Z');

  function seeded(db: Database, id = 'abcdef01'): string {
    return seedChild(db, seedParent(db), id);
  }

  it('считает вызовы по ребёнку и отказывает на пределе', () => {
    const db = open();
    const childId = seeded(db);
    const other = seedChild(db, seedParent(db, 'p2', 'papa@example.com'), 'abcdef02');

    expect(reserveCodexCall(db, childId, NOW, 2)).toEqual({
      ok: true,
      day: '2026-08-19',
      used: 1,
      remaining: 1,
      limit: 2,
    });
    expect(reserveCodexCall(db, childId, NOW, 2).remaining).toBe(0);

    const refused = reserveCodexCall(db, childId, NOW, 2);
    expect(refused.ok).toBe(false);
    // Отказ не должен наращивать счётчик: иначе исчерпанная квота уходила бы
    // за предел, и поднять его на день вручную стало бы нечем.
    expect(refused.used).toBe(2);
    expect(readCodexQuota(db, childId, NOW, 2)).toEqual({
      day: '2026-08-19',
      used: 2,
      remaining: 0,
      limit: 2,
    });

    // Квота у каждого ребёнка своя: сосед по серверу не расходует чужую.
    expect(reserveCodexCall(db, other, NOW, 2)).toMatchObject({ ok: true, used: 1 });
  });

  it('списывает и неудачные вызовы: возврата резерва нет', () => {
    const db = open();
    const childId = seeded(db);

    // Резерв берётся до вызова, и итог вызова его не меняет — иначе зацикливание
    // на ошибках codex обходило бы защиту, ради которой квота и заведена.
    reserveCodexCall(db, childId, NOW, 3);
    reserveCodexCall(db, childId, NOW, 3);

    expect(readCodexQuota(db, childId, NOW, 3)).toMatchObject({ used: 2, remaining: 1 });
  });

  it('два параллельных резерва на границе предела пропускают только один', () => {
    const first = open();
    const childId = seeded(first);
    const second = open();

    expect(reserveCodexCall(first, childId, NOW, 2).ok).toBe(true);

    const winner = reserveCodexCall(first, childId, NOW, 2);
    const loser = reserveCodexCall(second, childId, NOW, 2);

    expect(winner.ok).toBe(true);
    expect(loser.ok).toBe(false);
    expect(
      first.prepare<[], { calls: number }>('SELECT calls FROM codex_quota').get()?.calls,
    ).toBe(2);
  });

  it('сутки сменяются по московской полуночи, а не по UTC', () => {
    const db = open();
    const childId = seeded(db);

    // 23:00 и 02:00 по UTC — это один московский день: полночь UTC его не рвёт.
    reserveCodexCall(db, childId, new Date('2026-08-18T23:00:00.000Z'), 2);
    const sameDay = reserveCodexCall(db, childId, new Date('2026-08-19T02:00:00.000Z'), 2);
    expect(sameDay).toMatchObject({ ok: true, day: '2026-08-19', used: 2 });

    // 20:59 UTC — ещё 19-е по Москве, 21:00 UTC — уже 20-е.
    expect(reserveCodexCall(db, childId, new Date('2026-08-19T20:59:00.000Z'), 2).ok).toBe(false);
    expect(reserveCodexCall(db, childId, new Date('2026-08-19T21:00:00.000Z'), 2)).toMatchObject({
      ok: true,
      day: '2026-08-20',
      used: 1,
    });
    // Вчерашняя строка остаётся: она нужна разбору, а не выдаче.
    expect(readCodexQuota(db, childId, new Date('2026-08-19T20:00:00.000Z'), 2).used).toBe(2);
  });

  it('отвергает неизвестного ребёнка и предел, который не положительное целое', () => {
    const db = open();
    const childId = seeded(db);

    expect(() => reserveCodexCall(db, 'deadbeef', NOW, 2)).toThrow();
    // Нулевой предел неотличим от «квота кончилась навсегда», дробный — от опечатки.
    expect(() => reserveCodexCall(db, childId, NOW, 0)).toThrow(/Предел суточной квоты/);
    expect(() => reserveCodexCall(db, childId, NOW, 1.5)).toThrow(/Предел суточной квоты/);
    expect(() => readCodexQuota(db, childId, NOW, -1)).toThrow(/Предел суточной квоты/);
  });

  it('держит калибровочные константы спеки: суточная квота вызовов', () => {
    expect(CODEX_DAILY_QUOTA).toBe(60);
  });
});

describe('счётчики неудачных входов', () => {
  const NOW = new Date('2026-08-19T12:00:00.000Z');
  const EMAIL = 'mama@example.com';
  const ADDRESS = '203.0.113.7';

  function target(overrides: Partial<LoginTarget> = {}): LoginTarget {
    return { kind: 'password', email: EMAIL, address: ADDRESS, ...overrides };
  }

  function failTimes(db: Database, times: number, over: Partial<LoginTarget> = {}): LoginGate {
    let gate: LoginGate = { allowed: true, retryAfterMs: 0 };
    for (let index = 0; index < times; index += 1) {
      gate = recordLoginFailure(db, target(over), NOW);
    }
    return gate;
  }

  it('пускает, пока серии нет', () => {
    const db = open();

    expect(checkLoginGate(db, target(), NOW)).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(failTimes(db, LOGIN_EMAIL_FAILURE_LIMIT - 1)).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(checkLoginGate(db, target(), NOW).allowed).toBe(true);
  });

  it('серия неудач приводит к паузе, а верный пароль после неё проходит', () => {
    const db = open();

    const locked = failTimes(db, LOGIN_EMAIL_FAILURE_LIMIT);
    expect(locked).toEqual({
      allowed: false,
      reason: 'locked',
      retryAfterMs: LOGIN_LOCKOUT_MS,
    });
    expect(checkLoginGate(db, target(), NOW).allowed).toBe(false);

    // Внутри паузы остаток убывает, но вход закрыт.
    const midway = new Date(NOW.getTime() + LOGIN_LOCKOUT_MS / 2);
    expect(checkLoginGate(db, target(), midway)).toMatchObject({
      allowed: false,
      retryAfterMs: LOGIN_LOCKOUT_MS / 2,
    });

    // После паузы счётчик остыл: тот, кто просто забыл пароль, снова входит.
    const after = new Date(NOW.getTime() + LOGIN_LOCKOUT_MS);
    expect(checkLoginGate(db, target(), after)).toEqual({ allowed: true, retryAfterMs: 0 });

    // И считается заново, а не продолжает старую серию.
    expect(recordLoginFailure(db, target(), after)).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(
      db
        .prepare<[], { failures: number }>(
          "SELECT failures FROM login_attempts WHERE scope = 'email'",
        )
        .get()?.failures,
    ).toBe(1);
  });

  it('убирает остывшие строки, а не копит их без предела', () => {
    const db = open();
    // Ключ по почте задаёт кто угодно снаружи: без уборки неудачные входы —
    // единственная таблица управляющей базы, которую растит неаутентифицированный
    // клиент, и растёт она навсегда.
    for (let index = 0; index < 5; index += 1) {
      recordLoginFailure(db, target({ email: `чужой${String(index)}@example.com` }), NOW);
    }
    const rows = (): number =>
      db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM login_attempts')
        .get()?.count ?? 0;
    expect(rows()).toBeGreaterThan(5);

    const later = new Date(NOW.getTime() + LOGIN_LOCKOUT_MS + 1);
    recordLoginFailure(db, target({ email: 'mama@example.com', address: '198.51.100.9' }), later);

    // Остались только строки последней неудачи: остывшая строка и так начинает
    // серию заново, так что решение от уборки не меняется.
    expect(rows()).toBe(2);
    expect(checkLoginGate(db, target({ email: 'mama@example.com' }), later).allowed).toBe(true);
  });

  it('не убирает строку с испорченной отметкой времени', () => {
    const db = open();
    failTimes(db, LOGIN_EMAIL_FAILURE_LIMIT);
    // Непрочитанная отметка означает неизвестное состояние счётчика, а не
    // давнюю неудачу: убрав её, уборка открыла бы вход тому, кого запретили.
    db.prepare("UPDATE login_attempts SET last_failed_at = 'мусор' WHERE scope = 'email'").run();

    const later = new Date(NOW.getTime() + LOGIN_LOCKOUT_MS * 10);
    recordLoginFailure(db, target({ email: 'papa@example.com' }), later);

    expect(checkLoginGate(db, target(), later)).toMatchObject({ reason: 'unavailable' });
  });

  it('новая неудача внутри паузы её продлевает', () => {
    const db = open();
    failTimes(db, LOGIN_EMAIL_FAILURE_LIMIT);

    // Подбирающий не должен пересиживать запрет, продолжая долбить.
    const midway = new Date(NOW.getTime() + LOGIN_LOCKOUT_MS / 2);
    expect(recordLoginFailure(db, target(), midway).retryAfterMs).toBe(LOGIN_LOCKOUT_MS);
    expect(checkLoginGate(db, target(), new Date(NOW.getTime() + LOGIN_LOCKOUT_MS)).allowed).toBe(
      false,
    );
  });

  it('счётчики по почте и по адресу независимы', () => {
    const db = open();

    // Серия по одному адресу почты не закрывает вход другому с той же машины.
    failTimes(db, LOGIN_EMAIL_FAILURE_LIMIT);
    expect(checkLoginGate(db, target({ email: 'papa@example.com' }), NOW).allowed).toBe(true);
    // Почтовый счётчик, наоборот, не обходится сменой машины: он на почту и есть.
    expect(checkLoginGate(db, target({ address: '198.51.100.1' }), NOW).allowed).toBe(false);

    // Порог по адресу выше почтового: за ним стоит вся семья вместе с NAT.
    for (let index = 0; index < LOGIN_ADDRESS_FAILURE_LIMIT; index += 1) {
      recordLoginFailure(db, target({ email: `сосед${index}@example.com` }), NOW);
    }
    expect(checkLoginGate(db, target({ email: 'papa@example.com' }), NOW)).toMatchObject({
      allowed: false,
      reason: 'locked',
    });
  });

  it('счётчики пароля и PIN раздельные', () => {
    const db = open();

    failTimes(db, LOGIN_EMAIL_FAILURE_LIMIT, { kind: 'pin' });

    expect(checkLoginGate(db, target({ kind: 'pin' }), NOW).allowed).toBe(false);
    // Забытый PIN не должен закрывать вход паролем: это разные секреты.
    expect(checkLoginGate(db, target({ kind: 'password' }), NOW).allowed).toBe(true);
  });

  it('верный секрет гасит почтовый счётчик и не трогает адресный', () => {
    const db = open();
    failTimes(db, LOGIN_EMAIL_FAILURE_LIMIT - 1);

    clearLoginFailures(db, target());

    expect(
      db.prepare<[], { count: number }>("SELECT count(*) AS count FROM login_attempts WHERE scope = 'email'").get()
        ?.count,
    ).toBe(0);
    // Адресный остаётся: знание одного пароля не повод обнулять общий счёт.
    expect(
      db.prepare<[], { failures: number }>("SELECT failures FROM login_attempts WHERE scope = 'address'").get()
        ?.failures,
    ).toBe(LOGIN_EMAIL_FAILURE_LIMIT - 1);
  });

  it('считает попытки без почты и с несуществующим ящиком', () => {
    const db = open();

    // Вход по PIN идёт без почты, но адрес у него есть, и перебор по нему считается.
    failTimes(db, LOGIN_ADDRESS_FAILURE_LIMIT, { kind: 'pin', email: undefined });
    expect(checkLoginGate(db, target({ kind: 'pin', email: undefined }), NOW).allowed).toBe(false);

    // Пустой адрес не повод не считать: общее ведро вместо обхода счётчика.
    expect(recordLoginFailure(db, target({ address: '   ' }), NOW).allowed).toBe(true);
    expect(
      db
        .prepare<[string], { failures: number }>(
          "SELECT failures FROM login_attempts WHERE scope = 'address' AND key = ?",
        )
        .get(UNKNOWN_ADDRESS)?.failures,
    ).toBe(1);
  });

  it('приводит почту к одному ключу независимо от регистра и пробелов', () => {
    const db = open();

    failTimes(db, LOGIN_EMAIL_FAILURE_LIMIT - 1);
    // Иначе `Mama@Example.com ` начинал бы серию заново на каждой попытке.
    expect(recordLoginFailure(db, target({ email: ' Mama@Example.COM ' }), NOW)).toMatchObject({
      allowed: false,
      reason: 'locked',
    });
  });

  it('fail-closed: нечитаемый счётчик не пускает вход', () => {
    const db = open();

    db.exec('DROP TABLE login_attempts');

    expect(checkLoginGate(db, target(), NOW)).toEqual({
      allowed: false,
      reason: 'unavailable',
      retryAfterMs: LOGIN_LOCKOUT_MS,
    });
    // Незаписанная неудача — та же недоступность защиты, а не разрешение.
    expect(recordLoginFailure(db, target(), NOW)).toMatchObject({
      allowed: false,
      reason: 'unavailable',
    });
  });

  it('fail-closed: испорченная отметка времени не считается давней', () => {
    const db = open();
    failTimes(db, 1);
    db.prepare("UPDATE login_attempts SET last_failed_at = 'позавчера'").run();

    expect(checkLoginGate(db, target(), NOW)).toMatchObject({
      allowed: false,
      reason: 'unavailable',
    });
  });

  it('держит калибровочные константы спеки: пороги и пауза', () => {
    expect(LOGIN_EMAIL_FAILURE_LIMIT).toBe(5);
    expect(LOGIN_ADDRESS_FAILURE_LIMIT).toBe(20);
    expect(LOGIN_LOCKOUT_MS).toBe(15 * 60 * 1000);
  });
});

describe('обслуживание родителей', () => {
  const NOW = new Date('2026-08-19T10:00:00.000Z');
  const PASSWORD = 'пароль-подлиннее';

  function at(ms: number): Date {
    return new Date(NOW.getTime() + ms);
  }

  it('находит родителя по адресу в любом регистре и не показывает хешей', () => {
    const db = open();
    const parentId = createParent(db, 'Mama@Example.COM', NOW);

    const found = findParentByEmail(db, ' MAMA@example.com ');
    expect(found).toEqual({
      id: parentId,
      email: 'mama@example.com',
      hasPassword: false,
      hasPin: false,
      createdAt: NOW.toISOString(),
    });
    // Хеши наружу не выходят вовсе: скрипту они не нужны, а напечатать их
    // проще всего именно из такой выборки.
    expect(JSON.stringify(found)).not.toContain('scrypt');
  });

  it('отвечает «нет такого» и на неразобранный адрес, и на чужой', () => {
    const db = open();
    createParent(db, 'mama@example.com', NOW);

    expect(findParentByEmail(db, 'не адрес')).toBeUndefined();
    expect(findParentByEmail(db, '')).toBeUndefined();
    expect(findParentByEmail(db, 'papa@example.com')).toBeUndefined();
  });

  it('показывает отключённого родителя, а не прячет его', () => {
    const db = open();
    const parentId = createParent(db, 'mama@example.com', NOW);
    expect(disableParent(db, parentId, at(HOUR_MS))).toBe(true);

    // Иначе повторное заведение упало бы на UNIQUE, а скрипт сказал бы
    // «такого родителя нет» — про того, кто в базе есть.
    expect(findParentByEmail(db, 'mama@example.com')).toMatchObject({
      id: parentId,
      disabledAt: at(HOUR_MS).toISOString(),
    });
  });

  it('меняет пароль и гасит прежние сессии', () => {
    const db = open();
    const parentId = createParent(db, 'mama@example.com', NOW);
    const invite = issueParentInvite(db, parentId, NOW);
    const redeemed = redeemParentInvite(db, invite.token, PASSWORD, NOW);
    expect(redeemed.ok).toBe(true);
    if (!redeemed.ok) return;

    setParentPassword(db, parentId, 'совсем-другой-пароль', at(HOUR_MS));

    // Старая сессия и старый пароль обязаны перестать работать: иначе смена
    // пароля после кражи ноутбука ничего бы не меняла.
    expect(resolveParentSession(db, redeemed.session.token, at(2 * HOUR_MS))).toBeUndefined();
    expect(loginParent(db, 'mama@example.com', PASSWORD, at(2 * HOUR_MS))).toEqual({
      ok: false,
      reason: 'bad-password',
    });
    const login = loginParent(db, 'mama@example.com', 'совсем-другой-пароль', at(2 * HOUR_MS));
    expect(login.ok).toBe(true);
    expect(findParentByEmail(db, 'mama@example.com')?.hasPassword).toBe(true);
  });

  it('гасит сессию и оба вида приглашений даже в ту же миллисекунду', () => {
    const db = open();
    const parentId = createParent(db, 'mama@example.com', NOW);
    const entered = redeemParentInvite(db, issueParentInvite(db, parentId, NOW).token, PASSWORD, NOW);
    if (!entered.ok) throw new Error('начальный пароль не установлен');
    const parentInvite = issueParentInvite(db, parentId, NOW);
    const childId = createChild(db, parentId, 'Сын', NOW);
    markChildReady(db, childId);
    const deviceInvite = issueDeviceInvite(db, childId, 'browser', 'ноутбук', NOW);
    const claimed = redeemDeviceInvite(
      db,
      issueDeviceInvite(db, childId, 'agent', 'контроллер', NOW).token,
      NOW,
    );
    if (!claimed.ok) throw new Error('тестовое устройство не погашено');

    setParentPassword(db, parentId, 'совсем-другой-пароль', NOW);

    expect(resolveParentSession(db, entered.session.token, NOW)).toBeUndefined();
    expect(readParentInvite(db, parentInvite.token, NOW)).toEqual({ ok: false, reason: 'expired' });
    expect(redeemDeviceInvite(db, deviceInvite.token, NOW)).toEqual({ ok: false, reason: 'expired' });
    expect(resolveChildDevice(db, claimed.token, NOW)).toBeUndefined();
  });

  it('при смене пароля по ссылке оставляет только новую сессию в ту же миллисекунду', () => {
    const db = open();
    const parentId = createParent(db, 'mama@example.com', NOW);
    const first = redeemParentInvite(db, issueParentInvite(db, parentId, NOW).token, PASSWORD, NOW);
    if (!first.ok) throw new Error('начальный пароль не установлен');
    const changed = redeemParentInvite(
      db,
      issueParentInvite(db, parentId, NOW).token,
      'совсем-другой-пароль',
      NOW,
    );
    if (!changed.ok) throw new Error('пароль по второй ссылке не сменился');

    expect(resolveParentSession(db, first.session.token, NOW)).toBeUndefined();
    expect(resolveParentSession(db, changed.session.token, NOW)).toMatchObject({ parentId });
  });

  it('гасит токен детского устройства сменой родительского пароля', () => {
    const db = open();
    const parentId = createParent(db, 'mama@example.com', NOW);
    const childId = createChild(db, parentId, 'Сын', NOW);
    markChildReady(db, childId);
    const claimed = redeemDeviceInvite(
      db,
      issueDeviceInvite(db, childId, 'browser', 'ноутбук', NOW).token,
      NOW,
    );
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;

    setParentPassword(db, parentId, 'совсем-другой-пароль', at(HOUR_MS));

    expect(resolveChildDevice(db, claimed.token, at(2 * HOUR_MS))).toBeUndefined();
  });

  // Приглашение — это право задать пароль заново, то есть полный вход. Без
  // этого утёкшая ссылка оставалась бы способом отобрать учётную запись ещё
  // неделю, а средство, которое от неё советуют, — смена пароля — не помогало бы.
  it('гасит невыкупленное приглашение сменой пароля', () => {
    const db = open();
    const parentId = createParent(db, 'mama@example.com', NOW);
    const stale = issueParentInvite(db, parentId, NOW);
    const first = redeemParentInvite(db, issueParentInvite(db, parentId, NOW).token, PASSWORD, NOW);
    expect(first.ok).toBe(true);

    setParentPassword(db, parentId, 'совсем-другой-пароль', at(HOUR_MS));

    expect(readParentInvite(db, stale.token, at(2 * HOUR_MS)))
      .toEqual({ ok: false, reason: 'expired' });
    expect(redeemParentInvite(db, stale.token, 'третий-пароль-подлиннее', at(2 * HOUR_MS)))
      .toEqual({ ok: false, reason: 'expired' });
    // Пароль от погашенного приглашения не должен был смениться.
    expect(loginParent(db, 'mama@example.com', 'третий-пароль-подлиннее', at(2 * HOUR_MS)))
      .toEqual({ ok: false, reason: 'bad-password' });
    expect(loginParent(db, 'mama@example.com', 'совсем-другой-пароль', at(2 * HOUR_MS)).ok).toBe(true);
  });

  it('оставляет в силе приглашение, выпущенное после смены пароля', () => {
    const db = open();
    const parentId = createParent(db, 'mama@example.com', NOW);
    expect(redeemParentInvite(db, issueParentInvite(db, parentId, NOW).token, PASSWORD, NOW).ok)
      .toBe(true);
    setParentPassword(db, parentId, 'совсем-другой-пароль', at(HOUR_MS));

    const fresh = issueParentInvite(db, parentId, at(2 * HOUR_MS));
    expect(redeemParentInvite(db, fresh.token, 'третий-пароль-подлиннее', at(3 * HOUR_MS)).ok)
      .toBe(true);
  });

  // Токен уже выданного устройства смена пароля гасит (`claimed_at` старше
  // отметки). Невыкупленная ссылка обязана гаснуть вместе с ним: погашенная
  // после смены, она поставила бы себе свежий `claimed_at` и пережила бы
  // ровно то событие, которым её и снимали.
  it('гасит невыкупленное приглашение устройства сменой пароля', () => {
    const db = open();
    const parentId = createParent(db, 'mama@example.com', NOW);
    const childId = createChild(db, parentId, 'Сын', NOW);
    markChildReady(db, childId);
    const stale = issueDeviceInvite(db, childId, 'agent', 'контроллер', NOW);

    setParentPassword(db, parentId, 'совсем-другой-пароль', at(HOUR_MS));

    expect(redeemDeviceInvite(db, stale.token, at(2 * HOUR_MS)))
      .toEqual({ ok: false, reason: 'expired' });

    // Выпущенная после смены — работает: гаснет не всё подряд, а выданное до неё.
    const fresh = issueDeviceInvite(db, childId, 'agent', 'контроллер', at(3 * HOUR_MS));
    const claimed = redeemDeviceInvite(db, fresh.token, at(4 * HOUR_MS));
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    expect(resolveChildDevice(db, claimed.token, at(5 * HOUR_MS))).toMatchObject({ childId });
  });

  it('отказывается ставить короткий, слишком длинный или чужой пароль', () => {
    const db = open();
    const parentId = createParent(db, 'mama@example.com', NOW);

    expect(() => setParentPassword(db, parentId, 'к'.repeat(MIN_PASSWORD_LENGTH - 1), NOW))
      .toThrow(/короче/u);
    expect(() => setParentPassword(db, parentId, 'д'.repeat(1000), NOW)).toThrow(/длиннее/u);
    expect(() => setParentPassword(db, 'нет-такого', PASSWORD, NOW)).toThrow(/нет в управляющей базе/u);
    // Пароль отключённого не меняется: сначала его включают обратно.
    disableParent(db, parentId, NOW);
    expect(() => setParentPassword(db, parentId, PASSWORD, NOW)).toThrow(/отключён/u);
  });

  it('отключение необратимо для входа и повторно ничего не переписывает', () => {
    const db = open();
    const parentId = createParent(db, 'mama@example.com', NOW);
    const invite = issueParentInvite(db, parentId, NOW);
    const redeemed = redeemParentInvite(db, invite.token, PASSWORD, NOW);
    expect(redeemed.ok).toBe(true);
    if (!redeemed.ok) return;

    expect(disableParent(db, parentId, at(HOUR_MS))).toBe(true);
    expect(loginParent(db, 'mama@example.com', PASSWORD, at(2 * HOUR_MS))).toEqual({
      ok: false,
      reason: 'disabled',
    });
    expect(resolveParentSession(db, redeemed.session.token, at(2 * HOUR_MS))).toBeUndefined();

    // Второе отключение — не ошибка, но и не новая отметка: она осталась от
    // первого, и по ней разбирают, когда доступ закрыли.
    expect(disableParent(db, parentId, at(DAY_MS))).toBe(false);
    expect(findParentByEmail(db, 'mama@example.com')?.disabledAt).toBe(at(HOUR_MS).toISOString());
  });

  it('перечисляет всех детей всех родителей, включая выведенных', () => {
    const db = open();
    const mama = createParent(db, 'mama@example.com', NOW);
    const papa = createParent(db, 'papa@example.com', NOW);
    const ready = createChild(db, mama, 'Сын', NOW);
    markChildReady(db, ready);
    const provisioning = createChild(db, papa, 'Дочь', at(HOUR_MS));
    const retired = createChild(db, mama, 'Племянник', at(2 * HOUR_MS));
    markChildReady(db, retired);
    retireChild(db, retired, at(3 * HOUR_MS));

    // Снятию копии нужны все: выведенный ребёнок хранит прогресс так же, как
    // обслуживаемый, а `listServiceableChildren` показывает только готовых.
    expect(listAllChildren(db).map((child) => child.id)).toEqual([ready, provisioning, retired]);
  });

  it('не отдаёт на обслуживание детей отключённого родителя', () => {
    const db = open();
    const mama = createParent(db, 'mama@example.com', NOW);
    const papa = createParent(db, 'papa@example.com', NOW);
    const mine = createChild(db, mama, 'Сын', NOW);
    markChildReady(db, mine);
    const other = createChild(db, papa, 'Дочь', at(HOUR_MS));
    markChildReady(db, other);

    expect(listServiceableChildren(db).map((child) => child.id)).toEqual([mine, other]);

    // Диспетчер и `prefetch` приходят без предъявителя, то есть мимо всякой
    // проверки `disabled_at`: не отсечь отключённую семью здесь значит и дальше
    // тратить на неё суточную квоту модели.
    disableParent(db, papa, at(2 * HOUR_MS));
    expect(listServiceableChildren(db).map((child) => child.id)).toEqual([mine]);
    // Снятию копии отключённый родитель не помеха: его прогресс никуда не делся.
    expect(listAllChildren(db).map((child) => child.id)).toEqual([mine, other]);
  });
});

describe('оператор админки', () => {
  const NOW = new Date('2026-08-21T09:00:00.000Z');
  const EMAIL = 'operator@example.com';
  const PASSWORD = 'пароль-оператора-длинный';

  function at(ms: number): Date {
    return new Date(NOW.getTime() + ms);
  }

  /** Заведённый оператор с паролем: без него не проверить ни один вход. */
  function seedAdmin(db: Database, email = EMAIL): string {
    const adminId = createAdmin(db, email, NOW);
    setAdminPassword(db, adminId, PASSWORD, NOW);
    return adminId;
  }

  function loggedIn(db: Database, now: Date = NOW): { adminId: string; token: string } {
    const adminId = seedAdmin(db);
    const result = loginAdmin(db, EMAIL, PASSWORD, now);
    if (!result.ok) throw new Error(`вход не прошёл: ${result.reason}`);
    return { adminId, token: result.session.token };
  }

  it('заводит оператора и находит его по адресу в любом регистре без хешей', () => {
    const db = open();
    const adminId = createAdmin(db, ' Operator@Example.COM ', NOW);

    const found = findAdminByEmail(db, 'OPERATOR@example.com');
    expect(found).toEqual({
      id: adminId,
      email: EMAIL,
      hasPassword: false,
      createdAt: NOW.toISOString(),
    });
    // Хеши наружу не выходят вовсе: CLI они не нужны, а напечатать их проще
    // всего именно из такой выборки.
    expect(JSON.stringify(found)).not.toContain('scrypt');

    setAdminPassword(db, adminId, PASSWORD, NOW);
    expect(findAdminByEmail(db, EMAIL)).toMatchObject({ hasPassword: true });
  });

  it('отказывается заводить второго оператора с тем же адресом и не разбирает не адрес', () => {
    const db = open();
    createAdmin(db, EMAIL, NOW);

    expect(() => createAdmin(db, EMAIL, NOW)).toThrow(/уже заведён/u);
    expect(() => createAdmin(db, 'не адрес', NOW)).toThrow(/не похож на электронную почту/u);
    expect(findAdminByEmail(db, 'не адрес')).toBeUndefined();
    expect(findAdminByEmail(db, 'другой@example.com')).toBeUndefined();
  });

  it('показывает отключённого оператора, а не прячет его', () => {
    const db = open();
    const adminId = seedAdmin(db);
    expect(disableAdmin(db, adminId, at(HOUR_MS))).toBe(true);
    // Повторное отключение отметку не переписывает: она осталась от первого.
    expect(disableAdmin(db, adminId, at(2 * HOUR_MS))).toBe(false);

    expect(findAdminByEmail(db, EMAIL)).toMatchObject({
      id: adminId,
      disabledAt: at(HOUR_MS).toISOString(),
    });
  });

  it('пускает верным паролем и разрешает выданную сессию в предъявителя', () => {
    const db = open();
    const adminId = seedAdmin(db);

    const result = loginAdmin(db, ' OPERATOR@example.com ', PASSWORD, NOW);
    expect(result).toMatchObject({ ok: true, adminId });
    if (!result.ok) throw new Error('вход обязан пройти');
    expect(result.session.expiresAt).toBe(at(ADMIN_SESSION_MAX_MS).toISOString());
    // В базе — только отпечаток: её дамп войти не даёт.
    const stored = db
      .prepare<[string], { token_hash: string }>(
        'SELECT token_hash FROM admin_sessions WHERE admin_id = ?',
      )
      .get(adminId);
    expect(stored?.token_hash).toBe(hashToken(result.session.token));
    expect(stored?.token_hash).not.toBe(result.session.token);

    expect(resolveAdminSession(db, result.session.token, at(60_000))).toEqual({
      adminId,
      email: EMAIL,
    });
  });

  it('отказывает неверным паролем, неизвестным адресом и оператором без пароля', () => {
    const db = open();
    seedAdmin(db);
    const noPassword = createAdmin(db, 'second@example.com', NOW);

    expect(loginAdmin(db, EMAIL, 'пароль-оператора-другой', NOW)).toEqual({
      ok: false,
      reason: 'bad-password',
    });
    expect(loginAdmin(db, EMAIL, '', NOW)).toEqual({ ok: false, reason: 'bad-password' });
    expect(loginAdmin(db, EMAIL, 'я'.repeat(MAX_SECRET_LENGTH + 1), NOW)).toEqual({
      ok: false,
      reason: 'bad-password',
    });
    expect(loginAdmin(db, 'никто@example.com', PASSWORD, NOW)).toEqual({
      ok: false,
      reason: 'unknown-email',
    });
    expect(loginAdmin(db, 'не адрес', PASSWORD, NOW)).toEqual({
      ok: false,
      reason: 'unknown-email',
    });
    expect(loginAdmin(db, 'second@example.com', PASSWORD, NOW)).toEqual({
      ok: false,
      reason: 'no-password',
    });
    // Ни один отказ не завёл сессии — иначе отказ был бы входом.
    expect(
      db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM admin_sessions').get(),
    ).toEqual({ count: 0 });
    expect(noPassword).toMatch(/^[0-9a-f]{32}$/u);
  });

  it('отказывает отключённому оператору и гасит его живую сессию', () => {
    const db = open();
    const { adminId, token } = loggedIn(db);
    expect(resolveAdminSession(db, token, at(60_000))).toMatchObject({ adminId });

    disableAdmin(db, adminId, at(2 * 60_000));

    // Ни одной строки сессии отключение не переписывает: её гасит тот же текст
    // условия, которым сессия и проверяется.
    expect(
      db
        .prepare<[string], { revoked_at: string | null }>(
          'SELECT revoked_at FROM admin_sessions WHERE admin_id = ?',
        )
        .get(adminId)?.revoked_at,
    ).toBeNull();
    expect(resolveAdminSession(db, token, at(3 * 60_000))).toBeUndefined();
    expect(loginAdmin(db, EMAIL, PASSWORD, at(3 * 60_000))).toEqual({
      ok: false,
      reason: 'disabled',
    });
  });

  it('гасит сессию бездействием и подновляет отметку не чаще SESSION_TOUCH_MS', () => {
    const db = open();
    const { token } = loggedIn(db);

    // Раньше порога подновления отметка остаётся прежней: запись на каждый
    // запрос — это запись в WAL на каждый опрос страницы.
    expect(resolveAdminSession(db, token, at(SESSION_TOUCH_MS - 1000))).toBeDefined();
    const lastSeen = (): string =>
      db
        .prepare<[], { last_seen_at: string }>('SELECT last_seen_at FROM admin_sessions')
        .get()?.last_seen_at ?? '';
    expect(lastSeen()).toBe(NOW.toISOString());

    expect(resolveAdminSession(db, token, at(SESSION_TOUCH_MS))).toBeDefined();
    expect(lastSeen()).toBe(at(SESSION_TOUCH_MS).toISOString());

    // Отсчёт бездействия идёт от подновлённой отметки, а не от входа.
    const busy = SESSION_TOUCH_MS + ADMIN_SESSION_IDLE_MS - 1000;
    expect(resolveAdminSession(db, token, at(busy))).toBeDefined();
    expect(lastSeen()).toBe(at(busy).toISOString());
    expect(resolveAdminSession(db, token, at(busy + ADMIN_SESSION_IDLE_MS))).toBeUndefined();
  });

  it('гасит сессию потолком даже у того, кто не отрывается от экрана', () => {
    const db = open();
    const { token } = loggedIn(db);

    // Шаг меньше срока бездействия: вкладка живая, и гасить её нечему, кроме
    // потолка. Без него ежедневно открываемая вкладка держала бы вход вечно.
    const step = 25 * 60 * 1000;
    let elapsed = step;
    for (; elapsed < ADMIN_SESSION_MAX_MS; elapsed += step) {
      expect(resolveAdminSession(db, token, at(elapsed))).toMatchObject({ email: EMAIL });
    }
    expect(elapsed).toBeGreaterThanOrEqual(ADMIN_SESSION_MAX_MS);
    expect(resolveAdminSession(db, token, at(elapsed))).toBeUndefined();
  });

  it('гасит сменой пароля даже сессию, выданную в ту же миллисекунду', () => {
    const db = open();
    const { adminId, token } = loggedIn(db);

    // Отметка `credentials_changed_at` совпадает с `created_at` сессии, и
    // сравнением строк их не упорядочить: без явного погашения украденная
    // cookie пережила бы смену пароля, которую от неё и советуют.
    setAdminPassword(db, adminId, 'пароль-оператора-новый!', NOW);

    expect(resolveAdminSession(db, token, at(60_000))).toBeUndefined();
    expect(loginAdmin(db, EMAIL, PASSWORD, at(60_000))).toEqual({
      ok: false,
      reason: 'bad-password',
    });
    const fresh = loginAdmin(db, EMAIL, 'пароль-оператора-новый!', at(60_000));
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) throw new Error('вход новым паролем обязан пройти');
    expect(resolveAdminSession(db, fresh.session.token, at(2 * 60_000))).toMatchObject({ adminId });
  });

  it('меряет длину пароля до KDF и не трогает отключённого', () => {
    const db = open();
    const adminId = createAdmin(db, EMAIL, NOW);

    expect(() => setAdminPassword(db, adminId, 'к'.repeat(MIN_ADMIN_PASSWORD_LENGTH - 1), NOW)).toThrow(
      /короче/u,
    );
    expect(() => setAdminPassword(db, adminId, 'д'.repeat(MAX_SECRET_LENGTH + 1), NOW)).toThrow(
      /длиннее/u,
    );
    // Ни один из отказов ничего не записал: пароля у оператора по-прежнему нет.
    expect(findAdminByEmail(db, EMAIL)).toMatchObject({ hasPassword: false });

    disableAdmin(db, adminId, at(HOUR_MS));
    expect(() => setAdminPassword(db, adminId, PASSWORD, at(2 * HOUR_MS))).toThrow(/отключён/u);
    expect(() => setAdminPassword(db, 'нет такого', PASSWORD, NOW)).toThrow(/нет в управляющей базе/u);
  });

  it('выход гасит сессию и повторным не считается', () => {
    const db = open();
    const { token } = loggedIn(db);

    expect(revokeAdminSession(db, token, at(60_000))).toBe(true);
    expect(resolveAdminSession(db, token, at(2 * 60_000))).toBeUndefined();
    expect(revokeAdminSession(db, token, at(3 * 60_000))).toBe(false);
    // Неизвестный токен — тот же ответ, без исключения.
    expect(revokeAdminSession(db, 'посторонний токен', NOW)).toBe(false);
    expect(resolveAdminSession(db, 'посторонний токен', NOW)).toBeUndefined();
  });

  it('считает перебор пароля оператора отдельно от родительского', () => {
    const db = open();
    const target: LoginTarget = { kind: 'admin', email: EMAIL, address: '203.0.113.7' };

    for (let i = 0; i < LOGIN_EMAIL_FAILURE_LIMIT; i += 1) {
      recordLoginFailure(db, target, NOW);
    }
    expect(checkLoginGate(db, target, NOW)).toMatchObject({ allowed: false, reason: 'locked' });

    // Общий счётчик означал бы, что перебор чужого родительского пароля
    // запирает вход оператору, то есть служит способом ослепить его.
    expect(
      checkLoginGate(db, { kind: 'password', email: EMAIL, address: '198.51.100.4' }, NOW),
    ).toMatchObject({ allowed: true });
    expect(
      checkLoginGate(db, { kind: 'pin', email: EMAIL, address: '198.51.100.4' }, NOW),
    ).toMatchObject({ allowed: true });

    clearLoginFailures(db, target);
    expect(checkLoginGate(db, target, NOW)).toMatchObject({ allowed: true });
  });

  it('держит калибровочные константы спеки: пароль и сроки сессии оператора', () => {
    expect(MIN_ADMIN_PASSWORD_LENGTH).toBe(16);
    expect(ADMIN_SESSION_IDLE_MS).toBe(30 * 60 * 1000);
    expect(ADMIN_SESSION_MAX_MS).toBe(8 * 60 * 60 * 1000);
  });
});

describe('журнал действий оператора', () => {
  const NOW = new Date('2026-08-21T09:00:00.000Z');

  function seedAdmin(db: Database, id = 'a1', email = 'operator@example.com'): string {
    db.prepare('INSERT INTO admins (id, email) VALUES (?, ?)').run(id, email);
    return id;
  }

  function at(ms: number): Date {
    return new Date(NOW.getTime() + ms);
  }

  it('пишет действие целиком и читает его обратно', () => {
    const db = open();
    const adminId = seedAdmin(db);
    const parentId = seedParent(db);
    const childId = seedChild(db, parentId);

    const id = recordAdminAudit(
      db,
      {
        adminId,
        action: 'impersonation-start',
        childId,
        parentId,
        detail: 'role=browser',
      },
      NOW,
    );

    expect(listAdminAudit(db, { limit: 10 })).toEqual({
      entries: [
        {
          id,
          adminId,
          at: NOW.toISOString(),
          action: 'impersonation-start',
          childId,
          parentId,
          detail: 'role=browser',
        },
      ],
    });
  });

  it('не заводит пустых полей у записи без семьи и подробностей', () => {
    const db = open();
    const adminId = seedAdmin(db);
    recordAdminAudit(db, { adminId, action: 'login' }, NOW);

    const [entry] = listAdminAudit(db, { limit: 10 }).entries;
    // `undefined` в необязательных полях, а не `null`: экран отличает «не было»
    // от «пусто», и `null` пролез бы в текст фильтра как значение.
    expect(entry).toEqual({ id: entry?.id, adminId, at: NOW.toISOString(), action: 'login' });
    expect(Object.keys(entry ?? {})).not.toContain('childId');
  });

  it('отдаёт новые сверху и разводит одинаковые отметки по номеру', () => {
    const db = open();
    const adminId = seedAdmin(db);
    recordAdminAudit(db, { adminId, action: 'login', detail: 'первый' }, NOW);
    // Две записи в одну миллисекунду: без номера в порядке они шли бы как
    // попадётся, и страница теряла бы одну из них на границе.
    recordAdminAudit(db, { adminId, action: 'logout', detail: 'второй' }, NOW);
    recordAdminAudit(db, { adminId, action: 'login', detail: 'третий' }, at(1000));

    expect(listAdminAudit(db, { limit: 10 }).entries.map((entry) => entry.detail)).toEqual([
      'третий',
      'второй',
      'первый',
    ]);
  });

  it('режет страницу и продолжает её курсором без потерь и повторов', () => {
    const db = open();
    const adminId = seedAdmin(db);
    for (let index = 0; index < 5; index += 1) {
      // Первые две — в одну отметку: курсор обязан пережить именно этот случай.
      recordAdminAudit(db, { adminId, action: 'login', detail: `№${index}` }, at(index < 2 ? 0 : index));
    }

    const first = listAdminAudit(db, { limit: 2 });
    expect(first.entries.map((entry) => entry.detail)).toEqual(['№4', '№3']);
    expect(first.next).toEqual({ at: at(3).toISOString(), id: first.entries[1]?.id });

    const second = listAdminAudit(db, { limit: 2, before: first.next });
    expect(second.entries.map((entry) => entry.detail)).toEqual(['№2', '№1']);

    const third = listAdminAudit(db, { limit: 2, before: second.next });
    expect(third.entries.map((entry) => entry.detail)).toEqual(['№0']);
    // Хвост ровно кончился — курсора дальше нет, иначе экран просил бы пустую
    // страницу вечно.
    expect(third.next).toBeUndefined();
  });

  it('фильтрует ленту по действию и продолжает фильтр курсором', () => {
    const db = open();
    const adminId = seedAdmin(db);
    recordAdminAudit(db, { adminId, action: 'login', detail: 'вход-1' }, at(0));
    recordAdminAudit(db, { adminId, action: 'login-failed', detail: 'мимо' }, at(1));
    recordAdminAudit(db, { adminId, action: 'login', detail: 'вход-2' }, at(2));
    recordAdminAudit(db, { adminId, action: 'login', detail: 'вход-3' }, at(3));

    const page = listAdminAudit(db, { limit: 2, action: 'login' });
    expect(page.entries.map((entry) => entry.detail)).toEqual(['вход-3', 'вход-2']);
    // Курсор строится по отфильтрованной ленте: сползание на чужое действие
    // прятало бы половину страницы за записью, которой в фильтре нет.
    const next = listAdminAudit(db, { limit: 2, action: 'login', before: page.next });
    expect(next.entries.map((entry) => entry.detail)).toEqual(['вход-1']);
    expect(next.next).toBeUndefined();
  });

  it('держит калибровочные константы спеки: размер страницы журнала действий', () => {
    // Число вписано руками: ожидание из той же константы её подмену не ловит.
    expect(ADMIN_AUDIT_PAGE).toBe(200);
  });

  it('не обещает следующей страницы, когда записей ровно на страницу', () => {
    const db = open();
    const adminId = seedAdmin(db);
    recordAdminAudit(db, { adminId, action: 'login' }, NOW);
    recordAdminAudit(db, { adminId, action: 'logout' }, at(1));

    expect(listAdminAudit(db, { limit: 2 }).next).toBeUndefined();
  });

  it('отдаёт пустую страницу и пустой журнал, и пустой хвост за курсором', () => {
    const db = open();
    expect(listAdminAudit(db, { limit: 10 })).toEqual({ entries: [] });
    expect(listAdminAudit(db, { limit: 10, before: { at: NOW.toISOString(), id: 1 } })).toEqual({
      entries: [],
    });
  });

  it('отвергает действие вне списка и нецелый размер страницы', () => {
    const db = open();
    const adminId = seedAdmin(db);

    expect(() =>
      recordAdminAudit(db, { adminId, action: 'выгрузка' as AdminAuditAction }, NOW),
    ).toThrow(/не входит в журнал действий/);
    expect(db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM admin_audit').get()).toEqual(
      { count: 0 },
    );

    for (const limit of [0, -1, 2.5]) {
      expect(() => listAdminAudit(db, { limit })).toThrow(/положительным целым/);
    }
  });

  it('не молчит о записи с неизвестным действием, попавшей в таблицу мимо кода', () => {
    const db = open();
    const adminId = seedAdmin(db);
    db.prepare('INSERT INTO admin_audit (admin_id, action) VALUES (?, ?)').run(adminId, 'выгрузка');

    expect(() => listAdminAudit(db, { limit: 10 })).toThrow(/неизвестное действие/);
  });

  it('держит закрытый список действий: имена вписаны руками', () => {
    expect([...ADMIN_AUDIT_ACTIONS]).toEqual([
      'login',
      'login-failed',
      'logout',
      'impersonation-start',
      'impersonation-end',
      'parent-create',
      'parent-invite',
      'parent-password',
      'course-create',
      'course-update',
      'course-publish',
      'course-archive',
      'course-retry',
    ]);
    expect(isAdminAuditAction('impersonation-end')).toBe(true);
    expect(isAdminAuditAction('impersonation')).toBe(false);
  });
});

describe('имперсонация оператора', () => {
  const NOW = new Date('2026-08-21T09:00:00.000Z');
  const EMAIL = 'operator@example.com';
  const PASSWORD = 'пароль-оператора-длинный';

  function at(ms: number): Date {
    return new Date(NOW.getTime() + ms);
  }

  function seedAdmin(db: Database, id = 'a1', email = EMAIL): string {
    db.prepare('INSERT INTO admins (id, email) VALUES (?, ?)').run(id, email);
    return id;
  }

  /** Обслуживаемый ребёнок: без готовой базы имперсонировать нечего. */
  function seedReadyChild(db: Database, id = 'abcdef01'): string {
    const parentId = seedParent(db, `p-${id}`, `mama-${id}@example.com`);
    db.prepare('INSERT INTO children (id, parent_id, name, status) VALUES (?, ?, ?, ?)').run(
      id,
      parentId,
      'Сын',
      'ready',
    );
    return id;
  }

  function start(
    db: Database,
    adminId: string,
    childId: string,
    role = 'browser',
    now: Date = NOW,
  ): { token: string; expiresAt: string } {
    const result = startImpersonation(db, { adminId, childId, role }, now);
    if (!result.ok) throw new Error(`имперсонация не началась: ${result.reason}`);
    return { token: result.session.token, expiresAt: result.session.expiresAt };
  }

  it('заводит имперсонацию, хранит только отпечаток и разрешает её в предъявителя', () => {
    const db = open();
    const adminId = seedAdmin(db);
    const childId = seedReadyChild(db);

    const result = startImpersonation(db, { adminId, childId, role: 'parent' }, NOW);
    expect(result).toMatchObject({ ok: true, childId, parentId: `p-${childId}`, role: 'parent' });
    if (!result.ok) throw new Error('имперсонация обязана начаться');
    expect(result.session.expiresAt).toBe(at(IMPERSONATION_TTL_MS).toISOString());

    // В базе — только отпечаток: её дамп в чужую семью не пускает.
    const stored = db
      .prepare<[string], { token_hash: string; role: string }>(
        'SELECT token_hash, role FROM admin_impersonations WHERE admin_id = ?',
      )
      .get(adminId);
    expect(stored?.token_hash).toBe(hashToken(result.session.token));
    expect(stored?.token_hash).not.toBe(result.session.token);
    expect(stored?.role).toBe('parent');

    expect(resolveImpersonation(db, result.session.token, at(60_000))).toEqual({
      adminId,
      adminEmail: EMAIL,
      childId,
      parentId: `p-${childId}`,
      childName: 'Сын',
      role: 'parent',
      expiresAt: at(IMPERSONATION_TTL_MS).toISOString(),
    });
  });

  it('гасит предыдущую живую имперсонацию того же оператора', () => {
    const db = open();
    const adminId = seedAdmin(db);
    const first = seedReadyChild(db, 'abcdef01');
    const second = seedReadyChild(db, 'abcdef02');

    const one = start(db, adminId, first);
    const two = start(db, adminId, second, 'browser', at(60_000));

    // «В чьей я семье» не должно быть вопросом к вкладке браузера: живая
    // имперсонация у оператора ровно одна.
    expect(resolveImpersonation(db, one.token, at(2 * 60_000))).toBeUndefined();
    expect(resolveImpersonation(db, two.token, at(2 * 60_000))).toMatchObject({
      childId: second,
    });
    expect(
      db
        .prepare<[string], { revoked_at: string | null }>(
          'SELECT revoked_at FROM admin_impersonations WHERE token_hash = ?',
        )
        .get(hashToken(one.token))?.revoked_at,
    ).toBe(at(60_000).toISOString());

    // Чужого оператора вытеснение не касается: у каждого своя одна.
    const other = seedAdmin(db, 'a2', 'second@example.com');
    const alien = start(db, other, first, 'parent', at(3 * 60_000));
    expect(resolveImpersonation(db, two.token, at(4 * 60_000))).toMatchObject({ childId: second });
    expect(resolveImpersonation(db, alien.token, at(4 * 60_000))).toMatchObject({ adminId: other });
  });

  it('истекает по сроку и гасится выходом', () => {
    const db = open();
    const adminId = seedAdmin(db);
    const childId = seedReadyChild(db);
    const { token } = start(db, adminId, childId);

    expect(resolveImpersonation(db, token, at(IMPERSONATION_TTL_MS - 1))).toBeDefined();
    expect(resolveImpersonation(db, token, at(IMPERSONATION_TTL_MS))).toBeUndefined();

    const fresh = start(db, adminId, childId, 'browser', at(IMPERSONATION_TTL_MS));
    expect(revokeImpersonation(db, fresh.token, at(IMPERSONATION_TTL_MS + 60_000))).toBe(true);
    expect(resolveImpersonation(db, fresh.token, at(IMPERSONATION_TTL_MS + 2 * 60_000))).toBeUndefined();
    // Повторный выход и посторонний токен — тот же ответ, без исключения.
    expect(revokeImpersonation(db, fresh.token, at(IMPERSONATION_TTL_MS + 3 * 60_000))).toBe(false);
    expect(revokeImpersonation(db, 'посторонний токен', NOW)).toBe(false);
    expect(resolveImpersonation(db, 'посторонний токен', NOW)).toBeUndefined();
  });

  it('гасит имперсонацию сменой пароля в ту же миллисекунду и отключением оператора', () => {
    const db = open();
    const adminId = createAdmin(db, EMAIL, NOW);
    setAdminPassword(db, adminId, PASSWORD, NOW);
    const childId = seedReadyChild(db);
    const { token } = start(db, adminId, childId);

    // Отметка `credentials_changed_at` совпадает с `created_at` строки, и
    // сравнением строк их не упорядочить: без явного погашения уведённая
    // cookie имперсонации пережила бы смену пароля.
    setAdminPassword(db, adminId, 'пароль-оператора-новый!', NOW);
    expect(resolveImpersonation(db, token, at(60_000))).toBeUndefined();

    const fresh = start(db, adminId, childId, 'browser', at(60_000));
    disableAdmin(db, adminId, at(2 * 60_000));
    // Отключение ни одной строки не переписывает: её гасит тот же текст
    // условия, которым имперсонация и проверяется.
    expect(
      db
        .prepare<[string], { revoked_at: string | null }>(
          'SELECT revoked_at FROM admin_impersonations WHERE token_hash = ?',
        )
        .get(hashToken(fresh.token))?.revoked_at,
    ).toBeNull();
    expect(resolveImpersonation(db, fresh.token, at(3 * 60_000))).toBeUndefined();
  });

  it('отказывает агенту и необслуживаемому ребёнку, ничего не записав', () => {
    const db = open();
    const adminId = seedAdmin(db);
    const ready = seedReadyChild(db);
    const parentId = seedParent(db, 'p-provisioning', 'papa@example.com');
    db.prepare('INSERT INTO children (id, parent_id, name) VALUES (?, ?, ?)').run(
      'abcdef03',
      parentId,
      'Дочь',
    );
    const retired = seedReadyChild(db, 'abcdef04');
    retireChild(db, retired, NOW);

    // Агенту открыт один read-only маршрут: смотреть там нечего.
    expect(startImpersonation(db, { adminId, childId: ready, role: 'agent' }, NOW)).toEqual({
      ok: false,
      reason: 'bad-role',
    });
    expect(startImpersonation(db, { adminId, childId: ready, role: 'admin' }, NOW)).toEqual({
      ok: false,
      reason: 'bad-role',
    });
    expect(startImpersonation(db, { adminId, childId: 'abcdef03', role: 'browser' }, NOW)).toEqual({
      ok: false,
      reason: 'no-child',
    });
    expect(startImpersonation(db, { adminId, childId: retired, role: 'browser' }, NOW)).toEqual({
      ok: false,
      reason: 'no-child',
    });
    expect(startImpersonation(db, { adminId, childId: 'abcdef99', role: 'browser' }, NOW)).toEqual({
      ok: false,
      reason: 'no-child',
    });
    expect(
      db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM admin_impersonations').get(),
    ).toEqual({ count: 0 });
  });

  it('перестаёт разрешать имперсонацию, если ребёнка вывели уже после старта', () => {
    const db = open();
    const adminId = seedAdmin(db);
    const childId = seedReadyChild(db);
    const { token } = start(db, adminId, childId);
    expect(resolveImpersonation(db, token, at(60_000))).toBeDefined();

    retireChild(db, childId, at(2 * 60_000));

    // Пятнадцать минут — долгий срок для «семья ушла»: обслуживаемость
    // проверяется на каждом обращении, а не только на старте.
    expect(resolveImpersonation(db, token, at(3 * 60_000))).toBeUndefined();
  });

  it('не заводит и не разрешает заход в семью отключённого родителя', () => {
    const db = open();
    const adminId = seedAdmin(db);
    const childId = seedReadyChild(db);
    const { token } = start(db, adminId, childId);
    expect(resolveImpersonation(db, token, at(60_000))).toBeDefined();

    disableParent(db, `p-${childId}`, at(2 * 60_000));

    // `npm run parent -- disable` — единственный рычаг «перестать обслуживать
    // семью», и на заходе он обязан действовать так же, как на её собственном
    // входе: иначе отключение семьи оставляло бы её открытой ровно тому пути,
    // который её и показывает.
    expect(resolveImpersonation(db, token, at(3 * 60_000))).toBeUndefined();
    expect(startImpersonation(db, { adminId, childId, role: 'browser' }, at(4 * 60_000))).toEqual({
      ok: false,
      reason: 'no-child',
    });
  });

  it('знает закрытый список ролей имперсонации', () => {
    expect([...IMPERSONATION_ROLES]).toEqual(['browser', 'parent']);
    expect(isImpersonationRole('browser')).toBe(true);
    expect(isImpersonationRole('parent')).toBe(true);
    expect(isImpersonationRole('agent')).toBe(false);
    expect(isImpersonationRole('admin')).toBe(false);
  });

  it('держит калибровочные константы спеки: срок имперсонации', () => {
    expect(IMPERSONATION_TTL_MS).toBe(15 * 60 * 1000);
  });
});
