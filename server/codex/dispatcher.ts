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
import type { FailureLog } from '../log.js';
import type { CodexRunner } from './client.js';
import type { CodexConcurrency } from './concurrency.js';
import { TopicBackoff } from './topic-backoff.js';
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
  /** Актуальная программа ребёнка; вызывается заново перед каждой фазой. */
  graphFor?: (childId: string) => TopicGraph;
  /** Совместимый fallback для тестов и legacy-вызовов. */
  graph?: TopicGraph;
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
  /**
   * Журнал аварий. Обязателен: каталога данных диспетчер не знает, а умолчание
   * «никуда» теряло бы отступ по недоступной модели молча — то есть ровно ту
   * аварию, из-за которой у всей семьи стынет банк.
   */
  failures: FailureLog;
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
/**
 * Первая внятная причина отказа за обход. Нужна журналу: числа «ни одна из 12
 * подготовок» хватает, чтобы понять, что очередь стоит, и не хватает, чтобы
 * понять почему, — а текст ошибки называет и просроченную авторизацию, и
 * кончившийся баланс.
 */
function firstCycleError(sweep: SweepReport): string | undefined {
  for (const child of sweep.children) {
    for (const cycle of child.cycles) {
      for (const attempt of cycleAttempts(cycle)) {
        if (attempt.error !== undefined) return attempt.error;
      }
    }
  }
  return undefined;
}

