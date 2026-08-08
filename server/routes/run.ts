/**
 * HTTP-обвязка забега. Выбор тем, подсчёт итога и прогноза
 * живут в доменных модулях; здесь только граница HTTP.
 */
import type { Database } from 'better-sqlite3';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TopicGraph } from '../curriculum.js';
import { SUBJECTS, type Subject } from '../db.js';
import { forecastFor } from '../forecast.js';
import { readTopicStates } from '../mastery.js';
import { finishRun, startRun } from '../run.js';
import { planFromDatabase } from '../scheduler.js';
import { SessionError } from '../session-error.js';

/** День состоит из 2–3 забегов; главный экран показывает верхние три. */
export const DAILY_RUNS = 3;

export interface RunRoutesOptions {
  db: Database;
  graph: TopicGraph;
  now?: () => Date;
  /** Соединение всё ещё привязано к текущему файлу базы. */
  available?: () => boolean;
}

function triagedSubjects(db: Database): Set<Subject> {
  return new Set(
    db.prepare<[], { subject: Subject }>(
      `SELECT DISTINCT subject FROM runs
        WHERE kind = 'triage' AND finished_at IS NOT NULL`,
    ).all().map((row) => row.subject),
  );
}

class BadRequest extends Error {}

function unavailable(options: RunRoutesOptions, reply: FastifyReply): FastifyReply | undefined {
  if (options.available?.() !== false) return undefined;
  return reply.code(503).send({ error: 'Забег недоступен: файл базы заменён, нужен перезапуск' });
}

function fail(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof BadRequest) return reply.code(400).send({ error: error.message });
  if (error instanceof SessionError) {
    const status = error.code === 'run-not-found' ? 404 : 409;
    return reply.code(status).send({ error: error.message, code: error.code });
  }
  throw error;
}

function readSubject(body: unknown): Subject {
  const value = typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)['subject']
    : undefined;
  if (typeof value !== 'string' || !SUBJECTS.includes(value as Subject)) {
    throw new BadRequest(`Поле subject должно быть одним из: ${SUBJECTS.join(', ')}`);
  }
  return value as Subject;
}

function readPathId(value: string): number {
  if (!/^\d+$/.test(value)) throw new BadRequest('Идентификатор забега должен быть положительным целым');
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new BadRequest('Идентификатор забега должен быть положительным целым');
  }
  return id;
}

/** Регистрирует план, старт и финиш обычного забега. */
export function registerRunRoutes(app: FastifyInstance, options: RunRoutesOptions): void {
  const { db, graph } = options;
  const now = options.now ?? ((): Date => new Date());

  app.get('/api/run/plan', (_request, reply) => {
    const stopped = unavailable(options, reply);
    if (stopped !== undefined) return stopped;

    const at = now();
    const triaged = triagedSubjects(db);
    const plan = planFromDatabase(db, graph, DAILY_RUNS, at).map((item) => ({
      subject: item.subject,
      topic: { id: item.topic.id, title: item.topic.title },
      priority: item.priority,
      triagePassed: triaged.has(item.subject),
    }));
    const states = readTopicStates(db);
    const forecasts = SUBJECTS.flatMap((subject) => {
      const forecast = forecastFor(graph, states, subject, at);
      return forecast === null ? [] : [forecast];
    });
    const triage = SUBJECTS.map((subject) => ({
      subject,
      passed: triaged.has(subject),
    }));

    return reply.send({ plan, forecasts, triage });
  });

  app.post('/api/run/start', (request, reply) => {
    const stopped = unavailable(options, reply);
    if (stopped !== undefined) return stopped;
    try {
      return reply.send(startRun(db, graph, readSubject(request.body), { now: now() }));
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/api/run/:id/finish', (request, reply) => {
    const stopped = unavailable(options, reply);
    if (stopped !== undefined) return stopped;
    try {
      return reply.send(finishRun(db, graph, readPathId(request.params.id), { now: now() }));
    } catch (error) {
      return fail(reply, error);
    }
  });
}

/** Явные 503 на рабочих URL, если карта или база не поднялись. */
export function registerUnavailableRun(app: FastifyInstance, reason: string): void {
  const handler = (_request: unknown, reply: FastifyReply): FastifyReply =>
    reply.code(503).send({ error: `Забег недоступен: ${reason}` });

  app.get('/api/run/plan', handler);
  app.post('/api/run/start', handler);
  app.post('/api/run/:id/finish', handler);
}
