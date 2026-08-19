import { describe, expect, it } from 'vitest';
import {
  MIN_PIN_PEPPER_LENGTH,
  hashParentPin,
  readParentPin,
  readPinPepper,
  verifyParentPin,
} from '../server/parent-pin.js';

const PEPPER = 'pepper-длиной-достаточной-для-проверки';
const PIN = '123456';

describe('PIN родителей', () => {
  it('держит калибровочные константы спеки', () => {
    expect(MIN_PIN_PEPPER_LENGTH).toBe(16);
  });

  it('принимает только от 6 до 12 цифр', () => {
    expect(readParentPin(undefined)).toBeUndefined();
    expect(readParentPin('12345')).toBeUndefined();
    expect(readParentPin('1234567890123')).toBeUndefined();
    expect(readParentPin('12345a')).toBeUndefined();
    expect(readParentPin(' 123456')).toBeUndefined();
    expect(readParentPin('123456')).toBe('123456');
    expect(readParentPin('123456789012')).toBe('123456789012');
  });

  it('принимает pepper только достаточной длины', () => {
    expect(readPinPepper(undefined)).toBeUndefined();
    expect(readPinPepper('')).toBeUndefined();
    expect(readPinPepper('x'.repeat(MIN_PIN_PEPPER_LENGTH - 1))).toBeUndefined();
    expect(readPinPepper('x'.repeat(MIN_PIN_PEPPER_LENGTH))).toBe('x'.repeat(MIN_PIN_PEPPER_LENGTH));
  });

  it('сверяет предъявленный PIN с хешем, а не с открытым значением', () => {
    const hash = hashParentPin(PIN, PEPPER);
    expect(hash).not.toContain(PIN);
    expect(verifyParentPin(hash, PIN, PEPPER)).toBe(true);
    expect(verifyParentPin(hash, '123457', PEPPER)).toBe(false);
    expect(verifyParentPin(hash, '1', PEPPER)).toBe(false);
  });

  it('даёт разным солям разные хеши одного PIN', () => {
    expect(hashParentPin(PIN, PEPPER)).not.toBe(hashParentPin(PIN, PEPPER));
  });

  it('без верного pepper тот же хеш не открывается', () => {
    const hash = hashParentPin(PIN, PEPPER);
    expect(verifyParentPin(hash, PIN, `${PEPPER}-другой`)).toBe(false);
  });

  it('без pepper отказывает, а не принимает молча', () => {
    const hash = hashParentPin(PIN, PEPPER);
    expect(verifyParentPin(hash, PIN, undefined)).toBe(false);
    expect(verifyParentPin(hash, PIN, '')).toBe(false);
    expect(verifyParentPin(hash, PIN, 'коротко')).toBe(false);
  });

  it('отказывает на пустом эталоне и на мусоре вместо хеша', () => {
    expect(verifyParentPin(undefined, PIN, PEPPER)).toBe(false);
    expect(verifyParentPin('', PIN, PEPPER)).toBe(false);
    expect(verifyParentPin('scrypt$16384$8$1$мусор', PIN, PEPPER)).toBe(false);
  });

  it('не хеширует PIN неверного формата ни при записи, ни при проверке', () => {
    expect(() => hashParentPin('12345', PEPPER)).toThrow(/цифр/u);
    expect(() => hashParentPin(PIN, 'коротко')).toThrow(/pepper/u);
    const hash = hashParentPin(PIN, PEPPER);
    expect(verifyParentPin(hash, '12345a', PEPPER)).toBe(false);
  });
});
