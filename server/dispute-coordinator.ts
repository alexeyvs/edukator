/**
 * Координатор разбора споров одного арендатора.
 *
 * Разбор спора — единственная часть занятия, которая переживает сам запрос:
 * ученик нажал кнопку и решает дальше, а вызов модели идёт минуты. Значит,
 * где-то должно жить состояние «этот спор уже разбирается», «этот отложен до
 * повтора» и «эти разборы надо дождаться перед закрытием базы».
 *
 * Раньше оно лежало в замыкании `registerSessionRoutes`, то есть было одно на
 * процесс. Многоарендному серверу это не годится: спор — это строка в базе
 * конкретного ребёнка, номера у разных детей совпадают, и общий набор
 * `reviewing` заставил бы спор №7 одного ребёнка ждать спора №7 другого, а
 * восстановление незакрытых споров прошло бы только по той базе, что открыта
 * при старте. Поэтому координатор заводится на арендатора — рядом с проверкой
 * отпечатка файла (`available`), которая тоже своя на каждую базу.
 */
import type { Database } from 'better-sqlite3';
import type { TopicGraph } from './curriculum.js';
import { disputeReviewer, type DisputeReviewer } from './codex/dispute.js';
import { disputeConcurrency, type CodexConcurrency } from './codex/concurrency.js';
import { openDisputes, resolveDispute } from './session.js';

/** Потолок отступа: при долгом отказе — не больше четырёх запусков в час. */
export const DISPUTE_RETRY_MAX_MS = 15 * 60_000;

/**
 * Первая пауза перед повтором. Короткие повторы быстро переживают случайный
 * отказ, но постоянная поломка codex не должна запускать сотни внешних
 * процессов в час на каждый спор — дальше пауза удваивается до потолка.
 */
export const DISPUTE_RETRY_MS = 1_000;

/** Запуск фоновой работы: тесты подменяют её, чтобы дождаться разбора. */
export type BackgroundRunner = (task: () => Promise<void>) => void;

export interface DisputeCoordinatorOptions {
  /** База того ребёнка, чьи споры разбираются. */
  db: Database;
  graph: TopicGraph;
  /** Разбирающий спор; по умолчанию — вызов codex. */
  review?: DisputeReviewer;
  background?: BackgroundRunner;
  log?: (message: string) => void;
  /** Соединение всё ещё привязано к текущему файлу базы. */
  available?: () => boolean;
  /** Отдельный бюджет разбора споров; он процессный, а не на арендатора. */
  disputeBudget?: CodexConcurrency;
  /** Пауза перед автоматическим повтором незакрытого спора. */
  disputeRetryMs?: number;
}

/**
 * Пауза перед следующим повтором: удваивается с каждым отказом и упирается в
 * потолок. Вынесена наружу, чтобы проверяться литералами: тесты гоняют
 * координатор с `disputeRetryMs: 1`, и на такой паузе постоянная задержка
 * неотличима от растущей.
 */
export function nextDisputeRetryDelay(delay: number): number {
  return Math.min(delay * 2, DISPUTE_RETRY_MAX_MS);
}

function defaultLog(message: string): void {
  process.stderr.write(`${message}\n`);
}

export class DisputeCoordinator {
  readonly #db: Database;
  readonly #graph: TopicGraph;
  readonly #review: DisputeReviewer;
  readonly #background: BackgroundRunner;
  readonly #log: (message: string) => void;
  readonly #available: () => boolean;
  readonly #budget: CodexConcurrency;
  readonly #retryMs: number;

  /**
   * Споры, разбор которых уже идёт. Без этого набора каждое повторное нажатие
   * кнопки (а состояние спора клиент узнаёт именно повторным запросом) поднимало
   * бы ещё один процесс codex на минуты.
   */
  readonly #reviewing = new Set<number>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #retryTimers = new Map<number, ReturnType<typeof setTimeout>>();
  readonly #retryDelays = new Map<number, number>();
  #stopped = false;

  constructor(options: DisputeCoordinatorOptions) {
    this.#db = options.db;
    this.#graph = options.graph;
    this.#review = options.review ?? disputeReviewer();
    this.#background = options.background ?? ((task): void => void task());
    this.#log = options.log ?? defaultLog;
    this.#available = options.available ?? ((): boolean => true);
    this.#budget = options.disputeBudget ?? disputeConcurrency;
    this.#retryMs = options.disputeRetryMs ?? DISPUTE_RETRY_MS;
  }

