import { describe, expect, it } from 'vitest';
import {
  MAX_FORWARDED_HOPS,
  DEFAULT_TRUSTED_PROXIES,
  MAX_ADDRESS_LENGTH,
  UNKNOWN_ADDRESS,
  clientAddress,
  normalizeAddress,
  readTrustedProxies,
} from '../server/client-address.js';

const LOOPBACK = readTrustedProxies(undefined);

describe('normalizeAddress', () => {
  it('приводит записи одного адреса к одному виду', () => {
    expect(normalizeAddress(' 203.0.113.7 ')).toBe('203.0.113.7');
    // Порт к адресу не относится: иначе каждое соединение давало бы свой ключ.
    expect(normalizeAddress('203.0.113.7:41234')).toBe('203.0.113.7');
    expect(normalizeAddress('[2001:DB8::1]:443')).toBe('2001:db8::1');
    expect(normalizeAddress('2001:db8::1')).toBe('2001:db8::1');
    // Тот же loopback, каким его показывает сокет с двойным стеком.
    expect(normalizeAddress('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeAddress('fe80::1%en0')).toBe('fe80::1');
  });

  it('отвергает то, что адресом не является', () => {
    expect(normalizeAddress(undefined)).toBeUndefined();
    expect(normalizeAddress('   ')).toBeUndefined();
    expect(normalizeAddress('[2001:db8::1')).toBeUndefined();
    expect(normalizeAddress('x'.repeat(MAX_ADDRESS_LENGTH + 1))).toBeUndefined();
  });
});

describe('readTrustedProxies', () => {
  it('без настройки верит только loopback', () => {
    expect([...readTrustedProxies(undefined)].sort()).toEqual([...DEFAULT_TRUSTED_PROXIES].sort());
  });

  it('разбирает список через запятую и пробелы, отбрасывая мусор', () => {
    const trusted = readTrustedProxies('10.0.0.8, [::1] , не адрес!!, 10.0.0.9');

    expect(trusted.has('10.0.0.8')).toBe(true);
    expect(trusted.has('10.0.0.9')).toBe(true);
    expect(trusted.has('::1')).toBe(true);
    // Умолчания к списку не добавляются: заданный список задан целиком.
    expect(trusted.has('127.0.0.1')).toBe(false);
  });

  it('пустая настройка означает «не верить никому», а не умолчание', () => {
    // `??` поймал бы только незаданную переменную, а `EDUKATOR_TRUSTED_PROXIES=`
    // — это сознательный отказ от прокси, и подменять его loopback нельзя.
    expect(readTrustedProxies('')).toEqual(new Set());
    expect(readTrustedProxies('   ')).toEqual(new Set());
  });
});

describe('clientAddress', () => {
  it('берёт адрес сокета, когда прокси нет', () => {
    expect(
      clientAddress({ socketAddress: '::ffff:203.0.113.7', trusted: LOOPBACK }),
    ).toBe('203.0.113.7');
  });

  it('читает X-Forwarded-For от доверенного адреса', () => {
    expect(
      clientAddress({
        socketAddress: '127.0.0.1',
        forwardedFor: '203.0.113.7',
        trusted: LOOPBACK,
      }),
    ).toBe('203.0.113.7');
  });

  it('игнорирует X-Forwarded-For от недоверенного адреса', () => {
    // Иначе подбирающий пароль дописывал бы новый адрес на каждую попытку и
    // счётчик по адресу перестал бы существовать.
    expect(
      clientAddress({
        socketAddress: '203.0.113.7',
        forwardedFor: '198.51.100.1',
        trusted: LOOPBACK,
      }),
    ).toBe('203.0.113.7');
  });

  it('идёт по цепочке справа налево до первого недоверенного', () => {
    const trusted = readTrustedProxies('127.0.0.1, 10.0.0.8');

    expect(
      clientAddress({
        // Слева то, что дописал сам клиент: до него разбор доходить не должен.
        socketAddress: '127.0.0.1',
        forwardedFor: '1.1.1.1, 203.0.113.7, 10.0.0.8',
        trusted,
      }),
    ).toBe('203.0.113.7');
  });

  it('на неразобранной цепочке остаётся при адресе сокета', () => {
    expect(
      clientAddress({
        socketAddress: '127.0.0.1',
        forwardedFor: '203.0.113.7, не адрес!!',
        trusted: LOOPBACK,
      }),
    ).toBe('127.0.0.1');
    // Пустые шаги — не мусор, а разделители: их пропускаем.
    expect(
      clientAddress({ socketAddress: '127.0.0.1', forwardedFor: ' , 203.0.113.7, ', trusted: LOOPBACK }),
    ).toBe('203.0.113.7');
    // Цепочка целиком из доверенных не даёт клиента вовсе.
    expect(
      clientAddress({ socketAddress: '127.0.0.1', forwardedFor: '::1', trusted: LOOPBACK }),
    ).toBe('127.0.0.1');
  });

  it('длинная цепочка режется справа: шаг доверенного прокси остаётся в окне', () => {
    // Клиент дописывает столько шагов, что настоящий — тот, что приписал сам
    // прокси, — уходит за предел. Срез с левого края оставил бы в окне только
    // подложенное, и ключ счётчика перебора выбирал бы сам подбирающий.
    const forged = Array.from({ length: MAX_FORWARDED_HOPS + 8 }, (_, index) => `198.51.100.${index + 1}`);
    const chain = [...forged, '203.0.113.7'].join(', ');

    expect(clientAddress({ socketAddress: '127.0.0.1', forwardedFor: chain, trusted: LOOPBACK })).toBe(
      '203.0.113.7',
    );
  });

  it('держит калибровочную константу длины цепочки', () => {
    // Число вписано руками: собранное из самой константы ожидание её подмену
    // не поймало бы.
    expect(MAX_FORWARDED_HOPS).toBe(32);
  });

  it('неизвестный адрес сокета даёт общий ключ, а не пустой', () => {
    expect(clientAddress({ socketAddress: undefined, trusted: LOOPBACK })).toBe(UNKNOWN_ADDRESS);
    // Заголовок без разобранного сокета не читается: доверять нечему.
    expect(
      clientAddress({ socketAddress: '', forwardedFor: '203.0.113.7', trusted: LOOPBACK }),
    ).toBe(UNKNOWN_ADDRESS);
  });
});
