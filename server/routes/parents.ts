/**
 * HTTP-граница родительской сводки и управления доступом к компьютеру.
 *
 * Ребёнок назван в адресе: `id` забегов и заданий нумеруются в каждой базе с
 * нуля, и сводка «того ребёнка, чья cookie пришла» превращала бы родителя с
 * двумя детьми в человека, который никогда не знает, чей отчёт читает.
 *
 * Матрица допуска здесь на одну строку сложнее общей (`ROUTE_ACCESS.dashboard`):
 * чтение открыто и родителю, и самому ученику — по основной спеке он видит тот
 * же дашборд и знает о нём, — а изменяющие маршруты требуют PIN, но только от
 * детского предъявителя. Вошедшему родителю PIN не спрашивается ни на одном
 * действии: он подтверждён паролем, и второе подтверждение тем же человеком
 * ничего не добавляет. Смысл PIN ровно один — «за детской машиной сейчас сидит
 * родитель».
 */
import type { Database } from 'better-sqlite3';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { TopicGraph } from '../curriculum.js';
import {
  clearComputerAccessOverride,
  setComputerAccessOverride,
  type ComputerAccessOverrideMode,
} from '../computer-access.js';
import { readDailyGate } from '../daily-gate.js';
import { readPinPepper, verifyParentPin } from '../parent-pin.js';
import { readParentsDashboard, readParentsRunDetail } from '../parents.js';
import {
  checkLoginGate,
  clearLoginFailures,
  readParentEmail,
  readParentPinHash,
  recordLoginFailure,
  type LoginTarget,
} from '../control-db.js';
import { clientAddress, readTrustedProxies } from '../client-address.js';
import { headerValue, type Bearer } from '../auth.js';
import { integrityPublicJson } from './integrity.js';
import {
  ROUTE_ACCESS,
  childIdParam,
  failAuth,
  type TenantContext,
  type TenantContextResolver,
} from './tenant-context.js';

type ComputerAccessMode = ComputerAccessOverrideMode | 'automatic';

export interface ParentsRoutesOptions {
  context: TenantContextResolver;
  graph: TopicGraph;
  /**
   * Управляющая база. В ней и эталон PIN семьи, и счётчик неудачных попыток:
   * PIN свой у каждой семьи, и один общий на процесс означал бы, что чужой
   * родитель управляет доступом к компьютеру не своего ребёнка.
   */
  control: Database;
  pinPepper?: string;
  /**
   * Кому верить в `X-Forwarded-For`. По умолчанию — список из окружения: без
   * него счётчик по адресу считал бы адрес, присланный самим подбирающим.
   */
  trustedProxies?: Set<string>;
  now?: () => Date;
}

/**
 * Нужен ли PIN этому предъявителю. Родительская сессия — единственный, кому
 * нет: см. заголовок модуля.
 */
export function needsPin(bearer: Bearer): boolean {
  return bearer.kind !== 'parent';
}

function unavailable(context: TenantContext, reply: FastifyReply): FastifyReply | undefined {
  if (context.tenant.available()) return undefined;
  return reply.code(503).send({
    error: 'Дашборд родителей недоступен: файл базы заменён, нужен перезапуск',
  });
}

function readMode(body: unknown): ComputerAccessMode | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const fields = Object.keys(body);
  if (fields.length !== 1 || fields[0] !== 'mode') return undefined;
  const mode = (body as Record<string, unknown>)['mode'];
  return mode === 'automatic' || mode === 'blocked' || mode === 'unlocked'
    ? mode
    : undefined;
}

function bearerPin(request: FastifyRequest): string {
  const header = request.headers.authorization;
  const match = header?.match(/^Bearer ([^\s]+)$/iu);
  return match?.[1] ?? '';
}

