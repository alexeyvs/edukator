/** HTTP-граница боя с боссом; правила переходов живут в `boss.ts`. */
import type { Database } from 'better-sqlite3';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TopicGraph } from '../curriculum.js';
import {
  BossError,
  bossTopicState,
  concedeBoss,
  nextBossTask,
  startBoss,
  submitBossAnswer,
  type BossErrorCode,
} from '../boss.js';
import { MAX_ANSWER_LENGTH } from '../codex/prompt.js';
import { issuedTaskJson } from './task-json.js';

export interface BossRoutesOptions {
  db: Database;
  graph: TopicGraph;
  now?: () => Date;
  available?: () => boolean;
}

class BadRequest extends Error {}

const STATUS_BY_CODE: Record<BossErrorCode, number> = {
  'boss-not-found': 404,
  'boss-hint-forbidden': 400,
  'boss-not-eligible': 409,
  'boss-closed': 409,
  'boss-not-ready': 409,
  'boss-finished': 409,
  'boss-inconsistent': 409,
  'boss-wrong-task': 409,
  'boss-mistake-pending': 409,
  'boss-dispute-open': 409,
  'boss-complete': 409,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readId(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new BadRequest(`${label} должен быть положительным целым числом`);
  }
  return value;
}

function readPathId(value: string): number {
  if (!/^\d+$/.test(value)) throw new BadRequest('Идентификатор боя должен быть положительным целым числом');
  return readId(Number(value), 'Идентификатор боя');
}

function readTopicId(body: unknown): string {
  const value = isObject(body) ? body['topic_id'] : undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    throw new BadRequest('Поле topic_id должно быть непустой строкой');
  }
  return value;
}

function fail(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof BadRequest) return reply.code(400).send({ error: error.message });
  if (error instanceof BossError) {
    return reply.code(STATUS_BY_CODE[error.code]).send({ error: error.message, code: error.code });
  }
  throw error;
}

function unavailable(options: BossRoutesOptions, reply: FastifyReply): FastifyReply | undefined {
  if (options.available?.() !== false) return undefined;
  return reply.code(503).send({ error: 'Босс недоступен: файл базы заменён, нужен перезапуск' });
}

export function registerBossRoutes(app: FastifyInstance, options: BossRoutesOptions): void {
  const { db, graph } = options;
  const now = options.now ?? ((): Date => new Date());

  app.get('/api/boss/topics', (_request, reply) => {
    const stopped = unavailable(options, reply);
    if (stopped !== undefined) return stopped;
    return reply.send({
      topics: graph.order.map((topic) => ({
        id: topic.id,
        title: topic.title,
        subject: topic.subject,
        readiness: bossTopicState(db, topic.id),
      })),
    });
  });

  app.post('/api/boss/start', (request, reply) => {
    const stopped = unavailable(options, reply);
    if (stopped !== undefined) return stopped;
    try {
      return reply.send(startBoss(db, graph, readTopicId(request.body), { now: now() }));
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>('/api/boss/:id/next', (request, reply) => {
    const stopped = unavailable(options, reply);
    if (stopped !== undefined) return stopped;
    try {
      const result = nextBossTask(db, graph, readPathId(request.params.id));
      return reply.send({ ...result, task: issuedTaskJson(result.task, false) });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/api/boss/:id/answer', (request, reply) => {
    const stopped = unavailable(options, reply);
    if (stopped !== undefined) return stopped;
    try {
      const body = request.body;
      if (!isObject(body)) throw new BadRequest('Тело ответа должно быть объектом');
      const answer = body['answer'];
      if (typeof answer !== 'string') throw new BadRequest('Поле answer должно быть строкой');
      if (answer.length > MAX_ANSWER_LENGTH) {
        throw new BadRequest(`Поле answer длиннее ${MAX_ANSWER_LENGTH} символов`);
      }
      const hintUsed = body['hint_used'];
      if (hintUsed !== undefined && typeof hintUsed !== 'boolean') {
        throw new BadRequest('Поле hint_used должно быть логическим');
      }
      const durationMs = body['duration_ms'];
      if (durationMs !== undefined &&
          (typeof durationMs !== 'number' || !Number.isSafeInteger(durationMs) || durationMs < 0)) {
        throw new BadRequest('Поле duration_ms должно быть целым числом миллисекунд не меньше 0');
      }
      return reply.send(submitBossAnswer(db, graph, {
        runId: readPathId(request.params.id),
        taskId: readId(body['task_id'], 'Поле task_id'),
        answer,
        at: now(),
        ...(hintUsed === undefined ? {} : { hintUsed }),
        ...(durationMs === undefined ? {} : { durationMs }),
      }));
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/api/boss/:id/concede', (request, reply) => {
    const stopped = unavailable(options, reply);
    if (stopped !== undefined) return stopped;
    try {
      return reply.send(concedeBoss(db, readPathId(request.params.id), { now: now() }));
    } catch (error) {
      return fail(reply, error);
    }
  });
}

export function registerUnavailableBoss(app: FastifyInstance, reason: string): void {
  const handler = (_request: unknown, reply: FastifyReply): FastifyReply =>
    reply.code(503).send({ error: `Босс недоступен: ${reason}` });
  app.get('/api/boss/topics', handler);
  app.post('/api/boss/start', handler);
  app.get('/api/boss/:id/next', handler);
  app.post('/api/boss/:id/answer', handler);
  app.post('/api/boss/:id/concede', handler);
}
