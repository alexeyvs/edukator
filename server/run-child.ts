import { spawn } from 'node:child_process';

export const MAX_CHILD_OUTPUT_BYTES = 1024 * 1024;
const KILL_GRACE_MS = 250;
/**
 * Сколько ждать `close` после SIGKILL, прежде чем бросить потомка. `close`
 * приходит, только когда закрыты обе унаследованные трубы, а внук, успевший
 * вызвать `setsid`, из группы уходит, SIGKILL по `-pid` его не достаёт и трубу
 * он держит — обещание тогда не разрешалось бы никогда, и срок, ради которого
 * всё и заведено, ничего не ограничивал бы.
 */
const ABANDON_GRACE_MS = 1000;

export interface RunChildOptions {
  bin: string;
  args: string[];
  label: string;
  timeoutMs: number;
  /** Текст для stdin; поток закрывается сразу после записи. Без текста stdin остаётся закрытым. */
  input?: string;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface ChildOutput {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Процесс не уложился в срок и был снят вместе с группой. Отдельный класс, а не
 * текст: вызывающий отличает молчащий инструмент от инструмента, который
 * ответил отказом, — повторять первый теми же попытками бессмысленно, он съест
 * ещё столько же времени.
 */
export class ChildTimeoutError extends Error {}

/** Процесс перебрал общий предел вывода и был снят вместе с группой. */
export class ChildOutputLimitError extends Error {}

/** The owner cancelled the child because its enclosing operation is shutting down. */
export class ChildAbortError extends Error {}

/**
 * Живые группы процессов: снимаются, если родитель уходит раньше них.
 *
 * `detached` заводит потомку собственную группу — только так его снимает
 * `process.kill(-pid)` по сроку, — но она же выводит его из группы терминала:
 * Ctrl-C по `npm run prefetch` до потомка не доходит, а таймер, который снял бы
 * его по сроку, умирает вместе с родителем. Два вызова codex по десять минут
 * остаются жечь подписку, и собрать их ответ уже некому.
 */
const liveGroups = new Set<number>();

/** Сигналы, на которых родителя снимают снаружи; `exit` их не покрывает. */
const DEATH_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

function killLiveGroups(): void {
  for (const pid of liveGroups) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Группа уже мертва либо pid ушёл чужому: снимать некого, а бросать
      // отсюда нельзя — обработчик выхода не имеет права заслонить причину.
    }
  }
  liveGroups.clear();
}

function onDeathSignal(name: NodeJS.Signals, owned: boolean): void {
  killLiveGroups();
  releaseSignalHandlers();
  // Свой обработчик отменяет умолчание сигнала, поэтому смерть по нему
  // возвращается руками — но только там, где до нас сигнал никто не слушал.
  // У сервера на тех же сигналах висит `closeOnSignals`, и убить процесс
  // из-под него значило бы оборвать закрытие базы ровно там, где оно и
  // заводилось: WAL остался бы неперенесённым.
  if (owned) process.kill(process.pid, name);
}

const signalHandlers = new Map<NodeJS.Signals, () => void>();

function holdSignalHandlers(): void {
  if (signalHandlers.size > 0) return;
  for (const name of DEATH_SIGNALS) {
    // Считается до подписки: `once` чужого обработчика снимается перед вызовом,
    // и в момент самого сигнала счётчик уже ничего не говорит о том, ждёт ли
    // кто-то ещё завершения.
    const owned = process.listenerCount(name) === 0;
    const handler = (): void => onDeathSignal(name, owned);
    signalHandlers.set(name, handler);
    process.on(name, handler);
  }
}

/**
 * Обработчики снимаются, как только потомков не осталось: подписка на сигнал
 * держит цикл событий, и `npm run prefetch` не завершался бы, сделав всю работу.
 */
function releaseSignalHandlers(): void {
  for (const [name, handler] of signalHandlers) process.off(name, handler);
  signalHandlers.clear();
}

let exitHookInstalled = false;

function watchGroup(pid: number): void {
  liveGroups.add(pid);
  holdSignalHandlers();
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // `exit` покрывает обычный выход и необработанное исключение; сигналы — нет,
  // на них Node уходит мимо этого события, потому у них свой обработчик.
  process.on('exit', killLiveGroups);
}

function forgetGroup(pid: number | undefined): void {
  if (pid !== undefined) liveGroups.delete(pid);
  if (liveGroups.size === 0) releaseSignalHandlers();
}

