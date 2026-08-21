/**
 * Слой 1 статистики оператора: всё, что видно из одной `control.db`.
 *
 * Ни одной детской базы этот обход не открывает — и это его главное свойство, а
 * не экономия. Это первый экран админки, и открыть он обязан ровно тогда, когда
 * с детскими базами что-то не так: испорченный файл, база новее приложения,
 * пропавший каталог. Обход, который ради двух цифр открывает тридцать баз,
 * отказал бы вместе с первой из них — то есть ровно в тот момент, ради которого
 * оператор в админку и заходит.
 *
 * Размеры баз поэтому берутся `statSync` по вычисленному из `id` пути: файл на
 * диске измеряется, не открываясь, и подменённый или битый ничем не отличается
 * от исправного.
 */
import { statSync, statfsSync } from 'node:fs';
import type { Database } from 'better-sqlite3';
import {
  CODEX_DAILY_QUOTA,
  childDatabasePath,
  countLiveAdminSessions,
  countLiveParentSessions,
  listActiveLockouts,
  type ChildStatus,
  type LoginLockout,
} from '../control-db.js';
import { controlDatabasePath } from '../data-dir.js';
import { moscowDate } from '../moscow-time.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Окна «заведено недавно». Оба задают спека и первый экран, а не расчёт. */
export const OVERVIEW_WINDOW_DAYS = [7, 30] as const;

/**
 * С какого возраста незавершённое заведение считается застрявшим. Протокол
 * `provisioning` → `ready` проходит за секунды: час здесь не порог терпения, а
 * заведомо недостижимый для исправного заведения срок, после которого строка
 * означает оборванный процесс, а не идущую работу.
 */
export const STUCK_PROVISIONING_MS = 60 * 60 * 1000;

/** Сколько заведено всего и за оба окна. */
export interface AdminCreatedCounts {
  total: number;
  last7Days: number;
  last30Days: number;
}

export interface AdminParentsOverview extends AdminCreatedCounts {
  disabled: number;
}

/**
 * Четыре состояния разбивают `total` без пересечений: выведенный ребёнок
 * считается только в `retired`, каким бы ни был его `status`. `retireChild`
 * трогает лишь `retired_at`, так что без этой оговорки выведенный при
 * `provisioning` ребёнок вечно висел бы на главном экране заведением, которое
 * никто не чинит, — а в списке застрявших его законно нет.
 */
export interface AdminChildrenOverview extends AdminCreatedCounts {
  ready: number;
  provisioning: number;
  failed: number;
  retired: number;
}

/** Ребёнок, чьё заведение не доехало: базы у него либо нет, либо она неизвестна. */
export interface AdminStuckChild {
  childId: string;
  parentId: string;
  name: string;
  status: Exclude<ChildStatus, 'ready'>;
  createdAt: string;
}

/** Расход суточной квоты одним ребёнком. Нулевые в список не попадают. */
export interface AdminQuotaChild {
  childId: string;
  used: number;
}

export interface AdminQuotaOverview {
  /** Московские сутки, за которые считан расход. */
  day: string;
  /** Предел на одного ребёнка, а не на сервер: квота именно такая. */
  limit: number;
  /** Сумма по всем детям. */
  used: number;
  children: AdminQuotaChild[];
}

export interface AdminSessionsOverview {
  parents: number;
  admins: number;
}

export interface AdminDevicesOverview {
  browser: number;
  agent: number;
  /** Выпущенные и ещё не погашенные приглашения устройств. */
  pendingInvites: number;
}

/** Размер одной базы на диске. Отсутствие файла — это состояние, а не ноль. */
export interface AdminDatabaseSize {
  childId: string;
  bytes: number;
  /** `false` — файла нет вовсе: у застрявшего заведения так и должно быть. */
  present: boolean;
}

export interface AdminStorageOverview {
  controlBytes: number;
  childrenBytes: number;
  totalBytes: number;
  /** Свободное место каталога данных; `undefined` — файловая система не ответила. */
  freeBytes?: number;
  children: AdminDatabaseSize[];
}

