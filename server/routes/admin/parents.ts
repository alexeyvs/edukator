/**
 * HTTP-граница управления семьями из админки: завести семью, выпустить ссылку
 * на смену пароля и поставить пароль самому.
 *
 * Это первые изменяющие маршруты оператора поверх `control.db`, и оба замка
 * имперсонации их не касаются вовсе: аренды у них нет, а `createAdminContext`
 * смотрит только `__Host-edu_admin` и о заходах не знает. Заход оператору здесь
 * ничего не даёт и ничего не отнимает — он ходит своей же админской cookie.
 *
 * Три действия, а не одно, и в журнале они тоже три. Разница между ними не в
 * механике, а в том, кто после них знает пароль семьи: ссылку оператор только
 * передаёт, а поставленный им пароль — это вход, который потом ничем не
 * отличить от родительского. Свести их в одну запись значило бы стереть из
 * ленты ровно то, ради чего её читают.
 *
 * Открытый токен приглашения виден ровно в одном ответе — на выпуск. Ни в
 * журнал действий, ни в список семей он не попадает: в базе лежит только
 * отпечаток, а вторая копия ссылки, живущая дольше самой ссылки, — это вход в
 * семью для всякого, кто читает ленту.
 */
import type { Database } from 'better-sqlite3';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  MIN_PASSWORD_LENGTH,
  createParent,
  issueParentInvite,
  normalizeEmail,
  readParent,
  recordAdminAudit,
  setParentPassword,
  type ParentRecord,
} from '../../control-db.js';
import { MAX_SECRET_LENGTH } from '../../secrets.js';
import { ROUTE_ACCESS, failAuth, type AdminContextResolver } from '../tenant-context.js';

export interface AdminParentsRoutesOptions {
  context: AdminContextResolver;
  control: Database;
  now?: () => Date;
}

/** Что читает заведение семьи. Лишнее поле — повод отказать, как и на входе. */
function readEmailBody(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const fields = body as Record<string, unknown>;
  if (Object.keys(fields).length !== 1) return undefined;
  const email = fields['email'];
  return typeof email === 'string' ? email : undefined;
}

function readPasswordBody(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const fields = body as Record<string, unknown>;
  if (Object.keys(fields).length !== 1) return undefined;
  const password = fields['password'];
  return typeof password === 'string' ? password : undefined;
}

/**
 * Родитель в ответе: то же, что видит список семей, и ни одного отпечатка.
 *
 * `disabledAt` здесь нет намеренно: отключённому родителю оба изменяющих
 * маршрута отказывают 409 раньше, чем дойдут до ответа, — поле, которого не
 * бывает, читалось бы как «бывает, но сейчас пусто».
 */
function parentView(parent: ParentRecord): {
  parentId: string;
  email: string;
  hasPassword: boolean;
  hasPin: boolean;
  createdAt: string;
} {
  return {
    parentId: parent.id,
    email: parent.email,
    hasPassword: parent.hasPassword,
    hasPin: parent.hasPin,
    createdAt: parent.createdAt,
  };
}

