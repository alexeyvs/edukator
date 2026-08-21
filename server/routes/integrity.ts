import type { FastifyInstance, FastifyReply } from 'fastify';
import type { IntegrityPublicStatus } from '../integrity.js';
import { issuedTaskJson } from './task-json.js';
import { MAX_ANSWER_LENGTH } from '../codex/prompt.js';
import { ROUTE_ACCESS, failAuth, type TenantContextResolver } from './tenant-context.js';
import { IntegrityError } from '../integrity-error.js';

export interface IntegrityRoutesOptions {
  context: TenantContextResolver;
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

function unavailable(available: () => boolean, reply: FastifyReply): FastifyReply | undefined {
  if (available()) return undefined;
  return reply.code(503).send({ error: 'Проверка ответов недоступна: файл базы заменён' });
}

export function registerIntegrityRoutes(app: FastifyInstance, options: IntegrityRoutesOptions): void {
  // `mutating`, хотя метод безопасный: `integrity.status` не читает, а
  // подталкивает проверку — ставит `reviewing`, занимает слот codex и на
  // зачтённой проверке закрывает сам забег (`finish`). Детская cookie
  // `SameSite=Lax` уезжает и на переходе с чужой страницы, так что без
  // подтверждённого источника этот адрес — способ чужими руками завершить
  // занятие ребёнка и сжечь бюджет модели.
  app.get('/api/integrity/:runId', (request, reply) => {
    try {
      const context = options.context(request, { allow: ROUTE_ACCESS.child, mutating: true });
      const stopped = unavailable(context.tenant.available, reply);
      if (stopped !== undefined) return stopped;
      const runId = pathId((request.params as { runId?: string }).runId);
      if (runId === null) return reply.code(400).send({ error: 'Некорректный идентификатор занятия' });
      const state = context.tenant.integrity.status(runId);
      if (state === null) return reply.code(404).send({ error: 'Проверка занятия не найдена' });
      return reply.send(integrityPublicJson(state));
    } catch (error) {
      return failAuth(reply, error);
    }
  });

  app.post('/api/integrity/:runId/retry/:itemId', (request, reply) => {
    try {
      const context = options.context(request, { allow: ROUTE_ACCESS.child });
      const stopped = unavailable(context.tenant.available, reply);
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
      return reply.send(integrityPublicJson(
        context.tenant.integrity.retry(runId, itemId, answer, duration, hintUsed ?? false),
      ));
    } catch (error) {
      // 409 — только отказ **по состоянию** проверки. Прежний общий `catch`
      // уносил в него и внутреннюю поломку («задание исчезло», подменённый
      // файл базы, отказ драйвера): её текст уезжал наружу обычным ответом, а
      // сама она не попадала ни в обработчик ошибок, ни в журнал аварий.
      if (error instanceof IntegrityError) {
        return reply.code(409).send({ error: error.message, code: error.code });
      }
      return failAuth(reply, error);
    }
  });
}

export function registerUnavailableIntegrity(app: FastifyInstance, reason: string): void {
  const send = (_request: unknown, reply: FastifyReply): FastifyReply =>
    reply.code(503).send({ error: `Проверка ответов недоступна: ${reason}` });
  app.get('/api/integrity/:runId', send);
  app.post('/api/integrity/:runId/retry/:itemId', send);
}
