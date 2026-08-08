export interface HttpFailure {
  status: number;
  message: string;
  code?: string;
}

/** Общий разбор JSON и безопасной ошибки для всех browser API. */
export async function requestJson<T>(
  url: string,
  init: RequestInit | undefined,
  fallback: string,
  errorFactory: (failure: HttpFailure) => Error = ({ message }) => new Error(message),
): Promise<T> {
  const response = init === undefined ? await fetch(url) : await fetch(url, init);
  const body = await response.json() as unknown;
  if (!response.ok) {
    const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
    const message = typeof record['error'] === 'string' ? record['error'] : fallback;
    const code = typeof record['code'] === 'string' ? record['code'] : undefined;
    throw errorFactory({ status: response.status, message, ...(code === undefined ? {} : { code }) });
  }
  return body as T;
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