export function registerAdminParentsRoutes(
  app: FastifyInstance,
  options: AdminParentsRoutesOptions,
): void {
  const now = options.now ?? ((): Date => new Date());
  const control = options.control;

  app.post('/api/admin/parents', (request, reply) => {
    let admin;
    try {
      admin = options.context(request, { allow: ROUTE_ACCESS.admin });
    } catch (error) {
      return failAuth(reply, error);
    }

    const email = readEmailBody(request.body);
    if (email === undefined) return reply.code(400).send({ error: 'Нужно поле email' });
    // Приведённый адрес нужен и записи в журнал: `createParent` приводит его
    // сам, и вторая проверка «а вдруг всё-таки не адрес» ниже была бы копией
    // этой, разъезжающейся с ней молча.
    const normalized = normalizeEmail(email);
    if (normalized === undefined) {
      return reply.code(400).send({ error: 'Адрес не похож на электронную почту' });
    }

    const at = now();
    try {
      // Родитель и его ссылка — одна транзакция: заведённый без приглашения
      // родитель не имеет входа вовсе, а второго заведения по тому же адресу
      // уже не сделать — `UNIQUE` отдаст 409 навсегда.
      const created = control.transaction(() => {
        const parentId = createParent(control, email, at);
        const invite = issueParentInvite(control, parentId, at);
        recordAdminAudit(
          control,
          { adminId: admin.admin.adminId, action: 'parent-create', parentId, detail: `семья ${normalized}` },
          at,
        );
        return { parentId, invite };
      }).immediate();

      const parent = readParent(control, created.parentId);
      if (parent === undefined) throw new Error('Заведённый родитель исчез из управляющей базы');
      return reply.code(201).send({
        parent: parentView(parent),
        invite: { path: `/invite/${created.invite.token}`, expiresAt: created.invite.expiresAt },
      });
    } catch (error) {
      // «Уже заведён» — не поломка и не отказ доступа: оператор видит адрес и
      // сам решит, выпускать ли этой семье новую ссылку.
      if (error instanceof Error && /уже заведён/u.test(error.message)) {
        return reply.code(409).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post('/api/admin/parents/:parentId/invite', (request, reply) => {
    let admin;
    try {
      admin = options.context(request, { allow: ROUTE_ACCESS.admin });
    } catch (error) {
      return failAuth(reply, error);
    }

    const parentId = (request.params as { parentId: string }).parentId;
    const parent = readParent(control, parentId);
    if (parent === undefined) return reply.code(404).send({ error: 'Семья не найдена' });
    if (parent.disabledAt !== undefined) {
      return reply.code(409).send({ error: 'Родитель отключён: ссылку ему не выпустить' });
    }

    const at = now();
    const invite = control.transaction(() => {
      const issued = issueParentInvite(control, parentId, at);
      recordAdminAudit(
        control,
        { adminId: admin.admin.adminId, action: 'parent-invite', parentId, detail: `ссылка на смену пароля: ${parent.email}` },
        at,
      );
      return issued;
    }).immediate();

    return reply.code(201).send({
      invite: { path: `/invite/${invite.token}`, expiresAt: invite.expiresAt },
    });
  });

  app.post('/api/admin/parents/:parentId/password', (request, reply) => {
    let admin;
    try {
      admin = options.context(request, { allow: ROUTE_ACCESS.admin });
    } catch (error) {
      return failAuth(reply, error);
    }

    const password = readPasswordBody(request.body);
    if (password === undefined) return reply.code(400).send({ error: 'Нужно поле password' });
    // Обе границы названы до поиска родителя: негодный пароль не станет годным
    // ни от какой семьи, а `scrypt` на него — способ занять процессор.
    if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_SECRET_LENGTH) {
      return reply.code(400).send({
        error: `Пароль должен быть от ${MIN_PASSWORD_LENGTH} до ${MAX_SECRET_LENGTH} знаков`,
      });
    }

    const parentId = (request.params as { parentId: string }).parentId;
    const parent = readParent(control, parentId);
    if (parent === undefined) return reply.code(404).send({ error: 'Семья не найдена' });
    if (parent.disabledAt !== undefined) {
      return reply.code(409).send({ error: 'Родитель отключён: пароль ему не поставить' });
    }

    const at = now();
    // `setParentPassword` хеширует **до** своей транзакции, поэтому запись в
    // журнал идёт отдельным вызовом: обернув оба одной, мы держали бы запись в
    // управляющей базе все десятки миллисекунд `scrypt`.
    setParentPassword(control, parentId, password, at);
    recordAdminAudit(
      control,
      { adminId: admin.admin.adminId, action: 'parent-password', parentId, detail: `пароль поставлен оператором: ${parent.email}` },
      at,
    );

    // Перечитывать родителя незачем: `setParentPassword` отказывает броском,
    // если не изменил ни строки, — то есть после его возврата пароль стоит
    // наверняка. Второй запрос отвечал бы на уже известный вопрос.
    return reply.send({ parent: { ...parentView(parent), hasPassword: true } });
  });
}

/** Заглушка управления семьями на сервере без управляющей базы. */
export function registerUnavailableAdminParents(app: FastifyInstance, reason: string): void {
  const send = (_request: unknown, reply: FastifyReply): FastifyReply =>
    reply.code(503).send({ error: `Управление семьями недоступно: ${reason}` });
  app.post('/api/admin/parents', send);
  app.post('/api/admin/parents/:parentId/invite', send);
  app.post('/api/admin/parents/:parentId/password', send);
}