/** Ребёнок в списке семей: состояние, а не содержание занятий. */
export interface AdminFamilyChild {
  childId: string;
  name: string;
  status: ChildStatus;
  lastActivityAt?: string;
  retiredAt?: string;
  createdAt: string;
}

/**
 * Семья целиком. Выведенные дети остаются в списке: «куда делся ребёнок» —
 * такой же вопрос оператору, как «почему он не занимается», и семья без них
 * выглядела бы пустой у того, кто всех детей вывел.
 */
export interface AdminFamily {
  parentId: string;
  email: string;
  disabledAt?: string;
  createdAt: string;
  children: AdminFamilyChild[];
}

export interface AdminOverview {
  generatedAt: string;
  families: AdminFamily[];
  parents: AdminParentsOverview;
  children: AdminChildrenOverview;
  stuck: AdminStuckChild[];
  quota: AdminQuotaOverview;
  sessions: AdminSessionsOverview;
  devices: AdminDevicesOverview;
  lockouts: LoginLockout[];
  storage: AdminStorageOverview;
}

export interface AdminOverviewOptions {
  /** Каталог данных: по нему считаются пути детских баз и свободное место. */
  dataDir: string;
  now?: Date;
  /** Предел суточной квоты, если он переопределён вызывающим. */
  quotaLimit?: number;
}

interface ParentsRow {
  total: number;
  last7: number;
  last30: number;
  disabled: number;
}

interface ChildrenRow extends Omit<ParentsRow, 'disabled'> {
  ready: number;
  provisioning: number;
  failed: number;
  retired: number;
}

interface StuckRow {
  id: string;
  parent_id: string;
  name: string;
  status: Exclude<ChildStatus, 'ready'>;
  created_at: string;
}

/**
 * Спутники WAL. Считаются вместе с основным файлом: под WAL часть зафиксированных
 * транзакций лежит именно в `-wal`, и размер одного файла занижал бы то, что
 * база на самом деле занимает на диске.
 */
const DATABASE_SUFFIXES = ['', '-wal', '-shm'] as const;

/** Размер базы вместе со спутниками. `undefined` — основного файла нет. */
function databaseSize(path: string): number | undefined {
  let total = 0;
  let present = false;
  for (const suffix of DATABASE_SUFFIXES) {
    try {
      total += statSync(`${path}${suffix}`).size;
      if (suffix === '') present = true;
    } catch {
      // Пропавший спутник — обычное дело у закрытой базы; пропавший основной
      // файл разбирается вызывающим по `present`.
    }
  }
  return present ? total : undefined;
}

/**
 * Строка агрегата. `COUNT` возвращает её всегда, даже по пустой таблице, но
 * типы `better-sqlite3` об этом не знают. Подставленный вместо неё ноль сделал
 * бы «родителей нет» и «база не ответила» одинаковыми на экране, поэтому здесь
 * отказ, а не умолчание.
 */
function requireAggregate<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new Error(`Управляющая база не ответила на подсчёт: ${what}`);
  return row;
}

/** Свободное место каталога данных. Отказ — не повод не отдать всю сводку. */
function freeSpace(dir: string): number | undefined {
  try {
    const stats = statfsSync(dir);
    return stats.bsize * stats.bavail;
  } catch {
    return undefined;
  }
}

/**
 * Сводка первого экрана. Одно чтение управляющей базы плюс `stat` файлов: ни
 * одного соединения к детской базе здесь не открывается.
 */
