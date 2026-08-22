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
import type { CurriculumSnapshot } from './curriculum-provider.js';
import { loadSeedBank, SeedBankError } from './codex/seed-bank.js';
import { childDatabasePath, isChildServiceable, readChild } from './control-db.js';
import {
  DisputeCoordinator,
  type BackgroundRunner,
  type DisputeCoordinatorOptions,
  type DisputeScheduler,
} from './dispute-coordinator.js';
import {
  createIntegrityCoordinator,
  type IntegrityCoordinator,
  type IntegrityCoordinatorOptions,
} from './integrity.js';
import { finishRun } from './run.js';
import { finishLearningMaterial } from './learning.js';
import { readDailyGate } from './daily-gate.js';
import { failureLogFor, type FailureLog, type FailureRecord } from './log.js';

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
  /** Immutable программа, зафиксированная для текущей операции. */
  curriculum: CurriculumSnapshot;
  /** Карта редакции сохранённого run (включая уже снятый курс). */
  graphForRun: (runId: number) => TopicGraph;
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
  disputes: DisputeScheduler;
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
  /** Персональные снимки и исторические редакции каталога. */
  curriculum?: Pick<import('./curriculum-provider.js').CurriculumProvider, 'get' | 'graphFor'>;
  /** Потолок открытых баз; проверяется как положительное целое. */
  maxOpen?: number;
  /** Каталог посевного банка; подменяется в тестах. */
  seedDir?: string;
  /** Открытие соединения; подменяется в тестах подмены файла. */
  openSession?: (path: string) => SessionDatabase | undefined;
  /** Куда писать о происходящем; по умолчанию stderr. */
  log?: (message: string) => void;
  /** Журнал аварий; по умолчанию — файл в том же каталоге данных. */
  failures?: FailureLog;
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
  readonly #curriculum: TenantRegistryOptions['curriculum'];
  readonly #maxOpen: number;
  readonly #seedDir: string | undefined;
  readonly #openSession: (path: string) => SessionDatabase | undefined;
  readonly #log: (message: string) => void;
  readonly #failures: FailureLog;
  readonly #disputeOptions: Omit<
    DisputeCoordinatorOptions,
    'db' | 'graph' | 'graphForDispute' | 'available'
  >;
  readonly #integrityOptions: Pick<
    IntegrityCoordinatorOptions,
    'review' | 'budget' | 'background' | 'retryMs' | 'now' | 'log'
  >;
  readonly #tenants = new Map<string, Tenant>();
  /** Дети, открытие которых идёт прямо сейчас: см. `open`. */
  readonly #opening = new Set<string>();
  /** Уже названные аварии открытия, по ребёнку: см. `#reportOnce`. */
  readonly #reported = new Map<string, Set<string>>();

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
    this.#curriculum = options.curriculum;
    this.#maxOpen = maxOpen;
    this.#seedDir = options.seedDir;
    this.#openSession = options.openSession ?? ((path) => openSessionDatabase(path));
    this.#log = options.log ?? ((message) => process.stderr.write(`${message}\n`));
    // Умолчание настоящее, а не пустышка: каталог данных реестр знает, и
    // молчаливая потеря аварии — ровно то, чего журнал заведён не допускать.
    this.#failures = options.failures ?? failureLogFor(options.dataDir);
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
    const cached = this.#tenants.get(childId);
    return cached === undefined ? undefined : this.#requestView(cached, cached.curriculum);
  }

  /** Все открытые аренды. Порядок — порядок открытия. */
  list(): Tenant[] {
    return [...this.#tenants.values()].map((tenant) =>
      this.#requestView(tenant, tenant.curriculum));
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
    if (cached !== undefined) {
      const snapshot = this.#snapshot(childId);
      if (snapshot !== cached.curriculum) {
        this.#syncCurriculum(childId, cached.db, snapshot.graph);
        cached.curriculum = snapshot;
        this.#seedBank(childId, cached.db, snapshot.graph);
      }
      return this.#requestView(cached, snapshot);
    }

    if (this.#opening.has(childId)) {
      throw new Error(`Повторный вход в открытие базы ребёнка ${childId}`);
    }

    const child = readChild(this.#control, childId);
    if (!isChildServiceable(child)) {
      throw new TenantError('not-serviceable', `Ребёнок ${childId} не обслуживается`);
    }

    // Потолок проверяется после кеша: уже открытому ребёнку он не мешает.
    if (this.#tenants.size >= this.#maxOpen) {
      const overflow =
        `открыто ${String(this.#tenants.size)} баз при потолке ${String(this.#maxOpen)}: ` +
        `ребёнку ${childId} отказано, открытые базы не тронуты`;
      this.#log(overflow);
      this.#reportOnce(childId, 'too-many-open', {
        event: 'tenant-open-failed', message: overflow, childId,
      });
      throw new TenantError('too-many-open', `Потолок открытых баз исчерпан: ${childId}`);
    }

    const path = childDatabasePath(this.#dataDir, childId);
    this.#opening.add(childId);
    let opened: SessionDatabase | undefined;
    try {
      opened = this.#openSession(path);
      if (opened === undefined) {
        // Файл на месте, а соединение не открылось, — значит, его подменили в
        // окно открытия: `openSessionDatabase` отказывает либо по пропавшему
        // файлу, либо по разошедшимся отпечаткам, и разделить их постфактум
        // можно только тем, есть ли файл сейчас. Проверка вероятностная, как и
        // сам отпечаток, но авария «базу подменили» и авария «базы нет» зовут к
        // разным действиям, и одно название на обе прятало бы первую.
        const detached = fileIdentity(path) !== undefined;
        this.#reportOnce(
          childId,
          detached ? 'detached' : 'not-opened',
          detached
            ? {
                event: 'tenant-detached',
                message: 'файл базы подменён в момент открытия',
                childId,
              }
            : {
                event: 'tenant-open-failed',
                message: 'файл базы не открылся',
                childId,
              },
        );
        throw new TenantError('unavailable', `База ребёнка ${childId} недоступна: ${path}`);
      }
      // Темы заводятся до посева: без строк `topic_state` вставка заданий упала
      // бы на внешнем ключе.
      const snapshot = this.#snapshot(childId);
      this.#syncCurriculum(childId, opened.db, snapshot.graph);
      this.#seedBank(childId, opened.db, snapshot.graph);
    } catch (error) {
      if (opened !== undefined) this.#closeQuietly(childId, opened.db);
      // Испорченный файл базы — состояние одного арендатора, а не поломка
      // сервера: пятисотка от `openDatabase` увела бы отказ в общий обработчик
      // и звала бы к перезапуску всю семью. Наружу уходит общий текст
      // (`AUTH_MESSAGE.unavailable`), а чья именно база испорчена, видно только
      // отсюда: остальные дети при этом работают, и по одному 503 их не
      // различить.
      this.#log(`база ребёнка ${childId} недоступна: ${(error as Error).message}`);
      // Отказ, уже названный выше своим именем, второй раз не пишется: подмену
      // файла и переполнение потолка журнал получил там, где они и различимы.
      if (error instanceof TenantError) throw error;
      // Сюда доезжает и отказ миграции: она идёт внутри `openDatabase`, и база
      // новее приложения либо не поддающаяся обновлению видна только отсюда.
      this.#reportOnce(childId, 'not-migrated', {
        event: 'tenant-open-failed',
        message: 'база ребёнка не открыта',
        detail: (error as Error).message,
        childId,
      });
      throw new TenantError('unavailable', `База ребёнка ${childId} недоступна: ${path}`);
    } finally {
      this.#opening.delete(childId);
    }

    const file = opened.file;
    const available = (): boolean => fileIdentity(path) === file;
    // Сборка координаторов защищена так же, как открытие: она не инертна.
    // `createIntegrityCoordinator` синхронно поднимает незакрытые проверки, и
    // осиротевшая строка (задание удалено, темы больше нет в карте) бросает
    // отсюда. Оставленная снаружи защиты, она уносила бы соединение мимо кеша:
    // закрыть его было бы уже нечем — в `#tenants` аренда не попала, `close`
    // и `closeAll` до неё не достают, — и каждый следующий запрос открывал бы
    // ещё одно, не замечая потолка. Наружу при этом уходила бы пятисотка
    // вместо `unavailable`.
    let tenant: Tenant;
    try {
      tenant = this.#assemble(childId, path, opened, available, this.#snapshot(childId));
    } catch (error) {
      this.#closeQuietly(childId, opened.db);
      this.#log(`база ребёнка ${childId} недоступна: ${(error as Error).message}`);
      this.#reportOnce(childId, 'not-assembled', {
        event: 'tenant-open-failed',
        message: 'аренда ребёнка не собрана',
        detail: (error as Error).message,
        childId,
      });
      throw new TenantError('unavailable', `База ребёнка ${childId} недоступна: ${path}`);
    }
    this.#tenants.set(childId, tenant);
    // База открылась — прежние жалобы на неё больше не «уже сказанное»:
    // сломайся она снова, авария обязана попасть в журнал заново.
    this.#reported.delete(childId);
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
      tenant.disputes.restore();
    } catch (error) {
      this.#log(
        `незакрытые споры ребёнка ${childId} не восстановлены: ${(error as Error).message}`,
      );
    }
    return this.#requestView(tenant, tenant.curriculum);
  }

  /** Freeze the curriculum identity seen by one request while reusing resources. */
  #requestView(tenant: Tenant, curriculum: CurriculumSnapshot): Tenant {
    return { ...tenant, curriculum };
  }

  /**
   * Авария открытия пишется **переходом**, а не на каждую попытку.
   *
   * Открытие зовут все подряд: маршруты ребёнка, обход диспетчера раз в минуту
   * и опрос агента раз в двадцать секунд, — а все три причины отказа (файла
   * нет, файл подменён, потолок исчерпан) держатся до починки. Строка на каждую
   * попытку давала бы тысячи одинаковых записей в сутки при всём ретеншене
   * `LOG_MAX_BYTES × LOG_KEEP_FILES` и видимом хвосте `LOG_TAIL_BYTES`: они
   * вытеснили бы из журнала ровно ту запись, которая называет причину. То же
   * рассуждение, что у `/api/health`, где переход состояния пишется по той же
   * причине.
   */
  #reportOnce(childId: string, key: string, record: FailureRecord): void {
    const seen = this.#reported.get(childId) ?? new Set<string>();
    if (seen.has(key)) return;
    seen.add(key);
    this.#reported.set(childId, seen);
    this.#failures(record);
  }

  /**
   * Координаторы аренды и она сама. Вынесено из `open` только затем, чтобы
   * отказ сборки ловился одним `catch` вместе с закрытием соединения.
   */
  #assemble(
    childId: string,
    path: string,
    opened: SessionDatabase,
    available: () => boolean,
    curriculum: CurriculumSnapshot,
  ): Tenant {
    const graphForRun = (runId: number): TopicGraph => this.#graphForRun(opened.db, runId);
    const disputes = new DisputeCoordinator({
      ...this.#disputeOptions,
      db: opened.db,
      graph: this.#graph,
      graphForDispute: (disputeId) => {
        const run = opened.db.prepare<[number], { run_id: number | null }>(
          `SELECT attempts.run_id
             FROM disputes JOIN attempts ON attempts.id = disputes.attempt_id
            WHERE disputes.id = ?`,
        ).get(disputeId);
        return run?.run_id === null || run === undefined
          ? (this.#tenants.get(childId)?.curriculum.graph ?? curriculum.graph)
          : graphForRun(run.run_id);
      },
      available,
    });
    const integrity = createIntegrityCoordinator({
      ...this.#integrityOptions,
      db: opened.db,
      graph: this.#graph,
      graphForRun,
      available,
      complete: (runId, at) => {
        const kind = opened.db.prepare<[number], { kind: string }>(
          'SELECT kind FROM runs WHERE id = ?',
        ).get(runId)?.kind;
        const operationGraph = graphForRun(runId);
        if (kind === 'lesson') {
          const result = finishLearningMaterial(opened.db, operationGraph, runId, { now: at });
          const learningGate = readDailyGate(
            opened.db,
            at,
            this.#snapshot(childId).revisionIds,
          ).learning;
          const completed = {
            ...result,
            required: learningGate.required && learningGate.materialId === result.materialId,
          };
          opened.db.prepare('UPDATE runs SET summary = ? WHERE id = ?')
            .run(JSON.stringify(completed), runId);
          return completed;
        }
        if (kind === 'run') return { ...finishRun(opened.db, operationGraph, runId, { now: at }) };
        throw new Error(`Проверка осмысленности не завершает занятие вида «${String(kind)}»`);
      },
    });
    return {
      childId,
      path,
      db: opened.db,
      curriculum,
      graphForRun,
      file: opened.file,
      available,
      disputes,
      integrity,
    };
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

  #syncCurriculum(childId: string, db: Database.Database, graph: TopicGraph): void {
    const result = syncTopicState(db, graph);

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
  #seedBank(childId: string, db: Database.Database, graph: TopicGraph): void {
    try {
      const result = loadSeedBank(
        db,
        graph,
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

  #snapshot(childId: string): CurriculumSnapshot {
    if (this.#curriculum !== undefined) return this.#curriculum.get(childId);
    const courses = Object.freeze(this.#graph.subjects.map((courseId) => {
      const metadata = this.#graph.courses.get(courseId);
      if (metadata === undefined) throw new Error(`У курса «${courseId}» нет метаданных`);
      return Object.freeze({ ...metadata, revisionId: metadata.revisionId ?? 0 });
    }));
    return Object.freeze({
      childId,
      generation: Object.freeze({ catalog: 0, child: 0 }),
      courses,
      revisionIds: new Map(
        courses.flatMap((course) => course.revisionId > 0 ? [[course.courseId, course.revisionId]] : []),
      ),
      graph: this.#graph,
    });
  }

  #graphForRun(db: Database.Database, runId: number): TopicGraph {
    const run = db.prepare<[number], { subject: string; course_revision_id: number | null }>(
      'SELECT subject, course_revision_id FROM runs WHERE id = ?',
    ).get(runId);
    if (run === undefined) throw new Error(`Забег ${String(runId)} не найден`);
    if (this.#curriculum !== undefined) {
      try {
        return this.#curriculum.graphFor(run.subject, run.course_revision_id);
      } catch (error) {
        // Только legacy-run может откатиться к файловой карте. Явно сохранённая
        // редакция обязана существовать: иначе продолжение смешало бы контент.
        if (run.course_revision_id !== null || !this.#graph.bySubject.has(run.subject)) throw error;
      }
    }
    if (!this.#graph.bySubject.has(run.subject)) {
      throw new Error(`Для legacy-забега ${String(runId)} нет карты курса «${run.subject}»`);
    }
    return this.#graph;
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
