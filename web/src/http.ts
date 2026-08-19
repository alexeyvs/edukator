export interface HttpFailure {
  status: number;
  message: string;
  code?: string;
}

/** Текст на случай, когда сервер закрыл доступ молча, без своего объяснения. */
export const SIGNED_OUT_MESSAGE = 'Нужно войти';

/**
 * Отказ по отсутствующей сессии. Отдельный класс, а не обычная `Error`, потому
 * что 401 для экрана — не «не удалось загрузить»: данные в порядке, вошедшего
 * нет. Без этого различия каждый экран показывал бы свой fallback («не
 * получилось загрузить сводку»), и вошедший заново читал бы его как поломку
 * сервера.
 */
export class SignedOutError extends Error {
  readonly status = 401;

  constructor(message: string = SIGNED_OUT_MESSAGE) {
    super(message);
    this.name = 'SignedOutError';
  }
}

/**
 * Отказ, у которого сохранён код. Экрану одноразовой ссылки нужно отличать
 * «ссылку уже погасили» (404 — новая, повторять нечего) от «запрос не доехал»
 * (обрыв сети, 503 неготового сервера): в первом случае просить новую ссылку
 * правильно, во втором — это совет выбросить работающую одноразовую ссылку,
 * которую сервер не тронул.
 */
export class HttpError extends Error {
  readonly status: number;

  readonly code: string | undefined;

  constructor(failure: HttpFailure) {
    super(failure.message);
    this.name = 'HttpError';
    this.status = failure.status;
    this.code = failure.code;
  }
}

type SignedOutListener = () => void;

const signedOutListeners = new Set<SignedOutListener>();

/**
 * Подписка на потерю сессии. Слушателя ставит корень приложения: сессия
 * кончается посреди любого экрана, а решение «показать вход» принимается один
 * раз и наверху — экран, который сам решает, что делать с 401, разъедется с
 * соседним.
 */
export function onSignedOut(listener: SignedOutListener): () => void {
  signedOutListeners.add(listener);
  return () => { signedOutListeners.delete(listener); };
}

export interface RequestPolicy {
  /**
   * Значит ли 401 «сессии нет». По умолчанию да, но у входа и у проверки PIN
   * тем же кодом отвечает неподошедший секрет: выход из учётной записи по
   * опечатке в PIN выкидывал бы родителя со сводки на каждой второй попытке, а
   * на форме входа — гасил бы текст «неверный адрес или пароль».
   */
  signedOutOn401?: boolean;
}

/** Тело отказа, если оно вообще JSON. Не-JSON — не поломка клиента, а чужой ответ. */
async function readErrorBody(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    return undefined;
  }
}

/** Общий разбор JSON и безопасной ошибки для всех browser API. */
export async function requestJson<T>(
  url: string,
  init: RequestInit | undefined,
  fallback: string,
  errorFactory: (failure: HttpFailure) => Error = ({ message }) => new Error(message),
  policy: RequestPolicy = {},
): Promise<T> {
  const response = init === undefined ? await fetch(url) : await fetch(url, init);
  if (!response.ok) {
    // Тело отказа разбирается защищённо: отказать мог не сервер. Обратный прокси
    // отвечает 401 и 502 страницей HTML, и `json()` бросал бы на ней
    // `SyntaxError` раньше, чем разбор дошёл бы до `SignedOutError`, — то есть
    // кончившаяся сессия за прокси показывала бы «не удалось загрузить» вместо
    // экрана входа. Удачный ответ, наоборот, обязан быть JSON: там не-JSON
    // означает не чужой ответ, а разъехавшийся контракт.
    const body = await readErrorBody(response);
    const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
    const serverMessage = typeof record['error'] === 'string' ? record['error'] : undefined;
    const code = typeof record['code'] === 'string' ? record['code'] : undefined;
    if (response.status === 401 && policy.signedOutOn401 !== false) {
      for (const listener of [...signedOutListeners]) listener();
      throw new SignedOutError(serverMessage ?? SIGNED_OUT_MESSAGE);
    }
    throw errorFactory({
      status: response.status,
      message: serverMessage ?? fallback,
      ...(code === undefined ? {} : { code }),
    });
  }
  try {
    return await response.json() as T;
  } catch {
    // Удачный ответ обязан быть JSON: не-JSON здесь означает не чужой ответ, а
    // разъехавшийся контракт. Но `SyntaxError` браузера — строка на языке
    // браузера («Unexpected end of JSON input»), а вызывающие рисуют
    // `error.message` как есть, и вместо русского объяснения операции ученик
    // видел бы английский текст разборщика.
    throw errorFactory({ status: response.status, message: fallback });
  }
}

export function jsonRequest(method: 'POST' | 'PUT', body?: unknown): RequestInit {
  return {
    method,
    ...(body === undefined ? {} : {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  };
}
