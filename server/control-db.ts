import { createHash, randomBytes } from 'node:crypto';
import { relative, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { MAX_ADDRESS_LENGTH, UNKNOWN_ADDRESS } from './client-address.js';
import { moscowDate } from './moscow-time.js';
import { MAX_SECRET_LENGTH, hashSecret, verifySecret } from './secrets.js';

/**
 * Версия схемы управляющей базы. Хранится в её собственном `PRAGMA user_version`
 * и живёт отдельно от `SCHEMA_VERSION` детской базы: это разные файлы с разной
 * историей, и общий номер заставлял бы мигрировать одну ради изменений другой.
 */
export const CONTROL_SCHEMA_VERSION = 2;

/** Таблицы управляющей базы. Тесты сверяют состав файла именно с этим списком. */
export const CONTROL_TABLES = [
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

/**
 * Счётчики перебора вынесены отдельной строкой: `CHECK` в SQLite на месте не
 * меняется, поэтому переход к версии 2 пересоздаёт таблицу этим же текстом —
 * вторая, разошедшаяся с этой копия DDL дала бы базу, собранную миграцией, и
 * базу, собранную с нуля, с разными ограничениями.
 */
const LOGIN_ATTEMPTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS login_attempts (
    -- Счётчики раздельные: по адресу электронной почты и по адресу клиента.
    scope           TEXT    NOT NULL CHECK (scope IN ('email', 'address')),
    -- Вид перебора: пароль родителя, PIN родителя и пароль оператора. Оператор
    -- считается отдельно намеренно — общий счётчик означал бы, что перебор
    -- чужого родительского пароля запирает вход оператору.
    kind            TEXT    NOT NULL CHECK (kind IN ('password', 'pin', 'admin')),
    key             TEXT    NOT NULL,
    failures        INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
    first_failed_at TEXT    NOT NULL DEFAULT (${NOW_ISO}),
    last_failed_at  TEXT    NOT NULL DEFAULT (${NOW_ISO}),
    PRIMARY KEY (scope, kind, key)
  );
`;

/**
 * Роли имперсонации: оператор входит в чужую семью либо ребёнком, либо
 * родителем. `agent` сюда не входит намеренно — ему открыт единственный
 * read-only маршрут, и смотреть под ним нечего.
 */
export const IMPERSONATION_ROLES = ['browser', 'parent'] as const;

export type ImpersonationRole = (typeof IMPERSONATION_ROLES)[number];

/**
 * Ограничение схемы собирается из того же списка: разойтись им нечем, а
 * рукописная копия перечисления в DDL молча разрешила бы роль, которой нет.
 */
const IMPERSONATION_ROLE_CHECK = `role IN (${IMPERSONATION_ROLES.map((role) => `'${role}'`).join(', ')})`;

/**
 * Таблицы админки оператора. Появились в версии 2 и держатся отдельно от
 * семейной части: доменного отношения к ней у них нет, а миграция обязана
 * выполнить ровно этот текст.
 */
const ADMIN_SCHEMA = `
  CREATE TABLE IF NOT EXISTS admins (
    id                     TEXT PRIMARY KEY,
    -- Как у родителя: адрес уже приведён к нижнему регистру, сравнение точное.
    email                  TEXT NOT NULL UNIQUE CHECK (email = lower(email) AND email <> ''),
    -- Пусто, пока пароль не установлен CLI. Приглашений по ссылке у оператора
    -- нет вовсе: одноразовая ссылка ко всем семьям сразу не нужна ни в одном
    -- сценарии, а стоит ровно того, что даёт.
    password_hash          TEXT,
    -- Гасит и сессии оператора, и его живые имперсонации.
    credentials_changed_at TEXT,
    disabled_at            TEXT,
    created_at             TEXT NOT NULL DEFAULT (${NOW_ISO})
  );

  CREATE TABLE IF NOT EXISTS admin_sessions (
    id           INTEGER PRIMARY KEY,
    admin_id     TEXT NOT NULL REFERENCES admins (id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL UNIQUE,
    -- Как у родительской сессии: бездействие считается от last_seen_at,
    -- абсолютный потолок — от expires_at, проверяются оба.
    last_seen_at TEXT NOT NULL DEFAULT (${NOW_ISO}),
    expires_at   TEXT NOT NULL,
    revoked_at   TEXT,
    created_at   TEXT NOT NULL DEFAULT (${NOW_ISO})
  );

  CREATE INDEX IF NOT EXISTS admin_sessions_admin ON admin_sessions (admin_id);

  CREATE TABLE IF NOT EXISTS admin_impersonations (
    id         INTEGER PRIMARY KEY,
    admin_id   TEXT NOT NULL REFERENCES admins (id) ON DELETE CASCADE,
    child_id   TEXT NOT NULL REFERENCES children (id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (${IMPERSONATION_ROLE_CHECK}),
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL DEFAULT (${NOW_ISO})
  );

  CREATE INDEX IF NOT EXISTS admin_impersonations_admin ON admin_impersonations (admin_id);

  CREATE TABLE IF NOT EXISTS admin_audit (
    id        INTEGER PRIMARY KEY,
    -- Без ON DELETE CASCADE намеренно: у журнала действий смысл ровно в том,
    -- что удаление оператора его не стирает, а упирается во внешний ключ.
    admin_id  TEXT NOT NULL REFERENCES admins (id),
    at        TEXT NOT NULL DEFAULT (${NOW_ISO}),
    action    TEXT NOT NULL,
    -- Семья названа значениями, а не ссылками: запись обязана пережить и
    -- ушедшего ребёнка, и удалённого родителя, иначе след заходов в семью
    -- исчезает вместе с самой семьёй.
    child_id  TEXT,
    parent_id TEXT,
    detail    TEXT
  );

  -- Чтение идёт страницей «новые сверху» с курсором по (at, id); по одному at
  -- порядок неоднозначен, поэтому в индексе оба поля.
  CREATE INDEX IF NOT EXISTS admin_audit_at ON admin_audit (at, id);
`;

const CONTROL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS parents (
    id                     TEXT PRIMARY KEY,
    -- Адрес хранится уже приведённым к нижнему регистру: сравнение идёт точным
    -- совпадением, а SQLite не знает регистра ничего, кроме ASCII.
    email                  TEXT NOT NULL UNIQUE CHECK (email = lower(email) AND email <> ''),
    -- Пусто, пока родитель не установил пароль по приглашению.
    password_hash          TEXT,
    pin_hash               TEXT,
    -- Отметка смены пароля: по ней гаснут выданные до неё сессии и токены
    -- устройств. PIN её не двигает — см. setParentPin.
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

  ${LOGIN_ATTEMPTS_SCHEMA}

  ${ADMIN_SCHEMA}
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

    if (version !== 1) {
      // Молчаливое «ничего не делаем» превратило бы пропущенный переход в
      // порчу данных, поэтому неизвестная версия — отказ, а не умолчание.
      throw new Error(
        `Управляющая база версии ${version} не имеет перехода к ${CONTROL_SCHEMA_VERSION}`,
      );
    }

    db.exec(ADMIN_SCHEMA);

    // `kind` получил третье значение, а `CHECK` в SQLite на месте не меняется.
    // Строки переносятся: обнулить счётчики перебора миграцией значит открыть
    // окно подбора в предсказуемое время — в момент обновления приложения.
    db.exec(`
      ALTER TABLE login_attempts RENAME TO login_attempts_v1;
      ${LOGIN_ATTEMPTS_SCHEMA}
      INSERT INTO login_attempts (scope, kind, key, failures, first_failed_at, last_failed_at)
        SELECT scope, kind, key, failures, first_failed_at, last_failed_at FROM login_attempts_v1;
      DROP TABLE login_attempts_v1;
    `);

    db.pragma(`user_version = ${CONTROL_SCHEMA_VERSION}`);
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
  admins: ['id', 'email', 'password_hash', 'credentials_changed_at', 'disabled_at', 'created_at'],
  admin_sessions: [
    'id',
    'admin_id',
    'token_hash',
    'last_seen_at',
    'expires_at',
    'revoked_at',
    'created_at',
  ],
  admin_impersonations: [
    'id',
    'admin_id',
    'child_id',
    'role',
    'token_hash',
    'expires_at',
    'revoked_at',
    'created_at',
  ],
  admin_audit: ['id', 'admin_id', 'at', 'action', 'child_id', 'parent_id', 'detail'],
};

/** Индексы, на которых держатся выборки по родителю и ребёнку. */
const REQUIRED_CONTROL_INDEXES = [
  'parent_invites_parent',
  'parent_sessions_parent',
  'children_parent',
  'child_devices_child',
  'admin_sessions_admin',
  'admin_impersonations_admin',
  'admin_audit_at',
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
  // Составной ключ проверяется наравне с `CHECK`: версия 2 меняла именно его,
  // и база со старым `(scope, key)` при новом `user_version` прошла бы молча —
  // а `ON CONFLICT (scope, kind, key)` падал бы уже на входе, превращая каждую
  // попытку входа в `unavailable` без единой строки о причине.
  login_attempts: [
    "'email', 'address'",
    "'password', 'pin', 'admin'",
    'PRIMARY KEY (scope, kind, key)',
  ],
  admins: ['email = lower(email)'],
  admin_impersonations: [IMPERSONATION_ROLE_CHECK],
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
  created_at: string;
  disabled_at: string | null;
  credentials_changed_at: string | null;
}

function selectInvite(db: Database.Database, token: string): InviteRow | undefined {
  return db
    .prepare<[string], InviteRow>(
      `SELECT i.parent_id, i.used_at, i.expires_at, i.created_at,
              p.email, p.disabled_at, p.credentials_changed_at
         FROM parent_invites i
         JOIN parents p ON p.id = i.parent_id
        WHERE i.token_hash = ?`,
    )
    .get(hashToken(token));
}

/**
 * Условие «приглашение старше последней смены пароля» — то же и здесь, и в
 * `UPDATE`, который приглашение гасит. Отдельной строкой SQL потому, что решать
 * по снимку нельзя: между чтением и записью пароль мог смениться.
 */
const INVITE_AFTER_CREDENTIALS =
  `created_at >= COALESCE(
     (SELECT p.credentials_changed_at FROM parents p WHERE p.id = parent_invites.parent_id), '')`;

function inviteFailure(row: InviteRow | undefined, now: Date): ParentAuthFailure | undefined {
  if (row === undefined) return 'unknown-token';
  if (row.disabled_at !== null) return 'disabled';
  if (row.used_at !== null) return 'used';
  // Смена пароля гасит и невыкупленные приглашения. Приглашение — это право
  // задать пароль заново, то есть полный вход; без этой строки утёкшая ссылка
  // оставалась бы способом отобрать учётную запись ещё неделю, а единственное
  // средство, которое от неё советуют, — смена пароля — ничего бы не меняло.
  if (row.credentials_changed_at !== null && row.credentials_changed_at > row.created_at) {
    return 'expired';
  }
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
 * Гасит всё, что было выдано до смены пароля, явными записями в той же
 * транзакции. Одной отметки `credentials_changed_at` недостаточно: SQLite и
 * `Date` хранят миллисекунды, поэтому выданный и сменённый в одну миллисекунду
 * секрет невозможно упорядочить сравнением строк.
 */
function invalidateParentArtifacts(db: Database.Database, parentId: string, stamp: string): void {
  db.prepare(
    `UPDATE parent_sessions SET revoked_at = ?
      WHERE parent_id = ? AND revoked_at IS NULL`,
  ).run(stamp, parentId);
  db.prepare(
    `UPDATE parent_invites SET expires_at = ?
      WHERE parent_id = ? AND used_at IS NULL AND expires_at > ?`,
  ).run(stamp, parentId, stamp);
  db.prepare(
    `UPDATE child_devices SET invite_expires_at = ?
      WHERE claimed_at IS NULL AND revoked_at IS NULL AND invite_expires_at > ?
        AND child_id IN (SELECT id FROM children WHERE parent_id = ?)`,
  ).run(stamp, stamp, parentId);
  db.prepare(
    `UPDATE child_devices SET revoked_at = ?
      WHERE claimed_at IS NOT NULL AND revoked_at IS NULL
        AND child_id IN (SELECT id FROM children WHERE parent_id = ?)`,
  ).run(stamp, parentId);
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
  // ссылки. Погашенность, срок и отключённость родителя проверяет сам
  // `UPDATE`, иначе решение принималось бы по снимку, устаревшему к моменту
  // записи: между этим чтением и погашением лежит `scrypt` — десятки
  // миллисекунд, которых `disable` хватает с запасом.
  if (selectInvite(db, token) === undefined) return { ok: false, reason: 'unknown-token' };

  const passwordHash = hashSecret(password);
  const stamp = now.toISOString();
  const tokenHash = hashToken(token);

  return db.transaction((): ParentAuthResult => {
    // Погашение и проверка условий — один `UPDATE`: между чтением выше и этой
    // строкой то же приглашение мог погасить соседний запрос, и вторая сессия
    // по одной ссылке — это второй пароль у того, кто ссылку перехватил.
    const consumed = db
      .prepare(
        `UPDATE parent_invites SET used_at = ?
          WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
            AND ${INVITE_AFTER_CREDENTIALS}
            AND EXISTS (SELECT 1 FROM parents p
                         WHERE p.id = parent_invites.parent_id AND p.disabled_at IS NULL)`,
      )
      .run(stamp, tokenHash, stamp);
    if (consumed.changes === 0) {
      return { ok: false, reason: inviteFailure(selectInvite(db, token), now) ?? 'used' };
    }

    // Отключённость проверяет сам `UPDATE`, а не строка после него. Возврат
    // отказа **после** удачного погашения — обычный возврат, то есть
    // транзакция фиксируется: приглашение сгорело бы, пароль остался бы
    // незаданным, а нового приглашения отключённому родителю не выписать —
    // единственный вход в учётную запись исчез бы от гонки с `disable`.
    const row = selectInvite(db, token);
    // Строки после удачного `UPDATE` не быть не может; если она всё же
    // пропала, состояние непонятно — и здесь нужен откат, а не отказ.
    if (row === undefined) throw new Error('Погашенное приглашение исчезло из управляющей базы');

    db.prepare('UPDATE parents SET password_hash = ?, credentials_changed_at = ? WHERE id = ?').run(
      passwordHash,
      stamp,
      row.parent_id,
    );
    invalidateParentArtifacts(db, row.parent_id, stamp);
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
  // `verifySecret` отвергает пустые и слишком длинные строки до KDF. Без
  // отдельной траты времени известный адрес отвечал на них мгновенно, а
  // неизвестный проходил через dummy-scrypt и выдавал существование аккаунта.
  if (password.length === 0 || password.length > MAX_SECRET_LENGTH) {
    spendVerificationTime();
    return { ok: false, reason: 'bad-password' };
  }
  if (!verifySecret(row.password_hash, password)) {
    return { ok: false, reason: 'bad-password' };
  }
  return { ok: true, parentId: row.id, session: insertParentSession(db, row.id, now) };
}

/**
 * Повторно подтверждает уже известного родителя без выпуска новой сессии.
 * Нужна повышению роли на общей детской машине: одна забытая cookie доказывает
 * лишь, что родитель когда-то входил в этом браузере, но не что сейчас перед
 * экраном именно он.
 */
export function verifyParentPassword(
  db: Database.Database,
  parentId: string,
  password: string,
): boolean {
  const row = db
    .prepare<[string], ParentCredentialsRow>(
      'SELECT id, password_hash, disabled_at FROM parents WHERE id = ?',
    )
    .get(parentId);
  if (row === undefined || row.disabled_at !== null || row.password_hash === null) {
    spendVerificationTime();
    return false;
  }
  if (password.length === 0 || password.length > MAX_SECRET_LENGTH) {
    spendVerificationTime();
    return false;
  }
  return verifySecret(row.password_hash, password);
}

interface ParentSessionRow {
  id: number;
  parent_id: string;
  email: string;
  last_seen_at: string;
  expires_at: string;
}

/**
 * Живая сессия родителя одним текстом SQL — всё, что не зависит от текущего
 * времени: не погашена, родитель не отключён, пароль после её выдачи не менялся.
 *
 * Отдельным фрагментом по той же причине, что и `ADMIN_SESSION_ALIVE`: это же
 * условие считает живые сессии сводке оператора, и вторая его копия там
 * означала бы, что показанное число описывает не то множество, которое пускают.
 */
const PARENT_SESSION_ALIVE = `
  parent_sessions.revoked_at IS NULL
  AND parent_sessions.created_at >= COALESCE(
        (SELECT p.credentials_changed_at FROM parents p WHERE p.id = parent_sessions.parent_id), '')
  AND NOT EXISTS (
        SELECT 1 FROM parents p
         WHERE p.id = parent_sessions.parent_id AND p.disabled_at IS NOT NULL)`;

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
      `SELECT parent_sessions.id, parent_sessions.parent_id, parent_sessions.last_seen_at,
              parent_sessions.expires_at, parents.email
         FROM parent_sessions
         JOIN parents ON parents.id = parent_sessions.parent_id
        WHERE parent_sessions.token_hash = ? AND ${PARENT_SESSION_ALIVE}`,
    )
    .get(hashToken(token));
  if (row === undefined) return undefined;

  const stamp = now.toISOString();
  // Оба срока проверяются на каждом обращении: потолок гасит сессию даже у
  // того, кто заходит ежедневно, а бездействие — забытую вкладку.
  if (row.expires_at <= stamp) return undefined;
  const lastSeen = Date.parse(row.last_seen_at);
  if (!Number.isFinite(lastSeen) || now.getTime() - lastSeen >= PARENT_SESSION_IDLE_MS) {
    return undefined;
  }

  if (now.getTime() - lastSeen >= SESSION_TOUCH_MS) {
    db.prepare('UPDATE parent_sessions SET last_seen_at = ? WHERE id = ?').run(stamp, row.id);
  }
  return { parentId: row.parent_id, email: row.email };
}

/**
 * Сколько родительских сессий сейчас живы. Считается тем же условием, что и
 * разрешение cookie, плюс оба срока: сводке оператора нужно число тех, кого
 * сервер прямо сейчас пустит, а не число строк в таблице.
 */
export function countLiveParentSessions(db: Database.Database, now: Date = new Date()): number {
  const row = db
    .prepare<[string, string], { live: number }>(
      `SELECT COUNT(*) AS live FROM parent_sessions
        WHERE ${PARENT_SESSION_ALIVE}
          AND parent_sessions.expires_at > ?
          AND parent_sessions.last_seen_at > ?`,
    )
    .get(now.toISOString(), new Date(now.getTime() - PARENT_SESSION_IDLE_MS).toISOString());
  return row?.live ?? 0;
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

/**
 * Ставит родителю PIN. Хеш считает вызывающий: приправка PIN живёт в
 * `parent-pin.ts` вместе с pepper, и управляющая база про него не знает.
 *
 * `credentials_changed_at` эта запись намеренно **не** двигает. Той отметкой
 * гаснут все родительские сессии и все токены детских устройств, а PIN — не
 * вход, а второе подтверждение у двух изменяющих маршрутов: ни родительская
 * cookie, ни токен на детской машине его в себе не несут, и погасить их сменой
 * PIN значило бы разослать всем детям новые ссылки-приглашения из-за действия,
 * которое их учётных данных не касается.
 */
export function setParentPin(db: Database.Database, parentId: string, pinHash: string): void {
  const updated = db
    .prepare('UPDATE parents SET pin_hash = ? WHERE id = ? AND disabled_at IS NULL')
    .run(pinHash, parentId);
  if (updated.changes === 0) {
    throw new Error(`Родителя ${parentId} нет в управляющей базе или он отключён`);
  }
}

/**
 * Эталон PIN родителя. Отдаётся только хешем: открытого значения нет ни в базе,
 * ни в памяти сервера, а `undefined` значит «PIN не настроен» — маршруту этого
 * достаточно, чтобы закрыться, а не пускать без подтверждения.
 */
export function readParentPinHash(db: Database.Database, parentId: string): string | undefined {
  const row = db
    .prepare<[string], { pin_hash: string | null }>(
      'SELECT pin_hash FROM parents WHERE id = ? AND disabled_at IS NULL',
    )
    .get(parentId);
  return row === undefined || row.pin_hash === null ? undefined : row.pin_hash;
}

/**
 * Адрес родителя по `id`. Нужен счётчику неудач PIN: считает он по учётной
 * записи (`scope = 'email'`), а маршрут родителей знает только `parent_id`
 * ребёнка, чью сводку открыли. Отключённый родитель отсеивается здесь же —
 * его PIN всё равно уже ничего не подтверждает.
 */
export function readParentEmail(db: Database.Database, parentId: string): string | undefined {
  const row = db
    .prepare<[string], { email: string }>(
      'SELECT email FROM parents WHERE id = ? AND disabled_at IS NULL',
    )
    .get(parentId);
  return row?.email;
}

/** Родитель так, как его видит обслуживание: без единого хеша наружу. */
export interface ParentRecord {
  id: string;
  email: string;
  /** Пароль уже установлен по приглашению. Самого хеша здесь нет намеренно. */
  hasPassword: boolean;
  hasPin: boolean;
  disabledAt?: string;
  createdAt: string;
}

/**
 * Родитель по адресу. Отключённый тоже возвращается: обслуживающий скрипт
 * обязан сказать «он отключён», а не «такого нет» — иначе повторное заведение
 * упало бы на `UNIQUE` без внятной причины.
 *
 * Неразобранный адрес — это `undefined`, а не исключение: для поиска «не адрес»
 * и «нет такого» — один и тот же ответ.
 */
export function findParentByEmail(db: Database.Database, email: string): ParentRecord | undefined {
  const normalized = normalizeEmail(email);
  if (normalized === undefined) return undefined;
  const row = db
    .prepare<[string], {
      id: string;
      email: string;
      password_hash: string | null;
      pin_hash: string | null;
      disabled_at: string | null;
      created_at: string;
    }>(
      `SELECT id, email, password_hash, pin_hash, disabled_at, created_at
         FROM parents WHERE email = ?`,
    )
    .get(normalized);
  if (row === undefined) return undefined;
  return {
    id: row.id,
    email: row.email,
    hasPassword: row.password_hash !== null,
    hasPin: row.pin_hash !== null,
    ...(row.disabled_at === null ? {} : { disabledAt: row.disabled_at }),
    createdAt: row.created_at,
  };
}

/**
 * Ставит родителю пароль в обход приглашения: почтового восстановления у нас
 * нет, и забытый пароль меняет тот, у кого есть доступ к серверу.
 *
 * `credentials_changed_at` двигается, как и при погашении приглашения, и это не
 * побочный эффект, а смысл: смена пароля гасит и родительские сессии, и токены
 * детских устройств. Иначе смена пароля после кражи ноутбука ничего бы не
 * меняла — украденная cookie продолжала бы работать.
 */
export function setParentPassword(
  db: Database.Database,
  parentId: string,
  password: string,
  now: Date = new Date(),
): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Пароль короче ${MIN_PASSWORD_LENGTH} знаков`);
  }
  if (password.length > MAX_SECRET_LENGTH) {
    throw new Error(`Пароль длиннее ${MAX_SECRET_LENGTH} знаков`);
  }
  // Хеширование до записи: `scrypt` стоит десятки миллисекунд и под WAL всё это
  // время держал бы запись в управляющей базе.
  const passwordHash = hashSecret(password);
  const stamp = now.toISOString();
  db.transaction(() => {
    const updated = db
      .prepare('UPDATE parents SET password_hash = ?, credentials_changed_at = ? WHERE id = ? AND disabled_at IS NULL')
      .run(passwordHash, stamp, parentId);
    if (updated.changes === 0) {
      throw new Error(`Родителя ${parentId} нет в управляющей базе или он отключён`);
    }
    invalidateParentArtifacts(db, parentId, stamp);
  }).immediate();
}

/**
 * Отключает родителя. Ни сессии, ни устройства при этом не трогаются: их
 * действительность проверяется выборкой через `parents`, и `disabled_at` гасит
 * их той же строкой — вместе с детьми, чьи базы после этого не обслуживаются.
 *
 * `false` — «уже был отключён»; строка при этом не переписывается, чтобы отметка
 * осталась от первого отключения.
 */
export function disableParent(
  db: Database.Database,
  parentId: string,
  now: Date = new Date(),
): boolean {
  const updated = db
    .prepare('UPDATE parents SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL')
    .run(now.toISOString(), parentId);
  return updated.changes > 0;
}

/* ─── Дети и устройства ─────────────────────────────────────────────────── */

/**
 * Срок приглашения устройства. Сутки, а не неделя приглашения родителя: ссылку
 * ребёнку показывают на экране здесь и сейчас, и всё, что она переживает, —
 * дорога от родительского телефона до детского компьютера.
 */
export const DEVICE_INVITE_TTL_MS = DAY_MS;

/** Предел длины имени ребёнка: оно только подпись в списке, не ключ. */
export const MAX_CHILD_NAME_LENGTH = 64;

/** Предел длины подписи устройства: та же роль, тот же предел. */
export const MAX_DEVICE_LABEL_LENGTH = 64;

/**
 * Каталог детских баз внутри каталога данных. Имя файла — сам `id`, поэтому
 * ничего, кроме `id`, в путь не подставляется.
 */
export const CHILDREN_DIR = 'children';

/**
 * Допустимый `id` ребёнка. Тот же запрет, что и в `CHILD_ID_CHECK` схемы, но
 * проверенный до любого обращения к файловой системе: `id` служит именем файла,
 * и всё, кроме шестнадцатеричных знаков, — это чужой путь.
 */
export const CHILD_ID_PATTERN = /^[0-9a-f]{8,64}$/u;

export type ChildStatus = 'provisioning' | 'ready' | 'failed';

export type DeviceKind = 'browser' | 'agent';

export interface ChildSummary {
  id: string;
  parentId: string;
  name: string;
  status: ChildStatus;
  lastActivityAt?: string;
  retiredAt?: string;
  createdAt: string;
}

/**
 * Выпущенное приглашение устройства. Номер строки отдаётся вместе с токеном:
 * иначе выпустивший её маршрут искал бы своё же устройство перебором списка.
 */
export interface IssuedDeviceInvite extends IssuedToken {
  deviceId: number;
}

export interface DeviceSummary {
  id: number;
  childId: string;
  kind: DeviceKind;
  label: string;
  inviteExpiresAt: string;
  claimedAt?: string;
  revokedAt?: string;
  createdAt: string;
}

/** Причина отказа детскому предъявителю. Наружу маршрут отдаёт один общий текст. */
export type ChildAuthFailure = 'unknown-token' | 'expired' | 'used' | 'disabled' | 'retired' | 'revoked';

export type DeviceClaimResult =
  | { ok: true; childId: string; deviceId: number; kind: DeviceKind; token: string }
  | { ok: false; reason: ChildAuthFailure };

export interface ChildPrincipal {
  childId: string;
  parentId: string;
  /**
   * Устройство, чьим токеном пришёл предъявитель. У захода оператора в чужую
   * семью его нет: он смотрит из админки, а не с детской машины, и выдуманный
   * номер выглядел бы в отзыве устройств настоящей строкой.
   */
  deviceId?: number;
  kind: DeviceKind;
  name: string;
}

/**
 * Путь базы ребёнка. Колонки с путём в управляющей базе нет намеренно: он
 * считается из непрозрачного `id`, и подменить его записью в базе нельзя.
 * Итог канонизируется и сверяется с каталогом `children/`: даже если проверка
 * формата однажды ослабнет, наружу этого каталога путь не выйдет.
 */
export function childDatabasePath(dataDir: string, childId: string): string {
  if (!CHILD_ID_PATTERN.test(childId)) {
    throw new Error(`Идентификатор ребёнка «${childId}» не годится в имя файла базы`);
  }
  const root = resolve(dataDir, CHILDREN_DIR);
  const file = resolve(root, `${childId}.db`);
  // `relative` сравнивает уже канонизированные пути: `..` и разделитель внутри
  // `id` дали бы здесь либо выход вверх, либо вложенный каталог.
  if (relative(root, file) !== `${childId}.db`) {
    throw new Error(`Путь базы ребёнка «${childId}» выводит за каталог ${CHILDREN_DIR}`);
  }
  return file;
}

function requireLiveParent(db: Database.Database, parentId: string): void {
  const parent = db
    .prepare<[string], { disabled_at: string | null }>('SELECT disabled_at FROM parents WHERE id = ?')
    .get(parentId);
  if (parent === undefined) throw new Error(`Родителя ${parentId} нет в управляющей базе`);
  if (parent.disabled_at !== null) throw new Error(`Родитель ${parentId} отключён`);
}

/**
 * Заводит ребёнка. Статус `provisioning` — не украшение: базы у него ещё нет, и
 * до её появления он не должен доставаться ни маршрутам, ни воркеру.
 */
export function createChild(
  db: Database.Database,
  parentId: string,
  name: string,
  now: Date = new Date(),
): string {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_CHILD_NAME_LENGTH) {
    throw new Error(`Имя ребёнка должно быть от 1 до ${MAX_CHILD_NAME_LENGTH} знаков`);
  }
  requireLiveParent(db, parentId);
  const id = randomBytes(16).toString('hex');
  db.prepare(
    `INSERT INTO children (id, parent_id, name, status, created_at)
     VALUES (?, ?, ?, 'provisioning', ?)`,
  ).run(id, parentId, trimmed, now.toISOString());
  return id;
}

