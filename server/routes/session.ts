/**
 * HTTP-обвязка занятия. Логика живёт в `server/session.ts`, здесь только разбор
 * запроса, коды ответов и запуск фонового разбора спора.
 *
 * Отказ по состоянию (`SessionError`) отличается от поломки: первый — обычный
 * ответ 4xx, второй обязан остаться пятисоткой, иначе ошибка в банке заданий
 * выглядела бы как «ученик что-то не так нажал».
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Database } from 'better-sqlite3';
import type { TopicGraph } from '../curriculum.js';
import { disputeReviewer, type DisputeReviewer } from '../codex/dispute.js';
import {
  nextTask,
  openDispute,
  resolveDispute,
  submitAnswer,
  SessionError,
  type IssuedTask,
  type SessionErrorCode,
} from '../session.js';

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
};

/** Запуск фоновой работы: тесты подменяют её, чтобы дождаться разбора. */
export type BackgroundRunner = (task: () => Promise<void>) => void;

export interface SessionRoutesOptions {
  db: Database;
  graph: TopicGraph;
  /** Разбирающий спор; по умолчанию — вызов codex. */
  review?: DisputeReviewer;
  background?: BackgroundRunner;
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
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new BadRequest(`Поле ${field} должно быть положительным целым числом`);
  }
  return value;
}

class BadRequest extends Error {}

function taskJson(task: IssuedTask): Record<string, unknown> {
  return {
    id: task.id,
    topic_id: task.topicId,
    topic_title: task.topicTitle,
    subject: task.subject,
    question: task.question,
    hint: task.hint,
    difficulty: task.difficulty,
    answer_format: task.answerFormat,
  };
}

function fail(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof BadRequest) return reply.code(400).send({ error: error.message });
  if (error instanceof SessionError) {
    return reply.code(STATUS_BY_CODE[error.code]).send({ error: error.message, code: error.code });
  }
  throw error;
}

export function registerSessionRoutes(app: FastifyInstance, options: SessionRoutesOptions): void {
  const { db, graph } = options;
  const review = options.review ?? disputeReviewer();
  const log = options.log ?? defaultLog;
  const background: BackgroundRunner = options.background ?? ((task) => void task());
  const now = options.now ?? ((): Date => new Date());

  /**
   * Разбор идёт фоном: ученик нажал кнопку и решает дальше, а вызов модели
   * занимает минуты. Ошибка разбора спор не закрывает — он остаётся открытым и
   * разберётся следующей попыткой.
   */
  function scheduleReview(id: number): void {
    background(async () => {
      try {
        await resolveDispute(db, graph, id, review);
      } catch (error) {
        log(`разбор спора ${id} не выполнен: ${(error as Error).message}`);
      }
    });
  }

  app.get('/api/session/next', (_request, reply) => {
    const result = nextTask(db, graph, {
      now: now(),
      ...(options.seedDir === undefined ? {} : { seedDir: options.seedDir }),
    });

    // 503, а не 404: предлагать нечего сейчас — воркер догенерирует, а все темы
    // освоенными не остаются дольше, чем до следующего повторения.
    if (result.status === 'no-topic') {
      return reply
        .code(503)
        .send({ error: 'Планировщику нечего предложить: свободных тем нет' });
    }
    if (result.status === 'no-task') {
      return reply
        .code(503)
        .send({ error: `По теме «${result.topicId}» нет готовых заданий` });
    }

    return reply.send({ task: taskJson(result.task) });
  });

  app.post('/api/session/answer', (request, reply) => {
    try {
      const body = request.body;
      const taskId = readId(body, 'task_id');
      const answer = isObject(body) ? body['answer'] : undefined;
      if (typeof answer !== 'string') {
        throw new BadRequest('Поле answer должно быть строкой');
      }
      const hintUsed = isObject(body) ? body['hint_used'] : undefined;
      const durationMs = isObject(body) ? body['duration_ms'] : undefined;
      if (hintUsed !== undefined && typeof hintUsed !== 'boolean') {
        throw new BadRequest('Поле hint_used должно быть логическим');
      }
      if (durationMs !== undefined && typeof durationMs !== 'number') {
        throw new BadRequest('Поле duration_ms должно быть числом');
      }

      const result = submitAnswer(db, graph, {
        taskId,
        answer,
        at: now(),
        ...(hintUsed === undefined ? {} : { hintUsed }),
        ...(durationMs === undefined ? {} : { durationMs }),
      });

      return reply.send({
        attempt_id: result.attemptId,
        correct: result.correct,
        normalized: result.normalized,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        answer: result.answer,
        explain: result.explain,
        joke: result.joke,
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

  app.post('/api/session/dispute', (request, reply) => {
    try {
      const attemptId = readId(request.body, 'attempt_id');
      const dispute = openDispute(db, attemptId);
      if (dispute.created) scheduleReview(dispute.id);

      // 202: спор принят, но вердикта ещё нет — его приносит следующий запрос
      // состояния, а не этот ответ.
      return reply
        .code(dispute.created ? 202 : 200)
        .send({ dispute_id: dispute.id, status: dispute.status });
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
    reply.code(503).send({ error: `Занятие недоступно: ${reason}` });

  app.get('/api/session/next', handler);
  app.post('/api/session/answer', handler);
  app.post('/api/session/dispute', handler);
}
