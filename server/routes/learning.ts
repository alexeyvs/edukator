/** HTTP-граница персонального материала; состояние и атомарность живут в learning.ts. */
import type { Database } from 'better-sqlite3';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TopicGraph } from '../curriculum.js';
import {
  assertLearningReadyForIntegrity,
  finishLearningMaterial,
  LearningError,
  openLearningMaterial,
  readLearningMaterial,
  startLearningRun,
} from '../learning.js';
import { runProgress } from '../run.js';
import { readDailyGate } from '../daily-gate.js';
import type { IntegrityCoordinator } from '../integrity.js';

export interface LearningRoutesOptions {
  db: Database;
  graph: TopicGraph;
  now?: () => Date;
  available?: () => boolean;
  integrity?: IntegrityCoordinator;
}

class BadRequest extends Error {}

function readPathId(value: string, label: string): number {
  if (!/^\d+$/u.test(value)) throw new BadRequest(`${label} должен быть положительным целым`);
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new BadRequest(`${label} должен быть положительным целым`);
  }
  return id;
}

function unavailable(options: LearningRoutesOptions, reply: FastifyReply): FastifyReply | undefined {
  if (options.available?.() !== false) return undefined;
  return reply.code(503).send({
    error: 'Учебный материал недоступен: файл базы заменён, нужен перезапуск',
  });
}

function fail(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof BadRequest) return reply.code(400).send({ error: error.message });
  if (error instanceof LearningError) {
    return reply.code(error.code === 'learning-not-found' ? 404 : 409)
      .send({ error: error.message, code: error.code });
  }
  throw error;
}

function materialJson(db: Database, graph: TopicGraph, materialId: number): Record<string, unknown> {
  const material = readLearningMaterial(db, materialId);
  const topic = graph.byId.get(material.topicId);
  if (topic === undefined || topic.subject !== material.subject) {
    throw new LearningError(
      'learning-inconsistent',
      `Тема материала ${materialId} отсутствует в карте`,
    );
  }
  return {
    id: material.id,
    subject: material.subject,
    topic: { id: topic.id, title: topic.title },
    recommendationReason: material.recommendationReason,
    estimatedMinutes: material.estimatedMinutes,
    status: material.status,
    content: material.content,
    progress: material.progress,
    passScore: material.passScore,
  };
}

export function registerLearningRoutes(app: FastifyInstance, options: LearningRoutesOptions): void {
  const { db, graph } = options;
  const now = options.now ?? ((): Date => new Date());

  app.get<{ Params: { id: string } }>('/api/learning/:id', (request, reply) => {
    const stopped = unavailable(options, reply);
    if (stopped !== undefined) return stopped;
    try {
      return reply.send(materialJson(
        db,
        graph,
        readPathId(request.params.id, 'Идентификатор материала'),
      ));
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/api/learning/:id/open', (request, reply) => {
    const stopped = unavailable(options, reply);
    if (stopped !== undefined) return stopped;
    try {
      const materialId = readPathId(request.params.id, 'Идентификатор материала');
      const opened = openLearningMaterial(db, materialId, { now: now() });
      return reply.send({ ...opened, material: materialJson(db, graph, materialId) });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/api/learning/:id/test', (request, reply) => {
    const stopped = unavailable(options, reply);
    if (stopped !== undefined) return stopped;
    try {
      const started = startLearningRun(
        db,
        readPathId(request.params.id, 'Идентификатор материала'),
        { now: now() },
      );
      return reply.send({ ...started, progress: runProgress(db, started.runId) });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post<{ Params: { runId: string } }>('/api/learning/run/:runId/finish', (request, reply) => {
    const stopped = unavailable(options, reply);
    if (stopped !== undefined) return stopped;
    try {
      const at = now();
      const runId = readPathId(request.params.runId, 'Идентификатор lesson-run');
      if (options.integrity !== undefined) {
        assertLearningReadyForIntegrity(db, runId);
        const state = options.integrity.begin(runId);
        if (state.status !== 'completed') return reply.send(state);
        const result = state.result as unknown as ReturnType<typeof finishLearningMaterial>;
        const learningGate = readDailyGate(db, at).learning;
        return reply.send({
          ...result,
          required: learningGate.required && learningGate.materialId === result.materialId,
        });
      }
      const result = finishLearningMaterial(db, graph, runId, { now: at });
      const learningGate = readDailyGate(db, at).learning;
      return reply.send({
        ...result,
        required: learningGate.required && learningGate.materialId === result.materialId,
      });
    } catch (error) {
      return fail(reply, error);
    }
  });
}

export function registerUnavailableLearning(app: FastifyInstance, reason: string): void {
  const handler = (_request: unknown, reply: FastifyReply): FastifyReply =>
    reply.code(503).send({ error: `Учебный материал недоступен: ${reason}` });
  app.get('/api/learning/:id', handler);
  app.post('/api/learning/:id/open', handler);
  app.post('/api/learning/:id/test', handler);
  app.post('/api/learning/run/:runId/finish', handler);
}
