import type { FastifyInstance, FastifyReply } from 'fastify';
import type { IntegrityCoordinator, IntegrityPublicStatus } from '../integrity.js';
import { issuedTaskJson } from './task-json.js';
import { MAX_ANSWER_LENGTH } from '../codex/prompt.js';

export interface IntegrityRoutesOptions {
  coordinator: IntegrityCoordinator;
  available?: () => boolean;
}

/** Единая HTTP-форма integrity-состояния для всех маршрутов, которые могут его вернуть. */
export function integrityPublicJson(state: IntegrityPublicStatus): Record<string, unknown> {
  if (state.status !== 'retry_required') return state;
  return {
    status: state.status,
    flagged: state.flagged,
    remaining: state.remaining,
    retry: {
      item_id: state.retry.itemId,
      task: issuedTaskJson(state.retry.task),
    },
  };
}

function pathId(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/u.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function unavailable(options: IntegrityRoutesOptions, reply: FastifyReply): FastifyReply | undefined {
  if (options.available?.() !== false) return undefined;
  return reply.code(503).send({ error: 'Проверка ответов недоступна: файл базы заменён' });
}

export function registerIntegrityRoutes(app: FastifyInstance, options: IntegrityRoutesOptions): void {
  app.get('/api/integrity/:runId', (request, reply) => {
    const stopped = unavailable(options, reply);
    if (stopped !== undefined) return stopped;
    const runId = pathId((request.params as { runId?: string }).runId);
    if (runId === null) return reply.code(400).send({ error: 'Некорректный идентификатор занятия' });
    const state = options.coordinator.status(runId);
    if (state === null) return reply.code(404).send({ error: 'Проверка занятия не найдена' });
    return reply.send(integrityPublicJson(state));
  });

  app.post('/api/integrity/:runId/retry/:itemId', (request, reply) => {
    const stopped = unavailable(options, reply);
    if (stopped !== undefined) return stopped;
    const params = request.params as { runId?: string; itemId?: string };
    const runId = pathId(params.runId);
    const itemId = pathId(params.itemId);
    if (runId === null || itemId === null) {
      return reply.code(400).send({ error: 'Некорректный идентификатор занятия или вопроса' });
    }
    const body = request.body as { answer?: unknown; duration_ms?: unknown; hint_used?: unknown } | null;
    const answer = body?.answer;
    const duration = body?.duration_ms;
    const hintUsed = body?.hint_used;
    if (typeof answer !== 'string' || answer.trim() === '' || answer.length > MAX_ANSWER_LENGTH) {
      return reply.code(400).send({ error: 'Ответ должен быть непустой строкой допустимой длины' });
    }
    if (typeof duration !== 'number' || !Number.isSafeInteger(duration) || duration < 0) {
      return reply.code(400).send({ error: 'Время ответа должно быть целым числом миллисекунд' });
    }
    if (hintUsed !== undefined && typeof hintUsed !== 'boolean') {
      return reply.code(400).send({ error: 'Поле hint_used должно быть логическим' });
    }
    try {
      return reply.send(integrityPublicJson(
        options.coordinator.retry(runId, itemId, answer, duration, hintUsed ?? false),
      ));
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
  });
}

export function registerUnavailableIntegrity(app: FastifyInstance, reason: string): void {
  const send = (_request: unknown, reply: FastifyReply): FastifyReply =>
    reply.code(503).send({ error: `Проверка ответов недоступна: ${reason}` });
  app.get('/api/integrity/:runId', send);
  app.post('/api/integrity/:runId/retry/:itemId', send);
}
