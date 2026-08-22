/**
 * Первый замок захода на собранном сервере.
 *
 * Проверяется не сам отказ (это `tests/family-routes.test.ts` и
 * `tests/auth-routes.test.ts` на своих Fastify), а **разводка**: оба места, где
 * замок выписан руками, обязаны получить от `buildServer` один и тот же
 * счётчик — тот, чьё число уезжает в запись о конце захода. Аренды у этих
 * маршрутов нет, общая матрица допуска их не видит, и забытый на сборке
 * счётчик не роняет ничего: заход просто оставляет в ленте «отказов записи: 0»
 * после того, как оператор весь свой срок пробовал писать в чужую семью.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listAdminAudit, startImpersonation } from '../server/control-db.js';
import { ADMIN_COOKIE, IMPERSONATION_COOKIE } from '../server/auth.js';
import {
  createAdminAccount,
  HARNESS_PASSWORD,
  SAME_ORIGIN,
  signInAdmin,
  startTenantServer,
  type TenantServer,
} from './server-harness.js';

describe('разводка первого замка захода', () => {
  let dir: string;
  let server: TenantServer;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'edukator-impersonation-wiring-'));
    server = await startTenantServer({ dataDir: dir });
  });

  afterEach(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('считает отказы и семьи, и смены пароля — одним счётчиком', async () => {
    const admin = createAdminAccount(server.control);
    const session = signInAdmin(server.control, admin);
    const started = startImpersonation(
      server.control,
      { adminId: admin.adminId, childId: server.childId, role: 'parent' },
    );
    if (!started.ok) throw new Error(`заход не начался: ${started.reason}`);
    const carried = {
      cookie: `${IMPERSONATION_COOKIE}=${started.session.token}`,
      'sec-fetch-site': SAME_ORIGIN,
    };

    // Состав семьи и пароль лежат в `control.db`, куда `PRAGMA query_only`
    // второго замка не достаёт вовсе: держит их только этот замок.
    const child = await server.app.inject({
      method: 'POST',
      url: '/api/family/children',
      headers: carried,
      payload: { name: 'Подложенный' },
    });
    const password = await server.app.inject({
      method: 'POST',
      url: '/api/auth/parent/password',
      headers: carried,
      payload: { current: HARNESS_PASSWORD, next: 'совсем-другой-пароль' },
    });

    expect(child.statusCode).toBe(403);
    expect(password.statusCode).toBe(403);
    expect((password.json() as { code: string }).code).toBe('read-only');

    const left = await server.app.inject({
      method: 'DELETE',
      url: '/api/admin/impersonate',
      headers: {
        cookie: `${ADMIN_COOKIE}=${session.token}; ${IMPERSONATION_COOKIE}=${started.session.token}`,
        'sec-fetch-site': SAME_ORIGIN,
      },
    });
    expect(left.statusCode).toBe(200);

    // Оба отказа доехали до одного счётчика: разъехавшись, они дали бы единицу
    // вместо двойки, и по ленте было бы не видно, что оператор пробовал ещё и
    // сменить пароль чужой семьи.
    const end = listAdminAudit(server.control, { limit: 10 }).entries
      .find((entry) => entry.action === 'impersonation-end');
    expect(end?.detail).toBe('parent, отказов записи: 2');
  });
});
