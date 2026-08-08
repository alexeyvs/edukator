/** HTTP-граница триажа; выбор темы и сложности остаётся в `triage.ts`. */
import type { Database } from 'better-sqlite3';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TopicGraph } from '../curriculum.js';
import { SUBJECTS, type Subject } from '../db.js';
import { runProgress, startRun } from '../run.js';
import { SessionError } from '../session-error.js';
import { nextTriageTask } from '../triage.js';

export interface TriageRoutesOptions {
  db: Database;
  graph: TopicGraph;
  now?: () => Date;
  /** Соединение всё ещё привязано к текущему файлу базы. */
  available?: () => boolean;
}

interface TriageRun {
  subject: Subject;
  kind: 'run' | 'triage';
  finished_at: string | null;
}

class BadRequest extends Error {}

function unavailable(options: TriageRoutesOptions, reply: FastifyReply): FastifyReply | undefined {
  if (options.available?.() !== false) return undefined;
  return reply.code(503).send({ error: 'Триаж недоступен: файл базы заменён, нужен перезапуск' });
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
  if (!/^\d+$/.test(value)) throw new BadRequest('Идентификатор триажа должен быть положительным целым');
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new BadRequest('Идентификатор триажа должен быть положительным целым');
  }
  return id;
}

function fail(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof BadRequest) return reply.code(400).send({ error: error.message });
  if (error instanceof SessionError) {
    const status = error.code === 'run-not-found' ? 404 : 409;
    return reply.code(status).send({ error: error.message, code: error.code });
  }
  throw error;
}

function readTriageRun(db: Database, id: number): TriageRun {
  const run = db.prepare<[number], TriageRun>(
    'SELECT subject, kind, finished_at FROM runs WHERE id = ?',
  ).get(id);
  if (run === undefined) throw new SessionError('run-not-found', `Забег ${id} не найден`);
  if (run.finished_at !== null) throw new SessionError('run-finished', `Забег ${id} уже завершён`);
  if (run.kind !== 'triage') {
    throw new SessionError('task-not-in-run', `Забег ${id} не является триажем`);
  }
  return run;
}

/** Регистрирует запуск триажа и выдачу диагностического задания. */
export function registerTriageRoutes(app: FastifyInstance, options: TriageRoutesOptions): void {
  const { db, graph } = options;
  const now = options.now ?? ((): Date => new Date());

  app.post('/api/triage/start', (request, reply) => {
    const stopped = unavailable(options, reply);
    if (stopped !== undefined) return stopped;
    try {
      return reply.send(startRun(db, graph, readSubject(request.body), {
        kind: 'triage',
        now: now(),
      }));
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>('/api/triage/:id/next', (request, reply) => {
    const stopped = unavailable(options, reply);
    if (stopped !== undefined) return stopped;
    try {
      const id = readPathId(request.params.id);
      const run = readTriageRun(db, id);
      const result = nextTriageTask(db, graph, id, { subject: run.subject });
      if (result.status === 'done') return reply.send(result);

      // Подсказка намеренно не пересекает HTTP-границу: даже скрытая кнопка на
      // клиенте не должна позволять подсмотреть её через ответ API.
      return reply.send({
        status: 'ok',
        progress: runProgress(db, id),
        task: {
          id: result.task.id,
          topic_id: result.task.topicId,
          topic_title: result.task.topicTitle,
          subject: result.task.subject,
          question: result.task.question,
          ...(result.task.instruction === undefined ? {} : {
            instruction: result.task.instruction,
            material: result.task.material,
            material_format: result.task.materialFormat,
            choices: result.task.choices,
          }),
          difficulty: result.task.difficulty,
          answer_format: result.task.answerFormat,
        },
      });
    } catch (error) {
      return fail(reply, error);
    }
  });
}

/** Явные 503 вместо немого 404, если карта или база не поднялись. */
export function registerUnavailableTriage(app: FastifyInstance, reason: string): void {
  const handler = (_request: unknown, reply: FastifyReply): FastifyReply =>
    reply.code(503).send({ error: `Триаж недоступен: ${reason}` });

  app.post('/api/triage/start', handler);
  app.get('/api/triage/:id/next', handler);
}
