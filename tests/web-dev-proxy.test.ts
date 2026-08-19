import { describe, expect, it } from 'vitest';
import type { ProxyOptions, UserConfig } from 'vite';
import { isSameOrigin } from '../server/auth.js';
import viteConfig from '../web/vite.config.js';

/**
 * Прокси Vite и проверка источника — одно правило, разложенное по двум файлам:
 * дев-сервер отдаёт страницу с `:5173`, а `/api` уносит на `:3000`, и то, каким
 * доедет `Host`, решает, пройдёт ли изменяющий запрос `isSameOrigin`. Поэтому
 * настройка проверяется не «как записана», а тем, что из неё получается.
 */
function apiProxy(): ProxyOptions {
  const config = viteConfig as UserConfig;
  const proxy = config.server?.proxy?.['/api'];
  if (typeof proxy !== 'object') {
    throw new Error('Прокси /api записан строкой: Vite сам включит changeOrigin');
  }
  return proxy;
}

/** Заголовки, с которыми запрос от страницы `:5173` доедет до сервера через прокси. */
function proxiedHeaders(proxy: ProxyOptions): Record<string, string> {
  const target = new URL(String(proxy.target));
  return {
    origin: 'http://localhost:5173',
    host: proxy.changeOrigin === true ? target.host : 'localhost:5173',
    'sec-fetch-site': 'same-origin',
  };
}

describe('дев-прокси Vite', () => {
  it('оставляет Host страницы, иначе изменяющий запрос в dev получает 403', () => {
    expect(isSameOrigin(proxiedHeaders(apiProxy()))).toBe(true);
  });

  it('ведёт на порт сервера', () => {
    expect(apiProxy().target).toBe('http://localhost:3000');
  });
});
