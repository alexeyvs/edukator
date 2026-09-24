import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import { AuthError } from '../server/auth.js';
import { openDatabase } from '../server/db.js';
import { registerDailyTopicRoutes, registerUnavailableDailyTopics } from '../server/routes/daily-topics.js';
import type { TenantContext } from '../server/routes/tenant-context.js';
import { fakeTenant, FAKE_CHILD_ID } from './tenant-context-helper.js';

const at = new Date('2026-09-23T10:00:00.000Z');
const base = `/api/family/children/${FAKE_CHILD_ID}/daily-topics`;

describe('родительский API тем на день', () => {
  let dir: string;
  let db: Database;
  let app: FastifyInstance;
  let bearer: 'parent' | 'browser';
  let available: boolean;
  let modelFails: boolean;
  const prepare = vi.fn(async () => undefined);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'edukator-daily-routes-'));
    db = openDatabase(join(dir, 'child.db'));
    available = true;
    modelFails = false;
    prepare.mockClear();
    const tenant = fakeTenant(db, { available: () => available });
    bearer = 'parent';
    app = Fastify();
    registerDailyTopicRoutes(app, {
      context: (_request, options) => {
        if (bearer !== 'parent' || options.childId !== FAKE_CHILD_ID) {
          throw new AuthError('forbidden', 'Нет доступа');
        }
        return { tenant, child: { id: FAKE_CHILD_ID } } as TenantContext;
      },
      control: { prepare: () => ({ run: () => undefined }) } as unknown as Database,
      now: () => at,
      prepare,
      run: async () => {
        if (modelFails) throw new Error('Модель недоступна');
        return JSON.stringify({ items: [
          { index: 0, title: 'Проценты', subject_id: 'math', subject_title: 'Математика', topic_id: null },
        ] });
      },
    });
    await app.ready();
  });
  afterEach(async () => { await app.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

  it('даёт предпросмотр, подтверждение, состояние, повтор ошибки и отмену', async () => {
    const preview = await app.inject({ method: 'POST', url: `${base}/preview`, payload: { text: 'Проценты' } });
    expect(preview.statusCode).toBe(200);
    const items = preview.json().items;
    expect(items).toMatchObject([{ title: 'Проценты', subjectId: 'math', topicId: null }]);
    const confirmed = await app.inject({ method: 'PUT', url: base, payload: {
      sourceText: 'Проценты', requestKey: 'request-1', items,
    } });
    expect(confirmed.statusCode).toBe(202);
    expect(prepare).toHaveBeenCalledWith(FAKE_CHILD_ID);
    expect((await app.inject({ method: 'GET', url: base })).json().preparing.items).toHaveLength(1);
    const itemId = confirmed.json().set.items[0].id;
    db.prepare("UPDATE daily_topic_items SET status = 'error', last_error = 'Сбой' WHERE id = ?").run(itemId);
    expect((await app.inject({ method: 'POST', url: `${base}/retry` })).json().preparing.items[0].status)
      .toBe('preparing');
    expect(prepare).toHaveBeenCalledTimes(2);
    expect((await app.inject({ method: 'DELETE', url: base })).json()).toEqual({ active: null, preparing: null });
    expect((await app.inject({ method: 'POST', url: `${base}/retry` })).statusCode).toBe(400);
  });

  it('отвергает детскую сессию, чужого ребёнка и неверные данные', async () => {
    bearer = 'browser';
    expect((await app.inject({ method: 'GET', url: base })).statusCode).toBe(403);
    bearer = 'parent';
    expect((await app.inject({ method: 'GET', url: '/api/family/children/other/daily-topics' })).statusCode)
      .toBe(403);
    expect((await app.inject({ method: 'POST', url: `${base}/preview`, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: base, payload: { sourceText: 'x', requestKey: 'x', items: [{}] } })).statusCode)
      .toBe(400);
  });

  it('сообщает о недоступной модели и недоступной базе', async () => {
    modelFails = true;
    expect((await app.inject({ method: 'POST', url: `${base}/preview`, payload: { text: 'Проценты' } })).statusCode)
      .toBe(503);
    available = false;
    expect((await app.inject({ method: 'GET', url: base })).statusCode).toBe(503);
    expect((await app.inject({ method: 'POST', url: `${base}/preview`, payload: { text: 'Проценты' } })).statusCode)
      .toBe(503);
    expect((await app.inject({ method: 'PUT', url: base, payload: {} })).statusCode).toBe(503);
    expect((await app.inject({ method: 'POST', url: `${base}/retry` })).statusCode).toBe(503);
    expect((await app.inject({ method: 'DELETE', url: base })).statusCode).toBe(503);
    const own = Fastify();
    registerUnavailableDailyTopics(own, 'тест');
    await own.ready();
    try {
      expect((await own.inject({ method: 'GET', url: base })).statusCode).toBe(503);
      expect((await own.inject({ method: 'POST', url: `${base}/preview` })).statusCode).toBe(503);
      expect((await own.inject({ method: 'PUT', url: base })).statusCode).toBe(503);
      expect((await own.inject({ method: 'POST', url: `${base}/retry` })).statusCode).toBe(503);
      expect((await own.inject({ method: 'DELETE', url: base })).statusCode).toBe(503);
    } finally { await own.close(); }
  });
});
