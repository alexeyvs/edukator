/** HTTP-граница снимка родителей и PIN-защищённого управления доступом. */
import type { Database } from 'better-sqlite3';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { TopicGraph } from '../curriculum.js';
import {
  clearComputerAccessOverride,
  setComputerAccessOverride,
  type ComputerAccessOverrideMode,
} from '../computer-access.js';
import { readDailyGate } from '../daily-gate.js';
import { verifyParentPin } from '../parent-pin.js';
import { readParentsDashboard } from '../parents.js';

export const PARENT_AUTH_FAILURE_LIMIT = 5;
export const PARENT_AUTH_WINDOW_MS = 5 * 60 * 1000;

type ComputerAccessMode = ComputerAccessOverrideMode | 'automatic';

interface AuthFailure {
  at: number;
}

export interface ParentsRoutesOptions {
  db: Database;
  graph: TopicGraph;
  parentPin?: string;
  now?: () => Date;
  available?: () => boolean;
}

function unavailable(options: ParentsRoutesOptions, reply: FastifyReply): FastifyReply | undefined {
  if (options.available?.() !== false) return undefined;
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

  app.get('/api/parents', (_request, reply) => {
    const stopped = unavailable(options, reply);
    if (stopped !== undefined) return stopped;
    const dashboard = readParentsDashboard(options.db, options.graph, now());
    return reply.send({
      ...dashboard,
      computerAccess: {
        ...dashboard.computerAccess,
        configured: options.parentPin !== undefined,
      },
    });
  });

  app.put('/api/parents/computer-access', (request, reply) => {
    const stopped = unavailable(options, reply);
    if (stopped !== undefined) return stopped;
    if (options.parentPin === undefined) {
      return reply.code(503).send({ error: 'Управление доступом недоступно: PIN родителя не настроен' });
    }

    const current = now();
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

    if (!verifyParentPin(options.parentPin, bearerPin(request))) {
      failures.set(request.ip, [...recent, { at }]);
      return reply.code(401).send({ error: 'Неверный PIN родителя' });
    }
    failures.delete(request.ip);

    const mode = readMode(request.body);
    if (mode === undefined) {
      return reply.code(400).send({
        error: 'Поле mode должно быть одним из: automatic, blocked, unlocked',
      });
    }
    if (mode === 'automatic') clearComputerAccessOverride(options.db);
    else setComputerAccessOverride(options.db, mode, current);
    return reply.send(readDailyGate(options.db, current));
  });
}

export function registerUnavailableParents(app: FastifyInstance, reason: string): void {
  const send = (_request: unknown, reply: FastifyReply): FastifyReply =>
    reply.code(503).send({ error: `Дашборд родителей недоступен: ${reason}` });
  app.get('/api/parents', send);
  app.put('/api/parents/computer-access', send);
}
