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
import { MAX_ANSWER_LENGTH } from '../codex/prompt.js';
import { codexConcurrency, type CodexConcurrency } from '../codex/concurrency.js';
import {
  nextTask,
  openDispute,
  resolveDispute,
  submitAnswer,
  SessionError,
  type IssuedTask,
  type SessionErrorCode,
} from '../session.js';
import { runProgress } from '../run.js';

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
  /** Соединение всё ещё привязано к текущему файлу базы. */
  available?: () => boolean;
  /** Общий с воркером бюджет вызовов codex. */
  codexBudget?: CodexConcurrency;
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

export function registerSessionRoutes(
  app: FastifyInstance,
  options: SessionRoutesOptions,
): () => Promise<void> {
  const { db, graph } = options;
  const review = options.review ?? disputeReviewer();
  const log = options.log ?? defaultLog;
  const background: BackgroundRunner = options.background ?? ((task) => void task());
  const now = options.now ?? ((): Date => new Date());
  const budget = options.codexBudget ?? codexConcurrency;

  /**
   * Споры, разбор которых уже идёт. Без этого набора каждое повторное нажатие
   * кнопки (а состояние спора клиент узнаёт именно повторным запросом) поднимало
   * бы ещё один процесс codex на минуты.
   */
  const reviewing = new Set<number>();
  const pendingReviews = new Set<Promise<unknown>>();

  function unavailable(reply: FastifyReply): FastifyReply | undefined {
    if (options.available?.() !== false) return undefined;
    return reply.code(503).send({ error: 'Занятие недоступно: файл базы заменён, нужен перезапуск' });
  }

  /**
   * Разбор идёт фоном: ученик нажал кнопку и решает дальше, а вызов модели
   * занимает минуты. Ошибка разбора спор не закрывает — он остаётся открытым, и
   * следующее нажатие кнопки ставит его на разбор заново.
   *
   * Одновременных разборов вместе с воркером не больше общего бюджета: набор `reviewing`
   * держит только повтор по одному и тому же спору, а разных открытых споров
   * бывает сколько угодно, и каждый — это ещё один процесс codex на минуты.
   * Сверх предела спор остаётся открытым и попадёт на разбор со следующим
   * запросом — ровно тот же сценарий, что и при недоступном codex.
   */
  function scheduleReview(id: number): void {
    if (reviewing.has(id)) return;
    const pending = budget.tryRun(() => resolveDispute(db, graph, id, review));
    if (pending === undefined) {
      log(`разбор спора ${id} отложен: заняты все ${budget.limit} места codex`);
      return;
    }
    reviewing.add(id);
    pendingReviews.add(pending);
    background(async () => {
      try {
        await pending;
      } catch (error) {
        log(`разбор спора ${id} не выполнен: ${(error as Error).message}`);
      } finally {
        pendingReviews.delete(pending);
        // Именно в `finally`: снятая только при успехе пометка навсегда
        // запретила бы повторный разбор спора, который как раз и остался
        // открытым из-за недоступного codex.
        reviewing.delete(id);
      }
    });
  }

  app.get('/api/session/next', (request, reply) => {
    const stopped = unavailable(reply);
    if (stopped !== undefined) return stopped;
    try {
      const runId = readQueryId(request.query, 'runId');
      const result = nextTask(db, graph, {
        now: now(),
        log,
        ...(runId === undefined ? {} : { runId }),
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

      return reply.send({
        task: taskJson(result.task),
        ...(runId === undefined ? {} : { progress: runProgress(db, runId) }),
      });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/session/answer', (request, reply) => {
    const stopped = unavailable(reply);
    if (stopped !== undefined) return stopped;
    try {
      const body = request.body;
      const taskId = readId(body, 'task_id');
      const runId = isObject(body) && body['runId'] !== undefined ? readId(body, 'runId') : undefined;
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

  app.post('/api/session/dispute', (request, reply) => {
    const stopped = unavailable(reply);
    if (stopped !== undefined) return stopped;
    try {
      const attemptId = readId(request.body, 'attempt_id');
      const dispute = openDispute(db, attemptId);
      // Не только на заведение: спор остаётся `open`, когда разбор не удался
      // (codex недоступен, ответ не разобрался), и повторное нажатие кнопки —
      // единственное, что ставит его на разбор снова. Параллельный второй разбор
      // безопасен: `resolveDispute` перечитывает спор уже под записью.
      if (dispute.status === 'open') scheduleReview(dispute.id);

      // 202: спор принят, но вердикта ещё нет — его приносит следующий запрос
      // состояния, а не этот ответ.
      return reply
        .code(dispute.created ? 202 : 200)
        .send({ dispute_id: dispute.id, status: dispute.status });
    } catch (error) {
      return fail(reply, error);
    }
  });

  // `app.close()` закрывает соединение занятия. Фоновый разбор уже держит
  // ссылку на него и после удачного ответа модели пишет вердикт транзакцией,
  // поэтому закрывать базу раньше — превращать штатное завершение в случайный
  // `database connection is not open`. На сигнале `runChild` сначала снимает
  // потомка, так что ожидание здесь быстро завершается и WAL закрывается после
  // всей работы с базой.
  return async () => {
    await Promise.allSettled([...pendingReviews]);
  };
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
}
