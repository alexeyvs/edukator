/**
 * Диспетчер прогрева: один фоновый цикл на процесс, обходящий детей.
 *
 * Воркер (`runWarmupCycle`) греет одну базу и о существовании остальных не
 * знает. Пока ребёнок был один, этого хватало; с несколькими детьми свой цикл
 * на каждого означал бы, что второй ребёнок забирает у первого общий бюджет
 * codex ровно тогда, когда первый сидит за занятием: слотов два на процесс, и
 * достаются они тому, кто первым добежал до семафора, а не тому, кто ждёт
 * задания на экране.
 *
 * Отсюда обход фазами. Сначала все, кому не хватает до порога (`REFILL_BELOW`),
 * и ученик за экраном в этой очереди первый: ему задание нужно сейчас, а не
 * через три чужих батча. Только когда у всех есть на чём заниматься, обход идёт
 * вторым заходом и добивает запас до `QUEUE_TARGET` — и там же, в фазе
 * излишков, готовятся босс и персональный материал.
 *
 * Указатель обхода переживает цикл: без него дети всегда обслуживались бы в
 * порядке заведения, и последний доходил бы до генерации только в те обходы,
 * где всем предыдущим уже нечего греть.
 */
import type Database from 'better-sqlite3';
import {
  listServiceableChildren,
  readCodexQuota,
  CODEX_DAILY_QUOTA,
  type ChildSummary,
} from '../control-db.js';
import type { TopicGraph } from '../curriculum.js';
import type { CodexRunner } from './client.js';
import type { CodexConcurrency } from './concurrency.js';
import {
  cycleAttempts,
  MAX_BATCHES_PER_TOPIC,
  QUEUE_TARGET,
  REFILL_BELOW,
  runWarmupCycle,
  type CycleReport,
  type WorkerLog,
  type WorkerOptions,
} from './worker.js';

/** Пауза между обходами, когда всё в порядке. */
export const IDLE_INTERVAL_MS = 60 * 1000;

/** Первая пауза после недоступности codex; дальше удваивается. */
export const BACKOFF_BASE_MS = 60 * 1000;

/** Потолок паузы: codex может вернуться в любой момент, и ждать его полдня незачем. */
export const BACKOFF_MAX_MS = 30 * 60 * 1000;

/**
 * Насколько свежей должна быть отметка активности ребёнка, чтобы его вообще
 * грели. Двое суток: пропущенный день не повод остудить банк, а неделя тишины —
 * повод, потому что за брошенного ребёнка платят все остальные и его суточная
 * квота вызовов.
 */
export const ACTIVE_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * Окно «ученик за экраном». Отметка активности глушится пятью минутами
 * (`SESSION_TOUCH_MS`), и у занимающегося прямо сейчас она отстаёт на эти пять
 * минут плюс время на само задание. Пятнадцать минут покрывают и то и другое,
 * не превращая в «за экраном» того, кто закрыл вкладку полчаса назад.
 */
export const AT_SCREEN_MS = 15 * 60 * 1000;

/**
 * Потолок батчей на тему в фазе порога. Один: фаза существует ровно затем,
 * чтобы у каждого нашлось на чём заниматься, и ребёнок с тремя холодными темами
 * не имеет права выесть обход целиком — остальное ему дольёт фаза излишков.
 */
export const FLOOR_BATCHES_PER_TOPIC = 1;

/** Настройки цикла на одного ребёнка: всё, что не зависит от того, чей он. */
export type DispatcherWorkerOptions = Omit<
  WorkerOptions,
  'db' | 'graph' | 'budget' | 'prepareBoss' | 'prepareLearning'
> & {
  /** Пауза между обходами; тесты подменяют её, чтобы не ждать по-настоящему. */
  wait?: (ms: number) => Promise<void>;
};

/** Подменяемый цикл прогрева: тесты проверяют порядок обхода, не зовя модель. */
export type CycleRunner = (options: WorkerOptions) => Promise<CycleReport>;

export interface WarmupDispatcherOptions {
  /** Управляющая база: по ней берётся список детей, их свежесть и квота. */
  control: Database.Database;
  graph: TopicGraph;
  /**
   * Открывает базу ребёнка. `undefined` — пропустить его в этом обходе: его
   * база может быть испорчена или упереться в потолок открытых, и это состояние
   * одного арендатора, а не повод остановить обход.
   */
  open: (childId: string) => Database.Database | undefined;
  /** Настройки цикла на ребёнка; отсюда же берутся `produce`, `run` и `wait`. */
  worker?: DispatcherWorkerOptions;
  /** Общий с разборами споров бюджет процесса. */
  budget?: CodexConcurrency;
  /** Обёртка вызова модели на ребёнка: суточная квота своя у каждого. */
  runFor?: (childId: string) => CodexRunner;
  now?: () => Date;
  log?: WorkerLog;
  /** Подменяемый цикл; по умолчанию `runWarmupCycle`. */
  cycle?: CycleRunner;
  /** Окно свежести отметки активности; по умолчанию `ACTIVE_WINDOW_MS`. */
  activeWindowMs?: number;
  /** Окно «за экраном»; по умолчанию `AT_SCREEN_MS`. */
  atScreenMs?: number;
  /** Суточный предел вызовов; по умолчанию `CODEX_DAILY_QUOTA`. */
  quotaLimit?: number;
}

