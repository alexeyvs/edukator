/** Хранение паролей и PIN: `scrypt` с индивидуальной солью и разбор строки хеша. */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Параметры KDF. Лежат не только в коде, но и в самой строке хеша: подняв их
 * здесь, мы не ломаем записи, посчитанные прежними — они проверятся своими.
 */
export const SCRYPT_N = 16384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_KEY_LENGTH = 32;

const SALT_LENGTH = 16;

/**
 * Предел длины секрета. Проверяется **до** KDF: `scrypt` при N=16384 стоит
 * десятки миллисекунд, и без предела длинный пароль превращается в способ
 * занять процессор — а вход открыт всем, кто дотянулся до сервера.
 */
export const MAX_SECRET_LENGTH = 128;

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/**
 * Потолок памяти одного вызова. `scrypt` берёт 128 * N * r байт, и параметры
 * при проверке приходят из базы: без явного потолка испорченная строка
 * `scrypt$1048576$64$...` попросила бы восемь гигабайт.
 */
const MAX_SCRYPT_MEMORY = 64 * 1024 * 1024;

/** Разумные границы параметров: всё за ними — испорченная или чужая запись. */
const MIN_SCRYPT_N = 1024;
const MAX_SCRYPT_R = 32;
const MAX_SCRYPT_P = 16;

function assertParams(params: ScryptParams): void {
  const { N, r, p } = params;
  // N обязан быть степенью двойки — иначе `scryptSync` бросает изнутри.
  if (!Number.isInteger(N) || N < MIN_SCRYPT_N || (N & (N - 1)) !== 0) {
    throw new Error(`Параметр scrypt N недопустим: ${N}`);
  }
  if (!Number.isInteger(r) || r < 1 || r > MAX_SCRYPT_R) {
    throw new Error(`Параметр scrypt r недопустим: ${r}`);
  }
  if (!Number.isInteger(p) || p < 1 || p > MAX_SCRYPT_P) {
    throw new Error(`Параметр scrypt p недопустим: ${p}`);
  }
  // Считается настоящий расход, а не `128 * N * r`: `scrypt` берёт ещё и блок
  // распараллеливания, и без `p` в формуле проверка пропускала бы параметры,
  // которые сам KDF отвергает по `maxmem` (`scrypt$65536$8$16$…` — ровно такие).
  // Пропущенные сюда, они падают уже внутри `derive`, то есть на пути входа.
  if (128 * r * (N + p + 2) > MAX_SCRYPT_MEMORY) {
    throw new Error(`Параметры scrypt требуют больше ${MAX_SCRYPT_MEMORY} байт памяти`);
  }
}

function assertSecret(secret: string): void {
  if (secret.length === 0) throw new Error('Секрет пуст');
  if (secret.length > MAX_SECRET_LENGTH) {
    throw new Error(`Секрет длиннее ${MAX_SECRET_LENGTH} знаков`);
  }
}

function derive(secret: string, salt: Buffer, params: ScryptParams): Buffer {
  return scryptSync(secret, salt, SCRYPT_KEY_LENGTH, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: MAX_SCRYPT_MEMORY,
  });
}

/**
 * Считает хеш секрета со свежей солью. Формат — `scrypt$N$r$p$соль$хеш`,
 * base64url: такую строку можно положить в колонку, показать в логе разбора и
 * прочитать глазами, не гадая о параметрах.
 */
export function hashSecret(
  secret: string,
  params: ScryptParams = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
): string {
  assertSecret(secret);
  assertParams(params);
  const salt = randomBytes(SALT_LENGTH);
  const key = derive(secret, salt, params);
  return [
    'scrypt',
    params.N,
    params.r,
    params.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

interface ParsedHash {
  params: ScryptParams;
  salt: Buffer;
  key: Buffer;
}

/**
 * Разбирает строку хеша. Возвращает `undefined` на всём, что не разобралось:
 * испорченная запись — это отказ во входе, а не исключение из-под маршрута.
 */
function parseSecretHash(stored: string): ParsedHash | undefined {
  const parts = stored.split('$');
  if (parts.length !== 6) return undefined;
  const [algorithm, rawN, rawR, rawP, rawSalt, rawKey] = parts as [
    string, string, string, string, string, string,
  ];
  if (algorithm !== 'scrypt') return undefined;
  // `Number` на пустой строке даёт 0, поэтому вид числа проверяется отдельно.
  if (!/^\d+$/u.test(rawN) || !/^\d+$/u.test(rawR) || !/^\d+$/u.test(rawP)) return undefined;
  const params = { N: Number(rawN), r: Number(rawR), p: Number(rawP) };
  try {
    assertParams(params);
  } catch {
    return undefined;
  }
  // `Buffer.from` молча выбрасывает знаки не из алфавита, так что алфавит
  // проверяется сам: иначе «соль» из кириллицы стала бы пустым буфером.
  if (!/^[A-Za-z0-9_-]+$/u.test(rawSalt) || !/^[A-Za-z0-9_-]+$/u.test(rawKey)) return undefined;
  const salt = Buffer.from(rawSalt, 'base64url');
  const key = Buffer.from(rawKey, 'base64url');
  if (salt.length === 0 || key.length !== SCRYPT_KEY_LENGTH) return undefined;
  return { params, salt, key };
}

/**
 * Сверяет предъявленный секрет с сохранённым хешем. Сравнение постоянного
 * времени по буферам одинаковой длины; всё, что не разобралось или не прошло по
 * длине, — `false`.
 */
export function verifySecret(stored: string, presented: string): boolean {
  if (presented.length === 0 || presented.length > MAX_SECRET_LENGTH) return false;
  const parsed = parseSecretHash(stored);
  if (parsed === undefined) return false;
  // Второй заслон под тем же правилом «испорченная запись — отказ во входе, а
  // не исключение»: границы параметров выше проверены, но они и сам KDF —
  // разные реализации одного условия, и разъехавшись, они превратили бы одну
  // испорченную строку в пятисотку на каждой попытке входа этой учётной записи.
  let derived: Buffer;
  try {
    derived = derive(presented, parsed.salt, parsed.params);
  } catch {
    return false;
  }
  return timingSafeEqual(derived, parsed.key);
}