function buildAdminOverviewSnapshot(
  control: Database,
  options: AdminOverviewOptions,
): AdminOverview {
  const now = options.now ?? new Date();
  const stamp = now.toISOString();
  const [days7, days30] = OVERVIEW_WINDOW_DAYS;
  const since7 = new Date(now.getTime() - days7 * DAY_MS).toISOString();
  const since30 = new Date(now.getTime() - days30 * DAY_MS).toISOString();
  const quotaLimit = options.quotaLimit ?? CODEX_DAILY_QUOTA;

  const parents = requireAggregate(
    control
      .prepare<[string, string], ParentsRow>(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(created_at >= ?), 0) AS last7,
                COALESCE(SUM(created_at >= ?), 0) AS last30,
                COALESCE(SUM(disabled_at IS NOT NULL), 0) AS disabled
           FROM parents`,
      )
      .get(since7, since30),
    'родители',
  );

  const children = requireAggregate(
    control
      .prepare<[string, string], ChildrenRow>(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(created_at >= ?), 0) AS last7,
                COALESCE(SUM(created_at >= ?), 0) AS last30,
                COALESCE(SUM(status = 'ready' AND retired_at IS NULL), 0) AS ready,
                COALESCE(SUM(status = 'provisioning' AND retired_at IS NULL), 0) AS provisioning,
                COALESCE(SUM(status = 'failed' AND retired_at IS NULL), 0) AS failed,
                COALESCE(SUM(retired_at IS NOT NULL), 0) AS retired
           FROM children`,
      )
      .get(since7, since30),
    'дети',
  );

  // Выведенный ребёнок в застрявших не значится ни при каком статусе: его
  // заведение уже никого не ждёт, и чинить там нечего.
  const stuck = control
    .prepare<[string], StuckRow>(
      `SELECT id, parent_id, name, status, created_at
         FROM children
        WHERE retired_at IS NULL
          AND (status = 'failed' OR (status = 'provisioning' AND created_at <= ?))
        ORDER BY created_at, id`,
    )
    .all(new Date(now.getTime() - STUCK_PROVISIONING_MS).toISOString());

  const day = moscowDate(now);
  const quotaRows = control
    .prepare<[string], { child_id: string; calls: number }>(
      `SELECT child_id, calls FROM codex_quota
        WHERE day = ? AND calls > 0
        ORDER BY calls DESC, child_id`,
    )
    .all(day);

  // Счёт живых устройств повторяет предикат `resolveChildDevice`, а не считает
  // строки: цифра на экране обещает «столько устройств сервер прямо сейчас
  // пустит». Отключённый родитель, выведенный ребёнок, неготовая база и смена
  // пароля гасят токен, не трогая `revoked_at`, — и без этих условий панель
  // после смены пароля (обычной реакции на утёкшую ссылку) продолжала бы
  // отчитываться о погашенных устройствах как о живых. То же рассуждение, что
  // у `countLiveParentSessions`.
  const DEVICE_LIVE = `d.revoked_at IS NULL
        AND p.disabled_at IS NULL AND c.retired_at IS NULL AND c.status = 'ready'`;
  const deviceRows = control
    .prepare<[], { kind: 'browser' | 'agent'; live: number }>(
      `SELECT d.kind AS kind, COUNT(*) AS live FROM child_devices d
         JOIN children c ON c.id = d.child_id
         JOIN parents p ON p.id = c.parent_id
        WHERE d.claimed_at IS NOT NULL AND ${DEVICE_LIVE}
          AND (p.credentials_changed_at IS NULL OR p.credentials_changed_at <= d.claimed_at)
        GROUP BY d.kind`,
    )
    .all();
  const pendingInvites = requireAggregate(
    control
      .prepare<[string], { pending: number }>(
        `SELECT COUNT(*) AS pending FROM child_devices d
           JOIN children c ON c.id = d.child_id
           JOIN parents p ON p.id = c.parent_id
          WHERE d.claimed_at IS NULL AND ${DEVICE_LIVE} AND d.invite_expires_at > ?
            AND d.created_at >= COALESCE(p.credentials_changed_at, '')`,
      )
      .get(stamp),
    'приглашения устройств',
  ).pending;

  // Список берётся полным, вместе с выведенными: место на диске они занимают
  // так же, а «куда делись гигабайты» — вопрос как раз к ним.
  const childRows = control
    .prepare<[], {
      id: string;
      parent_id: string;
      name: string;
      status: ChildStatus;
      last_activity_at: string | null;
      retired_at: string | null;
      created_at: string;
    }>(
      `SELECT id, parent_id, name, status, last_activity_at, retired_at, created_at
         FROM children ORDER BY created_at, id`,
    )
    .all();
  const sizes: AdminDatabaseSize[] = childRows.map((row) => {
    const bytes = databaseSize(childDatabasePath(options.dataDir, row.id));
    return bytes === undefined
      ? { childId: row.id, bytes: 0, present: false }
      : { childId: row.id, bytes, present: true };
  });
  // Семьи собираются из тех же строк, что и размеры: второй проход по
  // `children` разошёлся бы с первым ровно тогда, когда между ними кого-то
  // завели, и ребёнок оказался бы в списке семьи без своего размера на диске.
  const byParent = new Map<string, AdminFamilyChild[]>();
  for (const row of childRows) {
    const list = byParent.get(row.parent_id) ?? [];
    list.push({
      childId: row.id,
      name: row.name,
      status: row.status,
      ...(row.last_activity_at === null ? {} : { lastActivityAt: row.last_activity_at }),
      ...(row.retired_at === null ? {} : { retiredAt: row.retired_at }),
      createdAt: row.created_at,
    });
    byParent.set(row.parent_id, list);
  }
  // Родитель без детей остаётся в списке: заведённая и пустая учётная запись —
  // это состояние, за которым оператор и приходит («пригласил и не завёл»).
  const families: AdminFamily[] = control
    .prepare<[], { id: string; email: string; disabled_at: string | null; created_at: string }>(
      'SELECT id, email, disabled_at, created_at FROM parents ORDER BY created_at, id',
    )
    .all()
    .map((row) => ({
      parentId: row.id,
      email: row.email,
      ...(row.disabled_at === null ? {} : { disabledAt: row.disabled_at }),
      createdAt: row.created_at,
      children: byParent.get(row.id) ?? [],
    }));

  const controlBytes = databaseSize(controlDatabasePath(options.dataDir)) ?? 0;
  const childrenBytes = sizes.reduce((sum, size) => sum + size.bytes, 0);
  const free = freeSpace(options.dataDir);

  return {
    generatedAt: stamp,
    families,
    parents: {
      total: parents.total,
      last7Days: parents.last7,
      last30Days: parents.last30,
      disabled: parents.disabled,
    },
    children: {
      total: children.total,
      last7Days: children.last7,
      last30Days: children.last30,
      ready: children.ready,
      provisioning: children.provisioning,
      failed: children.failed,
      retired: children.retired,
    },
    stuck: stuck.map((row) => ({
      childId: row.id,
      parentId: row.parent_id,
      name: row.name,
      status: row.status,
      createdAt: row.created_at,
    })),
    quota: {
      day,
      limit: quotaLimit,
      used: quotaRows.reduce((sum, row) => sum + row.calls, 0),
      children: quotaRows.map((row) => ({ childId: row.child_id, used: row.calls })),
    },
    sessions: {
      parents: countLiveParentSessions(control, now),
      admins: countLiveAdminSessions(control, now),
    },
    devices: {
      browser: deviceRows.find((row) => row.kind === 'browser')?.live ?? 0,
      agent: deviceRows.find((row) => row.kind === 'agent')?.live ?? 0,
      pendingInvites,
    },
    lockouts: listActiveLockouts(control, now),
    storage: {
      controlBytes,
      childrenBytes,
      totalBytes: controlBytes + childrenBytes,
      ...(free === undefined ? {} : { freeBytes: free }),
      children: sizes,
    },
  };
}

/**
 * Builds every control-db part of one response from the same WAL snapshot.
 * Separate autocommit SELECTs could otherwise mix totals from before a
 * concurrent provisioning transaction with family rows from after it.
 */
export function buildAdminOverview(
  control: Database,
  options: AdminOverviewOptions,
): AdminOverview {
  return control.transaction(() => buildAdminOverviewSnapshot(control, options))();
}
