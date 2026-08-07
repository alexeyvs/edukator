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
    let failure: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const signal = (name: NodeJS.Signals): void => {
      try {
        if (grouped && child.pid !== undefined) process.kill(-child.pid, name);
        else child.kill(name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
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
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > limit) {
        stop(new Error(`${options.label}: вывод превысил ${limit} байт`));
      }
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => append('stdout', chunk));
    child.stderr.on('data', (chunk: string) => append('stderr', chunk));

    const timeout = setTimeout(
      () => stop(new Error(`${options.label}: превышен срок ${options.timeoutMs} мс`)),
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
