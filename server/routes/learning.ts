/** HTTP-граница персонального материала; состояние и атомарность живут в learning.ts. */
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Tenant } from '../tenant-registry.js';
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
import {
  ROUTE_ACCESS,
  failAuth,
  type TenantContext,
  type TenantContextResolver,
} from './tenant-context.js';
import { integrityPublicJson } from './integrity.js';
import { courseJson } from './course-json.js';

export interface LearningRoutesOptions {
  context: TenantContextResolver;
  now?: () => Date;
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

function unavailable(context: TenantContext, reply: FastifyReply): FastifyReply | undefined {
  if (context.tenant.available()) return undefined;
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
  return failAuth(reply, error);
}

function materialJson(tenant: Tenant, materialId: number): Record<string, unknown> {
  const material = readLearningMaterial(tenant.db, materialId);
  const currentRevision = tenant.curriculum.revisionIds.get(material.subject);
  const graph = material.courseRevisionId === currentRevision
    ? tenant.curriculum.graph
    : material.latestRunId !== null && material.latestRunFinishedAt === null
      ? tenant.graphForRun(material.latestRunId)
      : undefined;
  if (graph === undefined) {
    throw new LearningError(
      'learning-not-ready',
      `Материал ${materialId} относится к неактуальной редакции курса`,
    );
  }
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
    ...courseJson(graph, material.subject),
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
  const now = options.now ?? ((): Date => new Date());

  app.get<{ Params: { id: string } }>('/api/learning/:id', (request, reply) => {
    try {
      const context = options.context(request, { allow: ROUTE_ACCESS.child });
      const stopped = unavailable(context, reply);
      if (stopped !== undefined) return stopped;
      return reply.send(materialJson(
        context.tenant,
        readPathId(request.params.id, 'Идентификатор материала'),
      ));
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/api/learning/:id/open', (request, reply) => {
    try {
      const context = options.context(request, { allow: ROUTE_ACCESS.child });
      const db = context.tenant.db;
      const stopped = unavailable(context, reply);
      if (stopped !== undefined) return stopped;
      const materialId = readPathId(request.params.id, 'Идентификатор материала');
      materialJson(context.tenant, materialId);
      const opened = openLearningMaterial(db, materialId, { now: now() });
      return reply.send({ ...opened, material: materialJson(context.tenant, materialId) });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/api/learning/:id/test', (request, reply) => {
    try {
      const context = options.context(request, { allow: ROUTE_ACCESS.child });
      const db = context.tenant.db;
      const stopped = unavailable(context, reply);
      if (stopped !== undefined) return stopped;
      const materialId = readPathId(request.params.id, 'Идентификатор материала');
      materialJson(context.tenant, materialId);
      const started = startLearningRun(
        db,
        materialId,
        { now: now() },
      );
      return reply.send({ ...started, progress: runProgress(db, started.runId) });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post<{ Params: { runId: string } }>('/api/learning/run/:runId/finish', (request, reply) => {
    try {
      const context = options.context(request, { allow: ROUTE_ACCESS.child });
      const db = context.tenant.db;
      const stopped = unavailable(context, reply);
      if (stopped !== undefined) return stopped;
      const at = now();
      const runId = readPathId(request.params.runId, 'Идентификатор lesson-run');
      assertLearningReadyForIntegrity(db, runId);
      const state = context.tenant.integrity.begin(runId);
      if (state.status !== 'completed') return reply.send(integrityPublicJson(state));
      const result = state.result as unknown as ReturnType<typeof finishLearningMaterial>;
      const learningGate = readDailyGate(db, at, context.tenant.curriculum.revisionIds).learning;
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
