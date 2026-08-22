import { describe, expect, it } from 'vitest';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, isParentPassword } from './password-format';

describe('формат пароля родителя на клиенте', () => {
  it('держит границы спеки: числа вписаны руками', () => {
    // Ожидание из той же константы подмену не ловит, поэтому числа здесь свои.
    // Поднятый на сервере минимум оставил бы клиент, который молча принимает
    // короткий пароль и получает 400 без объяснения.
    expect(MIN_PASSWORD_LENGTH).toBe(10);
    expect(MAX_PASSWORD_LENGTH).toBe(128);
  });

  it('принимает пароль ровно по границам и отвергает за ними', () => {
    expect(isParentPassword('к'.repeat(MIN_PASSWORD_LENGTH))).toBe(true);
    expect(isParentPassword('к'.repeat(MAX_PASSWORD_LENGTH))).toBe(true);
    expect(isParentPassword('к'.repeat(MIN_PASSWORD_LENGTH - 1))).toBe(false);
    expect(isParentPassword('к'.repeat(MAX_PASSWORD_LENGTH + 1))).toBe(false);
    expect(isParentPassword('')).toBe(false);
  });
});
