import { createHash, timingSafeEqual } from 'node:crypto';

const PARENT_PIN_PATTERN = /^\d{6,12}$/u;

/** Некорректная или отсутствующая настройка закрывает write-маршрут через 503. */
export function readParentPin(value: string | undefined): string | undefined {
  return value !== undefined && PARENT_PIN_PATTERN.test(value) ? value : undefined;
}

/**
 * Сравниваются дайджесты фиксированной длины: ни длина, ни первый неверный знак
 * предъявленного PIN не превращают проверку в ранний выход.
 */
export function verifyParentPin(expected: string, presented: string): boolean {
  const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(expected), digest(presented));
}
