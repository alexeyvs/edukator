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
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { TopicGraph } from '../curriculum.js';
import {
  clearComputerAccessOverride,
  setComputerAccessOverride,
  type ComputerAccessOverrideMode,
} from '../computer-access.js';
import { readDailyGate } from '../daily-gate.js';
import { verifyParentPin } from '../parent-pin.js';
import { readParentsDashboard, readParentsRunDetail } from '../parents.js';
import type { Bearer } from '../auth.js';
import {
  ROUTE_ACCESS,
  childIdParam,
  failAuth,
  type TenantContext,
  type TenantContextResolver,
} from './tenant-context.js';
import { integrityPublicJson } from './integrity.js';

export const PARENT_AUTH_FAILURE_LIMIT = 5;
export const PARENT_AUTH_WINDOW_MS = 5 * 60 * 1000;

type ComputerAccessMode = ComputerAccessOverrideMode | 'automatic';

interface AuthFailure {
  at: number;
}

export interface ParentsRoutesOptions {
  context: TenantContextResolver;
  graph: TopicGraph;
  /**
   * Эталон PIN родителя — только хешем и только по его `id`: PIN свой у каждой
   * семьи, и один общий на процесс означал бы, что чужой родитель управляет
   * доступом к компьютеру не своего ребёнка.
   */
  parentPinHash?: (parentId: string) => string | undefined;
  pinPepper?: string;
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
  const failures = new Map<string, AuthFailure[]>();

  function recentFailures(ip: string, at: number): AuthFailure[] {
    const cutoff = at - PARENT_AUTH_WINDOW_MS;
    const recent = (failures.get(ip) ?? []).filter((failure) => failure.at > cutoff);
    if (recent.length === 0) failures.delete(ip);
    else failures.set(ip, recent);
    return recent;
  }

  /** Эталон PIN родителя этого ребёнка; `undefined` — PIN не настроен. */
  function pinHash(context: TenantContext): string | undefined {
    return options.parentPinHash?.(context.child.parentId);
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

      const expected = pinHash(context);
      const current = now();
      if (needsPin(context.bearer)) {
        if (expected === undefined) {
          return reply.code(503).send({
            error: 'Управление доступом недоступно: PIN родителя не настроен',
          });
        }

        const at = current.getTime();
        const recent = recentFailures(request.ip, at);
        if (recent.length >= PARENT_AUTH_FAILURE_LIMIT) {
          const retryAfter = Math.max(
            1,
            Math.ceil(((recent[0]?.at ?? at) + PARENT_AUTH_WINDOW_MS - at) / 1000),
          );
          return reply.header('retry-after', retryAfter).code(429).send({
            error: 'Слишком много неверных попыток PIN, повторите позже',
          });
        }

        if (!verifyParentPin(expected, bearerPin(request), options.pinPepper)) {
          failures.set(request.ip, [...recent, { at }]);
          return reply.code(401).send({ error: 'Неверный PIN родителя' });
        }
        failures.delete(request.ip);
      }

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

      const expected = pinHash(context);
      if (needsPin(context.bearer)) {
        if (expected === undefined) {
          return reply.code(503).send({
            error: 'Управление доступом недоступно: PIN родителя не настроен',
          });
        }
        const at = now().getTime();
        const recent = recentFailures(request.ip, at);
        if (recent.length >= PARENT_AUTH_FAILURE_LIMIT) {
          const retryAfter = Math.max(
            1,
            Math.ceil(((recent[0]?.at ?? at) + PARENT_AUTH_WINDOW_MS - at) / 1000),
          );
          return reply.header('retry-after', retryAfter).code(429).send({
            error: 'Слишком много неверных попыток PIN, повторите позже',
          });
        }
        if (!verifyParentPin(expected, bearerPin(request), options.pinPepper)) {
          failures.set(request.ip, [...recent, { at }]);
          return reply.code(401).send({ error: 'Неверный PIN родителя' });
        }
        failures.delete(request.ip);
      }

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