export function everySweepFailed(sweep: SweepReport): boolean {
  const attempts = sweep.children.flatMap((child) => {
    // Исчерпавший квоту и недоступный ребёнок не участвуют неудачами — ни
    // пропуском, ни тем, что успели попробовать до отказа. Квота кончается
    // **посреди** захода, и его неудачные попытки лежат в `cycles` рядом с
    // пометкой `skipped`: посчитав их, обход из одного наигравшегося ребёнка
    // увёл бы в получасовой отступ прогрев всей семьи — ровно то, от чего
    // диспетчер и переспрашивает квоту после недоступности.
    // Удавшиеся попытки такого ребёнка, однако, считаются: квота кончается
    // после них, и выкинув их вместе с пропуском, обход, в котором codex
    // здоров и задания сложены, объявлял бы себя пустым — и уводил семью в
    // получасовой отступ из-за одного соседа, у которого проверяющий забраковал
    // батч. Успех в списке делает вердикт «всё упало» ложным, чего и надо.
    if (child.skipped === 'quota' || child.skipped === 'unavailable') {
      return child.cycles.flatMap(cycleAttempts).filter((attempt) => attempt.stored > 0);
    }
    return child.cycles.flatMap(cycleAttempts);
  });
  if (attempts.length > 0) {
    return attempts.every((attempt) => attempt.error !== undefined && attempt.stored === 0);
  }

  // Ни одной фоновой подготовки за обход: паузу увеличивает только то, что до
  // неё не дошёл **ни один** ребёнок. Не состоявшийся заход (испорченная база,
  // упавший на профиле цикл) сам по себе — тоже неудачная попытка, иначе он
  // крутился бы раз в минуту вечно; но решать за весь процесс он вправе только
  // в одиночку. Сосед, у которого банк уже полон, попыток не даёт вовсе — и,
  // считая обход провальным по одному испорченному ребёнку, диспетчер морозил
  // бы прогрев всей семье на полчаса из-за чужого файла. Ученику за экраном при
  // этом и податься некуда: его самого обход прошёл, в `#served` он есть, и
  // будильник его запроса паузу не снимает.
  const participants = sweep.children.filter(
    (child) => child.skipped !== 'quota' && child.skipped !== 'unavailable',
  );
  return participants.length > 0 && participants.every((child) => child.skipped === 'error');
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
  readonly #failures: FailureLog;
  readonly #wait: (ms: number) => Promise<void>;
  /** С кого начинать следующий обход; переживает цикл. */
  #cursor: string | undefined;
  /**
   * До кого обход в самом деле дошёл: по нему `wake()` отличает нового от
   * своего. Именно «дошёл», а не «стоял в очереди»: обход обрывается на
   * `stop()` и на недоступном codex, и записанный заранее хвост очереди
   * означал бы, что будильник ребёнка, до которого дело так и не дошло,
   * проглатывается — а ждать ему при этом полный получасовой отступ.
   */
  #served = new Set<string>();
  /**
   * Отступы тем на ребёнка. Живут у диспетчера, а не у цикла: провал темы имеет
   * смысл только по отношению к следующему обходу, а цикл собирается заново на
   * каждой фазе каждого обхода. Экземпляр на ребёнка, не на процесс: имена тем
   * глобальны, и общий счётчик снимал бы тему с прогрева всей семье из-за
   * неудач одного ученика.
   *
   * Выведенный ребёнок отсюда не убирается: карта растёт по одной пустой записи
   * на ребёнка за всю жизнь процесса, а уборка по составу семьи означала бы
   * второй список детей рядом с `listServiceableChildren`.
   */
  #backoffs = new Map<string, TopicBackoff>();
  #stopped = false;
  #running: Promise<void> | undefined;
  /** Будильник текущей паузы; `null` — паузы сейчас нет (или идёт неснимаемая часть). */
  #alarm: (() => void) | null = null;
  /**
   * Прерыватель неснимаемой части паузы: её отменяет только `stop()`. Отдельно
   * от `#alarm` именно поэтому — закрытие сервера не имеет права досиживать
   * минуту, а будильник ребёнка не имеет права её снимать.
   */
  #halt: (() => void) | null = null;
  /**
   * Будильник, прозвонивший мимо паузы. Обход идёт минутами, и всё это время
   * `#alarm` пуст: без флага запрос вернувшегося ребёнка, пришедший посреди
   * обхода, пропадал бы, и ждать ему пришлось бы конец обхода **плюс** полный
   * отступ — до получаса.
   */
  #woken = false;

  constructor(options: WarmupDispatcherOptions) {
    this.#options = options;
    this.#log = options.log ?? defaultLog;
    this.#now = options.now ?? ((): Date => new Date());
    this.#cycle = options.cycle ?? runWarmupCycle;
    this.#failures = options.failures;
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
    this.#served = new Set<string>();

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
    const surplus = settings.target ?? QUEUE_TARGET;
    // Порог у фазы свой и равен её же запасу: голодные темы `runWarmupCycle`
    // отбирает по порогу, а не по запасу, и общий `REFILL_BELOW` на обеих фазах
    // означал бы, что фаза излишков не видит ни одной темы — один батч
    // (`TASK_BATCH_SIZE = 5`) уже поднимает тему выше порога 4, и до
    // `QUEUE_TARGET` её не добивал бы никто.
    const phases: { prepareBoss: boolean; target: number; threshold: number; maxBatches: number }[] = [
      // Фаза порога: всем поровну и по одному батчу на тему. Босса и материал
      // она не готовит — их закажет фаза излишков, и второй заказ за тот же
      // обход стоил бы вызовов модели на уже сделанное.
      { prepareBoss: false, target: threshold, threshold, maxBatches: FLOOR_BATCHES_PER_TOPIC },
      {
        prepareBoss: true,
        target: surplus,
        threshold: surplus,
        maxBatches: settings.maxBatches ?? MAX_BATCHES_PER_TOPIC,
      },
    ];

    for (const phase of phases) {
      for (const child of queue) {
        // Остановка проверяется на каждом ребёнке, а не только в цикле обхода:
        // `stop()` ждёт текущий заход, один заход тянется до `CODEX_TIMEOUT_MS`,
        // и без этой строки закрытие сервера по SIGTERM досиживало бы обе фазы
        // на всей семье — вместе с закрытием баз и снятием замка каталога.
        if (this.#stopped) return sweep;
        const report = reports.get(child.id);
        if (report === undefined || report.skipped !== undefined) continue;
        if (sweep.codexUnavailable) return sweep;
        this.#served.add(child.id);
        await this.#runChild(child.id, report, {
          target: phase.target,
          threshold: phase.threshold,
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
    this.#woken = true;
    this.#alarm?.();
  }

  /** Останавливает обход: текущий цикл доигрывается, новый не начинается. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#alarm?.();
    this.#halt?.();
    await this.#running;
    this.#running = undefined;
  }

  async #loop(): Promise<void> {
    let failures = 0;

    while (!this.#stopped) {
      let unavailable = false;
      /** Почему обход считается провалившимся; по нему пишется авария. */
      let reason: string | undefined;
      // Флаг гасится перед обходом, а не после паузы: он означает «будильник
      // прозвонил после того, как этот обход начался». Иначе запрос, пришедший
      // до самого первого обхода, съедал бы первую паузу — и второй обход шёл бы
      // сразу за первым, ничего не изменившим.
      this.#woken = false;
      try {
        const report = await this.sweep();
        unavailable = report.codexUnavailable;
        if (!unavailable && everySweepFailed(report)) {
          unavailable = true;
          const attempts = report.children.reduce(
            (total, child) => total + child.cycles.reduce((sum, cycle) => sum + cycleAttempts(cycle).length, 0),
            0,
          );
          reason =
            `за обход ${String(report.children.length)} ребёнка(детей) ` +
            `ни одна из ${String(attempts)} фоновых подготовок не дала заданий`;
          this.#log(`диспетчер: ${reason}, пауза увеличена`);
          // Отдельное событие от `codex-unavailable`: сюда попадает codex,
          // который **запустился** и вышел с ненулевым кодом — просроченная
          // авторизация, кончившийся баланс, обрыв сети. Снаружи это выглядит
          // работающей моделью, и без своей категории причина простоя очереди
          // терялась бы среди «codex не запускается».
          this.#failures({
            event: 'codex-run-failed',
            message: 'ни один вызов codex за обход не дал заданий',
            detail: firstCycleError(report) ?? reason,
          });
        } else if (unavailable) {
          reason = 'codex не запускается';
        }
      } catch (error) {
        // Обход не должен уронить сервер: ошибка сюда доходит только
        // неожиданная, и следующий обход — единственный способ узнать, что она
        // прошла.
        unavailable = true;
        reason = `обход провалился: ${(error as Error).message}`;
        this.#log(`диспетчер: ${reason}`);
        this.#failures({
          event: 'sweep-failed',
          message: 'обход прогрева провалился',
          detail: (error as Error).message,
        });
      }

      failures = unavailable ? failures + 1 : 0;
      const delay = backoffDelay(failures);
      // Авария пишется на каждый отступ, а не только на первый: по журналу
      // видно, сколько обходов подряд легло и до какой паузы дошло удвоение.
      // И до проверки остановки: обход лёг независимо от того, закрывают ли
      // сервер следом, а запись, пропущенная на закрытии, унесла бы с собой
      // причину, по которой его и перезапускают.
      if (unavailable) {
        this.#failures({
          event: 'codex-unavailable',
          message: `прогрев отложен на ${String(Math.round(delay / 1000))} с ` +
            `после ${String(failures)} неудачного(ых) обхода(ов)`,
          ...(reason === undefined ? {} : { detail: reason }),
        });
      }
      if (this.#stopped) break;
      // Здоровый обход будильник снимает целиком: греть некому только что
      // появившемуся ребёнку незачем ждать минуту.
      if (this.#woken && failures === 0) continue;

      if (!this.#woken) {
        // Гонка паузы с будильником: после отказов codex она доходит до
        // получаса, а вернувшийся ребёнок и `stop()` обязаны её прерывать, а не
        // досиживать.
        await Promise.race([
          this.#wait(delay),
          new Promise<void>((resolve) => {
            this.#alarm = resolve;
          }),
        ]);
        this.#alarm = null;
        if (this.#stopped) break;
      }

      // Будильник после неудачного обхода паузу укорачивает, но не отменяет.
      // Отменяя, он отменял бы отступ вовсе, как только детей больше одного:
      // обход обрывается на первом же недоступном codex, второй ребёнок в
      // `#served` не попадает, его запрос снимает паузу — и следующий обход
      // обрывается уже на нём, будя первого. Дети пингуют друг друга сколько
      // угодно часто, а каждая попытка резервирует суточную квоту вызовов и не
      // возвращает её: недоступная на десять минут модель выедала бы дневной
      // предел обоим за пару минут. Досиживается обычная пауза между обходами,
      // а не получасовой отступ: ребёнок, до которого оборвавшийся обход не
      // дошёл, ждёт минуту.
      if (this.#woken && failures > 0) {
        await Promise.race([
          this.#wait(Math.min(delay, IDLE_INTERVAL_MS)),
          new Promise<void>((resolve) => {
            this.#halt = resolve;
          }),
        ]);
        this.#halt = null;
      }
    }
  }

  /** Один заход по одному ребёнку. Отказ его базы обход не останавливает. */
  /** Отступы тем этого ребёнка; заводятся при первом обходе. */
  #backoffFor(childId: string): TopicBackoff {
    const existing = this.#backoffs.get(childId);
    if (existing !== undefined) return existing;
    const created = new TopicBackoff();
    this.#backoffs.set(childId, created);
    return created;
  }

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
      const graph = this.#options.graphFor?.(childId) ?? this.#options.graph;
      if (graph === undefined) throw new Error(`программа ребёнка ${childId} недоступна`);
      const cycle = await this.#cycle({
        ...settings,
        db,
        graph,
        target: phase.target,
        threshold: phase.threshold,
        maxBatches: phase.maxBatches,
        prepareBoss: phase.prepareBoss,
        prepareLearning: phase.prepareLearning,
        log: this.#log,
        ...(this.#options.budget === undefined ? {} : { budget: this.#options.budget }),
        ...(this.#options.now === undefined ? {} : { now: this.#options.now }),
        ...(run === undefined ? {} : { run }),
        backoff: this.#backoffFor(childId),
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
      this.#failures({
        event: 'sweep-failed',
        message: 'заход прогрева по ребёнку провалился',
        detail: (error as Error).message,
        childId,
      });
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
