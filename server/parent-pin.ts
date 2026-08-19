/** Формат родительского PIN, серверный pepper и сверка с сохранённым хешем. */
import { createHmac } from 'node:crypto';
import { hashSecret, verifySecret } from './secrets.js';

const PARENT_PIN_PATTERN = /^\d{6,12}$/u;

/**
 * Минимальная длина pepper. Он не лежит в базе и добирает ту стойкость, которой
 * у PIN нет: шестизначных значений миллион, и дамп с `pin_hash` перебирается
 * офлайн за секунды, сколько бы ни стоил один `scrypt`.
 */
export const MIN_PIN_PEPPER_LENGTH = 16;

/** Некорректная или отсутствующая настройка закрывает write-маршрут через 503. */
export function readParentPin(value: string | undefined): string | undefined {
  return value !== undefined && PARENT_PIN_PATTERN.test(value) ? value : undefined;
}

/** Короткий pepper не лучше его отсутствия, поэтому короткий — это его отсутствие. */
export function readPinPepper(value: string | undefined): string | undefined {
  return value !== undefined && value.length >= MIN_PIN_PEPPER_LENGTH ? value : undefined;
}

/**
 * Приправленный PIN. HMAC, а не склейка: pepper служит ключом, и подобранный
 * `scrypt`-хеш без него бесполезен. Результат — 43 знака base64url, так что
 * предел длины секрета им не задевается.
 */
function peppered(pin: string, pepper: string): string {
  return createHmac('sha256', pepper).update(pin, 'utf8').digest('base64url');
}

/**
 * Считает эталон для хранения. Формат PIN и pepper проверяются здесь: записать
 * хеш от мусора значило бы завести PIN, который никогда не подойдёт.
 */
export function hashParentPin(pin: string, pepper: string): string {
  if (readParentPin(pin) === undefined) {
    throw new Error('PIN родителя должен состоять из 6-12 цифр');
  }
  if (readPinPepper(pepper) === undefined) {
    throw new Error(`Серверный pepper короче ${MIN_PIN_PEPPER_LENGTH} знаков`);
  }
  return hashSecret(peppered(pin, pepper));
}

/**
 * Сверяет предъявленный PIN с сохранённым хешем. Открытого эталона у проверки
 * нет и быть не должно. Без настроенного pepper — отказ: молчаливое сравнение
 * «как-нибудь» превратило бы недонастроенный сервер в открытый.
 */
export function verifyParentPin(
  pinHash: string | undefined,
  presented: string,
  pepper: string | undefined,
): boolean {
  const key = readPinPepper(pepper);
  if (pinHash === undefined || key === undefined) return false;
  // Формат предъявленного проверяется до KDF. Ранний выход здесь ничего не
  // говорит о самом PIN: он виден и так, из ответа на любой неверный ввод.
  if (readParentPin(presented) === undefined) return false;
  return verifySecret(pinHash, peppered(presented, key));
}
