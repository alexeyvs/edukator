/**
 * Ограничители долгих вызовов codex внутри одного процесса. Фоновый воркер
 * не имеет права занять место интерактивного разбора спора, поэтому у них разные
 * бюджеты: два места для прогрева и одно зарезервированное для споров.
 */
export const MAX_CODEX_CONCURRENCY = 2;
export const MAX_DISPUTE_CONCURRENCY = 1;

type Job<T> = {
  work: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

export class CodexConcurrency {
  readonly limit: number;
  #active = 0;
  readonly #queue: Job<unknown>[] = [];

  constructor(limit: number = MAX_CODEX_CONCURRENCY) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`Предел одновременных вызовов codex должен быть положительным целым, получено ${limit}`);
    }
    this.limit = limit;
  }

  get active(): number {
    return this.#active;
  }

  /** Ждёт свободного места; так воркер не принимает занятый бюджет за отказ codex. */
  run<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.#queue.push({ work, resolve, reject } as Job<unknown>);
      this.#drain();
    });
  }

  /** Запускает только сразу; спор при занятом бюджете остаётся открытым для повтора. */
  tryRun<T>(work: () => Promise<T>): Promise<T> | undefined {
    if (this.#active >= this.limit || this.#queue.length > 0) return undefined;
    return this.#start(work);
  }

  #start<T>(work: () => Promise<T>): Promise<T> {
    this.#active += 1;
    return Promise.resolve()
      .then(work)
      .finally(() => {
        this.#active -= 1;
        this.#drain();
      });
  }

  #drain(): void {
    while (this.#active < this.limit) {
      const job = this.#queue.shift();
      if (job === undefined) return;
      void this.#start(job.work).then(job.resolve, job.reject);
    }
  }
}

/** Один фоновый бюджет на процесс. */
export const codexConcurrency = new CodexConcurrency();

/** Отдельное место для споров: прогрев банка его не занимает. */
export const disputeConcurrency = new CodexConcurrency(MAX_DISPUTE_CONCURRENCY);