function setChildStatus(db: Database.Database, childId: string, status: ChildStatus): void {
  const updated = db
    .prepare('UPDATE children SET status = ? WHERE id = ? AND retired_at IS NULL')
    .run(status, childId);
  if (updated.changes === 0) {
    throw new Error(`Ребёнка ${childId} нет в управляющей базе или он уже выведен`);
  }
}

/** Переводит ребёнка в рабочее состояние. Зовётся, когда база уже на месте. */
export function markChildReady(db: Database.Database, childId: string): void {
  setChildStatus(db, childId, 'ready');
}

/**
 * Отмечает неудачу заведения. Без этого статуса оборванное заведение навсегда
 * осталось бы `provisioning` и молча ждало бы базы, которой никто не создаёт.
 */
export function markChildFailed(db: Database.Database, childId: string): void {
  setChildStatus(db, childId, 'failed');
}

/**
 * Выводит ребёнка. Устройства не трогаются: их действительность проверяется на
 * каждом обращении, и `retired_at` гасит их той же выборкой.
 */
export function retireChild(db: Database.Database, childId: string, now: Date = new Date()): boolean {
  const updated = db
    .prepare('UPDATE children SET retired_at = ? WHERE id = ? AND retired_at IS NULL')
    .run(now.toISOString(), childId);
  return updated.changes > 0;
}