/** Порядок обхода: кто за экраном, кто следом и с кого начинать в следующий раз. */
export interface SweepOrder {
  /** Занимающиеся прямо сейчас, самый свежий первым. */
  atScreen: ChildSummary[];
  /** Остальные свежие, начиная с указателя обхода. */
  rest: ChildSummary[];
  /** Дети, выпавшие из обхода по несвежести. */
  idle: ChildSummary[];
  /** С кого начинать следующий обход. */
  next: string | undefined;
}

export interface ChildSweepReport {
  childId: string;
  /** Заходы по фазам: сначала до порога, потом до запаса. */
  cycles: CycleReport[];
  /** Почему ребёнок пропущен, если он пропущен. */
  skipped?: 'quota' | 'unavailable' | 'error';
}

export interface SweepReport {
  children: ChildSweepReport[];
  /** Дети, выпавшие из обхода по несвежести. */
  idle: string[];
  /** codex не запускается: следующий обход откладывается с возрастающей паузой. */
  codexUnavailable: boolean;
}

function defaultLog(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** Таймер не держит процесс живым: прогрев не повод не дать серверу завершиться. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/**
 * Пауза до следующего обхода: обычный интервал, пока codex отвечает, и удвоение
 * от `BACKOFF_BASE_MS` за каждый подряд идущий отказ, до потолка.
 */
export function backoffDelay(failures: number): number {
  if (failures <= 0) return IDLE_INTERVAL_MS;
  return Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
}

/** Возраст отметки активности в миллисекундах; `undefined` — отметки нет. */
function activityAge(child: ChildSummary, now: Date): number | undefined {
  if (child.lastActivityAt === undefined) return undefined;
  const stamp = Date.parse(child.lastActivityAt);
  if (!Number.isFinite(stamp)) return undefined;
  return now.getTime() - stamp;
}

/**
 * Раскладывает детей по порядку обхода. Отдельная чистая функция потому, что
 * порядок и есть та политика, ради которой диспетчер заведён: его проверяют без
 * баз, генерации и таймеров.
 *
 * Указатель применяется только к обычной очереди: ученик за экраном обходит её
 * всегда, иначе указатель отправлял бы занимающегося ждать своей очереди.
 */
export function orderChildren(
  children: readonly ChildSummary[],
  options: {
    now: Date;
    cursor?: string | undefined;
    activeWindowMs?: number;
    atScreenMs?: number;
  },
): SweepOrder {
  const activeWindowMs = options.activeWindowMs ?? ACTIVE_WINDOW_MS;
  const atScreenMs = options.atScreenMs ?? AT_SCREEN_MS;

  const atScreen: { child: ChildSummary; age: number }[] = [];
  const fresh: ChildSummary[] = [];
  const idle: ChildSummary[] = [];

  for (const child of children) {
    const age = activityAge(child, options.now);
    // Ребёнок без отметки ни разу не заходил: греть ему нечего и незачем.
    if (age === undefined || age >= activeWindowMs) {
      idle.push(child);
      continue;
    }
    if (age < atScreenMs) atScreen.push({ child, age });
    else fresh.push(child);
  }

  // Сортировка устойчивая: при равном возрасте порядок остаётся тем, в котором
  // дети пришли из управляющей базы (`created_at`, `id`).
  atScreen.sort((left, right) => left.age - right.age);

  const at = options.cursor === undefined ? -1 : fresh.findIndex((child) => child.id === options.cursor);
  const rest = at < 0 ? fresh : [...fresh.slice(at), ...fresh.slice(0, at)];

  return {
    atScreen: atScreen.map((item) => item.child),
    rest,
    idle,
    // Следующий обход начинается со следующего в очереди. Указателя нет, пока
    // очередь короче двух: крутить её из одного ребёнка нечем.
    next: rest.length > 1 ? rest[1]?.id : undefined,
  };
}

/**
 * Обход не дал ничего: попытки фоновой подготовки были, и каждая упёрлась в
 * ошибку. Считается по всем детям сразу — отступ у процесса один, и уводить в
 * него весь обход из-за одного ребёнка, у которого проверяющий забраковал батч,
 * значило бы морозить остальных.
 */
export function everySweepFailed(sweep: SweepReport): boolean {
  const attempts = sweep.children.flatMap((child) => [
    ...child.cycles.flatMap(cycleAttempts),
    // Не состоявшийся заход — тоже неудачная попытка: цикл, падающий на
    // испорченном профиле, иначе крутился бы раз в минуту вечно. Исчерпанная
    // квота и недоступная база сюда не идут: они не стоят ни одного вызова
    // модели, и повторная проверка раз в минуту дешевле, чем получасовая
    // заморозка прогрева остальным.
    ...(child.skipped === 'error' ? [{ stored: 0, error: 'заход не состоялся' }] : []),
  ]);
  return attempts.length > 0 && attempts.every(
    (attempt) => attempt.error !== undefined && attempt.stored === 0,
  );
}

/**
 * Обход детей с фоновым циклом.
 *
 * Дети обходятся по очереди, а не пулом: параллелизм фонового прогрева задан
 * процессным бюджетом codex (`codexConcurrency`), и раздача его сразу всем
 * детям вернула бы ровно ту гонку за слотами, ради которой заведён обход.
 */
export class WarmupDispatcher {
  readonly #options: WarmupDispatcherOptions;
  readonly #log: WorkerLog;
  readonly #now: () => Date;
  readonly #cycle: CycleRunner;
  readonly #wait: (ms: number) => Promise<void>;
  /** С кого начинать следующий обход; переживает цикл. */
  #cursor: string | undefined;
  /** Кто попал в последний обход: по нему `wake()` отличает нового от своего. */
  #served = new Set<string>();
  #stopped = false;
  #running: Promise<void> | undefined;
  /** Будильник текущей паузы; `null` — паузы сейчас нет. */
  #alarm: (() => void) | null = null;

  constructor(options: WarmupDispatcherOptions) {
    this.#options = options;
    this.#log = options.log ?? defaultLog;
    this.#now = options.now ?? ((): Date => new Date());
    this.#cycle = options.cycle ?? runWarmupCycle;
    this.#wait = options.worker?.wait ?? sleep;
  }

  /** Один обход: фаза порога, затем фаза излишков. */
  async sweep(): Promise<SweepReport> {
    const now = this.#now();
    const order = orderChildren(listServiceableChildren(this.#options.control), {
      now,
      cursor: this.#cursor,
      ...(this.#options.activeWindowMs === undefined
        ? {}
        : { activeWindowMs: this.#options.activeWindowMs }),
      ...(this.#options.atScreenMs === undefined ? {} : { atScreenMs: this.#options.atScreenMs }),
    });
    this.#cursor = order.next;

    const queue = [...order.atScreen, ...order.rest];
    this.#served = new Set(queue.map((child) => child.id));

    const reports = new Map<string, ChildSweepReport>();
    for (const child of queue) reports.set(child.id, { childId: child.id, cycles: [] });
    const sweep: SweepReport = {
      children: [...reports.values()],
      idle: order.idle.map((child) => child.id),
      codexUnavailable: false,
    };
    if (queue.length === 0) return sweep;

    const settings = this.#options.worker ?? {};
    const threshold = settings.threshold ?? REFILL_BELOW;
    const phases: { prepareBoss: boolean; target: number; maxBatches: number }[] = [
      // Фаза порога: всем поровну и по одному батчу на тему. Босса и материал
      // она не готовит — их закажет фаза излишков, и второй заказ за тот же
      // обход стоил бы вызовов модели на уже сделанное.
      { prepareBoss: false, target: threshold, maxBatches: FLOOR_BATCHES_PER_TOPIC },
      {
        prepareBoss: true,
        target: settings.target ?? QUEUE_TARGET,
        maxBatches: settings.maxBatches ?? MAX_BATCHES_PER_TOPIC,
      },
    ];

    for (const phase of phases) {
      for (const child of queue) {
        const report = reports.get(child.id);
        if (report === undefined || report.skipped !== undefined) continue;
        if (sweep.codexUnavailable) return sweep;
        await this.#runChild(child.id, report, {
          target: phase.target,
          threshold,
          maxBatches: phase.maxBatches,
          prepareBoss: phase.prepareBoss,
          prepareLearning: phase.prepareBoss,
        }, sweep);
      }
    }

    return sweep;
  }

  /** Обход, идущий прямо сейчас: тесты дожидаются им остановки. */
  get done(): Promise<void> {
    return this.#running ?? Promise.resolve();
  }

  /** Запускает бесконечный обход. Повторный вызов ничего не меняет. */
  start(): void {
    if (this.#running !== undefined || this.#stopped) return;
    this.#running = this.#loop();
  }

  /**
   * Прерывает паузу до следующего обхода.
   *
   * Без имени ребёнка — безусловно. С именем — только если этого ребёнка в
   * последнем обходе не было: иначе занимающийся ученик будил бы диспетчер на
   * каждом своём запросе, и обход шёл бы непрерывно, а получасовой отступ по
   * недоступной модели не наступал бы вовсе.
   */
  wake(childId?: string): void {
    if (childId !== undefined && this.#served.has(childId)) return;
    this.#alarm?.();
  }

  /** Останавливает обход: текущий цикл доигрывается, новый не начинается. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#alarm?.();
    await this.#running;
    this.#running = undefined;
  }

  async #loop(): Promise<void> {
    let failures = 0;

    while (!this.#stopped) {
      let unavailable = false;
      try {
        const report = await this.sweep();
        unavailable = report.codexUnavailable;
        if (!unavailable && everySweepFailed(report)) {
          unavailable = true;
          const attempts = report.children.reduce(
            (total, child) => total + child.cycles.reduce((sum, cycle) => sum + cycleAttempts(cycle).length, 0),
            0,
          );
          this.#log(
            `диспетчер: за обход ${String(report.children.length)} ребёнка(детей) ` +
              `ни одна из ${String(attempts)} фоновых подготовок не дала заданий, пауза увеличена`,
          );
        }
      } catch (error) {
        // Обход не должен уронить сервер: ошибка сюда доходит только
        // неожиданная, и следующий обход — единственный способ узнать, что она
        // прошла.
        unavailable = true;
        this.#log(`диспетчер: обход провалился: ${(error as Error).message}`);
      }

      failures = unavailable ? failures + 1 : 0;
      if (this.#stopped) break;

      // Гонка паузы с будильником: после отказов codex пауза доходит до
      // получаса, а вернувшийся ребёнок и `stop()` обязаны её прерывать, а не
      // досиживать.
      await Promise.race([
        this.#wait(backoffDelay(failures)),
        new Promise<void>((resolve) => {
          this.#alarm = resolve;
        }),
      ]);
      this.#alarm = null;
    }
  }

  /** Один заход по одному ребёнку. Отказ его базы обход не останавливает. */
  async #runChild(
    childId: string,
    report: ChildSweepReport,
    phase: {
      target: number;
      threshold: number;
      maxBatches: number;
      prepareBoss: boolean;
      prepareLearning: boolean;
    },
    sweep: SweepReport,
  ): Promise<void> {
    // Квота спрашивается до открытия базы: у исчерпавшего её ребёнка любой заход
    // кончится тем же отказом, и платить за него открытием базы незачем.
    if (this.#quotaExhausted(childId)) {
      report.skipped = 'quota';
      this.#log(`диспетчер: суточная квота ребёнка ${childId} исчерпана, обход его пропускает`);
      return;
    }

    const db = this.#options.open(childId);
    if (db === undefined) {
      report.skipped = 'unavailable';
      return;
    }

    const settings = this.#options.worker ?? {};
    const run = this.#options.runFor?.(childId) ?? settings.run;
    try {
      const cycle = await this.#cycle({
        ...settings,
        db,
        graph: this.#options.graph,
        target: phase.target,
        threshold: phase.threshold,
        maxBatches: phase.maxBatches,
        prepareBoss: phase.prepareBoss,
        prepareLearning: phase.prepareLearning,
        log: this.#log,
        ...(this.#options.budget === undefined ? {} : { budget: this.#options.budget }),
        ...(this.#options.now === undefined ? {} : { now: this.#options.now }),
        ...(run === undefined ? {} : { run }),
      });
      report.cycles.push(cycle);
      if (!cycle.codexUnavailable) return;

      // Исчерпанная квота приезжает той же недоступностью, что и отсутствующий
      // codex (`CodexQuotaError` наследует `CodexUnavailableError`), но это
      // состояние одного ребёнка: увести из-за неё в получасовой отступ весь
      // процесс значило бы, что один наигравшийся ребёнок останавливает прогрев
      // всей семье.
      if (this.#quotaExhausted(childId)) {
        report.skipped = 'quota';
        this.#log(`диспетчер: суточная квота ребёнка ${childId} исчерпана, обход его пропускает`);
        return;
      }
      sweep.codexUnavailable = true;
    } catch (error) {
      report.skipped = 'error';
      this.#log(`диспетчер: обход ребёнка ${childId} провалился: ${(error as Error).message}`);
    }
  }

  #quotaExhausted(childId: string): boolean {
    const quota = readCodexQuota(
      this.#options.control,
      childId,
      this.#now(),
      this.#options.quotaLimit ?? CODEX_DAILY_QUOTA,
    );
    return quota.remaining <= 0;
  }
}