/** Запускает внешний инструмент с конечным stdin, сроком и ограниченным выводом. */
export function runChild(options: RunChildOptions): Promise<ChildOutput> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    return Promise.reject(new Error(`${options.label}: срок должен быть положительным числом`));
  }
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted === true) {
      reject(new ChildAbortError(`${options.label}: выполнение отменено`));
      return;
    }
    const grouped = process.platform !== 'win32';
    const child = spawn(options.bin, options.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: grouped,
    });
    // Только своя группа: без `detached` снимать `-pid` нельзя, а потомок и так
    // уходит вместе с группой терминала.
    if (grouped && child.pid !== undefined) watchGroup(child.pid);
    const limit = options.maxOutputBytes ?? MAX_CHILD_OUTPUT_BYTES;
    let stdout = '';
    let stderr = '';
    // Счётчик ведётся по кускам: пересчёт `Buffer.byteLength` по всему
    // накопленному на каждое событие `data` — это перебор мегабайтов заново
    // на каждую строчку болтливого процесса.
    let bytes = 0;
    let failure: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let abandonTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const clearTimers = (): void => {
      clearTimeout(timeout);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (abandonTimer !== undefined) clearTimeout(abandonTimer);
      options.signal?.removeEventListener('abort', abort);
    };

    // Ошибка снятия не выбрасывается наружу ни в каком виде: `signal` зовётся из
    // таймера, из обработчика `data` и из `close`, а там исключение уже некому
    // поймать — оно валит процесс, и обещание остаётся навсегда неразрешённым.
    // Чинить всё равно нечего: `ESRCH` — процесс уже мёртв, `EPERM` — его pid
    // успел уйти чужой группе, и в обоих случаях снимать некого. Обещание
    // закроет обычный путь `close`/`error`.
    const signal = (name: NodeJS.Signals): void => {
      try {
        if (grouped && child.pid !== undefined) process.kill(-child.pid, name);
        else child.kill(name);
      } catch {
        // см. выше
      }
    };

    const stop = (error: Error): void => {
      if (failure !== undefined) return;
      failure = error;
      signal('SIGTERM');
      killTimer = setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS);
      // Второй срок — на сам `close`. Трубы рвутся руками: иначе оставшийся в
      // живых внук держал бы их открытыми, `close` не пришёл бы, а вместе с ним
      // не пришли бы ни `forgetGroup` (pid остался бы в `liveGroups`, а подписка
      // на сигналы — держать цикл событий), ни отказ вызывающему. У занятия это
      // навсегда занятое место в `reviewing`, у `prefetch` — незавершающийся
      // процесс, сделавший всю работу.
      abandonTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimers();
        forgetGroup(child.pid);
        child.stdout.destroy();
        child.stderr.destroy();
        reject(error);
      }, KILL_GRACE_MS + ABANDON_GRACE_MS);
    };

    const abort = (): void => stop(new ChildAbortError(`${options.label}: выполнение отменено`));
    options.signal?.addEventListener('abort', abort, { once: true });

    const append = (target: 'stdout' | 'stderr', chunk: string): void => {
      if (failure !== undefined) return;
      if (target === 'stdout') stdout += chunk;
      else stderr += chunk;
      bytes += Buffer.byteLength(chunk);
      if (bytes > limit) {
        stop(new ChildOutputLimitError(`${options.label}: вывод превысил ${limit} байт`));
      }
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => append('stdout', chunk));
    child.stderr.on('data', (chunk: string) => append('stderr', chunk));
    // Труба без подписки на `error` валит процесс необработанным исключением, а
    // разрыв её здесь — обычное дело: группу снимают SIGKILL'ом посреди чтения,
    // и `EPIPE`/`ECONNRESET` прилетает именно сюда. Обещание закрывает `close`
    // или срок, так что глотать нечего — читать всё равно больше нечего.
    child.stdout.on('error', () => undefined);
    child.stderr.on('error', () => undefined);
    // `end`, а не оставленная открытой труба: инструмент получает весь ввод и
    // EOF. Без `input` это эквивалент закрытого stdin. Ранний выход потомка
    // может дать EPIPE — его код/сигнал всё равно приходит через `close`, а
    // необработанная ошибка Writable свалила бы весь сервер раньше результата.
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input ?? '');

    const timeout = setTimeout(
      () => stop(new ChildTimeoutError(`${options.label}: превышен срок ${options.timeoutMs} мс`)),
      options.timeoutMs,
    );

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      forgetGroup(child.pid);
      reject(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      forgetGroup(child.pid);
      if (failure !== undefined) {
        // Лидер группы мог завершиться от SIGTERM раньше потомка, который
        // закрыл stdio и игнорирует TERM. `close` тогда приходит до таймера;
        // отменить эскалацию означало бы оставить потомка жить бесконечно.
        signal('SIGKILL');
        clearTimers();
        reject(failure);
      } else {
        clearTimers();
        resolve({ code, stdout, stderr });
      }
    });
  });
}
