/** Родительское управление списком школьных тем конкретного ребёнка. */
import type { Database } from 'better-sqlite3';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { codexConcurrency, type CodexConcurrency } from '../codex/concurrency.js';
import type { CodexRunner } from '../codex/client.js';
import {
  cancelDailyTopics, confirmDailyTopics, dailyTopicSets, DailyTopicError,
  type DailyTopicInput,
} from '../daily-topics.js';
import { previewDailyTopics } from '../daily-topic-preview.js';
import { failAuth, type TenantContextResolver } from './tenant-context.js';

export interface DailyTopicRoutesOptions {
  context: TenantContextResolver;
  control: Database;
  now?: () => Date;
  run?: CodexRunner;
  budget?: CodexConcurrency;
  prepare?: (childId: string) => Promise<void>;
  log?: (message: string) => void;
}

function bodyObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new DailyTopicError('Ожидается объект с темами');
  }
  return body as Record<string, unknown>;
}

function readConfirmation(body: unknown): {
  sourceText: string; requestKey: string; items: DailyTopicInput[];
} {
  const fields = bodyObject(body);
  if (typeof fields['sourceText'] !== 'string' || typeof fields['requestKey'] !== 'string' ||
    !Array.isArray(fields['items'])) throw new DailyTopicError('Неверный список тем');
  const items: DailyTopicInput[] = fields['items'].map((raw: unknown) => {
    const item = bodyObject(raw);
    if (typeof item['title'] !== 'string' || typeof item['subjectTitle'] !== 'string' ||
      !(item['subjectId'] === null || typeof item['subjectId'] === 'string') ||
      !(item['topicId'] === null || typeof item['topicId'] === 'string')) {
      throw new DailyTopicError('Неверный пункт списка тем');
    }
    return {
      title: item['title'],
      subjectId: item['subjectId'] as string | null,
      subjectTitle: item['subjectTitle'],
      topicId: item['topicId'] as string | null,
    };
  });
  return { sourceText: fields['sourceText'], requestKey: fields['requestKey'], items };
}

function fail(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof DailyTopicError) return reply.code(400).send({ error: error.message });
  return failAuth(reply, error);
}

export function registerDailyTopicRoutes(app: FastifyInstance, options: DailyTopicRoutesOptions): void {
  const now = options.now ?? ((): Date => new Date());
  const budget = options.budget ?? codexConcurrency;

  app.get<{ Params: { childId: string } }>('/api/family/children/:childId/daily-topics', (request, reply) => {
    try {
      const { tenant } = options.context(request, { allow: ['parent'], childId: request.params.childId });
      if (!tenant.available()) return reply.code(503).send({ error: 'База ребёнка недоступна' });
      return reply.send(dailyTopicSets(tenant.db, now()));
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post<{ Params: { childId: string } }>('/api/family/children/:childId/daily-topics/preview', async (request, reply) => {
    try {
      const { tenant } = options.context(request, { allow: ['parent'], childId: request.params.childId });
      if (!tenant.available()) return reply.code(503).send({ error: 'База ребёнка недоступна' });
      const raw = bodyObject(request.body)['text'];
      if (typeof raw !== 'string') throw new DailyTopicError('Нужен текст тем');
      let items: DailyTopicInput[];
      try {
        items = await budget.run(() => previewDailyTopics(raw, tenant.curriculum.graph, {
          ...(options.run === undefined ? {} : { run: options.run }),
        }));
      } catch (error) {
        if (error instanceof DailyTopicError) throw error;
        return reply.code(503).send({ error: 'Не удалось разобрать темы. Повторите попытку позже.' });
      }
      return reply.send({ items });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.put<{ Params: { childId: string } }>('/api/family/children/:childId/daily-topics', (request, reply) => {
    try {
      const { tenant, child } = options.context(request, {
        allow: ['parent'], childId: request.params.childId,
      });
      if (!tenant.available()) return reply.code(503).send({ error: 'База ребёнка недоступна' });
      const set = confirmDailyTopics(
        tenant.db, tenant.curriculum.graph, readConfirmation(request.body), now(),
      );
      options.control.prepare('UPDATE children SET last_activity_at = ? WHERE id = ?')
        .run(now().toISOString(), child.id);
      void options.prepare?.(child.id).catch((error: unknown) =>
        options.log?.(`подготовка дневных тем: ${error instanceof Error ? error.message : String(error)}`));
      return reply.code(202).send({ set });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post<{ Params: { childId: string } }>('/api/family/children/:childId/daily-topics/retry', (request, reply) => {
    try {
      const { tenant, child } = options.context(request, { allow: ['parent'], childId: request.params.childId });
      if (!tenant.available()) return reply.code(503).send({ error: 'База ребёнка недоступна' });
      const pending = dailyTopicSets(tenant.db, now()).preparing;
      if (pending === null) throw new DailyTopicError('Нечего повторять');
      tenant.db.prepare(
        `UPDATE daily_topic_items SET status = 'preparing', material_id = NULL, last_error = NULL
          WHERE set_id = ? AND status = 'error'`,
      ).run(pending.id);
      options.control.prepare('UPDATE children SET last_activity_at = ? WHERE id = ?')
        .run(now().toISOString(), child.id);
      void options.prepare?.(child.id).catch((error: unknown) =>
        options.log?.(`повтор подготовки дневных тем: ${error instanceof Error ? error.message : String(error)}`));
      return reply.send(dailyTopicSets(tenant.db, now()));
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.delete<{ Params: { childId: string } }>('/api/family/children/:childId/daily-topics', (request, reply) => {
    try {
      const { tenant } = options.context(request, { allow: ['parent'], childId: request.params.childId });
      if (!tenant.available()) return reply.code(503).send({ error: 'База ребёнка недоступна' });
      cancelDailyTopics(tenant.db, now());
      return reply.send(dailyTopicSets(tenant.db, now()));
    } catch (error) {
      return fail(reply, error);
    }
  });
}

export function registerUnavailableDailyTopics(app: FastifyInstance, reason: string): void {
  const send = (_request: unknown, reply: FastifyReply): FastifyReply =>
    reply.code(503).send({ error: `Темы на день недоступны: ${reason}` });
  app.get('/api/family/children/:childId/daily-topics', send);
  app.post('/api/family/children/:childId/daily-topics/preview', send);
  app.put('/api/family/children/:childId/daily-topics', send);
  app.post('/api/family/children/:childId/daily-topics/retry', send);
  app.delete('/api/family/children/:childId/daily-topics', send);
}
