import { spawn } from 'node:child_process';

export const MAX_CHILD_OUTPUT_BYTES = 1024 * 1024;
const KILL_GRACE_MS = 250;

export interface RunChildOptions {
  bin: string;
  args: string[];
  label: string;
  timeoutMs: number;
  maxOutputBytes?: number;
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

/** Запускает внешний инструмент с закрытым stdin, сроком и ограниченным выводом. */
export function runChild(options: RunChildOptions): Promise<ChildOutput> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    return Promise.reject(new Error(`${options.label}: срок должен быть положительным числом`));
  }
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(options.bin, options.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: grouped,
    });
    const limit = options.maxOutputBytes ?? MAX_CHILD_OUTPUT_BYTES;
    let stdout = '';
    let stderr = '';
    // Счётчик ведётся по кускам: пересчёт `Buffer.byteLength` по всему
    // накопленному на каждое событие `data` — это перебор мегабайтов заново
    // на каждую строчку болтливого процесса.
    let bytes = 0;
    let failure: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;

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
    };

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

    const timeout = setTimeout(
      () => stop(new ChildTimeoutError(`${options.label}: превышен срок ${options.timeoutMs} мс`)),
      options.timeoutMs,
    );

    child.once('error', (error) => {
      clearTimeout(timeout);
      if (killTimer !== undefined) clearTimeout(killTimer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (failure !== undefined) {
        // Лидер группы мог завершиться от SIGTERM раньше потомка, который
        // закрыл stdio и игнорирует TERM. `close` тогда приходит до таймера;
        // отменить эскалацию означало бы оставить потомка жить бесконечно.
        signal('SIGKILL');
        if (killTimer !== undefined) clearTimeout(killTimer);
        reject(failure);
      } else {
        if (killTimer !== undefined) clearTimeout(killTimer);
        resolve({ code, stdout, stderr });
      }
    });
  });
}
