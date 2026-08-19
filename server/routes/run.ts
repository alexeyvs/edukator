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
import { assertRunReadyForIntegrity, finishRun, runProgress, startRun, type RunProgress } from '../run.js';
import { planFromDatabase } from '../scheduler.js';
import { SessionError } from '../session-error.js';
import { readStreak } from '../streak.js';
import { bossTopicState } from '../boss.js';
import { bossProgress } from '../boss-rules.js';
import { learningMaterialCards } from '../learning.js';
import { readDailyGate } from '../daily-gate.js';
import { readSubjectCalibrations } from '../subject-calibration.js';
import {
  ROUTE_ACCESS,
  failAuth,
  type TenantContext,
  type TenantContextResolver,
} from './tenant-context.js';
import { integrityPublicJson } from './integrity.js';

export interface RunRoutesOptions {
  context: TenantContextResolver;
  graph: TopicGraph;
  now?: () => Date;
}

class BadRequest extends Error {}

interface ActiveRunCard {
  subject: Subject;
  topic: { id: string; title: string };
  priority: number;
  triagePassed: boolean;
  active: {
    runId: number;
    startedAt: string;
    progress: RunProgress;
  };
}

function activeRunCards(
  db: Database,
  graph: TopicGraph,
  triaged: ReadonlySet<Subject>,
): ActiveRunCard[] {
  return db.prepare<[], { id: number; subject: Subject; topic_id: string; started_at: string }>(
    `SELECT id, subject, topic_id, started_at FROM runs
      WHERE kind = 'run' AND finished_at IS NULL
        AND EXISTS (
          SELECT 1 FROM topic_state
           WHERE topic_state.topic_id = runs.topic_id AND topic_state.closed_at IS NULL
        )
      ORDER BY started_at DESC, id DESC`,
  ).all().flatMap((row) => {
    const topic = graph.byId.get(row.topic_id);
    if (topic === undefined || topic.subject !== row.subject) return [];
    return [{
      subject: row.subject,
      topic: { id: topic.id, title: topic.title },
      priority: 0,
      triagePassed: triaged.has(row.subject),
      active: {
        runId: row.id,
        startedAt: row.started_at,
        progress: runProgress(db, row.id),
      },
    }];
  });
}

function unavailable(context: TenantContext, reply: FastifyReply): FastifyReply | undefined {
  if (context.tenant.available()) return undefined;
  return reply.code(503).send({ error: 'Забег недоступен: файл базы заменён, нужен перезапуск' });
}

function fail(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof BadRequest) return reply.code(400).send({ error: error.message });
  if (error instanceof SessionError) {
    const status = error.code === 'run-not-found' ? 404 : 409;
    return reply.code(status).send({ error: error.message, code: error.code });
  }
  return failAuth(reply, error);
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

/** Тело плана: активные забеги, рекомендации, прогнозы и состояние тем. */
function planResponse(db: Database, graph: TopicGraph, at: Date): Record<string, unknown> {
  const calibrations = readSubjectCalibrations(db, graph);
  const triaged = new Set(SUBJECTS.filter((subject) => calibrations.get(subject)?.triagePassed));
  const gate = readDailyGate(db, at);
  const active = activeRunCards(db, graph, triaged);
  const planned = planFromDatabase(
    db,
    graph,
    Math.max(0, gate.remaining - active.length),
    at,
  ).map((item) => ({
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
    needed: calibrations.get(subject)?.calibrated !== true,
  }));

  const topics = graph.order.map((topic) => {
    const state = states.get(topic.id);
    if (state === undefined) {
      throw new Error(`План: тема «${topic.id}» не заведена в topic_state`);
    }
    return {
      id: topic.id,
      title: topic.title,
      subject: topic.subject,
      bossProgress: bossProgress(state.mastery),
      readiness: bossTopicState(db, topic.id),
    };
  });

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

  return {
    plan,
    learning,
    forecasts,
    triage,
    streak: readStreak(db, at),
    topics,
    gate,
  };
}

/** Регистрирует план, старт и финиш обычного забега. */
export function registerRunRoutes(app: FastifyInstance, options: RunRoutesOptions): void {
  const { graph } = options;
  const now = options.now ?? ((): Date => new Date());

  app.get('/api/run/plan', (request, reply) => {
    try {
      const context = options.context(request, { allow: ROUTE_ACCESS.child });
      const stopped = unavailable(context, reply);
      if (stopped !== undefined) return stopped;
      return reply.send(planResponse(context.tenant.db, graph, now()));
    } catch (error) {
      return failAuth(reply, error);
    }
  });

  app.post('/api/run/start', (request, reply) => {
    try {
      const context = options.context(request, { allow: ROUTE_ACCESS.child });
      const db = context.tenant.db;
      const stopped = unavailable(context, reply);
      if (stopped !== undefined) return stopped;
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
    try {
      const context = options.context(request, { allow: ROUTE_ACCESS.child });
      const stopped = unavailable(context, reply);
      if (stopped !== undefined) return stopped;
      const db = context.tenant.db;
      const runId = readPathId(request.params.id);
      const row = db.prepare<[number], { kind: string; finished_at: string | null }>(
        'SELECT kind, finished_at FROM runs WHERE id = ?',
      ).get(runId);
      if (row?.kind !== 'run' || row.finished_at !== null) {
        return reply.send(finishRun(db, graph, runId, { now: now() }));
      }
      assertRunReadyForIntegrity(db, runId);
      const state = context.tenant.integrity.begin(runId);
      return reply.send(state.status === 'completed' ? state.result : integrityPublicJson(state));
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
