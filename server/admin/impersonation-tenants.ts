/**
 * Второй замок имперсонации: своё соединение к базе ребёнка, на котором стоит
 * `PRAGMA query_only = ON`.
 *
 * Первый замок — отказ `read-only` в `resolveTenant` — держится на том, что
 * маршрут честно назвал себя изменяющим. Этого мало: `mutating` у нового
 * маршрута забывается молча, и цена ошибки здесь не 500, а запись в чужую
 * семью. Второй замок стоит ниже всякой матрицы: движок отказывает сам.
 *
 * Соединение **своё**, а не общий handle реестра: `query_only` — свойство
 * соединения, и включённый на общем он запер бы запись самому ребёнку, который
 * в это время занимается. И **не** голый `readonly`: настройка соединения живёт
 * в `openDatabase` (там же WAL и `PRAGMA foreign_keys = ON`), а имперсонация
 * обязана воспроизводить настоящий вход и отличаться ровно одним — иначе
 * оператор смотрит не на то, что видит семья.
 *
 * Аренда при этом открывается обычным путём, через реестр: миграция, посев и
 * координаторы отрабатывают так же, как для настоящего входа. Маршруту
 * достаётся та же аренда со вторым handle вместо `db`.
 */
import type Database from 'better-sqlite3';
import { IMPERSONATION_TTL_MS } from '../control-db.js';
import {
  openSessionDatabase,
  TenantError,
  type SessionDatabase,
  type Tenant,
} from '../tenant-registry.js';

/** Открытый handle только для чтения вместе с арендой, поверх которой он открыт. */
interface ReadOnlyHandle {
  db: Database.Database;
  /**
   * Аренда на момент открытия. Сравнивается по ссылке: реестр заводит новый
   * объект на каждое открытие базы, так что другая ссылка значит «базу
   * закрывали и открывали заново», то есть handle привязан к прежнему файлу.
   */
  source: Tenant;
  /** Когда handle трогали в последний раз; по нему его снимает срок. */
  touchedAt: number;
}

export interface ImpersonationTenantsOptions {
  /**
   * Насколько handle переживает последний запрос оператора. Умолчание — срок
   * самого захода: не тронутое дольше него соединение принадлежит заходу,
   * который уже не пустят.
   */
  ttlMs?: number;
  /** Открытие соединения; подменяется в тестах подмены файла. */
  openSession?: (path: string) => SessionDatabase | undefined;
  now?: () => Date;
  log?: (message: string) => void;
}

/**
 * Соединения только для чтения, открытые заходами оператора в чужие семьи.
 *
 * Кеш по ребёнку, а не по заходу: соединение к одной базе одно, и оператор,
 * листающий чужой дашборд, не заводит его на каждый запрос.
 *
 * Таймера здесь нет намеренно. Истёкший заход до `view` не доезжает вовсе — его
 * отвергает разбор предъявителя, — так что снимать просроченный handle некому,
 * кроме подметания при следующем заходе и общего закрытия. Заводить ради этого
 * будильник значило бы держать процесс живым ради соединения, которое ничего не
 * пишет и никого не блокирует.
 */
export class ImpersonationTenants {
  readonly #handles = new Map<string, ReadOnlyHandle>();
  readonly #ttlMs: number;
  readonly #openSession: (path: string) => SessionDatabase | undefined;
  readonly #now: () => Date;
  readonly #log: (message: string) => void;

  constructor(options: ImpersonationTenantsOptions = {}) {
    const ttlMs = options.ttlMs ?? IMPERSONATION_TTL_MS;
    // Ноль или отрицательное значение снимали бы handle раньше, чем им успели
    // воспользоваться, — то есть превращали бы кеш в открытие на каждый запрос.
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error(`Срок соединения имперсонации должен быть положительным, а не ${String(ttlMs)}`);
    }
    this.#ttlMs = ttlMs;
    this.#openSession = options.openSession ?? ((path) => openSessionDatabase(path));
    this.#now = options.now ?? ((): Date => new Date());
    this.#log = options.log ?? ((message) => process.stderr.write(`${message}\n`));
  }

  /** Сколько соединений открыто сейчас. */
  get size(): number {
    return this.#handles.size;
  }

  /**
   * Та же аренда, но с соединением только для чтения вместо `db`.
   *
   * Отпечаток файла сверяется с отпечатком аренды: второй handle открывается
   * позже первого, и подмена файла между открытиями дала бы оператору чужой
   * файл под именем этого ребёнка. Расхождение — тот же `unavailable`, что и у
   * реестра.
   */
  view(tenant: Tenant): Tenant {
    this.#sweep();

    const cached = this.#handles.get(tenant.childId);
    if (cached !== undefined && cached.source === tenant) {
      cached.touchedAt = this.#now().getTime();
      return { ...tenant, db: cached.db };
    }
    // Аренду переоткрыли: прежний handle привязан к соединению, которого уже
    // нет, и переиспользовать его нельзя.
    if (cached !== undefined) this.close(tenant.childId);

    const opened = this.#openSession(tenant.path);
    if (opened === undefined) {
      throw new TenantError('unavailable', `База ребёнка ${tenant.childId} недоступна: ${tenant.path}`);
    }
    if (opened.file !== tenant.file) {
      this.#closeQuietly(tenant.childId, opened.db);
      throw new TenantError(
        'unavailable',
        `Файл базы ребёнка ${tenant.childId} сменился между открытиями`,
      );
    }

    try {
      opened.db.pragma('query_only = ON');
      // Итог перечитывается по той же причине, что и у внешних ключей:
      // установка прагмы ничего не возвращает, и молча не включившийся
      // `query_only` оставил бы оператора с обычным пишущим соединением — то
      // есть снял бы второй замок, не сказав об этом ни слова.
      const queryOnly = opened.db.pragma('query_only', { simple: true });
      if (queryOnly !== 1) {
        throw new Error(`query_only не включился (${String(queryOnly)})`);
      }
    } catch (error) {
      this.#closeQuietly(tenant.childId, opened.db);
      throw error;
    }

    this.#handles.set(tenant.childId, {
      db: opened.db,
      source: tenant,
      touchedAt: this.#now().getTime(),
    });
    return { ...tenant, db: opened.db };
  }

  /** Закрывает соединение одного ребёнка. Отсутствующее — не ошибка. */
  close(childId: string): void {
    const handle = this.#handles.get(childId);
    if (handle === undefined) return;
    this.#handles.delete(childId);
    this.#closeQuietly(childId, handle.db);
  }

  /** Закрывает все соединения: остановка сервера проходит через неё. */
  closeAll(): void {
    for (const childId of [...this.#handles.keys()]) this.close(childId);
  }

  /** Снимает handle, не тронутые дольше срока захода. */
  #sweep(): void {
    const deadline = this.#now().getTime() - this.#ttlMs;
    for (const [childId, handle] of [...this.#handles]) {
      if (handle.touchedAt <= deadline) this.close(childId);
    }
  }

  #closeQuietly(childId: string, db: Database.Database): void {
    try {
      db.close();
    } catch (error) {
      // Отказ закрытия не имеет права заслонить то, ради чего закрывали.
      this.#log(`соединение имперсонации ребёнка ${childId} не закрыто: ${(error as Error).message}`);
    }
  }
}
