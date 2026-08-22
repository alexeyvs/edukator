/**
 * HTTP-обвязка профиля. Хранение и наложение патча живут в
 * `db.ts`; здесь только граница HTTP и текст знакомства из единой персоны.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { readPersonaIntroduction } from '../codex/prompt.js';
import {
  ProfileValidationError,
  readProfile,
  writeProfile,
  type Profile,
} from '../db.js';
import {
  ROUTE_ACCESS,
  failAuth,
  type TenantContext,
  type TenantContextResolver,
} from './tenant-context.js';

export interface ProfileRoutesOptions {
  context: TenantContextResolver;
  /** Путь параметром нужен для проверки ошибочной конфигурации. */
  personaPath?: string;
}

class BadRequest extends Error {}

function unavailable(context: TenantContext, reply: FastifyReply): FastifyReply | undefined {
  if (context.tenant.available()) return undefined;
  return reply.code(503).send({
    error: 'Профиль недоступен: файл базы заменён, нужен перезапуск',
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPatch(body: unknown): Partial<Profile> {
  if (!isObject(body)) throw new BadRequest('Тело профиля должно быть JSON-объектом');

  const allowed = new Set(['name', 'interests', 'examDate', 'partnerName']);
  const unknown = Object.keys(body).find((field) => !allowed.has(field));
  if (unknown !== undefined) throw new BadRequest(`Неизвестное поле профиля: ${unknown}`);

  if (body['name'] !== undefined && typeof body['name'] !== 'string') {
    throw new BadRequest('Поле name должно быть строкой');
  }
  if (body['partnerName'] !== undefined && typeof body['partnerName'] !== 'string') {
    throw new BadRequest('Поле partnerName должно быть строкой');
  }
  if (
    body['interests'] !== undefined &&
    (!Array.isArray(body['interests']) || body['interests'].some((item) => typeof item !== 'string'))
  ) {
    throw new BadRequest('Поле interests должно быть массивом строк');
  }
  if (
    body['examDate'] !== undefined &&
    body['examDate'] !== null &&
    typeof body['examDate'] !== 'string'
  ) {
    throw new BadRequest('Поле examDate должно быть ISO-датой или null');
  }

  return body;
}

function response(
  profile: Profile,
  options: ProfileRoutesOptions,
  context: TenantContext,
): Profile & { introduction: string; courses: unknown[] } {
  return {
    ...profile,
    introduction: readPersonaIntroduction(options.personaPath),
    courses: context.tenant.curriculum.courses.map(({ revisionId, ...course }) => ({
      ...course,
      revision: revisionId,
    })),
  };
}

/** Регистрирует чтение и частичную правку профиля. */
export function registerProfileRoutes(app: FastifyInstance, options: ProfileRoutesOptions): void {
  app.get('/api/profile', (request, reply) => {
    try {
      const context = options.context(request, { allow: ROUTE_ACCESS.child });
      const stopped = unavailable(context, reply);
      if (stopped !== undefined) return stopped;
      return reply.send(response(readProfile(context.tenant.db), options, context));
    } catch (error) {
      return failAuth(reply, error);
    }
  });

  app.put('/api/profile', (request, reply) => {
    try {
      const context = options.context(request, { allow: ROUTE_ACCESS.child });
      const stopped = unavailable(context, reply);
      if (stopped !== undefined) return stopped;
      return reply.send(
        response(writeProfile(context.tenant.db, readPatch(request.body)), options, context),
      );
    } catch (error) {
      if (
        error instanceof BadRequest ||
        error instanceof ProfileValidationError ||
        (error instanceof Error && /exam_date/u.test(error.message))
      ) {
        return reply.code(400).send({ error: (error as Error).message });
      }
      return failAuth(reply, error);
    }
  });
}

/** Рабочие URL отвечают явным 503, если база не поднялась. */
export function registerUnavailableProfile(app: FastifyInstance, reason: string): void {
  const send = (_request: unknown, reply: FastifyReply): FastifyReply =>
    reply.code(503).send({ error: `Профиль недоступен: ${reason}` });
  app.get('/api/profile', send);
  app.put('/api/profile', send);
}