interface ChildRow {
  id: string;
  parent_id: string;
  name: string;
  status: ChildStatus;
  last_activity_at: string | null;
  retired_at: string | null;
  created_at: string;
}

function toChildSummary(row: ChildRow): ChildSummary {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    status: row.status,
    ...(row.last_activity_at === null ? {} : { lastActivityAt: row.last_activity_at }),
    ...(row.retired_at === null ? {} : { retiredAt: row.retired_at }),
    createdAt: row.created_at,
  };
}

/** Список детей родителя. Выведенные не показываются, пока их не спросят явно. */
export function listChildren(
  db: Database.Database,
  parentId: string,
  options: { includeRetired?: boolean } = {},
): ChildSummary[] {
  const rows = db
    .prepare<[string, number], ChildRow>(
      `SELECT id, parent_id, name, status, last_activity_at, retired_at, created_at
         FROM children
        WHERE parent_id = ? AND (? = 1 OR retired_at IS NULL)
        ORDER BY created_at, id`,
    )
    .all(parentId, options.includeRetired === true ? 1 : 0);
  return rows.map(toChildSummary);
}

/** Один ребёнок по `id`. Принадлежность проверяет вызывающий: здесь её нет. */
export function readChild(db: Database.Database, childId: string): ChildSummary | undefined {
  const row = db
    .prepare<[string], ChildRow>(
      `SELECT id, parent_id, name, status, last_activity_at, retired_at, created_at
         FROM children WHERE id = ?`,
    )
    .get(childId);
  return row === undefined ? undefined : toChildSummary(row);
}

