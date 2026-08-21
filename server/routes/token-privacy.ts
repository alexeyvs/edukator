/**
 * Адреса, в которых открытый токен лежит прямо в пути, и что с ними делать.
 *
 * Приглашение родителя и детская ссылка приходят единственным способом — ссылкой
 * вида `/join/<token>`. Такой адрес утекает тремя путями сразу: он попадает в
 * лог сервера, в заголовок `Referer` следующего запроса со страницы и в кэш
 * браузера или прокси. Поэтому список таких путей объявлен здесь один раз: и
 * подстановка `<token>` в тексте отказа, и заголовки ответа обязаны считать
 * «адресом с токеном» одно и то же — своя копия правила у логов и у заголовков
 * разъехалась бы молча, и следующий такой адрес защитили бы только наполовину.
 */
import type { FastifyInstance } from 'fastify';

/**
 * Начала путей, за которыми идёт открытый токен. Две пары: страницы, которые
 * открывает человек по ссылке, и маршруты погашения, куда с этих страниц уходит
 * сам токен. Страницы `/join/` и `/invite/` отдаёт статика (список
 * пользовательских адресов собирается в `buildServer`), но защита от утечки
 * нужна им ровно так же, как API.
 */
export const TOKEN_PATH_PREFIXES = [
  '/join/',
  '/invite/',
  '/api/auth/parent/invite/',
  '/api/auth/child/claim/',
] as const;

/** Чем заменяется токен в тексте, уходящем в stderr. */
export const TOKEN_PLACEHOLDER = '<token>';

/**
 * Заголовки приватности для таких ответов. `no-referrer` — чтобы токен не ушёл
 * третьей стороне следующим же запросом со страницы; `no-store` — чтобы ссылка
 * не осталась ни в кэше браузера, ни в общем кэше прокси, откуда её достанет
 * следующий пользователь того же компьютера.
 */
export const TOKEN_PRIVACY_HEADERS: Readonly<Record<string, string>> = {
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

/** Начало пути с токеном, которому отвечает адрес, либо `undefined`. */
function tokenPrefix(url: string): string | undefined {
  const queryAt = url.indexOf('?');
  const path = queryAt === -1 ? url : url.slice(0, queryAt);
  return TOKEN_PATH_PREFIXES.find(
    (prefix) => path.startsWith(prefix) && path.length > prefix.length,
  );
}

/** Несёт ли адрес открытый токен. */
export function isTokenPath(url: string): boolean {
  return tokenPrefix(url) !== undefined;
}

/**
 * Прячет токен в адресе. Вырезается весь остаток пути, а не один сегмент:
 * `/join/a/b` — такой же неизвестный нам текст, и оставить от него хоть что-то
 * значит оставить в логе часть секрета. Строка запроса сохраняется: токен живёт
 * не в ней, а по ней отличают один отказ от другого.
 */
export function redactTokenUrl(url: string): string {
  const prefix = tokenPrefix(url);
  if (prefix === undefined) return url;
  const queryAt = url.indexOf('?');
  const query = queryAt === -1 ? '' : url.slice(queryAt);
  return `${prefix}${TOKEN_PLACEHOLDER}${query}`;
}

/**
 * Вешает заголовки приватности на все ответы по адресам с токеном.
 *
 * Хук именно `onSend`, а не `onRequest`: страницы отдаёт `@fastify/static`,
 * который ставит свой `cache-control` уже после `onRequest`, и выставленный
 * раньше `no-store` он бы просто перебил.
 */
export function registerTokenPrivacy(app: FastifyInstance): void {
  app.addHook('onSend', (request, reply, payload, done) => {
    if (isTokenPath(request.url)) {
      for (const [name, value] of Object.entries(TOKEN_PRIVACY_HEADERS)) {
        reply.header(name, value);
      }
    }
    done(null, payload);
  });
}

/**
 * Начала путей с токеном, собранные в одно чередование для поиска внутри
 * произвольного текста.
 */
const TOKEN_TEXT_PATTERN = new RegExp(
  `(${TOKEN_PATH_PREFIXES.map((prefix) => prefix.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join(
    '|',
  )})\\S+`,
  'gu',
);

/** Знаки, которыми кончается предложение, а не токен. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}»"']*$/u;

/**
 * Прячет токен всюду, где он встретился в тексте.
 *
 * `redactTokenUrl` берёт адрес целиком и потому умеет сохранить строку запроса;
 * здесь адрес лежит внутри фразы («не удалось погасить /join/<токен>: причина»),
 * и отличить `?` запроса от `?` предложения нечем — поэтому съедается весь
 * непробельный остаток. Хвостовая пунктуация возвращается: она заведомо не часть
 * токена, а без неё фраза в журнале теряет вид.
 *
 * Список начал — тот же `TOKEN_PATH_PREFIXES`: своя копия у журнала разъехалась
 * бы с заголовками ответа молча, и следующий адрес с секретом защитили бы
 * только наполовину.
 */
export function redactTokenText(text: string): string {
  return text.replace(TOKEN_TEXT_PATTERN, (match: string, prefix: string) => {
    const tail = match.slice(prefix.length);
    const punctuation = TRAILING_PUNCTUATION.exec(tail)?.[0] ?? '';
    return `${prefix}${TOKEN_PLACEHOLDER}${punctuation}`;
  });
}
