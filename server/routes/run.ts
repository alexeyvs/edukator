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
import { readStreak } from '../streak.js';
import { bossTopicState } from '../boss.js';
import { learningMaterialCards } from '../learning.js';
import { readDailyGate } from '../daily-gate.js';
import { moscowDayBounds } from '../moscow-time.js';

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
        WHERE kind = 'triage' AND finished_at IS NOT NULL AND summary IS NOT NULL`,
    ).all().map((row) => row.subject),
  );
}

class BadRequest extends Error {}

interface ActiveRunCard {
  subject: Subject;
  topic: { id: string; title: string };
  priority: number;
  triagePassed: boolean;
  active: true;
}

function activeRunCards(
  db: Database,
  graph: TopicGraph,
  triaged: ReadonlySet<Subject>,
  now: Date,
  limit: number,
): ActiveRunCard[] {
  if (limit <= 0) return [];
  const [start, next] = moscowDayBounds(now);
  return db.prepare<[string, string, number], { subject: Subject; topic_id: string }>(
    `SELECT subject, topic_id FROM runs
      WHERE kind = 'run' AND finished_at IS NULL
        AND started_at >= ? AND started_at < ?
        AND EXISTS (
          SELECT 1 FROM topic_state
           WHERE topic_state.topic_id = runs.topic_id AND topic_state.closed_at IS NULL
        )
      ORDER BY started_at DESC, id DESC LIMIT ?`,
  ).all(start, next, limit).flatMap((row) => {
    const topic = graph.byId.get(row.topic_id);
    if (topic === undefined || topic.subject !== row.subject) return [];
    return [{
      subject: row.subject,
      topic: { id: topic.id, title: topic.title },
      priority: 0,
      triagePassed: triaged.has(row.subject),
      active: true as const,
    }];
  });
}

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

function readStart(body: unknown): { subject: Subject; topicId?: string } {
  const value = typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)['subject']
    : undefined;
  if (typeof value !== 'string' || !SUBJECTS.includes(value as Subject)) {
    throw new BadRequest(`Поле subject должно быть одним из: ${SUBJECTS.join(', ')}`);
  }
  const topicId = (body as Record<string, unknown>)['topic_id'];
  if (topicId !== undefined && (typeof topicId !== 'string' || topicId.length === 0)) {
    throw new BadRequest('Поле topic_id должно быть непустой строкой');
  }
  return { subject: value as Subject, ...(topicId === undefined ? {} : { topicId }) };
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
    const gate = readDailyGate(db, at);
    const active = activeRunCards(db, graph, triaged, at, gate.remaining);
    const planned = planFromDatabase(db, graph, gate.remaining - active.length, at).map((item) => ({
      subject: item.subject,
      topic: { id: item.topic.id, title: item.topic.title },
      priority: item.priority,
      triagePassed: triaged.has(item.subject),
    }));
    const plan = [...active, ...planned];
    const states = readTopicStates(db);
    const forecasts = SUBJECTS.flatMap((subject) => {
      const forecast = forecastFor(graph, states, subject, at);
      return forecast === null ? [] : [forecast];
    });
    const triage = SUBJECTS.map((subject) => ({
      subject,
      passed: triaged.has(subject),
    }));

    const topics = graph.order.map((topic) => ({
      id: topic.id,
      title: topic.title,
      subject: topic.subject,
      readiness: bossTopicState(db, topic.id),
    }));

    const learning = learningMaterialCards(db).map((material) => {
      const topic = graph.byId.get(material.topicId);
      if (topic === undefined || topic.subject !== material.subject) {
        throw new Error(`План: тема материала «${material.topicId}» не согласована с предметом`);
      }
      return {
        id: material.id,
        subject: material.subject,
        topic: { id: topic.id, title: topic.title },
        recommendationReason: material.recommendationReason,
        estimatedMinutes: material.estimatedMinutes,
        status: material.status,
      };
    });

    return reply.send({
      plan,
      learning,
      forecasts,
      triage,
      streak: readStreak(db, at),
      topics,
      gate,
    });
  });

  app.post('/api/run/start', (request, reply) => {
    const stopped = unavailable(options, reply);
    if (stopped !== undefined) return stopped;
    try {
      const start = readStart(request.body);
      return reply.send(startRun(db, graph, start.subject, {
        now: now(),
        ...(start.topicId === undefined ? {} : { topicId: start.topicId }),
      }));
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