/**
 * Ребёнок, которого можно обслуживать: база на месте (`ready`) и он не выведен.
 * Один предикат на всех — и на разрешение аренды в маршрутах, и на обход детей
 * воркером: `provisioning` значит «базы ещё нет», и выданный по нему ребёнок
 * увёл бы занятие или фоновую генерацию в несуществующий файл.
 */
export function isChildServiceable(child: ChildSummary | undefined): boolean {
  return child !== undefined && child.status === 'ready' && child.retiredAt === undefined;
}

/**
 * Все обслуживаемые дети сервера, независимо от родителя. Порядок устойчив:
 * диспетчер воркера обходит детей по нему, и перестановка равных строк давала
 * бы разный порядок обхода на одинаковом состоянии.
 *
 * Отключённый родитель отсекается здесь же. У запроса нет предъявителя —
 * диспетчер и `prefetch` приходят сами, — а `disabled_at` проверяется только на
 * разрешении предъявителя, и без этого соединения фоновая генерация продолжала
 * бы тратить суточную квоту модели на семью, которую только что отключили.
 */
export function listServiceableChildren(db: Database.Database): ChildSummary[] {
  const rows = db
    .prepare<[], ChildRow>(
      `SELECT c.id, c.parent_id, c.name, c.status, c.last_activity_at, c.retired_at, c.created_at
         FROM children c
         JOIN parents p ON p.id = c.parent_id
        WHERE c.status = 'ready' AND c.retired_at IS NULL AND p.disabled_at IS NULL
        ORDER BY c.created_at, c.id`,
    )
    .all();
  return rows.map(toChildSummary);
}

/**
 * Отключён ли родитель этого ребёнка. Тот же отбор, что и у
 * `listServiceableChildren`, но по одному имени: `prefetch --child` зовут именно
 * так, а `npm run parent -- disable` — единственный рычаг «перестать обслуживать
 * семью». Без этой проверки обойти его можно было бы именем ребёнка, продолжая
 * тратить на отключённую семью вызовы модели и её суточную квоту.
 */
export function isChildParentDisabled(db: Database.Database, childId: string): boolean {
  const row = db
    .prepare<[string], { disabled: number }>(
      `SELECT (p.disabled_at IS NOT NULL) AS disabled
         FROM children c
         JOIN parents p ON p.id = c.parent_id
        WHERE c.id = ?`,
    )
    .get(childId);
  return row !== undefined && row.disabled === 1;
}

/**
 * Все дети всех родителей, включая выведенных и незаведённых. Нужен снятию
 * копии: выведенный ребёнок хранит прогресс ровно так же, как обслуживаемый, и
 * бэкап, который его пропускает, обнаруживается только когда возвращать уже
 * нечего.
 */
export function listAllChildren(db: Database.Database): ChildSummary[] {
  const rows = db
    .prepare<[], ChildRow>(
      `SELECT id, parent_id, name, status, last_activity_at, retired_at, created_at
         FROM children
        ORDER BY created_at, id`,
    )
    .all();
  return rows.map(toChildSummary);
}

/**
 * Выпускает приглашение устройства. Открытый токен возвращается один раз: в
 * базе лежит только его отпечаток, как и у приглашения родителя.
 */
