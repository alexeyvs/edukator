/**
 * HTTP-обвязка занятия. Логика живёт в `server/session.ts`, здесь только разбор
 * запроса, коды ответов и заказ фонового разбора спора координатору арендатора.
 *
 * Отказ по состоянию (`SessionError`) отличается от поломки: первый — обычный
 * ответ 4xx, второй обязан остаться пятисоткой, иначе ошибка в банке заданий
 * выглядела бы как «ученик что-то не так нажал».
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { MAX_ANSWER_LENGTH } from '../codex/prompt.js';
import {
  nextTask,
  openDispute,
  readResolvedDispute,
  skipRetry,
  submitAnswer,
  SessionError,
  type SessionErrorCode,
} from '../session.js';
import { issuedTaskJson } from './task-json.js';
import {
  ROUTE_ACCESS,
  failAuth,
  type TenantContext,
  type TenantContextResolver,
} from './tenant-context.js';
import { courseJson, operationGraph } from './course-json.js';

/** Код ответа на отказ по состоянию занятия. */
const STATUS_BY_CODE: Record<SessionErrorCode, number> = {
  'task-not-found': 404,
  // Не 404: задание существует, но лежит в очереди — это конфликт состояния,
  // и путать его с опечаткой в идентификаторе не стоит.
  'task-not-issued': 409,
  'already-answered': 409,
  'attempt-not-found': 404,
  'attempt-correct': 400,
  'dispute-not-found': 404,
  'run-not-found': 404,
  'run-finished': 409,
  'run-complete': 409,
  'run-not-ready': 409,
  'run-topic-unavailable': 409,
  'boss-dispute-open': 409,
  'boss-mistake-pending': 409,
  'task-not-in-run': 409,
  // 409, а не 500: задание оказалось негодным, но занятие цело — клиенту надо
  // просто запросить следующее.
  'task-defective': 409,
};

/**
 * Предел длины ответа ученика: всё, что длиннее, — не ответ, а мусор в теле.
 * Число живёт в `codex/prompt.ts` рядом с обрезкой промпта разбора спора: если
 * маршрут примет больше, чем увидит разбирающий, вердикт будет вынесен не по
 * тому тексту, который потом засчитается.
 */
export { MAX_ANSWER_LENGTH };

export interface SessionRoutesOptions {
  /**
   * База, признак подмены файла и разбор споров приходят вместе с арендой:
   * состояние разбора переживает запрос и обязано быть своим на каждую базу
   * (см. `server/dispute-coordinator.ts`).
   */
  context: TenantContextResolver;
  now?: () => Date;
  log?: (message: string) => void;
  /** Каталог посевного банка; по умолчанию репозиторный. */
  seedDir?: string;
}

function defaultLog(message: string): void {
  process.stderr.write(`${message}\n`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Целое из тела запроса: `"12"` и `12.5` — не идентификатор, а ошибка клиента. */
function readId(body: unknown, field: string): number {
  const value = isObject(body) ? body[field] : undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new BadRequest(`Поле ${field} должно быть положительным целым числом`);
  }
  return value;
}

function readQueryId(query: unknown, field: string): number | undefined {
  const value = isObject(query) ? query[field] : undefined;
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new BadRequest(`Параметр ${field} должен быть положительным целым числом`);
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new BadRequest(`Параметр ${field} должен быть положительным целым числом`);
  }
  return id;
}

class BadRequest extends Error {}

function fail(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof BadRequest) return reply.code(400).send({ error: error.message });
  if (error instanceof SessionError) {
    return reply.code(STATUS_BY_CODE[error.code]).send({ error: error.message, code: error.code });
  }
  return failAuth(reply, error);
}

