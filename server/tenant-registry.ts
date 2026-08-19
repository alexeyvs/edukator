/**
 * Реестр детских баз: по `id` ребёнка отдаёт живое соединение занятия.
 *
 * Однопользовательский сервер открывал базу один раз при старте и держал её в
 * замыкании. Здесь баз столько, сколько детей, и открываются они по первому
 * обращению: заводить соединение на каждый запрос нельзя (выдача задания, приём
 * ответа и разбор спора идут транзакциями, а под WAL новое соединение видело бы
 * чужой снимок посреди read-modify-write), а открывать все базы разом — значит
 * платить за каждого выведенного ребёнка при каждом запуске.
 */
import { statSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { openDatabase } from './db.js';
import { syncTopicState, type TopicGraph } from './curriculum.js';
import { loadSeedBank, SeedBankError } from './codex/seed-bank.js';
import { childDatabasePath, isChildServiceable, readChild } from './control-db.js';
import {
  DisputeCoordinator,
  type BackgroundRunner,
  type DisputeCoordinatorOptions,
} from './dispute-coordinator.js';
import {
  createIntegrityCoordinator,
  type IntegrityCoordinator,
  type IntegrityCoordinatorOptions,
} from './integrity.js';
import { finishRun } from './run.js';
import { finishLearningMaterial } from './learning.js';
import { readDailyGate } from './daily-gate.js';

/**
 * Отпечаток файла базы: устройство и inode. Нужен, чтобы отличить тот файл, с
 * которым занятие открыло соединение, от положенного на его место другого.
 * Иначе подмену не заметить вовсе: по отвязанному файлу отвечает не только
 * `SELECT 1` — под WAL проходит и запись. `SQLITE_FCNTL_HAS_MOVED`, из-за
 * которого в журнальном режиме была бы `SQLITE_READONLY_DBMOVED`, при WAL не
 * спрашивают, так что транзакция завершается успехом, а её данные остаются в
 * файле, которого по пути базы больше нет (проверено на нашем `openDatabase`).
 * Молчаливая потеря и есть причина держать отпечаток руками.
 *
 * `undefined` — файла нет или он не читается; такой ответ значит «сверять не с
 * чем», а не «тот же самый».
 */
export function fileIdentity(path: string): string | undefined {
  try {
    const info = statSync(path);
    return `${String(info.dev)}:${String(info.ino)}`;
  } catch {
    return undefined;
  }
}

/** Соединение занятия вместе с отпечатком файла, к которому оно привязано. */
export interface SessionDatabase {
  db: ReturnType<typeof openDatabase>;
  file: string;
}

/**
 * Открывает соединение занятия и снимает отпечаток файла **до и после**
 * открытия. Одного замера после открытия мало: подмена файла ровно в это окно
 * привязывает соединение к прежнему inode, а в отпечаток кладёт уже новый — тот
 * самый, что health и увидит по пути базы. Сверка совпала бы навсегда, и health
 * до перезапуска отвечал бы 200 занятию, чьи записи уходят в отвязанный файл.
 * Пропавший перед открытием файл (`before === undefined`) — тот же случай, и
 * открытие до него даже не доходит: `openDatabase` завёл бы пустую базу на
 * месте потерянной, а она переживает отказ занятия. Health по ней отвечает
 * «ok», следующий запуск поднимается зелёным — и потеря всего прогресса
 * выглядит здоровьем. По той же причине открытие идёт с `fileMustExist`: файл
 * может пропасть и между замером и открытием, а этот запрет проверяет сам
 * SQLite, атомарно с открытием.
 *
 * Замер свой на каждую базу: у детей разные файлы, и один общий отпечаток
 * означал бы, что подмена базы одного ребёнка либо не замечена, либо гасит
 * занятие всем остальным.
 *
 * Расхождение замеров значит «связь соединения с файлом не подтверждена»:
 * соединение закрывается, занятие не поднимается — как и при недоступной базе.
 * Отказ самого открытия пролетает наверх: его причину печатает вызывающий.
 *
 * Проверка остаётся вероятностной, и точнее её здесь не сделать. Замена вида
 * A→B→A целиком внутри окна открытия (файл подменили и вернули прежний обратно)
 * даёт совпадение замеров при соединении с B. Закрыть эту дыру можно было бы
 * только отпечатком того файла, который открыл сам SQLite, а он наружу не
 * выведен: `better-sqlite3` не отдаёт дескриптор, `PRAGMA database_list` знает
 * лишь путь, и пробной записью подмену не поймать — под WAL она проходит без
 * ошибки (см. `fileIdentity`). Договориться с тем, кто подменяет файл, тоже
 * нельзя: это человек с `cp` мимо всякой блокировки.
 */
export function openSessionDatabase(
  path: string,
  open: (target: string) => ReturnType<typeof openDatabase> = (target) =>
    openDatabase(target, { fileMustExist: true }),
): SessionDatabase | undefined {
  const before = fileIdentity(path);
  if (before === undefined) return undefined;
  const db = open(path);
  const after = fileIdentity(path);
  if (after === before) return { db, file: before };

  // Уборка в своём `try`: отказ закрытия не имеет права заслонить причину.
  try {
    db.close();
  } catch (error) {
    process.stderr.write(`соединение занятия не закрыто: ${(error as Error).message}\n`);
  }
  return undefined;
}

/**
 * Потолок одновременно открытых детских баз. Каждое соединение — это дескриптор
 * файла, отображение WAL и кеш страниц, и без потолка список детей задавал бы
 * расход памяти сервера. Значение с запасом больше домашней семьи: упереться в
 * него на живом сервере не должно.
 */
export const DEFAULT_MAX_OPEN_TENANTS = 32;

/** Причина отказа реестра. По ней маршрут выбирает код ответа. */
export type TenantErrorCode =
  /** Ребёнка нет, он ещё заводится, заведение сорвалось или он выведен. */
  | 'not-serviceable'
  /** Потолок открытых баз исчерпан: новых не открываем, старых не трогаем. */
  | 'too-many-open'
  /** Файл базы недоступен или сменился в момент открытия. */
  | 'unavailable';

/** Отказ реестра по состоянию, а не по поломке кода. */
export class TenantError extends Error {
  constructor(
    readonly code: TenantErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TenantError';
  }
}

/** Открытая аренда: соединение занятия одного ребёнка. */
export interface Tenant {
  childId: string;
  /** Путь базы; считается из `id`, в управляющей базе его нет. */
  path: string;
  db: Database.Database;
  /** Отпечаток файла на момент открытия (см. `fileIdentity`). */
  file: string;
  /**
   * Тот же признак, что `available` у маршрутов занятия: подмена файла базы
   * краснит именно этого ребёнка и не трогает остальных.
   */
  available: () => boolean;
  /**
   * Разбор споров этой базы. Он живёт рядом с проверкой отпечатка по той же
   * причине: спор — строка в базе конкретного ребёнка, и номера у разных детей
   * совпадают.
   */
  disputes: DisputeCoordinator;
  /** Проверка осмысленности ответов этой детской базы. */
  integrity: IntegrityCoordinator;
}

export interface TenantRegistryOptions {
  /** Управляющая база: по ней проверяется, кого вообще можно обслуживать. */
  control: Database.Database;
  /** Каталог данных; путь базы ребёнка считается от него. */
  dataDir: string;
  /** Карта тем: по ней заводятся строки `topic_state` и заливается посев. */
  graph: TopicGraph;
  /** Потолок открытых баз; проверяется как положительное целое. */
  maxOpen?: number;
  /** Каталог посевного банка; подменяется в тестах. */
  seedDir?: string;
  /** Открытие соединения; подменяется в тестах подмены файла. */
  openSession?: (path: string) => SessionDatabase | undefined;
  /** Куда писать о происходящем; по умолчанию stderr. */
  log?: (message: string) => void;
  /** Разбирающий спор; по умолчанию — вызов codex. */
  review?: DisputeCoordinatorOptions['review'];
  /** Запуск фоновой работы разбора; тесты его дожидаются. */
  background?: BackgroundRunner;
  /** Бюджет разбора споров; он процессный и общий на всех детей. */
  disputeBudget?: DisputeCoordinatorOptions['disputeBudget'];
  /** Пауза перед автоматическим повтором незакрытого спора. */
  disputeRetryMs?: number;
  /** Проверяющий осмысленность; по умолчанию — отдельный вызов codex. */
  integrityReview?: IntegrityCoordinatorOptions['review'];
  /** Общий процессный бюджет проверки осмысленности. */
  integrityBudget?: IntegrityCoordinatorOptions['budget'];
  /** Первая пауза фонового повтора проверки. */
  integrityRetryMs?: number;
  /** Часы проверок; обычно совпадают с часами HTTP-маршрутов. */
  now?: () => Date;
}

/**
 * Реестр открытых детских баз.
 *
 * **Вытеснения нет намеренно.** Упёршись в потолок, реестр отказывает новому
 * арендатору и говорит об этом, но не закрывает чужое соединение исподтишка:
 * закрытие под работающей проверкой даёт `database connection is not open`
 * посреди чужого забега, а забытый вместе с соединением отпечаток inode принял
 * бы подменённый файл за прежний. Место освобождает только явный `close`.
 */
export class TenantRegistry {
  readonly #control: Database.Database;
  readonly #dataDir: string;
  readonly #graph: TopicGraph;
  readonly #maxOpen: number;
  readonly #seedDir: string | undefined;
  readonly #openSession: (path: string) => SessionDatabase | undefined;
  readonly #log: (message: string) => void;
  readonly #disputeOptions: Omit<DisputeCoordinatorOptions, 'db' | 'graph' | 'available'>;
  readonly #integrityOptions: Pick<
    IntegrityCoordinatorOptions,
    'review' | 'budget' | 'background' | 'retryMs' | 'now' | 'log'
  >;
  readonly #tenants = new Map<string, Tenant>();
  /** Дети, открытие которых идёт прямо сейчас: см. `open`. */
  readonly #opening = new Set<string>();

  constructor(options: TenantRegistryOptions) {
    const maxOpen = options.maxOpen ?? DEFAULT_MAX_OPEN_TENANTS;
    // Ноль здесь неотличим от «детей нет»: сервер поднялся бы и отказывал всем
    // подряд с той же причиной, что и при пустом списке детей.
    if (!Number.isInteger(maxOpen) || maxOpen < 1) {
      throw new Error(`Потолок открытых баз должен быть положительным целым, а не ${String(maxOpen)}`);
    }
    this.#control = options.control;
    this.#dataDir = options.dataDir;
    this.#graph = options.graph;
    this.#maxOpen = maxOpen;
    this.#seedDir = options.seedDir;
    this.#openSession = options.openSession ?? ((path) => openSessionDatabase(path));
    this.#log = options.log ?? ((message) => process.stderr.write(`${message}\n`));
    this.#disputeOptions = {
      log: this.#log,
      ...(options.review === undefined ? {} : { review: options.review }),
      ...(options.background === undefined ? {} : { background: options.background }),
      ...(options.disputeBudget === undefined ? {} : { disputeBudget: options.disputeBudget }),
      ...(options.disputeRetryMs === undefined ? {} : { disputeRetryMs: options.disputeRetryMs }),
    };
    this.#integrityOptions = {
      log: this.#log,
      ...(options.integrityReview === undefined ? {} : { review: options.integrityReview }),
      ...(options.integrityBudget === undefined ? {} : { budget: options.integrityBudget }),
      ...(options.background === undefined ? {} : { background: options.background }),
      ...(options.integrityRetryMs === undefined ? {} : { retryMs: options.integrityRetryMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
    };
  }

  /** Сколько баз открыто сейчас. */
  get size(): number {
    return this.#tenants.size;
  }

  /** Потолок, с которым реестр собран. */
  get maxOpen(): number {
    return this.#maxOpen;
  }

  /** Уже открытая аренда, без попытки открыть новую. */
  peek(childId: string): Tenant | undefined {
    return this.#tenants.get(childId);
  }

  /** Все открытые аренды. Порядок — порядок открытия. */
  list(): Tenant[] {
    return [...this.#tenants.values()];
  }

  /**
   * Отдаёт соединение ребёнка, открывая его при первом обращении.
   *
   * Открытие синхронно от начала до конца, и это и есть замок: событийный цикл
   * не вклинится между проверкой кеша и записью в него, так что второе
   * обращение застаёт либо готовую аренду, либо ещё не начатое открытие —
   * миграция и посев проходят один раз. `#opening` ловит другой случай: заход
   * в `open` из собственного стека (подменённый `openSession`, обработчик
   * ошибки), при котором проверка кеша уже прошла, а записи в него ещё нет.
   * Если открытию однажды понадобится `await`, замок придётся заводить
   * настоящий: одной синхронности хватать перестанет.
   */
  open(childId: string): Tenant {
    const cached = this.#tenants.get(childId);
    if (cached !== undefined) return cached;

    if (this.#opening.has(childId)) {
      throw new Error(`Повторный вход в открытие базы ребёнка ${childId}`);
    }

    const child = readChild(this.#control, childId);
    if (!isChildServiceable(child)) {
      throw new TenantError('not-serviceable', `Ребёнок ${childId} не обслуживается`);
    }

    // Потолок проверяется после кеша: уже открытому ребёнку он не мешает.
    if (this.#tenants.size >= this.#maxOpen) {
      this.#log(
        `открыто ${String(this.#tenants.size)} баз при потолке ${String(this.#maxOpen)}: ` +
          `ребёнку ${childId} отказано, открытые базы не тронуты`,
      );
      throw new TenantError('too-many-open', `Потолок открытых баз исчерпан: ${childId}`);
    }

    const path = childDatabasePath(this.#dataDir, childId);
    this.#opening.add(childId);
    let opened: SessionDatabase | undefined;
    try {
      opened = this.#openSession(path);
      if (opened === undefined) {
        throw new TenantError('unavailable', `База ребёнка ${childId} недоступна: ${path}`);
      }
      // Темы заводятся до посева: без строк `topic_state` вставка заданий упала
      // бы на внешнем ключе.
      this.#syncCurriculum(childId, opened.db);
      this.#seedBank(childId, opened.db);
    } catch (error) {
      if (opened !== undefined) this.#closeQuietly(childId, opened.db);
      // Испорченный файл базы — состояние одного арендатора, а не поломка
      // сервера: пятисотка от `openDatabase` увела бы отказ в общий обработчик
      // и звала бы к перезапуску всю семью. Наружу уходит общий текст
      // (`AUTH_MESSAGE.unavailable`), а чья именно база испорчена, видно только
      // отсюда: остальные дети при этом работают, и по одному 503 их не
      // различить.
      this.#log(`база ребёнка ${childId} недоступна: ${(error as Error).message}`);
      if (error instanceof TenantError) throw error;
      throw new TenantError('unavailable', `База ребёнка ${childId} недоступна: ${path}`);
    } finally {
      this.#opening.delete(childId);
    }

    const file = opened.file;
    const available = (): boolean => fileIdentity(path) === file;
    const disputes = new DisputeCoordinator({
      ...this.#disputeOptions,
      db: opened.db,
      graph: this.#graph,
      available,
    });
    const integrity = createIntegrityCoordinator({
      ...this.#integrityOptions,
      db: opened.db,
      graph: this.#graph,
      available,
      complete: (runId, at) => {
        const kind = opened.db.prepare<[number], { kind: string }>(
          'SELECT kind FROM runs WHERE id = ?',
        ).get(runId)?.kind;
        if (kind === 'lesson') {
          const result = finishLearningMaterial(opened.db, this.#graph, runId, { now: at });
          const learningGate = readDailyGate(opened.db, at).learning;
          const completed = {
            ...result,
            required: learningGate.required && learningGate.materialId === result.materialId,
          };
          opened.db.prepare('UPDATE runs SET summary = ? WHERE id = ?')
            .run(JSON.stringify(completed), runId);
          return completed;
        }
        if (kind === 'run') return { ...finishRun(opened.db, this.#graph, runId, { now: at }) };
        throw new Error(`Проверка осмысленности не завершает занятие вида «${String(kind)}»`);
      },
    });
    const tenant: Tenant = {
      childId,
      path,
      db: opened.db,
      file,
      available,
      disputes,
      integrity,
    };
    this.#tenants.set(childId, tenant);
    // Восстановление идёт при открытии каждой базы, а не один раз при старте
    // сервера: спор переживает процесс в SQLite, а база второго ребёнка
    // открывается только по первому его обращению — и до него незакрытый спор
    // остался бы без исполнителя навсегда.
    //
    // Отказ восстановления аренду не отменяет: она уже в кеше, часть споров
    // могла встать на разбор и держать соединение, так что закрыть базу отсюда
    // нельзя, а пятисотка наружу запретила бы ребёнку заниматься из-за спора,
    // который и без того переспросится следующим нажатием кнопки.
    try {
      disputes.restore();
    } catch (error) {
      this.#log(
        `незакрытые споры ребёнка ${childId} не восстановлены: ${(error as Error).message}`,
      );
    }
    return tenant;
  }

  /**
   * Закрывает базу одного ребёнка. Отсутствующая аренда — не ошибка.
   *
   * Сначала останавливается разбор споров, и только потом закрывается
   * соединение: фоновый разбор держит на него ссылку и после ответа модели
   * пишет вердикт транзакцией, так что обратный порядок превращал бы штатное
   * закрытие в случайный `database connection is not open`.
   */
  async close(childId: string): Promise<void> {
    const tenant = this.#tenants.get(childId);
    if (tenant === undefined) return;
    this.#tenants.delete(childId);
    await Promise.allSettled([tenant.disputes.stop(), tenant.integrity.stop()]);
    this.#closeQuietly(childId, tenant.db);
  }

  /** Закрывает все базы: остановка сервера обходит арендаторов через неё. */
  async closeAll(): Promise<void> {
    // Последовательно, а не пулом: закрытий столько же, сколько открытых баз,
    // а ждать они умеют только собственные разборы.
    for (const childId of [...this.#tenants.keys()]) await this.close(childId);
  }

  #syncCurriculum(childId: string, db: Database.Database): void {
    const result = syncTopicState(db, this.#graph);

    // Осиротевшие строки не удаляются (тема может вернуться в карту), но и
    // молчать о них нельзя: обычно это переименованный `id`, то есть прогресс,
    // который больше никогда не попадёт ни в план, ни в прогноз.
    if (result.stale.length > 0) {
      this.#log(`у ребёнка ${childId} есть состояния без темы в карте: ${result.stale.join(', ')}`);
    }
  }

  /**
   * Заливает посев один раз за открытие базы. Порча посева ребёнка не роняет:
   * без него приложение работает, просто первая тема холодная — а отказ здесь
   * оставил бы ученика вовсе без занятия.
   */
  #seedBank(childId: string, db: Database.Database): void {
    try {
      const result = loadSeedBank(
        db,
        this.#graph,
        this.#seedDir === undefined ? {} : { dir: this.#seedDir },
      );
      if (result.loaded > 0) {
        this.#log(`посевной банк ребёнка ${childId}: добавлено ${String(result.loaded)} задани(й)`);
      }
    } catch (error) {
      // Частичный итог печатается вместе с причиной: порча одной записи не
      // отменяет остальные, и «посевной банк не загружен» без числа заданий
      // читалось бы как «не загружено ничего».
      const loaded = error instanceof SeedBankError ? error.result.loaded : 0;
      const partial = loaded > 0 ? ` (успело добавиться ${String(loaded)} задани(й))` : '';
      this.#log(
        `посевной банк ребёнка ${childId} не загружен${partial}: ${(error as Error).message}`,
      );
    }
  }

  #closeQuietly(childId: string, db: Database.Database): void {
    try {
      db.close();
    } catch (error) {
      // Отказ закрытия не имеет права заслонить то, ради чего закрывали.
      this.#log(`база ребёнка ${childId} не закрыта: ${(error as Error).message}`);
    }
  }
}
