/**
 * Общий бюджет долгих вызовов codex внутри одного процесса. Воркер и разбор
 * споров не могут держать отдельные счётчики: иначе каждый честно соблюдает
 * предел сам, а процесс в сумме запускает вдвое больше моделей.
 */
export const MAX_CODEX_CONCURRENCY = 2;

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

/** Один экземпляр на модуль Node, то есть один счётчик на процесс. */
export const codexConcurrency = new CodexConcurrency();
