/**
 * Чтение секретов со стандартного ввода для CLI обслуживания.
 *
 * Живёт отдельным модулем, потому что таких CLI больше одного: родителей
 * заводит `scripts/parent.ts`, оператора — `scripts/admin.ts`, и своя копия
 * этого чтения в каждом разъехалась бы с общей молча — ровно на тех двух
 * тонкостях, ради которых оно и написано (один `readline` на запуск и отказ на
 * закрытом вводе).
 */
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

/**
 * Чтение секретов со стандартного ввода: интерфейс один на весь запуск.
 *
 * Отдельный `readline` на каждый вопрос не годится: readline разбирает
 * пришедший кусок на строки сразу, поэтому первый интерфейс забирает из трубы
 * **обе** строки, отдаёт первую и выбрасывает вторую, а созданный следом второй
 * видит уже закрытый ввод. `printf 'пароль\nпароль\n' | npm run parent -- password`
 * отказывал бы «стандартный ввод закрыт», прочитав ровно половину ответа, —
 * то есть документированный договор «секрет читается со стандартного ввода»
 * работал бы только с живого терминала.
 *
 * Вывод readline уходит в никуда, приглашение печатается в stderr:
 * перенаправленный stdout не должен уносить с собой вопрос, на который никто не
 * увидел ответа.
 */
export interface SecretReader {
  read: (prompt: string) => Promise<string>;
  close: () => void;
}

export const STDIN_CLOSED = 'Секрет не введён: стандартный ввод закрыт';

export function createSecretReader(input: NodeJS.ReadableStream = process.stdin): SecretReader {
  const silent = new Writable({
    write(_chunk, _encoding, callback): void {
      callback();
    },
  });
  const rl = createInterface({
    input,
    output: silent,
    terminal: (input as NodeJS.ReadStream).isTTY === true,
  });

  // Строки, пришедшие раньше вопроса, не теряются: труба отдаёт их все разом,
  // и без буфера второй вопрос ждал бы того, что уже прочитано.
  const buffered: string[] = [];
  let waiting: { done: (line: string) => void; fail: (error: Error) => void } | undefined;
  let closed = false;

  rl.on('line', (line: string) => {
    const pending = waiting;
    waiting = undefined;
    if (pending === undefined) buffered.push(line);
    else pending.done(line);
  });
  // Закрытый ввод обязан разрешить ожидание отказом: неразрешённое обещание
  // опустошило бы цикл событий, и Node вышел бы с кодом 0 — то есть «пароль
  // сменён», хотя не сменилось ничего.
  rl.once('close', () => {
    closed = true;
    const pending = waiting;
    waiting = undefined;
    pending?.fail(new Error(STDIN_CLOSED));
  });

  return {
    async read(prompt: string): Promise<string> {
      process.stderr.write(prompt);
      try {
        const ready = buffered.shift();
        if (ready !== undefined) return ready;
        if (closed) throw new Error(STDIN_CLOSED);
        return await new Promise<string>((done, fail) => {
          waiting = { done, fail };
        });
      } finally {
        process.stderr.write('\n');
      }
    },
    close(): void {
      rl.close();
    },
  };
}

/**
 * Спрашивает секрет дважды и сверяет. Опечатка в пароле, который нигде не
 * отображается, иначе обнаружилась бы только при следующем входе — то есть
 * тогда, когда сменить его уже нечем.
 */
export async function readConfirmed(
  readSecret: SecretReader['read'],
  what: string,
): Promise<string> {
  const first = await readSecret(`Новый ${what}: `);
  const second = await readSecret(`Ещё раз: `);
  if (first !== second) throw new Error(`Введённый ${what} не совпал с повтором`);
  return first;
}
