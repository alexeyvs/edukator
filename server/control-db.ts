import Database from 'better-sqlite3';

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
