import { describe, expect, it } from 'vitest';
import {
  MAX_SECRET_LENGTH,
  SCRYPT_KEY_LENGTH,
  SCRYPT_N,
  SCRYPT_P,
  SCRYPT_R,
  hashSecret,
  verifySecret,
} from '../server/secrets.js';

describe('хранение секретов', () => {
  it('держит калибровочные параметры KDF', () => {
    expect(SCRYPT_N).toBe(16384);
    expect(SCRYPT_R).toBe(8);
    expect(SCRYPT_P).toBe(1);
    expect(SCRYPT_KEY_LENGTH).toBe(32);
    expect(MAX_SECRET_LENGTH).toBe(128);
  });

  it('пишет параметры в саму строку хеша, чтобы их можно было поднять', () => {
    const stored = hashSecret('верный-пароль');
    const parts = stored.split('$');
    expect(parts.slice(0, 4)).toEqual(['scrypt', '16384', '8', '1']);
    expect(parts).toHaveLength(6);
    // Соль и хеш — base64url без набивки: строка целиком годится для URL и логов.
    expect(parts[4]).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(parts[5]).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it('принимает верный секрет и отвергает неверный', () => {
    const stored = hashSecret('верный-пароль');
    expect(verifySecret(stored, 'верный-пароль')).toBe(true);
    expect(verifySecret(stored, 'верный-парол')).toBe(false);
    expect(verifySecret(stored, '')).toBe(false);
  });

  it('даёт разным солям разные хеши одного значения', () => {
    const first = hashSecret('одно и то же');
    const second = hashSecret('одно и то же');
    expect(first).not.toBe(second);
    expect(verifySecret(first, 'одно и то же')).toBe(true);
    expect(verifySecret(second, 'одно и то же')).toBe(true);
  });

  it('поднимает хеш, посчитанный с другими параметрами', () => {
    const stored = hashSecret('переносимый', { N: 1024, r: 4, p: 2 });
    expect(stored.startsWith('scrypt$1024$4$2$')).toBe(true);
    expect(verifySecret(stored, 'переносимый')).toBe(true);
    expect(verifySecret(stored, 'другой')).toBe(false);
  });

  it('отказывает на пустом и слишком длинном секрете до KDF', () => {
    expect(() => hashSecret('')).toThrow(/пуст/u);
    expect(() => hashSecret('x'.repeat(MAX_SECRET_LENGTH + 1))).toThrow(/длин/u);
    // Проверка длины стоит до KDF: иначе длинный пароль был бы способом занять процессор.
    const stored = hashSecret('короткий');
    expect(verifySecret(stored, 'x'.repeat(MAX_SECRET_LENGTH + 1))).toBe(false);
  });

  it('переживает мусор вместо строки хеша, не бросая наружу', () => {
    for (const stored of [
      '',
      'scrypt',
      'scrypt$16384$8$1$соль',
      'scrypt$16384$8$1$c29sdA$aGFzaA$лишнее',
      'argon2$16384$8$1$c29sdA$aGFzaA',
      'scrypt$нольцелых$8$1$c29sdA$aGFzaA',
      'scrypt$0$8$1$c29sdA$aGFzaA',
      'scrypt$16383$8$1$c29sdA$aGFzaA',
      'scrypt$16384$0$1$c29sdA$aGFzaA',
      'scrypt$16384$8$0$c29sdA$aGFzaA',
      'scrypt$1048576$64$1$c29sdA$aGFzaA',
      // Каждый параметр по отдельности допустим, а вместе они просят 4 ГиБ:
      // без отдельной проверки памяти испорченная строка в базе стала бы
      // способом положить процесс одной попыткой входа.
      'scrypt$1048576$32$1$c29sdA$aGFzaA',
      'scrypt$16384$8$1$$aGFzaA',
      'scrypt$16384$8$1$c29sdA$',
    ]) {
      expect(verifySecret(stored, 'что угодно')).toBe(false);
    }
  });

  it('отвергает хеш неожиданной длины, а не сравнивает обрезком', () => {
    const stored = hashSecret('секрет');
    const parts = stored.split('$');
    const short = [...parts.slice(0, 5), Buffer.from('коротко').toString('base64url')].join('$');
    expect(verifySecret(short, 'секрет')).toBe(false);
  });
});