export function issueDeviceInvite(
  db: Database.Database,
  childId: string,
  kind: DeviceKind,
  label = '',
  now: Date = new Date(),
  ttlMs: number = DEVICE_INVITE_TTL_MS,
): IssuedDeviceInvite {
  const trimmed = label.trim();
  if (trimmed.length > MAX_DEVICE_LABEL_LENGTH) {
    throw new Error(`Подпись устройства длиннее ${MAX_DEVICE_LABEL_LENGTH} знаков`);
  }
  const child = db
    .prepare<[string], { parent_id: string; status: ChildStatus; retired_at: string | null }>(
      'SELECT parent_id, status, retired_at FROM children WHERE id = ?',
    )
    .get(childId);
  if (child === undefined) throw new Error(`Ребёнка ${childId} нет в управляющей базе`);
  if (child.retired_at !== null) throw new Error(`Ребёнок ${childId} выведен`);
  // Приглашение для ребёнка без готовой базы дало бы вход в никуда: устройство
  // погасило бы ссылку, а первый же запрос упёрся бы в отсутствующего арендатора.
  if (child.status !== 'ready') {
    throw new Error(`Ребёнок ${childId} ещё не готов (${child.status})`);
  }
  requireLiveParent(db, child.parent_id);

  const token = createBearerToken();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const inserted = db
    .prepare(
      `INSERT INTO child_devices (child_id, kind, label, invite_hash, invite_expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(childId, kind, trimmed, hashToken(token), expiresAt, now.toISOString());
  return { token, expiresAt, deviceId: Number(inserted.lastInsertRowid) };
}

interface DeviceInviteRow {
  id: number;
  child_id: string;
  kind: DeviceKind;
  claimed_at: string | null;
  invite_expires_at: string;
  created_at: string;
  revoked_at: string | null;
  retired_at: string | null;
  disabled_at: string | null;
  credentials_changed_at: string | null;
}

function selectDeviceInvite(db: Database.Database, token: string): DeviceInviteRow | undefined {
  return db
    .prepare<[string], DeviceInviteRow>(
      `SELECT d.id, d.child_id, d.kind, d.claimed_at, d.invite_expires_at, d.created_at, d.revoked_at,
              c.retired_at, p.disabled_at, p.credentials_changed_at
         FROM child_devices d
         JOIN children c ON c.id = d.child_id
         JOIN parents p ON p.id = c.parent_id
        WHERE d.invite_hash = ?`,
    )
    .get(hashToken(token));
}

/** То же условие для приглашения устройства; текст один и там, где оно гасится. */
const DEVICE_INVITE_AFTER_CREDENTIALS =
  `created_at >= COALESCE(
     (SELECT p.credentials_changed_at
        FROM parents p JOIN children c ON c.parent_id = p.id
       WHERE c.id = child_devices.child_id), '')`;

function deviceInviteFailure(
  row: DeviceInviteRow | undefined,
  now: Date,
): ChildAuthFailure | undefined {
  if (row === undefined) return 'unknown-token';
  if (row.disabled_at !== null) return 'disabled';
  if (row.retired_at !== null) return 'retired';
  // Отзыв проверяется раньше погашения: родитель, отозвавший утёкшую ссылку,
  // обязан её этим и закрыть. Без этой строки погашение проходило бы успешно, а
  // выданный им токен не разрешался бы никогда (`resolveChildDevice` отбирает
  // по `revoked_at IS NULL`) — то есть ссылка «работала» бы у перехватившего.
  if (row.revoked_at !== null) return 'revoked';
  if (row.claimed_at !== null) return 'used';
  // Смена пароля гасит все выданные токены устройств (`resolveChildDevice`
  // сверяет её с `claimed_at`), и невыкупленная ссылка обязана гаснуть вместе с
  // ними: погашенная после смены, она поставила бы себе свежий `claimed_at` и
  // пережила бы ровно то событие, которым её и снимали.
  if (row.credentials_changed_at !== null && row.credentials_changed_at > row.created_at) {
    return 'expired';
  }
  if (row.invite_expires_at <= now.toISOString()) return 'expired';
  return undefined;
}

/**
 * Гасит приглашение устройства и выдаёт его постоянный токен. Погашение и
 * проверка условий — один `UPDATE`: два одновременных перехода по одной ссылке
 * обязаны завести ровно одно устройство, иначе перехвативший ссылку получает
 * такой же вход, как и ребёнок.
 */
export function redeemDeviceInvite(
  db: Database.Database,
  token: string,
  now: Date = new Date(),
): DeviceClaimResult {
  const deviceToken = createBearerToken();
  const stamp = now.toISOString();
  const inviteHash = hashToken(token);

  return db.transaction((): DeviceClaimResult => {
    // Все условия читаются под записью и только под ней: предпроверка снаружи
    // транзакции ничего бы не сэкономила (токен уже сгенерирован) и разъехалась
    // бы с состоянием, которое видит сам `UPDATE`.
    const before = selectDeviceInvite(db, token);
    const blocked = deviceInviteFailure(before, now);
    if (blocked !== undefined && blocked !== 'used' && blocked !== 'expired') {
      return { ok: false, reason: blocked };
    }
    const consumed = db
      .prepare(
        `UPDATE child_devices SET claimed_at = ?, token_hash = ?
          WHERE invite_hash = ? AND claimed_at IS NULL AND revoked_at IS NULL
            AND invite_expires_at > ?
            AND ${DEVICE_INVITE_AFTER_CREDENTIALS}`,
      )
      .run(stamp, hashToken(deviceToken), inviteHash, stamp);
    if (consumed.changes === 0) {
      return { ok: false, reason: deviceInviteFailure(selectDeviceInvite(db, token), now) ?? 'used' };
    }

    // Как и у родительского приглашения: отказ после удачного погашения
    // зафиксировал бы `claimed_at` вместе с токеном, которого никто не
    // получил, — ссылка сгорела бы, а устройство осталось бы незаведённым.
    const row = selectDeviceInvite(db, token);
    if (row === undefined) throw new Error('Погашенное приглашение устройства исчезло');
    return {
      ok: true,
      childId: row.child_id,
      deviceId: row.id,
      kind: row.kind,
      token: deviceToken,
    };
  }).immediate();
}

/** Отзыв устройства. Строка остаётся для разбора, но предъявителем уже не служит. */
export function revokeDevice(
  db: Database.Database,
  deviceId: number,
  now: Date = new Date(),
): boolean {
  const updated = db
    .prepare('UPDATE child_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(now.toISOString(), deviceId);
  return updated.changes > 0;
}

interface DeviceRow {
  id: number;
  child_id: string;
  kind: DeviceKind;
  label: string;
  invite_expires_at: string;
  claimed_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

const DEVICE_COLUMNS = `id, child_id, kind, label, invite_expires_at, claimed_at, revoked_at, created_at`;

function toDeviceSummary(row: DeviceRow): DeviceSummary {
  return {
    id: row.id,
    childId: row.child_id,
    kind: row.kind,
    label: row.label,
    inviteExpiresAt: row.invite_expires_at,
    ...(row.claimed_at === null ? {} : { claimedAt: row.claimed_at }),
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
    createdAt: row.created_at,
  };
}

/** Устройства ребёнка. Ни отпечатков, ни токенов наружу отсюда не уходит. */
export function listDevices(db: Database.Database, childId: string): DeviceSummary[] {
  return db
    .prepare<[string], DeviceRow>(
      `SELECT ${DEVICE_COLUMNS} FROM child_devices WHERE child_id = ? ORDER BY id`,
    )
    .all(childId)
    .map(toDeviceSummary);
}

/**
 * Одно устройство по `id`. Принадлежность проверяет вызывающий: `id` здесь
 * сквозной по всему серверу, и без проверки ребёнка отзыв по чужому номеру
 * гасил бы устройство соседней семьи.
 */
export function readDevice(db: Database.Database, deviceId: number): DeviceSummary | undefined {
  const row = db
    .prepare<[number], DeviceRow>(`SELECT ${DEVICE_COLUMNS} FROM child_devices WHERE id = ?`)
    .get(deviceId);
  return row === undefined ? undefined : toDeviceSummary(row);
}

interface ChildDeviceRow {
  id: number;
  child_id: string;
  parent_id: string;
  kind: DeviceKind;
  name: string;
  status: ChildStatus;
  claimed_at: string;
  last_activity_at: string | null;
  retired_at: string | null;
  disabled_at: string | null;
  credentials_changed_at: string | null;
}

/**
 * Разрешает токен устройства в детского предъявителя. Все четыре события
 * инвалидации проверяются **здесь**, на каждом обращении, а не при выдаче:
 * токен устройства живёт на детском компьютере месяцами, и отзыв, вывод
 * ребёнка, отключение родителя или смена пароля обязаны действовать сразу.
 * `undefined` — отказ по любой причине: снаружи они неразличимы.
 */
export function resolveChildDevice(
  db: Database.Database,
  token: string,
  now: Date = new Date(),
): ChildPrincipal | undefined {
  const row = db
    .prepare<[string], ChildDeviceRow>(
      `SELECT d.id, d.child_id, d.kind, d.claimed_at,
              c.parent_id, c.name, c.status, c.last_activity_at, c.retired_at,
              p.disabled_at, p.credentials_changed_at
         FROM child_devices d
         JOIN children c ON c.id = d.child_id
         JOIN parents p ON p.id = c.parent_id
        WHERE d.token_hash = ? AND d.revoked_at IS NULL`,
    )
    .get(hashToken(token));
  if (row === undefined) return undefined;
  if (row.disabled_at !== null) return undefined;
  if (row.retired_at !== null) return undefined;
  // Смена пароля родителя — обычно реакция на увод учётной записи, и всё, что
  // было выдано до неё, считается уведённым вместе с ней.
  if (row.credentials_changed_at !== null && row.credentials_changed_at > row.claimed_at) {
    return undefined;
  }
  // Ребёнок без готовой базы предъявителем не служит: обслуживать его нечем.
  if (row.status !== 'ready') return undefined;

  // Отметка активности глушится тем же сроком, что и `last_seen_at` сессии:
  // занятие бьёт в управляющую базу на каждом задании, а диспетчеру воркера
  // хватает свежести в минутах.
  //
  // Отмечается **только браузер ученика**: агент опрашивает `gate/status`
  // раз в двадцать секунд и сам по себе не значит, что за компьютером кто-то
  // сидит. Считая его активностью, диспетчер держал бы каждого оснащённого
  // контроллером ребёнка вечно «за экраном» — то есть приоритет обхода и окно
  // заброшенности переставали бы что-либо означать.
  if (row.kind === 'browser') {
    const lastActivity =
      row.last_activity_at === null ? undefined : Date.parse(row.last_activity_at);
    if (
      lastActivity === undefined ||
      !Number.isFinite(lastActivity) ||
      now.getTime() - lastActivity >= SESSION_TOUCH_MS
    ) {
      db.prepare('UPDATE children SET last_activity_at = ? WHERE id = ?').run(
        now.toISOString(),
        row.child_id,
      );
    }
  }

  return {
    childId: row.child_id,
    parentId: row.parent_id,
    deviceId: row.id,
    kind: row.kind,
    name: row.name,
  };
}

/* ─── Суточная квота вызовов codex ──────────────────────────────────────── */

/**
 * Предел вызовов codex на ребёнка в сутки. Единица счёта — один `runCodexCli`,
 * а не один слот семафора: за одним `budget.run` прячется от двух до шести
 * настоящих вызовов, и счёт по слотам превратил бы предел в кратный ему.
 * Число задано спекой; меняете его — меняйте и её.
 */
export const CODEX_DAILY_QUOTA = 60;

/** Состояние квоты ребёнка на московские сутки. */
export interface CodexQuotaState {
  day: string;
  used: number;
  remaining: number;
  limit: number;
}

/** Итог резерва. `ok = false` — предел исчерпан, счётчик при этом не вырос. */
export interface CodexQuotaReservation extends CodexQuotaState {
  ok: boolean;
}

function requireQuotaLimit(limit: number): void {
  // Ноль неотличим от «квота кончилась навсегда», дробное — от опечатки в
  // переменной окружения; и то и другое молча остановило бы весь фон.
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`Предел суточной квоты должен быть положительным целым, получено ${limit}`);
  }
}

function selectQuotaCalls(db: Database.Database, childId: string, day: string): number {
  const row = db
    .prepare<[string, string], { calls: number }>(
      'SELECT calls FROM codex_quota WHERE child_id = ? AND day = ?',
    )
    .get(childId, day);
  return row?.calls ?? 0;
}

function quotaState(db: Database.Database, childId: string, day: string, limit: number): CodexQuotaState {
  const used = selectQuotaCalls(db, childId, day);
  return { day, used, remaining: Math.max(0, limit - used), limit };
}

/**
 * Резервирует один вызов codex для ребёнка на текущие московские сутки.
 *
 * Резерв берётся **до** вызова и не возвращается, чем бы вызов ни кончился:
 * иначе зацикливание на ошибках модели обходило бы защиту, ради которой квота и
 * заведена. Проверка предела и приращение — один `INSERT ... ON CONFLICT` под
 * `immediate()`: разнеси их, и два фоновых конвейера на границе предела оба
 * увидели бы «место есть».
 */
export function reserveCodexCall(
  db: Database.Database,
  childId: string,
  now: Date = new Date(),
  limit: number = CODEX_DAILY_QUOTA,
): CodexQuotaReservation {
  requireQuotaLimit(limit);
  const day = moscowDate(now);
  return db
    .transaction((): CodexQuotaReservation => {
      const reserved = db
        .prepare(
          `INSERT INTO codex_quota (child_id, day, calls) VALUES (?, ?, 1)
             ON CONFLICT (child_id, day) DO UPDATE SET calls = calls + 1 WHERE calls < ?`,
        )
        .run(childId, day, limit);
      return { ok: reserved.changes > 0, ...quotaState(db, childId, day, limit) };
    })
    .immediate();
}

/** Читает квоту ребёнка на московские сутки, содержащие `now`, ничего не списывая. */
export function readCodexQuota(
  db: Database.Database,
  childId: string,
  now: Date = new Date(),
  limit: number = CODEX_DAILY_QUOTA,
): CodexQuotaState {
  requireQuotaLimit(limit);
  return quotaState(db, childId, moscowDate(now), limit);
}

/* ─── Защита от перебора ────────────────────────────────────────────────── */

/**
 * Порог неудач по адресу электронной почты. Пять попыток — это опечатка и
 * перебор раскладки, а не подбор: словарь на десять тысяч слов через такой
 * порог занимает годы. Число задано спекой; меняете его — меняйте и её.
 */
export const LOGIN_EMAIL_FAILURE_LIMIT = 5;

/**
 * Порог неудач по адресу клиента. Он выше почтового намеренно: за одним
 * адресом стоит вся семья вместе с NAT, и общий порог в пять означал бы, что
 * ошибившийся брат закрывает вход всем остальным.
 */
export const LOGIN_ADDRESS_FAILURE_LIMIT = 20;

/**
 * Пауза после серии неудач. Она же срок жизни счётчика: неудача старше паузы
 * счётчик не наращивает, а начинает заново — иначе редкие опечатки за месяц
 * складывались бы в запрет входа на ровном месте.
 */
export const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

/**
 * Что именно проверяется: пароль родителя, его PIN или пароль оператора.
 * Счётчики раздельные — общий с родительским означал бы, что перебор чужого
 * родительского пароля запирает вход оператору, то есть служит способом
 * ослепить его перед следующим шагом.
 */
export type LoginKind = 'password' | 'pin' | 'admin';

export type LoginScope = 'email' | 'address';

/** Кого считаем. Адрес есть всегда, почта — только там, где вход по ней идёт. */
export interface LoginTarget {
  kind: LoginKind;
  email?: string | undefined;
  address: string;
}

/**
 * Итог проверки. `unavailable` — не «пока нельзя», а «счётчик не читается»:
 * снаружи это тот же отказ, но по нему видно, что сервер сломан, а не занят.
 */
export interface LoginGate {
  allowed: boolean;
  reason?: 'locked' | 'unavailable';
  retryAfterMs: number;
}

const LOGIN_FAILURE_LIMIT: Record<LoginScope, number> = {
  email: LOGIN_EMAIL_FAILURE_LIMIT,
  address: LOGIN_ADDRESS_FAILURE_LIMIT,
};

interface LoginEntry {
  scope: LoginScope;
  key: string;
}

/**
 * Ключи счётчиков одной попытки. Почта берётся приведённой, но **не**
 * проверенной на вид адреса: перебор идёт и по несуществующим ящиках, и такие
 * попытки обязаны считаться тоже. Обрезка по длине — чтобы ключом не служила
 * присланная снаружи строка любого размера.
 */
/**
 * Ключи счётчика по одной попытке: почта (если вход по ней идёт) и адрес, оба
 * приведённые и обрезанные. Экспортируется ради журнала аварий: запись о
 * сработавшем запрете обязана называть тот же ключ, что и панель живых
 * запретов, — своя нормализация рядом с ней разъехалась бы с этой молча.
 */
export function loginEntries(target: LoginTarget): LoginEntry[] {
  const entries: LoginEntry[] = [];
  const email = (target.email ?? '').trim().toLowerCase().slice(0, MAX_EMAIL_LENGTH);
  if (email.length > 0) entries.push({ scope: 'email', key: email });
  const address = target.address.trim().toLowerCase().slice(0, MAX_ADDRESS_LENGTH);
  // Пустой адрес — не повод не считать: без ключа попытка обошла бы счётчик.
  entries.push({ scope: 'address', key: address.length > 0 ? address : UNKNOWN_ADDRESS });
  return entries;
}

interface LoginAttemptRow {
  failures: number;
  last_failed_at: string;
}

function selectLoginAttempt(
  db: Database.Database,
  kind: LoginKind,
  entry: LoginEntry,
): LoginAttemptRow | undefined {
  return db
    .prepare<[LoginScope, LoginKind, string], LoginAttemptRow>(
      'SELECT failures, last_failed_at FROM login_attempts WHERE scope = ? AND kind = ? AND key = ?',
    )
    .get(entry.scope, kind, entry.key);
}

/** Сколько паузы осталось этой строке. Ноль и меньше — счётчик уже остыл. */
function lockoutLeftMs(row: LoginAttemptRow, scope: LoginScope, now: Date): number | undefined {
  const last = Date.parse(row.last_failed_at);
  // Испорченная отметка — неизвестное состояние счётчика, а не «давняя неудача».
  if (!Number.isFinite(last)) return undefined;
  if (row.failures < LOGIN_FAILURE_LIMIT[scope]) return 0;
  return LOGIN_LOCKOUT_MS - (now.getTime() - last);
}

const COUNTER_BROKEN: LoginGate = {
  allowed: false,
  reason: 'unavailable',
  retryAfterMs: LOGIN_LOCKOUT_MS,
};

/**
 * Пускать ли попытку входа. Проверяется **до** сверки секрета: смысл паузы в
 * том, чтобы подбирающий не получал ни ответа, ни `scrypt` на каждый запрос.
 *
 * Fail-closed: любая беда с чтением счётчика — отказ. Открытый вход при
 * недоступной защите ровно тот случай, ради которого её и заводили.
 */
export function checkLoginGate(
  db: Database.Database,
  target: LoginTarget,
  now: Date = new Date(),
): LoginGate {
  try {
    let retryAfterMs = 0;
    for (const entry of loginEntries(target)) {
      const row = selectLoginAttempt(db, target.kind, entry);
      if (row === undefined) continue;
      const left = lockoutLeftMs(row, entry.scope, now);
      if (left === undefined) return COUNTER_BROKEN;
      if (left > 0) retryAfterMs = Math.max(retryAfterMs, left);
    }
    return retryAfterMs > 0 ? { allowed: false, reason: 'locked', retryAfterMs } : { allowed: true, retryAfterMs: 0 };
  } catch {
    return COUNTER_BROKEN;
  }
}

/**
 * Отмечает неудачу по обоим ключам и возвращает состояние, получившееся после
 * неё. Строка старше паузы начинается заново; новая неудача внутри паузы её
 * продлевает — подбирающий не должен пересиживать запрет, продолжая долбить.
 */
export function recordLoginFailure(
  db: Database.Database,
  target: LoginTarget,
  now: Date = new Date(),
): LoginGate {
  const stamp = now.toISOString();
  const stale = new Date(now.getTime() - LOGIN_LOCKOUT_MS).toISOString();
  try {
    return db
      .transaction((): LoginGate => {
        // Остывшие строки убираются здесь же. Ключ по почте задаёт неизвестный
        // клиент, ключ по адресу — сеть, и без уборки единственная таблица
        // управляющей базы, которую растит кто угодно снаружи, растёт навсегда.
        // На решение это не влияет: строка старше паузы и так начинает серию
        // заново (`CASE WHEN last_failed_at <= ?`). Испорченная отметка под
        // сравнение не попадает и остаётся — она означает неизвестное
        // состояние счётчика, а не давнюю неудачу.
        db.prepare('DELETE FROM login_attempts WHERE last_failed_at <= ?').run(stale);
        let retryAfterMs = 0;
        for (const entry of loginEntries(target)) {
          db.prepare(
            `INSERT INTO login_attempts (scope, kind, key, failures, first_failed_at, last_failed_at)
                  VALUES (?, ?, ?, 1, ?, ?)
               ON CONFLICT (scope, kind, key) DO UPDATE SET
                  failures        = CASE WHEN last_failed_at <= ? THEN 1 ELSE failures + 1 END,
                  first_failed_at = CASE WHEN last_failed_at <= ? THEN ? ELSE first_failed_at END,
                  last_failed_at  = ?`,
          ).run(entry.scope, target.kind, entry.key, stamp, stamp, stale, stale, stamp, stamp);
          const row = selectLoginAttempt(db, target.kind, entry);
          const left = row === undefined ? undefined : lockoutLeftMs(row, entry.scope, now);
          if (left === undefined) return COUNTER_BROKEN;
          if (left > 0) retryAfterMs = Math.max(retryAfterMs, left);
        }
        return retryAfterMs > 0
          ? { allowed: false, reason: 'locked', retryAfterMs }
          : { allowed: true, retryAfterMs: 0 };
      })
      .immediate();
  } catch {
    // Незаписанная неудача — та же недоступность счётчика: вход не пускаем.
    return COUNTER_BROKEN;
  }
}

/**
 * Гасит почтовый счётчик после верного секрета. Счётчик по адресу остаётся:
 * за ним стоит и тот, кто подбирает, а знание одного пароля не повод обнулять
 * ему общий счёт. Сам по себе он остынет через паузу.
 */
export function clearLoginFailures(db: Database.Database, target: LoginTarget): void {
  for (const entry of loginEntries(target)) {
    if (entry.scope !== 'email') continue;
    db.prepare('DELETE FROM login_attempts WHERE scope = ? AND kind = ? AND key = ?').run(
      entry.scope,
      target.kind,
      entry.key,
    );
  }
}

/** Действующая пауза входа: строка счётчика, чей предел уже сработал. */
export interface LoginLockout {
  scope: LoginScope;
  kind: LoginKind;
  /** Адрес почты либо адрес клиента — то, по чему счётчик и заведён. */
  key: string;
  failures: number;
  lastFailedAt: string;
  /** Сколько паузы осталось. Всегда больше нуля: остывшие строки сюда не попадают. */
  retryAfterMs: number;
}

/**
 * Все действующие паузы входа. Отбор идёт тем же `lockoutLeftMs`, что и сама
 * проверка: свой порог в сводке разошёлся бы с настоящим молча, и оператор
 * искал бы причину отказа там, где её нет.
 *
 * Испорченная отметка времени в список не попадает, хотя вход по ней и
 * закрывает: `checkLoginGate` считает её неизвестным состоянием счётчика, а не
 * паузой, и назвать её сводке нечем — ни начала, ни остатка у неё нет.
 */
export function listActiveLockouts(db: Database.Database, now: Date = new Date()): LoginLockout[] {
  const rows = db
    .prepare<[], { scope: LoginScope; kind: LoginKind; key: string; failures: number; last_failed_at: string }>(
      `SELECT scope, kind, key, failures, last_failed_at FROM login_attempts
        ORDER BY last_failed_at DESC, scope, kind, key`,
    )
    .all();
  const lockouts: LoginLockout[] = [];
  for (const row of rows) {
    const left = lockoutLeftMs(row, row.scope, now);
    if (left === undefined || left <= 0) continue;
    lockouts.push({
      scope: row.scope,
      kind: row.kind,
      key: row.key,
      failures: row.failures,
      lastFailedAt: row.last_failed_at,
      retryAfterMs: left,
    });
  }
  return lockouts;
}

/* ─── Оператор админки ──────────────────────────────────────────────────── */

/**
 * Нижняя граница пароля оператора. Она выше родительской (10) намеренно: один
 * пароль родителя открывает одну семью, а пароль оператора — все сразу, и
 * второго фактора у входа пока нет. Число задано спекой; меняете его — меняйте
 * и её.
 */
export const MIN_ADMIN_PASSWORD_LENGTH = 16;

/**
 * Срок бездействия сессии оператора. Тридцать минут вместо родительских
 * тридцати дней: у родителя долгая сессия — удобство, у оператора та же цифра
 * означает открытую дверь в чужие семьи с забытого ноутбука.
 */
export const ADMIN_SESSION_IDLE_MS = 30 * 60 * 1000;

/** Абсолютный потолок сессии оператора: рабочий день, и ни часом больше. */
export const ADMIN_SESSION_MAX_MS = 8 * 60 * 60 * 1000;

/**
 * Живая строка оператора одним текстом SQL. Он читается и при разрешении
 * cookie, и погашающим `UPDATE` смены пароля: две разошедшиеся копии условия
 * означали бы, что гасится не то множество строк, которое проверяется, а
 * снимок между отдельными чтением и записью успел бы устареть.
 *
 * Отключение и смена пароля стоят здесь же, а не в JS: `disabled_at` гасит
 * строку, не переписывая её, а `credentials_changed_at` отсекает всё, что было
 * выдано до неё.
 *
 * Имя таблицы — параметр, потому что условие у сессии и у имперсонации
 * буквально одно: разойдясь, они дали бы смену пароля, которая гасит вход, но
 * оставляет открытой имперсонацию, ради которой в этот вход и приходят.
 */
function adminOwnedAlive(table: 'admin_sessions' | 'admin_impersonations'): string {
  return `
  ${table}.revoked_at IS NULL
  AND ${table}.created_at >= COALESCE(
        (SELECT a.credentials_changed_at FROM admins a WHERE a.id = ${table}.admin_id), '')
  AND NOT EXISTS (
        SELECT 1 FROM admins a
         WHERE a.id = ${table}.admin_id AND a.disabled_at IS NOT NULL)`;
}

const ADMIN_SESSION_ALIVE = adminOwnedAlive('admin_sessions');

const IMPERSONATION_ALIVE = adminOwnedAlive('admin_impersonations');

/** Причина отказа во входе оператора. Наружу маршрут отдаёт один общий текст. */
export type AdminAuthFailure =
  | 'unknown-email'
  | 'no-password'
  | 'bad-password'
  | 'disabled'
  | 'weak-password';

export type AdminAuthResult =
  | { ok: true; adminId: string; session: IssuedToken }
  | { ok: false; reason: AdminAuthFailure };

export interface AdminPrincipal {
  adminId: string;
  email: string;
}

/** Оператор так, как его видит обслуживание: без единого хеша наружу. */
export interface AdminRecord {
  id: string;
  email: string;
  /** Пароль уже поставлен CLI. Самого хеша здесь нет намеренно. */
  hasPassword: boolean;
  disabledAt?: string;
  createdAt: string;
}

/**
 * Заводит оператора. Пароля у него ещё нет: приглашений по ссылке у админки
 * нет вовсе, и пароль ставит `setAdminPassword` на самой машине.
 */
export function createAdmin(db: Database.Database, email: string, now: Date = new Date()): string {
  const normalized = normalizeEmail(email);
  if (normalized === undefined) {
    throw new Error(`Адрес оператора «${email}» не похож на электронную почту`);
  }
  const id = randomBytes(16).toString('hex');
  try {
    db.prepare('INSERT INTO admins (id, email, created_at) VALUES (?, ?, ?)').run(
      id,
      normalized,
      now.toISOString(),
    );
  } catch (error) {
    // «UNIQUE constraint failed» ничего не говорит тому, кто запустил CLI.
    if (error instanceof Error && /UNIQUE/i.test(error.message)) {
      throw new Error(`Оператор с адресом ${normalized} уже заведён`);
    }
    throw error;
  }
  return id;
}

/**
 * Оператор по адресу. Отключённый тоже возвращается: CLI обязан сказать «он
 * отключён», а не «такого нет» — иначе повторное заведение упало бы на
 * `UNIQUE` без внятной причины. Неразобранный адрес — `undefined`: для поиска
 * «не адрес» и «нет такого» один и тот же ответ.
 */
export function findAdminByEmail(db: Database.Database, email: string): AdminRecord | undefined {
  const normalized = normalizeEmail(email);
  if (normalized === undefined) return undefined;
  const row = db
    .prepare<[string], {
      id: string;
      email: string;
      password_hash: string | null;
      disabled_at: string | null;
      created_at: string;
    }>(
      `SELECT id, email, password_hash, disabled_at, created_at
         FROM admins WHERE email = ?`,
    )
    .get(normalized);
  if (row === undefined) return undefined;
  return {
    id: row.id,
    email: row.email,
    hasPassword: row.password_hash !== null,
    ...(row.disabled_at === null ? {} : { disabledAt: row.disabled_at }),
    createdAt: row.created_at,
  };
}

/**
 * Ставит оператору пароль. Длина проверяется **до** KDF: иначе длинный пароль
 * становится способом занять процессор, а короткий — сводит на нет `scrypt`.
 *
 * `credentials_changed_at` двигается, и это не побочный эффект, а смысл: смена
 * пароля гасит все сессии оператора. Иначе смена пароля после кражи ноутбука
 * ничего бы не меняла — украденная cookie продолжала бы работать.
 */
export function setAdminPassword(
  db: Database.Database,
  adminId: string,
  password: string,
  now: Date = new Date(),
): void {
  if (password.length < MIN_ADMIN_PASSWORD_LENGTH) {
    throw new Error(`Пароль оператора короче ${MIN_ADMIN_PASSWORD_LENGTH} знаков`);
  }
  if (password.length > MAX_SECRET_LENGTH) {
    throw new Error(`Пароль оператора длиннее ${MAX_SECRET_LENGTH} знаков`);
  }
  // Хеширование до записи: `scrypt` стоит десятки миллисекунд и под WAL всё это
  // время держал бы запись в управляющей базе.
  const passwordHash = hashSecret(password);
  const stamp = now.toISOString();
  db.transaction(() => {
    // Гашение идёт **до** новой отметки: тот же текст `ADMIN_SESSION_ALIVE`
    // после неё не выбрал бы ни одной строки, и сессии остались бы живыми по
    // своим срокам. Одной отметки при этом мало: SQLite и `Date` хранят
    // миллисекунды, и выданную в ту же миллисекунду сессию сравнение строк не
    // упорядочивает.
    db.prepare(
      `UPDATE admin_sessions SET revoked_at = ?
        WHERE admin_id = ? AND ${ADMIN_SESSION_ALIVE}`,
    ).run(stamp, adminId);
    // Имперсонация гасится тем же движением и по той же причине: право войти в
    // чужую семью выдано этим же паролем, и пережить его смену оно не должно.
    db.prepare(
      `UPDATE admin_impersonations SET revoked_at = ?
        WHERE admin_id = ? AND ${IMPERSONATION_ALIVE}`,
    ).run(stamp, adminId);
    const updated = db
      .prepare(
        'UPDATE admins SET password_hash = ?, credentials_changed_at = ? WHERE id = ? AND disabled_at IS NULL',
      )
      .run(passwordHash, stamp, adminId);
    if (updated.changes === 0) {
      throw new Error(`Оператора ${adminId} нет в управляющей базе или он отключён`);
    }
  }).immediate();
}

/**
 * Отключает оператора. Сессии при этом не трогаются: их действительность
 * проверяется тем же `ADMIN_SESSION_ALIVE`, и `disabled_at` гасит их этой же
 * строкой.
 *
 * `false` — «уже был отключён»; строка не переписывается, чтобы отметка
 * осталась от первого отключения.
 */
export function disableAdmin(
  db: Database.Database,
  adminId: string,
  now: Date = new Date(),
): boolean {
  const updated = db
    .prepare('UPDATE admins SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL')
    .run(now.toISOString(), adminId);
  return updated.changes > 0;
}

/**
 * Заводит сессию оператора. `created_at` пишется явно, а не умолчанием схемы:
 * по нему сессия сравнивается с отметкой смены пароля, и расхождение часов
 * SQLite с нашими на секунду погасило бы только что выданный вход.
 */
function insertAdminSession(db: Database.Database, adminId: string, now: Date): IssuedToken {
  const token = createBearerToken();
  const stamp = now.toISOString();
  const expiresAt = new Date(now.getTime() + ADMIN_SESSION_MAX_MS).toISOString();
  db.prepare(
    `INSERT INTO admin_sessions (admin_id, token_hash, last_seen_at, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(adminId, hashToken(token), stamp, expiresAt, stamp);
  return { token, expiresAt };
}

interface AdminCredentialsRow {
  id: string;
  password_hash: string | null;
  disabled_at: string | null;
}

/** Вход по паролю. Любой отказ стоит одного `scrypt`: см. `spendVerificationTime`. */
export function loginAdmin(
  db: Database.Database,
  email: string,
  password: string,
  now: Date = new Date(),
): AdminAuthResult {
  const normalized = normalizeEmail(email);
  const row =
    normalized === undefined
      ? undefined
      : db
          .prepare<[string], AdminCredentialsRow>(
            'SELECT id, password_hash, disabled_at FROM admins WHERE email = ?',
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
  // `verifySecret` отвергает пустые и слишком длинные строки до KDF. Без
  // отдельной траты времени известный адрес отвечал бы на них мгновенно, а
  // неизвестный проходил через dummy-scrypt и выдавал существование записи.
  if (password.length === 0 || password.length > MAX_SECRET_LENGTH) {
    spendVerificationTime();
    return { ok: false, reason: 'bad-password' };
  }
  if (!verifySecret(row.password_hash, password)) {
    return { ok: false, reason: 'bad-password' };
  }
  return { ok: true, adminId: row.id, session: insertAdminSession(db, row.id, now) };
}

interface AdminSessionRow {
  id: number;
  admin_id: string;
  email: string;
  last_seen_at: string;
  expires_at: string;
}

/**
 * Разрешает cookie оператора в предъявителя. `undefined` — отказ по любой
 * причине: снаружи «нет такой сессии» и «сессия погасла» неразличимы.
 */
export function resolveAdminSession(
  db: Database.Database,
  token: string,
  now: Date = new Date(),
): AdminPrincipal | undefined {
  const row = db
    .prepare<[string], AdminSessionRow>(
      `SELECT admin_sessions.id, admin_sessions.admin_id, admin_sessions.last_seen_at,
              admin_sessions.expires_at, admins.email
         FROM admin_sessions JOIN admins ON admins.id = admin_sessions.admin_id
        WHERE admin_sessions.token_hash = ? AND ${ADMIN_SESSION_ALIVE}`,
    )
    .get(hashToken(token));
  if (row === undefined) return undefined;

  const stamp = now.toISOString();
  // Оба срока проверяются на каждом обращении: потолок гасит сессию даже у
  // того, кто работает не отрываясь, а бездействие — забытую вкладку.
  if (row.expires_at <= stamp) return undefined;
  const lastSeen = Date.parse(row.last_seen_at);
  if (!Number.isFinite(lastSeen) || now.getTime() - lastSeen >= ADMIN_SESSION_IDLE_MS) {
    return undefined;
  }

  if (now.getTime() - lastSeen >= SESSION_TOUCH_MS) {
    db.prepare('UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?').run(stamp, row.id);
  }
  return { adminId: row.admin_id, email: row.email };
}

/** Выход. Строка остаётся для разбора, но предъявителем уже не служит. */
export function revokeAdminSession(
  db: Database.Database,
  token: string,
  now: Date = new Date(),
): boolean {
  const result = db
    .prepare('UPDATE admin_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
    .run(now.toISOString(), hashToken(token));
  return result.changes > 0;
}

/**
 * Сколько сессий оператора сейчас живы. Тем же условием и с теми же сроками,
 * что и разрешение cookie: сводка показывает открытые двери, а не строки.
 */
export function countLiveAdminSessions(db: Database.Database, now: Date = new Date()): number {
  const row = db
    .prepare<[string, string], { live: number }>(
      `SELECT COUNT(*) AS live FROM admin_sessions
        WHERE ${ADMIN_SESSION_ALIVE}
          AND admin_sessions.expires_at > ?
          AND admin_sessions.last_seen_at > ?`,
    )
    .get(now.toISOString(), new Date(now.getTime() - ADMIN_SESSION_IDLE_MS).toISOString());
  return row?.live ?? 0;
}

/* ─── Имперсонация ──────────────────────────────────────────────────────── */

/**
 * Срок имперсонации. Пятнадцать минут против восьми часов админской сессии:
 * заход в чужую семью — это «посмотреть и выйти», и всё, что переживает
 * оставленную вкладку, — открытая дверь в чужие данные. Число задано спекой;
 * меняете его — меняйте и её.
 */
export const IMPERSONATION_TTL_MS = 15 * 60 * 1000;

const IMPERSONATION_ROLE_SET: ReadonlySet<string> = new Set(IMPERSONATION_ROLES);

/**
 * Роль ли это из закрытого списка. Проверка нужна во время работы, а не только
 * на сборке: роль приезжает телом запроса, и `agent` там отличается от `parent`
 * одной строкой.
 */
export function isImpersonationRole(value: string): value is ImpersonationRole {
  return IMPERSONATION_ROLE_SET.has(value);
}

/** Причина отказа начать имперсонацию. */
export type ImpersonationFailure = 'bad-role' | 'no-child';

export type ImpersonationStart =
  | {
      ok: true;
      childId: string;
      parentId: string;
      role: ImpersonationRole;
      session: IssuedToken;
    }
  | { ok: false; reason: ImpersonationFailure };

/**
 * Живая имперсонация так, как её видит разрешение предъявителя. Адрес
 * оператора и имя ребёнка здесь потому, что их показывает несъёмная полоса
 * поверх чужого экрана: без них она называет семью тем же непрозрачным `id`,
 * которым её называет URL.
 */
export interface ImpersonationPrincipal {
  adminId: string;
  adminEmail: string;
  childId: string;
  parentId: string;
  childName: string;
  role: ImpersonationRole;
  expiresAt: string;
}

interface ImpersonationRow {
  admin_id: string;
  email: string;
  child_id: string;
  role: string;
  expires_at: string;
}

/**
 * Начинает имперсонацию. `created_at` пишется явно, как и у сессии: по нему
 * строка сравнивается с отметкой смены пароля, и расхождение часов SQLite с
 * нашими на секунду погасило бы только что выданный заход.
 */
export function startImpersonation(
  db: Database.Database,
  // Роль объявлена строкой намеренно: она приходит телом запроса, и сузить её
  // типом — значит проверить на сборке то, что известно только во время работы.
  request: { adminId: string; childId: string; role: string },
  now: Date = new Date(),
): ImpersonationStart {
  const { adminId, childId, role } = request;
  if (!isImpersonationRole(role)) return { ok: false, reason: 'bad-role' };
  const child = readChild(db, childId);
  // «Не тот ребёнок» и «нет такого» — один ответ: обслуживать `provisioning` и
  // выведенного нечем, а разница между ними оператору ничего не даёт.
  //
  // Отключённый родитель сюда же. Заход выдаёт предъявителя семьи в обход её
  // собственного входа, и без этой строки `npm run parent -- disable` —
  // единственный рычаг «перестать обслуживать семью» — переставал бы
  // действовать ровно на том пути, который семью и показывает: обычный вход в
  // неё уже отказан, а оператор входит как ни в чём не бывало.
  if (child === undefined || !isChildServiceable(child) || isChildParentDisabled(db, childId)) {
    return { ok: false, reason: 'no-child' };
  }

  const token = createBearerToken();
  const stamp = now.toISOString();
  const expiresAt = new Date(now.getTime() + IMPERSONATION_TTL_MS).toISOString();
  db.transaction(() => {
    // Гашение прежней и выдача новой — одним движением: живая имперсонация у
    // оператора ровно одна, иначе «в чьей я семье» становится вопросом к
    // вкладке браузера, а не к базе.
    db.prepare(
      `UPDATE admin_impersonations SET revoked_at = ?
        WHERE admin_id = ? AND ${IMPERSONATION_ALIVE}`,
    ).run(stamp, adminId);
    db.prepare(
      `INSERT INTO admin_impersonations (admin_id, child_id, role, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(adminId, childId, role, hashToken(token), expiresAt, stamp);
  }).immediate();

  return { ok: true, childId: child.id, parentId: child.parentId, role, session: { token, expiresAt } };
}

/**
 * Разрешает cookie имперсонации. `undefined` — отказ по любой причине: снаружи
 * «нет такой», «истекла» и «оператора отключили» неразличимы.
 */
export function resolveImpersonation(
  db: Database.Database,
  token: string,
  now: Date = new Date(),
): ImpersonationPrincipal | undefined {
  const row = db
    .prepare<[string], ImpersonationRow>(
      `SELECT admin_impersonations.admin_id, admin_impersonations.child_id,
              admin_impersonations.role, admin_impersonations.expires_at, admins.email
         FROM admin_impersonations JOIN admins ON admins.id = admin_impersonations.admin_id
        WHERE admin_impersonations.token_hash = ? AND ${IMPERSONATION_ALIVE}`,
    )
    .get(hashToken(token));
  if (row === undefined) return undefined;
  if (row.expires_at <= now.toISOString()) return undefined;
  if (!isImpersonationRole(row.role)) {
    // Роль ограничена схемой, и попасть сюда нечему. Но молчаливый отказ на
    // этом месте выглядел бы истёкшим сроком, а испорченная таблица — нет.
    throw new Error(`Имперсонация содержит неизвестную роль «${row.role}»`);
  }

  // Обслуживаемость проверяется на каждом обращении, а не только на старте:
  // пятнадцать минут — долгий срок для «семью вывели», а открытая вкладка
  // продолжала бы показывать базу, которую больше не обслуживают.
  const child = readChild(db, row.child_id);
  if (child === undefined || !isChildServiceable(child)) return undefined;
  // Отключение родителя посреди захода закрывает его так же, как вывод
  // ребёнка: пятнадцать минут — долгий срок, а открытая вкладка иначе
  // продолжала бы показывать семью, которую только что перестали обслуживать.
  if (isChildParentDisabled(db, row.child_id)) return undefined;

  return {
    adminId: row.admin_id,
    adminEmail: row.email,
    childId: child.id,
    parentId: child.parentId,
    childName: child.name,
    role: row.role,
    expiresAt: row.expires_at,
  };
}

/** Выход из имперсонации. Строка остаётся для разбора, но заходом уже не служит. */
export function revokeImpersonation(
  db: Database.Database,
  token: string,
  now: Date = new Date(),
): boolean {
  const result = db
    .prepare(
      'UPDATE admin_impersonations SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL',
    )
    .run(now.toISOString(), hashToken(token));
  return result.changes > 0;
}

/**
 * Что оператор сделал. Список закрыт объединением типов, а не свободной
 * строкой: фильтр по действию имеет смысл, только если множество конечно, а
 * опечатка в имени иначе заводит новое «действие», которого не видно ни в
 * одном фильтре.
 */
export const ADMIN_AUDIT_ACTIONS = [
  'login',
  'login-failed',
  'logout',
  'impersonation-start',
  'impersonation-end',
] as const;

export type AdminAuditAction = (typeof ADMIN_AUDIT_ACTIONS)[number];

const ADMIN_AUDIT_ACTION_SET: ReadonlySet<string> = new Set(ADMIN_AUDIT_ACTIONS);

/** Действие ли это из закрытого списка. Тем же предикатом маршрут проверяет фильтр. */
export function isAdminAuditAction(value: string): value is AdminAuditAction {
  return ADMIN_AUDIT_ACTION_SET.has(value);
}

/** Что пишется в журнал действий. Время ставит сама запись. */
export interface AdminAuditRecord {
  adminId: string;
  action: AdminAuditAction;
  /** Ребёнок и родитель названы значениями: запись переживает уход семьи. */
  childId?: string;
  parentId?: string;
  detail?: string;
}

export interface AdminAuditEntry extends AdminAuditRecord {
  id: number;
  at: string;
}

/** Курсор страницы: обе половины, потому что по одному `at` порядок неоднозначен. */
export interface AdminAuditCursor {
  at: string;
  id: number;
}

export interface AdminAuditPage {
  entries: AdminAuditEntry[];
  /** Курсор следующей страницы; `undefined` — дальше ничего нет. */
  next?: AdminAuditCursor;
}

interface AdminAuditRow {
  id: number;
  admin_id: string;
  at: string;
  action: string;
  child_id: string | null;
  parent_id: string | null;
  detail: string | null;
}

function toAuditEntry(row: AdminAuditRow): AdminAuditEntry {
  // Действие читается обратно с проверкой: строку в таблице пишем только мы,
  // но выпавшее из списка значение обязано быть видно здесь, а не разъезжаться
  // с фильтром молча уже на экране.
  if (!isAdminAuditAction(row.action)) {
    throw new Error(`Журнал действий содержит неизвестное действие «${row.action}»`);
  }
  return {
    id: row.id,
    adminId: row.admin_id,
    at: row.at,
    action: row.action,
    ...(row.child_id === null ? {} : { childId: row.child_id }),
    ...(row.parent_id === null ? {} : { parentId: row.parent_id }),
    ...(row.detail === null ? {} : { detail: row.detail }),
  };
}

/**
 * Пишет действие оператора. Отметка ставится явно, а не умолчанием схемы:
 * страница читается курсором по этому же полю, и расхождение часов SQLite с
 * нашими переставило бы записи местами ровно на границе страницы.
 */
export function recordAdminAudit(
  db: Database.Database,
  record: AdminAuditRecord,
  now: Date = new Date(),
): number {
  if (!isAdminAuditAction(record.action)) {
    throw new Error(`Действие «${record.action}» не входит в журнал действий оператора`);
  }
  const result = db
    .prepare(
      `INSERT INTO admin_audit (admin_id, at, action, child_id, parent_id, detail)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.adminId,
      now.toISOString(),
      record.action,
      record.childId ?? null,
      record.parentId ?? null,
      record.detail ?? null,
    );
  return Number(result.lastInsertRowid);
}

/**
 * Размер страницы журнала действий. Ровно как у ленты аварий: оператор читает
 * их одним движением сверху вниз, и разные размеры страниц у двух соседних
 * лент означали бы, что «дальше» в одной и в другой значит разное.
 */
export const ADMIN_AUDIT_PAGE = 200;

/**
 * Страница журнала, новые сверху. Читается на строку больше запрошенного: так
 * «дальше ничего нет» отличается от «страница кончилась ровно» без второго
 * запроса `COUNT`, который под записью показал бы уже другое число.
 */
export function listAdminAudit(
  db: Database.Database,
  // Курсор и фильтр объявлены принимающими `undefined` явно: страницу
  // продолжают тем же `next`, которого у последней страницы нет, и
  // `exactOptionalPropertyTypes` иначе заставлял бы каждого вызывающего
  // разбирать этот случай спредом.
  options: {
    limit: number;
    action?: AdminAuditAction | undefined;
    before?: AdminAuditCursor | undefined;
  },
): AdminAuditPage {
  const { limit, action, before } = options;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`Размер страницы журнала должен быть положительным целым, а не ${limit}`);
  }
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (action !== undefined) {
    conditions.push('action = ?');
    params.push(action);
  }
  if (before !== undefined) {
    // Обе половины курсора: по одному `at` порядок неоднозначен, и на границе
    // страницы записи одной секунды либо повторились бы, либо пропали.
    conditions.push('(at < ? OR (at = ? AND id < ?))');
    params.push(before.at, before.at, before.id);
  }
  const where = conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`;
  const rows = db
    .prepare<Array<string | number>, AdminAuditRow>(
      `SELECT id, admin_id, at, action, child_id, parent_id, detail
         FROM admin_audit${where}
        ORDER BY at DESC, id DESC LIMIT ?`,
    )
    .all(...params, limit + 1);

  const entries = rows.slice(0, limit).map(toAuditEntry);
  const last = entries[entries.length - 1];
  if (rows.length <= limit || last === undefined) return { entries };
  return { entries, next: { at: last.at, id: last.id } };
}
