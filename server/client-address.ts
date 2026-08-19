/**
 * Адрес клиента для счётчиков неудачных входов.
 *
 * `X-Forwarded-For` подставляет кто угодно, поэтому заголовок читается **только**
 * от перечисленных адресов. Голое `trustProxy: true` защитой не является, а её
 * прямое отключение: подбирающий пароль дописал бы новый адрес на каждую попытку
 * и счётчик по адресу перестал бы существовать.
 *
 * Списком идут именно адреса, не сети: обратный прокси стоит на фиксированном
 * адресе, а разбор CIDR ради этого добавил бы разбору ещё один способ ошибиться.
 */
import { isIP } from 'node:net';

/** Максимальная длина адреса: полный IPv6 — 45 знаков, всё длиннее не адрес. */
export const MAX_ADDRESS_LENGTH = 45;

/**
 * Ключ для запросов, у которых адрес не разобрался. Общее ведро намеренно: без
 * него неизвестный адрес обходил бы счётчик вовсе.
 */
export const UNKNOWN_ADDRESS = 'unknown';

/** Кому верим по умолчанию: обратный прокси стоит на той же машине. */
export const DEFAULT_TRUSTED_PROXIES: readonly string[] = ['127.0.0.1', '::1'];

/**
 * Длина цепочки `X-Forwarded-For`, дальше которой разбирать нечего. Заголовок
 * приходит снаружи, и без предела он служит способом занять процессор.
 */
const MAX_FORWARDED_HOPS = 32;

const IPV4_MAPPED_PREFIX = '::ffff:';

/**
 * Приводит адрес к виду, в котором он сравнивается со списком доверенных и
 * ложится в ключ счётчика. `undefined` — «это не адрес»: пустая строка, обрывок
 * скобочной записи или строка длиннее любого IPv6.
 */
export function normalizeAddress(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let address = value.trim().toLowerCase();

  if (address.startsWith('[')) {
    // Скобочная запись IPv6, возможно с портом: `[::1]:5173`.
    const end = address.indexOf(']');
    if (end < 0) return undefined;
    address = address.slice(1, end);
  } else if (address.split(':').length === 2) {
    // Ровно одно двоеточие — это `адрес:порт` IPv4: у голого IPv6 их больше.
    address = address.slice(0, address.indexOf(':'));
  }

  // Зона интерфейса (`fe80::1%en0`) к адресу не относится и в ключ не идёт.
  const zone = address.indexOf('%');
  if (zone >= 0) address = address.slice(0, zone);

  // `::ffff:127.0.0.1` и `127.0.0.1` — один адрес, и в списке доверенных он
  // должен совпадать независимо от того, каким сокет его показал.
  if (address.startsWith(IPV4_MAPPED_PREFIX) && address.includes('.')) {
    address = address.slice(IPV4_MAPPED_PREFIX.length);
  }

  if (address.length === 0 || address.length > MAX_ADDRESS_LENGTH) return undefined;
  // Вид адреса проверяет `isIP`, а не своя регулярка: ключом счётчика и записью
  // в списке доверенных обязан быть адрес, а не любая присланная строка.
  return isIP(address) === 0 ? undefined : address;
}

/**
 * Читает список доверенных прокси из настройки. Незаданная переменная — это
 * умолчание, а **заданная пустой** — сознательное «не верить никому»: `??` ловит
 * только первое, и пустая строка не должна означать «как по умолчанию».
 */
export function readTrustedProxies(value: string | undefined): Set<string> {
  if (value === undefined) return new Set(DEFAULT_TRUSTED_PROXIES);
  const trusted = new Set<string>();
  for (const part of value.split(/[\s,]+/u)) {
    const address = normalizeAddress(part);
    if (address !== undefined) trusted.add(address);
  }
  return trusted;
}

export interface ClientAddressOptions {
  /** Адрес того, кто открыл соединение. У Fastify это `request.socket.remoteAddress`. */
  socketAddress: string | undefined;
  /** Значение `X-Forwarded-For` в том виде, в каком его прислали. */
  forwardedFor?: string | undefined;
  trusted: Set<string>;
}

/**
 * Определяет адрес клиента. Заголовок читается только тогда, когда соединение
 * пришло от доверенного адреса, и цепочка разбирается справа налево: слева
 * лежит то, что дописал сам клиент, и верить туда нельзя ни при каком прокси.
 */
export function clientAddress(options: ClientAddressOptions): string {
  const socket = normalizeAddress(options.socketAddress);
  if (socket === undefined) return UNKNOWN_ADDRESS;
  if (!options.trusted.has(socket)) return socket;

  const chain = (options.forwardedFor ?? '').split(',').slice(0, MAX_FORWARDED_HOPS);
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const part = chain[index] ?? '';
    if (part.trim().length === 0) continue;
    const candidate = normalizeAddress(part);
    // Неразобранный шаг обрывает разбор: пропустив его, мы взяли бы адрес левее,
    // а левую часть цепочки пишет сам клиент.
    if (candidate === undefined) return socket;
    // Доверенный шаг пропускаем и идём дальше влево: цепочка прокси может быть
    // длиннее одного, а первый недоверенный справа и есть клиент.
    if (!options.trusted.has(candidate)) return candidate;
  }
  return socket;
}
