import { createHash, randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { MAX_SECRET_LENGTH, hashSecret, verifySecret } from './secrets.js';

/**
 * Версия схемы управляющей базы. Хранится в её собственном `PRAGMA user_version`
 * и живёт отдельно от `SCHEMA_VERSION` детской базы: это разные файлы с разной
 * историей, и общий номер заставлял бы мигрировать одну ради изменений другой.
 */
export const CONTROL_SCHEMA_VERSION = 1;

/** Таблицы управляющей базы. Тесты сверяют состав файла именно с этим списком. */
export const CONTROL_TABLES = [
  'parents',
  'parent_invites',
  'parent_sessions',
  'children',
  'child_devices',
  'codex_quota',
  'login_attempts',
] as const;

export type ControlTable = (typeof CONTROL_TABLES)[number];

/**
 * Умолчание отметки времени. Формат тот же, что у `toISOString()`: сравнение по
 * этим колонкам строковое, а `datetime('now')` даёт другой формат и всё ломает.
 */
const NOW_ISO = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

/**
 * `id` ребёнка служит именем файла `children/<id>.db`, поэтому запрет на всё,
 * кроме шестнадцатеричных знаков, стоит уже на уровне схемы: даже если код
 * канонизации однажды ошибётся, `..` и разделитель пути в базу не попадут.
 */
const CHILD_ID_CHECK = `id NOT GLOB '*[^0-9a-f]*' AND length(id) BETWEEN 8 AND 64`;

const CONTROL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS parents (
    id                     TEXT PRIMARY KEY,
    -- Адрес хранится уже приведённым к нижнему регистру: сравнение идёт точным
    -- совпадением, а SQLite не знает регистра ничего, кроме ASCII.
    email                  TEXT NOT NULL UNIQUE CHECK (email = lower(email) AND email <> ''),
    -- Пусто, пока родитель не установил пароль по приглашению.
    password_hash          TEXT,
    pin_hash               TEXT,
    -- Отметка смены пароля или PIN: по ней гаснут выданные до неё сессии.
    credentials_changed_at TEXT,
    disabled_at            TEXT,
    created_at             TEXT NOT NULL DEFAULT (${NOW_ISO})
  );

  CREATE TABLE IF NOT EXISTS parent_invites (
    id         INTEGER PRIMARY KEY,
    parent_id  TEXT NOT NULL REFERENCES parents (id) ON DELETE CASCADE,
    -- В базе лежит только SHA-256 от токена: её дамп не даёт войти.
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at    TEXT,
    created_at TEXT NOT NULL DEFAULT (${NOW_ISO})
  );

  CREATE INDEX IF NOT EXISTS parent_invites_parent ON parent_invites (parent_id);

  CREATE TABLE IF NOT EXISTS parent_sessions (
    id           INTEGER PRIMARY KEY,
    parent_id    TEXT NOT NULL REFERENCES parents (id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL UNIQUE,
    -- Срок бездействия считается от last_seen_at, абсолютный потолок — от
    -- expires_at. Оба проверяются на каждом обращении, поэтому оба в схеме.
    last_seen_at TEXT NOT NULL DEFAULT (${NOW_ISO}),
    expires_at   TEXT NOT NULL,
    revoked_at   TEXT,
    created_at   TEXT NOT NULL DEFAULT (${NOW_ISO})
  );

  CREATE INDEX IF NOT EXISTS parent_sessions_parent ON parent_sessions (parent_id);

  CREATE TABLE IF NOT EXISTS children (
    id               TEXT PRIMARY KEY CHECK (${CHILD_ID_CHECK}),
    parent_id        TEXT NOT NULL REFERENCES parents (id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    -- Колонки с путём базы нет намеренно: путь считается из id, и подменить
    -- его записью в управляющей базе нельзя.
    status           TEXT NOT NULL DEFAULT 'provisioning'
                          CHECK (status IN ('provisioning', 'ready', 'failed')),
    -- По свежести отметки диспетчер воркера решает, кого вообще обслуживать.
    last_activity_at TEXT,
    retired_at       TEXT,
    created_at       TEXT NOT NULL DEFAULT (${NOW_ISO})
  );

  CREATE INDEX IF NOT EXISTS children_parent ON children (parent_id);

  CREATE TABLE IF NOT EXISTS child_devices (
    id                INTEGER PRIMARY KEY,
    child_id          TEXT NOT NULL REFERENCES children (id) ON DELETE CASCADE,
    kind              TEXT NOT NULL CHECK (kind IN ('browser', 'agent')),
    label             TEXT NOT NULL DEFAULT '',
    invite_hash       TEXT NOT NULL UNIQUE,
    invite_expires_at TEXT NOT NULL,
    claimed_at        TEXT,
    token_hash        TEXT UNIQUE,
    revoked_at        TEXT,
    created_at        TEXT NOT NULL DEFAULT (${NOW_ISO}),
    -- Погашенное приглашение обязано иметь токен, непогашенное — не иметь:
    -- иначе устройство без токена считалось бы действующим предъявителем.
    CHECK ((claimed_at IS NULL) = (token_hash IS NULL))
  );

  CREATE INDEX IF NOT EXISTS child_devices_child ON child_devices (child_id);

  CREATE TABLE IF NOT EXISTS codex_quota (
    child_id TEXT    NOT NULL REFERENCES children (id) ON DELETE CASCADE,
    -- Московские сутки в виде YYYY-MM-DD: сутки считает код, а не SQLite.
    day      TEXT    NOT NULL,
    calls    INTEGER NOT NULL DEFAULT 0 CHECK (calls >= 0),
    PRIMARY KEY (child_id, day)
  );

  CREATE TABLE IF NOT EXISTS login_attempts (
    -- Счётчики раздельные: по адресу электронной почты и по адресу клиента.
    scope           TEXT    NOT NULL CHECK (scope IN ('email', 'address')),
    kind            TEXT    NOT NULL CHECK (kind IN ('password', 'pin')),
    key             TEXT    NOT NULL,
    failures        INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
    first_failed_at TEXT    NOT NULL DEFAULT (${NOW_ISO}),
    last_failed_at  TEXT    NOT NULL DEFAULT (${NOW_ISO}),
    PRIMARY KEY (scope, kind, key)
  );
`;

/**
 * Номер версии управляющей базы. База новее кода отвергается, а не считается
 * мигрированной: молча работать с чужой схемой значило бы портить данные,
 * которых этот код не понимает.
 */
function readControlUserVersion(db: Database.Database): number {
  const [row] = db.pragma('user_version') as [{ user_version: number }];
  if (row.user_version > CONTROL_SCHEMA_VERSION) {
    throw new Error(
      `Управляющая база собрана более новой версией схемы (${row.user_version} > ${CONTROL_SCHEMA_VERSION}): обновите приложение`,
    );
  }
  return row.user_version;
}

/**
 * Приводит управляющую базу к текущей версии схемы. Идемпотентна: на уже
 * мигрированной базе ничего не выполняет. Вся DDL идёт одной транзакцией —
 * оборванная миграция не оставляет половину таблиц.
 */
export function migrateControl(db: Database.Database): void {
  if (readControlUserVersion(db) === CONTROL_SCHEMA_VERSION) return;

  // Версия перечитывается под записью, и транзакция именно `immediate`: между
  // быстрой проверкой выше и первым запросом транзакции базу мог мигрировать
  // соседний процесс (сервер и скрипты открывают её одновременно, а на чистом
  // каталоге данных оба видят версию 0). Отложенная транзакция повторила бы
  // миграцию поверх готовой схемы и упала бы «база без версии содержит объект
  // parents» на совершенно исправной базе.
  db.transaction(() => {
    const version = readControlUserVersion(db);
    if (version === CONTROL_SCHEMA_VERSION) return;

    if (version === 0) {
      const existing = db
        .prepare<[], { name: string }>(
          `SELECT name FROM sqlite_master
            WHERE type IN ('table', 'index', 'trigger')
              AND name NOT LIKE 'sqlite_%'
            LIMIT 1`,
        )
        .get();
      if (existing !== undefined) {
        throw new Error(
          `Управляющая база без версии содержит объект «${existing.name}»; автоматическая миграция неизвестной схемы запрещена`,
        );
      }
      db.exec(CONTROL_SCHEMA);
      db.pragma(`user_version = ${CONTROL_SCHEMA_VERSION}`);
      return;
    }

    // Переходы с прошлых версий появятся здесь; пока их нет, но молчаливое
    // «ничего не делаем» превратило бы пропущенный переход в порчу данных.
    throw new Error(
      `Управляющая база версии ${version} не имеет перехода к ${CONTROL_SCHEMA_VERSION}`,
    );
  }).immediate();
}

/** Колонки, без которых код обращается к несуществующему полю уже на первом запросе. */
const REQUIRED_CONTROL_COLUMNS: Record<ControlTable, readonly string[]> = {
  parents: [
    'id',
    'email',
    'password_hash',
    'pin_hash',
    'credentials_changed_at',
    'disabled_at',
    'created_at',
  ],
  parent_invites: ['id', 'parent_id', 'token_hash', 'expires_at', 'used_at', 'created_at'],
  parent_sessions: [
    'id',
    'parent_id',
    'token_hash',
    'last_seen_at',
    'expires_at',
    'revoked_at',
    'created_at',
  ],
  children: [
    'id',
    'parent_id',
    'name',
    'status',
    'last_activity_at',
    'retired_at',
    'created_at',
  ],
  child_devices: [
    'id',
    'child_id',
    'kind',
    'label',
    'invite_hash',
    'invite_expires_at',
    'claimed_at',
    'token_hash',
    'revoked_at',
    'created_at',
  ],
  codex_quota: ['child_id', 'day', 'calls'],
  login_attempts: ['scope', 'kind', 'key', 'failures', 'first_failed_at', 'last_failed_at'],
};

/** Индексы, на которых держатся выборки по родителю и ребёнку. */
const REQUIRED_CONTROL_INDEXES = [
  'parent_invites_parent',
  'parent_sessions_parent',
  'children_parent',
  'child_devices_child',
] as const;

/**
 * Ограничения, которые нельзя увидеть через `PRAGMA table_info`, а потеря их
 * ничего не ломает сразу: несуществующий `status`, устройство без токена и
 * `id` ребёнка с разделителем пути прошли бы молча.
 */
const REQUIRED_CONTROL_FRAGMENTS: Partial<Record<ControlTable, readonly string[]>> = {
  parents: ['email = lower(email)'],
  children: ["'provisioning', 'ready', 'failed'", CHILD_ID_CHECK],
  child_devices: ["'browser', 'agent'", '(claimed_at IS NULL) = (token_hash IS NULL)'],
  codex_quota: ['PRIMARY KEY (child_id, day)'],
  login_attempts: ["'email', 'address'", "'password', 'pin'"],
};

/** Не даёт базе с актуальным номером версии скрыть удалённую или чужую схему. */
export function validateControlSchema(db: Database.Database): void {
  for (const table of CONTROL_TABLES) {
    const columns = db
      .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name);
    const missing = REQUIRED_CONTROL_COLUMNS[table].filter((column) => !columns.includes(column));
    if (missing.length > 0) {
      throw new Error(`Схема управляющей базы повреждена: ${table} не содержит ${missing.join(', ')}`);
    }
  }

  const objects = new Set(
    db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type IN ('index', 'trigger')",
      )
      .all()
      .map((row) => row.name),
  );
  const missingObjects = REQUIRED_CONTROL_INDEXES.filter((name) => !objects.has(name));
  if (missingObjects.length > 0) {
    throw new Error(`Схема управляющей базы повреждена: отсутствуют ${missingObjects.join(', ')}`);
  }

  for (const [table, fragments] of Object.entries(REQUIRED_CONTROL_FRAGMENTS)) {
    const row = db
      .prepare<[string], { sql: string | null }>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(table);
    const sql = row?.sql ?? '';
    const absent = fragments.filter((fragment) => !sql.includes(fragment));
    if (absent.length > 0) {
      throw new Error(
        `Схема управляющей базы повреждена: ${table} не содержит обязательные ограничения`,
      );
    }
  }

  const [integrity] = db.pragma('quick_check') as [{ quick_check: string }];
  if (integrity.quick_check !== 'ok') {
    throw new Error(`SQLite quick_check: ${integrity.quick_check}`);
  }
}

export interface OpenControlDatabaseOptions {
  fileMustExist?: boolean;
}

/**
 * Открывает управляющую базу, включает WAL и внешние ключи и мигрирует схему.
 * Путь передаётся явно: единственной точки вроде `EDUKATOR_DB` у многоарендного
 * сервера быть не должно, каталог данных задаёт вызывающий.
 */
export function openControlDatabase(
  path: string,
  options: OpenControlDatabaseOptions = {},
): Database.Database {
  const db = new Database(path, { fileMustExist: options.fileMustExist ?? false });
  try {
    // Результат прагмы проверяется, а не отбрасывается: на недоступный WAL
    // SQLite не ошибается, а молча оставляет прежний журнал (сетевой том, база
    // в памяти). Без WAL резерв квоты и погашение приглашений берут
    // эксклюзивную блокировку на весь файл, и вход второго ребёнка отваливается
    // по `SQLITE_BUSY` без единого следа о причине.
    const journal = db.pragma('journal_mode = WAL', { simple: true });
    if (journal !== 'wal') {
      throw new Error(
        `Управляющая база ${path}: WAL не включился, журнал остался «${String(journal)}»`,
      );
    }
    // Внешние ключи действуют на соединение и по умолчанию выключены. Здесь на
    // них держится вся принадлежность: сессия без родителя и устройство без
    // ребёнка — это предъявитель, за которым нет никого.
    db.pragma('foreign_keys = ON');
    // Установка прагмы ничего не возвращает, поэтому итог перечитывается: на
    // соединении внутри открытой транзакции SQLite молча оставил бы ключи
    // выключенными, и принадлежность держалась бы ни на чём.
    const foreignKeys = db.pragma('foreign_keys', { simple: true });
    if (foreignKeys !== 1) {
      throw new Error(
        `Управляющая база ${path}: внешние ключи не включились (${String(foreignKeys)})`,
      );
    }
    migrateControl(db);
    validateControlSchema(db);
  } catch (error) {
    // Соединение уже открыто, а наружу уходит только исключение — закрывать его
    // вызывающему нечем. Без этого каждая неудачная миграция утекает
    // дескриптором до EMFILE.
    try {
      db.close();
    } catch {
      // Отказ закрытия не имеет права заслонить причину: наружу уходит она.
    }
    throw error;
  }
  return db;
}

/* ─── Родители, приглашения, сессии ─────────────────────────────────────── */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Срок приглашения родителя. Ссылка уходит внешним каналом и живёт неделю:
 * бессрочная лежала бы в переписке ровно до первого чужого чтения.
 */
export const PARENT_INVITE_TTL_MS = 7 * DAY_MS;

/** Срок бездействия сессии: 30 дней без единого обращения гасят её. */
export const PARENT_SESSION_IDLE_MS = 30 * DAY_MS;

/**
 * Абсолютный потолок сессии. Проверяется вместе со сроком бездействия: без него
 * ежедневно открываемая вкладка держала бы вход вечно, и украденная cookie —
 * тоже.
 */
export const PARENT_SESSION_MAX_MS = 90 * DAY_MS;

/**
 * Как часто сессия обновляет `last_seen_at`. Запись на каждый запрос — это
 * запись в WAL на каждый опрос страницы: у одного родителя их сотни в час, и
 * все они конкурируют с занятием ребёнка за ту же управляющую базу.
 */
export const SESSION_TOUCH_MS = 5 * 60 * 1000;

/** Длина токена предъявителя: 256 бит случайности, перебору не поддаётся. */
const TOKEN_BYTES = 32;

/** Предел длины адреса по RFC 5321; всё длиннее — не адрес, а нагрузка. */
export const MAX_EMAIL_LENGTH = 254;

/**
 * Нижняя граница пароля. Родителей заводит закрытый список, но короткий пароль
 * сводит на нет и `scrypt`, и счётчики неудач: подбирается он не у нас.
 */
export const MIN_PASSWORD_LENGTH = 10;

// Разбирать адрес полностью незачем: он служит только точным ключом входа.
// Проверяется ровно то, без чего ключ не ключ, — одна собака и никаких пробелов.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/** Причина отказа во входе. Наружу маршрут отдаёт один общий текст на все. */
export type ParentAuthFailure =
  | 'unknown-token'
  | 'expired'
  | 'used'
  | 'disabled'
  | 'unknown-email'
  | 'no-password'
  | 'bad-password'
  | 'weak-password';

/** Выданный предъявителю токен. Открытым он существует только здесь и в ответе. */
export interface IssuedToken {
  token: string;
  expiresAt: string;
}

export type ParentAuthResult =
  | { ok: true; parentId: string; session: IssuedToken }
  | { ok: false; reason: ParentAuthFailure };

export interface ParentPrincipal {
  parentId: string;
  email: string;
}

/** Токен предъявителя. Наружу уходит только он, в базу — только его отпечаток. */
export function createBearerToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Отпечаток токена для хранения. SHA-256 без соли и без KDF намеренно: токен
 * и так 256 бит случайности, перебирать в нём нечего, а выборка идёт по
 * равенству — значит, отпечаток обязан считаться одинаково при каждом входе.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

/**
 * Приводит адрес к виду, в котором он лежит в базе. `undefined` — это «не
 * адрес»: схема требует нижний регистр, а сравнение идёт точным совпадением.
 */
export function normalizeEmail(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > MAX_EMAIL_LENGTH) return undefined;
  return EMAIL_PATTERN.test(normalized) ? normalized : undefined;
}

/**
 * Эталон для отказа с той же ценой, что и у верного адреса. Без него «нет
 * такого родителя» отвечает мгновенно, а «неверный пароль» — через `scrypt`,
 * и разница во времени превращает вход в справочник заведённых адресов.
 */
let dummyPasswordHash: string | undefined;

function spendVerificationTime(): void {
  dummyPasswordHash ??= hashSecret(randomBytes(24).toString('base64url'));
  verifySecret(dummyPasswordHash, 'пароль, который никому не подойдёт');
}

/** Заводит родителя. Ни пароля, ни PIN у него ещё нет — они придут по приглашению. */
export function createParent(db: Database.Database, email: string, now: Date = new Date()): string {
  const normalized = normalizeEmail(email);
  if (normalized === undefined) {
    throw new Error(`Адрес родителя «${email}» не похож на электронную почту`);
  }
  const id = randomBytes(16).toString('hex');
  try {
    db.prepare('INSERT INTO parents (id, email, created_at) VALUES (?, ?, ?)').run(
      id,
      normalized,
      now.toISOString(),
    );
  } catch (error) {
    // Повторный запуск скрипта по тому же списку — обычное дело, и «UNIQUE
    // constraint failed» ничего не говорит тому, кто его запустил.
    if (error instanceof Error && /UNIQUE/i.test(error.message)) {
      throw new Error(`Родитель с адресом ${normalized} уже заведён`);
    }
    throw error;
  }
  return id;
}

/** Выпускает приглашение. Открытый токен возвращается один раз и нигде не хранится. */
export function issueParentInvite(
  db: Database.Database,
  parentId: string,
  now: Date = new Date(),
  ttlMs: number = PARENT_INVITE_TTL_MS,
): IssuedToken {
  const parent = db
    .prepare<[string], { disabled_at: string | null }>('SELECT disabled_at FROM parents WHERE id = ?')
    .get(parentId);
  if (parent === undefined) throw new Error(`Родителя ${parentId} нет в управляющей базе`);
  if (parent.disabled_at !== null) throw new Error(`Родитель ${parentId} отключён`);

  const token = createBearerToken();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  db.prepare(
    `INSERT INTO parent_invites (parent_id, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(parentId, hashToken(token), expiresAt, now.toISOString());
  return { token, expiresAt };
}

interface InviteRow {
  parent_id: string;
  email: string;
  used_at: string | null;
  expires_at: string;
  disabled_at: string | null;
}

function selectInvite(db: Database.Database, token: string): InviteRow | undefined {
  return db
    .prepare<[string], InviteRow>(
      `SELECT i.parent_id, i.used_at, i.expires_at, p.email, p.disabled_at
         FROM parent_invites i
         JOIN parents p ON p.id = i.parent_id
        WHERE i.token_hash = ?`,
    )
    .get(hashToken(token));
}

function inviteFailure(row: InviteRow | undefined, now: Date): ParentAuthFailure | undefined {
  if (row === undefined) return 'unknown-token';
  if (row.disabled_at !== null) return 'disabled';
  if (row.used_at !== null) return 'used';
  if (row.expires_at <= now.toISOString()) return 'expired';
  return undefined;
}

/**
 * Читает приглашение, **не** гася его: предпросмотр ссылки в мессенджере не
 * должен сжигать единственный вход родителя.
 */
export function readParentInvite(
  db: Database.Database,
  token: string,
  now: Date = new Date(),
): { ok: true; parentId: string; email: string } | { ok: false; reason: ParentAuthFailure } {
  const row = selectInvite(db, token);
  const failure = inviteFailure(row, now);
  if (failure !== undefined || row === undefined) {
    return { ok: false, reason: failure ?? 'unknown-token' };
  }
  return { ok: true, parentId: row.parent_id, email: row.email };
}

/**
 * Заводит сессию. `created_at` пишется явно, а не умолчанием схемы: по нему
 * сессия сравнивается с отметкой смены пароля, и расхождение часов SQLite с
 * нашими на секунду погасило бы только что выданный вход.
 */
function insertParentSession(db: Database.Database, parentId: string, now: Date): IssuedToken {
  const token = createBearerToken();
  const stamp = now.toISOString();
  const expiresAt = new Date(now.getTime() + PARENT_SESSION_MAX_MS).toISOString();
  db.prepare(
    `INSERT INTO parent_sessions (parent_id, token_hash, last_seen_at, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(parentId, hashToken(token), stamp, expiresAt, stamp);
  return { token, expiresAt };
}

/**
 * Гасит приглашение, ставит пароль и сразу выдаёт сессию: родитель пришёл по
 * ссылке, и второй вход по только что заданному паролю ничего не проверяет.
 *
 * Пароль хешируется **до** транзакции: `scrypt` стоит десятки миллисекунд, и
 * под WAL всё это время держал бы запись в управляющей базе.
 */
export function redeemParentInvite(
  db: Database.Database,
  token: string,
  password: string,
  now: Date = new Date(),
): ParentAuthResult {
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_SECRET_LENGTH) {
    return { ok: false, reason: 'weak-password' };
  }
  // Дешёвый отказ до KDF — только на том, что транзакция не решает: нет такой
  // ссылки, нет такого родителя. Погашенность и срок проверяет сам `UPDATE`,
  // иначе решение принималось бы по снимку, устаревшему к моменту записи.
  const known = selectInvite(db, token);
  if (known === undefined) return { ok: false, reason: 'unknown-token' };
  if (known.disabled_at !== null) return { ok: false, reason: 'disabled' };

  const passwordHash = hashSecret(password);
  const stamp = now.toISOString();
  const tokenHash = hashToken(token);

  return db.transaction((): ParentAuthResult => {
    // Погашение и проверка условий — один `UPDATE`: между чтением выше и этой
    // строкой то же приглашение мог погасить соседний запрос, и вторая сессия
    // по одной ссылке — это второй пароль у того, кто ссылку перехватил.
    const consumed = db
      .prepare('UPDATE parent_invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?')
      .run(stamp, tokenHash, stamp);
    if (consumed.changes === 0) {
      return { ok: false, reason: inviteFailure(selectInvite(db, token), now) ?? 'used' };
    }

    const row = selectInvite(db, token);
    if (row === undefined) return { ok: false, reason: 'unknown-token' };
    if (row.disabled_at !== null) return { ok: false, reason: 'disabled' };

    db.prepare('UPDATE parents SET password_hash = ?, credentials_changed_at = ? WHERE id = ?').run(
      passwordHash,
      stamp,
      row.parent_id,
    );
    return { ok: true, parentId: row.parent_id, session: insertParentSession(db, row.parent_id, now) };
  }).immediate();
}

interface ParentCredentialsRow {
  id: string;
  password_hash: string | null;
  disabled_at: string | null;
}

/** Вход по паролю. Любой отказ стоит одного `scrypt`: см. `spendVerificationTime`. */
export function loginParent(
  db: Database.Database,
  email: string,
  password: string,
  now: Date = new Date(),
): ParentAuthResult {
  const normalized = normalizeEmail(email);
  const row =
    normalized === undefined
      ? undefined
      : db
          .prepare<[string], ParentCredentialsRow>(
            'SELECT id, password_hash, disabled_at FROM parents WHERE email = ?',
          )
          .get(normalized);
  if (row === undefined) {
    spendVerificationTime();
    return { ok: false, reason: 'unknown-email' };
  }
  if (row.disabled_at !== null) {
    spendVerificationTime();
    return { ok: false, reason: 'disabled' };
  }
  if (row.password_hash === null) {
    spendVerificationTime();
    return { ok: false, reason: 'no-password' };
  }
  if (!verifySecret(row.password_hash, password)) {
    return { ok: false, reason: 'bad-password' };
  }
  return { ok: true, parentId: row.id, session: insertParentSession(db, row.id, now) };
}

interface ParentSessionRow {
  id: number;
  parent_id: string;
  email: string;
  last_seen_at: string;
  expires_at: string;
  created_at: string;
  disabled_at: string | null;
  credentials_changed_at: string | null;
}

/**
 * Разрешает cookie родителя в предъявителя. `undefined` — это отказ по любой
 * причине: снаружи «нет такой сессии» и «сессия погасла» неразличимы.
 */
export function resolveParentSession(
  db: Database.Database,
  token: string,
  now: Date = new Date(),
): ParentPrincipal | undefined {
  const row = db
    .prepare<[string], ParentSessionRow>(
      `SELECT s.id, s.parent_id, s.last_seen_at, s.expires_at, s.created_at,
              p.email, p.disabled_at, p.credentials_changed_at
         FROM parent_sessions s
         JOIN parents p ON p.id = s.parent_id
        WHERE s.token_hash = ? AND s.revoked_at IS NULL`,
    )
    .get(hashToken(token));
  if (row === undefined) return undefined;
  if (row.disabled_at !== null) return undefined;

  const stamp = now.toISOString();
  // Оба срока проверяются на каждом обращении: потолок гасит сессию даже у
  // того, кто заходит ежедневно, а бездействие — забытую вкладку.
  if (row.expires_at <= stamp) return undefined;
  const lastSeen = Date.parse(row.last_seen_at);
  if (!Number.isFinite(lastSeen) || now.getTime() - lastSeen >= PARENT_SESSION_IDLE_MS) {
    return undefined;
  }
  // Смена пароля или PIN гасит всё, что было выдано до неё: иначе увод cookie
  // не лечится ничем, кроме ручной чистки таблицы.
  if (row.credentials_changed_at !== null && row.credentials_changed_at > row.created_at) {
    return undefined;
  }

  if (now.getTime() - lastSeen >= SESSION_TOUCH_MS) {
    db.prepare('UPDATE parent_sessions SET last_seen_at = ? WHERE id = ?').run(stamp, row.id);
  }
  return { parentId: row.parent_id, email: row.email };
}

/** Выход. Строка остаётся для разбора, но предъявителем уже не служит. */
export function revokeParentSession(
  db: Database.Database,
  token: string,
  now: Date = new Date(),
): boolean {
  const result = db
    .prepare('UPDATE parent_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
    .run(now.toISOString(), hashToken(token));
  return result.changes > 0;
}