  /**
   * Ставит на разбор незакрытые споры этой базы. Спор переживает процесс в
   * SQLite, и после перезапуска его нельзя оставлять без исполнителя только
   * потому, что браузер уже потерял attempt_id. Зовётся при открытии **каждой**
   * базы, а не один раз при старте сервера: у второго ребёнка спор точно так же
   * остаётся открытым, а его база открывается позже и по первому обращению.
   */
  restore(): void {
    for (const id of openDisputes(this.#db)) this.schedule(id);
  }

  /**
   * Разбор идёт фоном: ученик нажал кнопку и решает дальше, а вызов модели
   * занимает минуты. Ошибка разбора спор не закрывает — он остаётся открытым, и
   * следующее нажатие кнопки ставит его на разбор заново.
   *
   * Разборы не делят бюджет с воркером: фоновый прогрев не должен задерживать
   * ответ ученику. Набор `#reviewing` держит только повтор по одному
   * и тому же спору, а разных споров бывает сколько угодно, и каждый — это ещё
   * один процесс codex на минуты. Сверх предела спор остаётся открытым и
   * попадёт на разбор со следующим запросом — ровно тот же сценарий, что и при
   * недоступном codex.
   */
  schedule(id: number): void {
    if (this.#stopped || !this.#available() || this.#reviewing.has(id)) return;
    const pending = this.#budget.tryRun(() =>
      resolveDispute(this.#db, this.#graph, id, async (context) => {
        const verdict = await this.#review(context);
        // За минуты внешнего разбора файл базы могли заменить. После await ещё
        // раз сверяем inode: дальше `resolveDispute` сразу и без нового await
        // пишет вердикт транзакцией. Писать в отвязанный inode нельзя: вердикт
        // и boss-переходы не попадут в базу, которая теперь лежит по этому пути.
        if (!this.#available()) {
          throw new Error('файл базы заменён во время разбора');
        }
        return verdict;
      }),
    );
    if (pending === undefined) {
      this.#log(`разбор спора ${String(id)} отложен: заняты все ${String(this.#budget.limit)} места codex`);
      this.#scheduleRetry(id);
      return;
    }
    this.#reviewing.add(id);
    this.#pending.add(pending);
    this.#background(async () => {
      try {
        await pending;
        const timer = this.#retryTimers.get(id);
        if (timer !== undefined) clearTimeout(timer);
        this.#retryTimers.delete(id);
        this.#retryDelays.delete(id);
      } catch (error) {
        this.#log(`разбор спора ${String(id)} не выполнен: ${(error as Error).message}`);
        // Заменённую базу этот процесс всё равно не переоткроет, поэтому
        // повторы до перезапуска лишь занимали бы бюджет Codex.
        if (this.#available()) this.#scheduleRetry(id);
      } finally {
        this.#pending.delete(pending);
        // Именно в `finally`: снятая только при успехе пометка навсегда
        // запретила бы повторный разбор спора, который как раз и остался
        // открытым из-за недоступного codex.
        this.#reviewing.delete(id);
      }
    });
  }

  /**
   * Гасит повторы и дожидается идущих разборов. Закрывать базу раньше —
   * превращать штатное завершение в случайный `database connection is not
   * open`: фоновый разбор держит ссылку на соединение и после удачного ответа
   * модели пишет вердикт транзакцией.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    for (const timer of this.#retryTimers.values()) clearTimeout(timer);
    this.#retryTimers.clear();
    this.#retryDelays.clear();
    await Promise.allSettled([...this.#pending]);
  }

  #scheduleRetry(id: number): void {
    if (this.#stopped || !this.#available() || this.#retryTimers.has(id)) return;
    const delay = this.#retryDelays.get(id) ?? this.#retryMs;
    this.#retryDelays.set(id, nextDisputeRetryDelay(delay));
    const timer = setTimeout(() => {
      this.#retryTimers.delete(id);
      this.schedule(id);
    }, delay);
    timer.unref();
    this.#retryTimers.set(id, timer);
  }
}
