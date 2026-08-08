/**
 * HTTP-обвязка профиля. Хранение и наложение патча живут в
 * `db.ts`; здесь только граница HTTP и текст знакомства из единой персоны.
 */
import type { Database } from 'better-sqlite3';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { readPersonaIntroduction } from '../codex/prompt.js';
import { readProfile, writeProfile, type Profile } from '../db.js';

export interface ProfileRoutesOptions {
  db: Database;
  /** Путь параметром нужен для проверки ошибочной конфигурации. */
  personaPath?: string;
  /** Соединение всё ещё привязано к текущему файлу базы. */
  available?: () => boolean;
}

class BadRequest extends Error {}

function unavailable(options: ProfileRoutesOptions, reply: FastifyReply): FastifyReply | undefined {
  if (options.available?.() !== false) return undefined;
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

function response(profile: Profile, options: ProfileRoutesOptions): Profile & { introduction: string } {
  return {
    ...profile,
    introduction: readPersonaIntroduction(options.personaPath),
  };
}

/** Регистрирует чтение и частичную правку профиля. */
export function registerProfileRoutes(app: FastifyInstance, options: ProfileRoutesOptions): void {
  app.get('/api/profile', (_request, reply) => {
    const stopped = unavailable(options, reply);
    if (stopped !== undefined) return stopped;
    return reply.send(response(readProfile(options.db), options));
  });

  app.put('/api/profile', (request, reply) => {
    const stopped = unavailable(options, reply);
    if (stopped !== undefined) return stopped;
    try {
      return reply.send(response(writeProfile(options.db, readPatch(request.body)), options));
    } catch (error) {
      if (error instanceof BadRequest || (error instanceof Error && /exam_date/u.test(error.message))) {
        return reply.code(400).send({ error: (error as Error).message });
      }
      throw error;
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