export function registerParentsRoutes(app: FastifyInstance, options: ParentsRoutesOptions): void {
  const now = options.now ?? ((): Date => new Date());
  const control = options.control;
  const pepper = readPinPepper(options.pinPepper);
  const trusted = options.trustedProxies
    ?? readTrustedProxies(process.env['EDUKATOR_TRUSTED_PROXIES']);

  /**
   * Эталон PIN родителя этого ребёнка; `undefined` — PIN не настроен.
   *
   * Ненастроенный серверный pepper считается тем же состоянием: сверять эталон
   * без него нечем, и честный 503 «PIN не настроен» полезнее молчаливого
   * «неверный PIN» — по последнему родитель искал бы ошибку в своих цифрах.
   */
  function pinHash(context: TenantContext): string | undefined {
    if (pepper === undefined) return undefined;
    return readParentPinHash(control, context.child.parentId);
  }

  /**
   * Кого считает счётчик неудач. Учётная запись родителя и адрес клиента — те
   * же два ключа, что и у входа по паролю, но с другим `kind`: подбор PIN за
   * детской машиной не должен закрывать родителю вход по паролю, и наоборот.
   *
   * Счётчик живёт в `control.db`, а не в памяти процесса: процессная карта
   * забывала всё при перезапуске — а перезапуск сервера подбирающий вызвать
   * умеет, и пятиминутная пауза кончалась бы вместе с ним.
   */
  function pinTarget(context: TenantContext, request: FastifyRequest): LoginTarget {
    const email = readParentEmail(control, context.child.parentId);
    return {
      kind: 'pin',
      ...(email === undefined ? {} : { email }),
      address: clientAddress({
        socketAddress: request.socket.remoteAddress,
        forwardedFor: headerValue(request.headers, 'x-forwarded-for'),
        trusted,
      }),
    };
  }

  /** Проверяет PIN только для действия с детской машины; родитель уже вошёл паролем. */
  function authorizeChange(
    context: TenantContext,
    request: FastifyRequest,
    reply: FastifyReply,
  ): FastifyReply | undefined {
    if (!needsPin(context.bearer)) return undefined;
    const expected = pinHash(context);
    if (expected === undefined) {
      return reply.code(503).send({
        error: 'Управление доступом недоступно: PIN родителя не настроен',
      });
    }
    if (bearerPin(request) === '') {
      return reply.code(401).send({ error: 'Нужен PIN родителя' });
    }

    const target = pinTarget(context, request);
    const current = now();
    const gate = checkLoginGate(control, target, current);
    if (!gate.allowed) {
      const retryAfter = Math.max(1, Math.ceil(gate.retryAfterMs / 1000));
      return reply
        .header('retry-after', retryAfter)
        .code(gate.reason === 'unavailable' ? 503 : 429)
        .send({
          error: gate.reason === 'unavailable'
            ? 'Управление доступом временно недоступно'
            : 'Слишком много неверных попыток PIN, повторите позже',
        });
    }

    if (!verifyParentPin(expected, bearerPin(request), pepper)) {
      const counted = recordLoginFailure(control, target, current);
      if (counted.reason === 'unavailable') {
        const retryAfter = Math.max(1, Math.ceil(counted.retryAfterMs / 1000));
        return reply.header('retry-after', retryAfter).code(503).send({
          error: 'Управление доступом временно недоступно',
        });
      }
      return reply.code(401).send({ error: 'Неверный PIN родителя' });
    }
    clearLoginFailures(control, target);
    return undefined;
  }

  function positiveId(value: string | undefined): number | undefined {
    if (value === undefined || !/^\d+$/u.test(value)) return undefined;
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : undefined;
  }

  app.get<{ Params: { childId: string } }>('/api/parents/:childId', (request, reply) => {
    try {
      const context = options.context(request, {
        allow: ROUTE_ACCESS.dashboard,
        childId: childIdParam(request.params),
      });
      const stopped = unavailable(context, reply);
      if (stopped !== undefined) return stopped;
      const dashboard = readParentsDashboard(context.tenant.db, options.graph, now());
      return reply.send({
        ...dashboard,
        computerAccess: {
          ...dashboard.computerAccess,
          configured: pinHash(context) !== undefined,
        },
      });
    } catch (error) {
      return failAuth(reply, error);
    }
  });

  app.get<{ Params: { childId: string; runId: string } }>(
    '/api/parents/:childId/runs/:runId',
    (request, reply) => {
      try {
        const context = options.context(request, {
          allow: ROUTE_ACCESS.dashboard,
          childId: childIdParam(request.params),
        });
        const stopped = unavailable(context, reply);
        if (stopped !== undefined) return stopped;
        const runId = positiveId(request.params.runId);
        if (runId === undefined) {
          return reply.code(400).send({
            error: 'Идентификатор занятия должен быть положительным целым числом',
          });
        }
        const detail = readParentsRunDetail(context.tenant.db, options.graph, runId, now());
        if (detail === null) {
          return reply.code(404).send({ error: 'Занятие не найдено в текущей недельной сводке' });
        }
        return reply.send(detail);
      } catch (error) {
        return failAuth(reply, error);
      }
    },
  );

  app.put<{ Params: { childId: string } }>(
    '/api/parents/:childId/computer-access',
    (request, reply) => {
      let context: TenantContext;
      try {
        context = options.context(request, {
          allow: ROUTE_ACCESS.dashboard,
          childId: childIdParam(request.params),
        });
      } catch (error) {
        return failAuth(reply, error);
      }
      const stopped = unavailable(context, reply);
      if (stopped !== undefined) return stopped;

      const current = now();
      const denied = authorizeChange(context, request, reply);
      if (denied !== undefined) return denied;

      const mode = readMode(request.body);
      if (mode === undefined) {
        return reply.code(400).send({
          error: 'Поле mode должно быть одним из: automatic, blocked, unlocked',
        });
      }
      const db = context.tenant.db;
      if (mode === 'automatic') clearComputerAccessOverride(db);
      else setComputerAccessOverride(db, mode, current);
      return reply.send(readDailyGate(db, current));
    },
  );

  app.put<{ Params: { childId: string; runId: string; itemId: string } }>(
    '/api/parents/:childId/runs/:runId/integrity/:itemId/approve',
    (request, reply) => {
      let context: TenantContext;
      try {
        context = options.context(request, {
          allow: ROUTE_ACCESS.dashboard,
          childId: childIdParam(request.params),
        });
      } catch (error) {
        return failAuth(reply, error);
      }
      const stopped = unavailable(context, reply);
      if (stopped !== undefined) return stopped;
      const denied = authorizeChange(context, request, reply);
      if (denied !== undefined) return denied;
      const runId = positiveId(request.params.runId);
      const itemId = positiveId(request.params.itemId);
      if (runId === undefined || itemId === undefined) {
        return reply.code(400).send({ error: 'Некорректный идентификатор занятия или вопроса' });
      }
      try {
        return reply.send(integrityPublicJson(context.tenant.integrity.approve(runId, itemId)));
      } catch (error) {
        return reply.code(409).send({ error: (error as Error).message });
      }
    },
  );
}

export function registerUnavailableParents(app: FastifyInstance, reason: string): void {
  const send = (_request: unknown, reply: FastifyReply): FastifyReply =>
    reply.code(503).send({ error: `Дашборд родителей недоступен: ${reason}` });
  app.get('/api/parents/:childId', send);
  app.get('/api/parents/:childId/runs/:runId', send);
  app.put('/api/parents/:childId/computer-access', send);
  app.put('/api/parents/:childId/runs/:runId/integrity/:itemId/approve', send);
}