export function registerSessionRoutes(
  app: FastifyInstance,
  options: SessionRoutesOptions,
): void {
  const log = options.log ?? defaultLog;
  const now = options.now ?? ((): Date => new Date());

  function unavailable(context: TenantContext, reply: FastifyReply): FastifyReply | undefined {
    if (context.tenant.available()) return undefined;
    return reply.code(503).send({ error: 'Занятие недоступно: файл базы заменён, нужен перезапуск' });
  }

  app.get('/api/session/next', (request, reply) => {
    try {
      // `mutating` при `GET` — не описка: выдача списывает задание из банка
      // безвозвратно, и без подтверждённого источника чужая страница жгла бы
      // банк переходом на этот адрес.
      const context = options.context(request, { allow: ROUTE_ACCESS.child, mutating: true });
      const db = context.tenant.db;
      const stopped = unavailable(context, reply);
      if (stopped !== undefined) return stopped;
      const runId = readQueryId(request.query, 'runId');
      const graph = runId === undefined
        ? context.tenant.curriculum.graph
        : operationGraph(context.tenant, runId);
      const excludeTaskId = readQueryId(request.query, 'excludeTaskId');
      const result = nextTask(db, graph, {
        now: now(),
        log,
        ...(runId === undefined ? {} : { runId }),
        ...(excludeTaskId === undefined ? {} : { excludeTaskId }),
        ...(options.seedDir === undefined ? {} : { seedDir: options.seedDir }),
      });

      // 503, а не 404: предлагать нечего сейчас — очередь пополняется
      // `npm run prefetch`, а все темы освоенными не остаются дольше, чем до
      // следующего повторения.
      if (result.status === 'no-topic') {
        return reply
          .code(503)
          .send({
            error: 'Планировщику нечего предложить: свободных тем нет',
            code: 'no-topic',
          });
      }
      if (result.status === 'no-task') {
        return reply
          .code(503)
          .send({
            error: `По теме «${result.topicId}» нет готовых заданий`,
            code: 'no-task',
          });
      }
      if (runId !== undefined && result.progress === undefined) {
        throw new Error(`Занятие: выдача для забега ${runId} не вернула progress`);
      }

      return reply.send({
        task: {
          ...issuedTaskJson(result.task),
          ...courseJson(graph, result.task.subject),
        },
        ...(result.retry === undefined ? {} : {
          retry: {
            attempt_id: result.retry.attemptId,
            previous_answer: result.retry.previousAnswer,
            answer: result.retry.answer,
            explain: result.retry.explain,
            joke: result.retry.joke,
            ...(result.retry.disputeStatus === undefined
              ? {}
              : { dispute_status: result.retry.disputeStatus }),
          },
        }),
        ...(runId === undefined ? {} : { progress: result.progress }),
      });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/session/answer', (request, reply) => {
    try {
      const context = options.context(request, { allow: ROUTE_ACCESS.child });
      const db = context.tenant.db;
      const stopped = unavailable(context, reply);
      if (stopped !== undefined) return stopped;
      const body = request.body;
      const taskId = readId(body, 'task_id');
      const runId = isObject(body) && body['runId'] !== undefined ? readId(body, 'runId') : undefined;
      const retryAttemptId = isObject(body) && body['retry_attempt_id'] !== undefined
        ? readId(body, 'retry_attempt_id')
        : undefined;
      if (runId !== undefined) {
        const issued = db.prepare<[number], { issued_run_id: number | null }>(
          'SELECT issued_run_id FROM task_bank WHERE id = ?',
        ).get(taskId);
        if (issued !== undefined && issued.issued_run_id !== runId) {
          throw new SessionError(
            'task-not-in-run',
            `Задание ${String(taskId)} не принадлежит забегу ${String(runId)}`,
          );
        }
      }
      const graph = runId === undefined
        ? context.tenant.curriculum.graph
        : operationGraph(context.tenant, runId);
      const answer = isObject(body) ? body['answer'] : undefined;
      if (typeof answer !== 'string') {
        throw new BadRequest('Поле answer должно быть строкой');
      }
      // Длина ограничена так же, как и всё остальное в теле: ответ ученика —
      // слово, фраза или число, а без предела в `attempts` уезжает мегабайт
      // (умолчание `bodyLimit` Fastify), и он же потом идёт в промпт разбора.
      if (answer.length > MAX_ANSWER_LENGTH) {
        throw new BadRequest(`Поле answer длиннее ${MAX_ANSWER_LENGTH} символов`);
      }
      const hintUsed = isObject(body) ? body['hint_used'] : undefined;
      const durationMs = isObject(body) ? body['duration_ms'] : undefined;
      if (hintUsed !== undefined && typeof hintUsed !== 'boolean') {
        throw new BadRequest('Поле hint_used должно быть логическим');
      }
      // Не только `typeof`: `1e999` разбирается в `Infinity`, а `1e300`
      // переживает `Math.round`, и оба доезжают до колонки
      // `duration_ms INTEGER` как есть — SQLite типы не навязывает, а
      // `CHECK (duration_ms >= 0)` пропускает и то, и другое. Отрицательное
      // отсекается здесь же: занятие зажимает его нулём, но клиенту, который
      // прислал минус, стоит ответить, что это ошибка, а не молча записать 0.
      if (
        durationMs !== undefined
        && (typeof durationMs !== 'number' || !Number.isSafeInteger(durationMs) || durationMs < 0)
      ) {
        throw new BadRequest('Поле duration_ms должно быть целым числом миллисекунд не меньше 0');
      }

      const result = submitAnswer(db, graph, {
        taskId,
        answer,
        at: now(),
        log,
        ...(runId === undefined ? {} : { runId }),
        ...(retryAttemptId === undefined ? {} : { retryAttemptId }),
        ...(hintUsed === undefined ? {} : { hintUsed }),
        ...(durationMs === undefined ? {} : { durationMs }),
      });

      return reply.send({
        attempt_id: result.attemptId,
        ...(result.integrityHeld === true ? { integrity_check: true } : {}),
        correct: result.correct,
        normalized: result.normalized,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        ...(result.integrityHeld === true ? {} : {
          answer: result.answer,
          explain: result.explain,
          joke: result.joke,
        }),
        xp: result.xp,
        progress: result.progress,
        topic: {
          id: result.state.topicId,
          mastery: result.state.mastery,
          attempts: result.state.attempts,
          next_review: result.state.nextReview,
        },
      });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/session/retry/skip', (request, reply) => {
    try {
      const context = options.context(request, { allow: ROUTE_ACCESS.child });
      const stopped = unavailable(context, reply);
      if (stopped !== undefined) return stopped;
      const runId = readId(request.body, 'runId');
      const taskId = readId(request.body, 'task_id');
      return reply.send({ progress: skipRetry(context.tenant.db, runId, taskId) });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/session/dispute', (request, reply) => {
    try {
      const context = options.context(request, { allow: ROUTE_ACCESS.child });
      const db = context.tenant.db;
      const stopped = unavailable(context, reply);
      if (stopped !== undefined) return stopped;
      const attemptId = readId(request.body, 'attempt_id');
      const dispute = openDispute(db, attemptId);
      // Не только на заведение: спор остаётся `open`, когда разбор не удался
      // (codex недоступен, ответ не разобрался), и повторное нажатие кнопки —
      // единственное, что ставит его на разбор снова. Параллельный второй разбор
      // безопасен: `resolveDispute` перечитывает спор уже под записью.
      if (dispute.status === 'open') context.tenant.disputes.schedule(dispute.id);

      // 202: спор принят, но вердикта ещё нет — его приносит следующий запрос
      // состояния, а не этот ответ.
      const resolved = dispute.status === 'open' ? null : readResolvedDispute(db, dispute.id);
      return reply
        .code(dispute.created ? 202 : 200)
        .send({
          dispute_id: dispute.id,
          status: dispute.status,
          ...(resolved === null ? {} : resolved),
        });
    } catch (error) {
      return fail(reply, error);
    }
  });
}

/**
 * Заглушка занятия для случая, когда база или карта тем не поднялись. Молчаливое
 * 404 на те же адреса выглядело бы как опечатка в пути, а причина видна только в
 * /api/health.
 */
export function registerUnavailableSession(app: FastifyInstance, reason: string): void {
  const handler = (_request: unknown, reply: FastifyReply): FastifyReply =>
    reply
      .code(503)
      .send({ error: `Занятие недоступно: ${reason}`, code: 'restart-required' });

  app.get('/api/session/next', handler);
  app.post('/api/session/answer', handler);
  app.post('/api/session/dispute', handler);
  app.post('/api/session/retry/skip', handler);
}
