/**
 * Разбор аргументов CLI обслуживания учётных записей: команда, `--email`,
 * `--data-dir`.
 *
 * Общий на все такие CLI намеренно. Здесь живёт не форма командной строки, а
 * запрет секретов во флагах: аргументы видны в `ps` любому пользователю машины
 * и остаются в истории оболочки. Своя копия разбора в `scripts/admin.ts`
 * разъехалась бы с родительской молча — и разъехалась бы ровно этим запретом,
 * потому что он единственная часть, которую легко «не переносить».
 */
import { resolve } from 'node:path';

export interface AccountArgs<A extends string> {
  action: A;
  email: string;
  dataDir?: string;
}

/**
 * @param who кого ищем по адресу в родительном падеже: «без адреса родителя не
 *            найти». Отказ обязан называть того, кого CLI обслуживает.
 */
export function parseAccountArgs<A extends string>(
  argv: string[],
  actions: readonly A[],
  who: string,
): AccountArgs<A> {
  const action = argv[0];
  if (action === undefined) {
    throw new Error(`Не указана команда, ожидается одна из: ${actions.join(', ')}`);
  }
  if (!actions.includes(action as A)) {
    throw new Error(`Неизвестная команда «${action}», ожидается одна из: ${actions.join(', ')}`);
  }

  const values = new Map<string, string>();
  const known = new Set(['email', 'data-dir']);
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index] ?? '';
    // Лишний позиционный аргумент называется местом, а не значением: набравший
    // `parent password --email a@b hunter2` по привычке к флагам иначе получал бы
    // свой пароль в stderr и в журнале запуска — ровно та утечка, ради которой
    // секреты флагами и не принимаются.
    if (!flag.startsWith('--')) {
      throw new Error(
        `Аргумент №${String(index)} не похож на флаг: ожидается --email или --data-dir. ` +
          'Значение не показано: им мог оказаться пароль',
      );
    }
    // Имя отделяется от значения **до** всякого сообщения: форма `--pin=1234`
    // иначе не совпала бы ни с одним известным флагом и уехала бы в текст
    // отказа целиком, вместе с секретом, — то есть запрет секретов во флагах
    // сам же вписал бы секрет в stderr и в лог запуска.
    const equals = flag.indexOf('=');
    const name = equals < 0 ? flag.slice(2) : flag.slice(2, equals);
    const shown = `--${name}`;
    // Пароль и PIN флагами не принимаются вовсе, а не «принимаются, но не
    // рекомендуются»: иначе они попадали бы в `ps` и в историю оболочки.
    if (name === 'password' || name === 'pin') {
      throw new Error(`Секрет не передаётся флагом ${shown}: он виден в списке процессов, скрипт спросит его сам`);
    }
    if (!known.has(name)) throw new Error(`Неизвестный флаг: ${shown}`);
    if (equals >= 0) {
      const inline = flag.slice(equals + 1);
      if (inline.trim() === '') throw new Error(`У флага ${shown} пустое значение`);
      if (values.has(name)) throw new Error(`Флаг ${shown} указан дважды`);
      values.set(name, inline);
      continue;
    }
    if (values.has(name)) throw new Error(`Флаг ${flag} указан дважды`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`У флага ${flag} нет значения`);
    if (value.trim() === '') throw new Error(`У флага ${flag} пустое значение`);
    values.set(name, value);
    index += 1;
  }

  const email = values.get('email');
  if (email === undefined) throw new Error(`Не указан --email: без адреса ${who} не найти`);
  const dir = values.get('data-dir');
  return {
    action: action as A,
    email,
    ...(dir === undefined ? {} : { dataDir: resolve(dir) }),
  };
}
