/**
 * HTTP-граница управления семьёй: состав детей, ссылки-приглашения устройств,
 * отзыв устройства и родительский PIN.
 *
 * Сюда пускают ровно одного предъявителя — родительскую сессию. Ни детская
 * cookie, ни агентский токен здесь не годятся ни на что: за детской машиной
 * сидит ученик, и возможность выпустить оттуда новую ссылку или отозвать чужое
 * устройство означала бы, что состав семьи меняет тот, кем она управляет.
 * PIN сюда тоже не пускает: он подтверждает действие уже вошедшего родителя, а
 * не заменяет вход.
 *
 * Открытый токен приглашения виден ровно в одном ответе — на создание
 * устройства. Повторно его не покажет ни список, ни отдельное чтение: в базе
 * лежит только отпечаток, и «показать ссылку ещё раз» здесь невозможно не по
 * недосмотру, а по устройству хранения.
 */
import type { Database } from 'better-sqlite3';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  MAX_CHILD_NAME_LENGTH,
  MAX_DEVICE_LABEL_LENGTH,
  createChild,
  issueDeviceInvite,
  listChildren,
  listDevices,
  readChild,
  readDevice,
  readParentPinHash,
  revokeDevice,
  setParentPin,
  type ChildSummary,
  type DeviceKind,
  type DeviceSummary,
  type ParentPrincipal,
} from '../control-db.js';
import {
  AUTH_MESSAGE,
  AUTH_STATUS,
  AuthError,
  assertSameOrigin,
  authorizeChild,
  resolveBearer,
} from '../auth.js';
import { hashParentPin, readParentPin, readPinPepper } from '../parent-pin.js';
import { provisionChildDatabase } from '../data-dir.js';

export interface FamilyRoutesOptions {
  control: Database;
  /** Каталог данных: в нём заводится база нового ребёнка. */
  dataDir: string;
  /**
   * Серверный pepper для PIN. Без него PIN не поставить: хеш, посчитанный «как
   * нибудь», перебирается по дампу базы за секунды.
   */
  pinPepper?: string;
  now?: () => Date;
}

/** Ребёнок в ответе: состояние базы и список устройств, без единого токена. */
interface FamilyChild extends ChildSummary {
  devices: DeviceSummary[];
}

function readName(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const name = (body as Record<string, unknown>)['name'];
  return typeof name === 'string' ? name : undefined;
}

/** Что читает выпуск приглашения. Вид устройства обязателен, подпись — нет. */
function readDeviceBody(body: unknown): { kind: DeviceKind; label: string } | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const fields = body as Record<string, unknown>;
  const kind = fields['kind'];
  if (kind !== 'browser' && kind !== 'agent') return undefined;
  const label = fields['label'] ?? '';
  if (typeof label !== 'string') return undefined;
  return { kind, label };
}

function readPinBody(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const pin = (body as Record<string, unknown>)['pin'];
  return typeof pin === 'string' ? pin : undefined;
}

/**
 * Номер устройства из адреса. Всё, что не целое положительное, — не номер:
 * `Number('12abc')` даёт `NaN`, а `parseInt` принял бы такую строку молча.
 */
function deviceIdParam(params: unknown): number | undefined {
  const raw = (params as { id: string }).id;
  // Сначала форма, потом число: `Number` принял бы и `0x4`, и `1e3`, и ` 12 `,
  // то есть одно устройство адресовалось бы несколькими написаниями подряд. Тот
  // же порядок у остальных разборщиков номеров в маршрутах.
  if (!/^\d+$/u.test(raw)) return undefined;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

export function registerFamilyRoutes(app: FastifyInstance, options: FamilyRoutesOptions): void {
  const now = options.now ?? ((): Date => new Date());
  const control = options.control;

  /**
   * Родитель запроса или отказ. Проверка источника идёт первой: разбор
   * предъявителя подновляет отметки в управляющей базе, то есть пишет, и чужая
   * страница не должна уметь заставить нас это сделать.
   */
  function requireParent(
    request: FastifyRequest,
    reply: FastifyReply,
  ): ParentPrincipal | undefined {
    try {
      assertSameOrigin(request.method, request.headers);
    } catch (error) {
      fail(reply, error as AuthError);
      return undefined;
    }
    const bearer = resolveBearer(control, request.headers, now());
    if (bearer === undefined) {
      fail(reply, new AuthError('unauthenticated', 'Предъявитель не разобран'));
      return undefined;
    }
    if (bearer.kind !== 'parent') {
      fail(reply, new AuthError('forbidden', `Предъявителю ${bearer.kind} сюда нельзя`));
      return undefined;
    }
    return bearer.parent;
  }

  function fail(reply: FastifyReply, error: AuthError): FastifyReply {
    return reply.code(AUTH_STATUS[error.code]).send({ error: AUTH_MESSAGE[error.code] });
  }

  /** Ребёнок со своими устройствами. Отпечатков и токенов в этом виде нет. */
  function withDevices(child: ChildSummary): FamilyChild {
    return { ...child, devices: listDevices(control, child.id) };
  }

  app.get('/api/family', (request, reply) => {
    const parent = requireParent(request, reply);
    if (parent === undefined) return reply;

    return reply.send({
      email: parent.email,
      // Настроен ли PIN — это про состояние, а не про сам секрет: без флага
      // родитель не отличил бы «PIN не задан» от «действие почему-то не идёт».
      pinConfigured: readParentPinHash(control, parent.parentId) !== undefined,
      children: listChildren(control, parent.parentId).map(withDevices),
    });
  });

  app.post('/api/family/children', (request, reply) => {
    const parent = requireParent(request, reply);
    if (parent === undefined) return reply;

    const name = readName(request.body);
    if (name === undefined || name.trim() === '' || name.trim().length > MAX_CHILD_NAME_LENGTH) {
      return reply.code(400).send({
        error: `Имя ребёнка должно быть от 1 до ${MAX_CHILD_NAME_LENGTH} знаков`,
      });
    }

    const childId = createChild(control, parent.parentId, name, now());
    try {
      // База заводится тем же запросом: ребёнок без готовой базы не годится ни
      // маршрутам, ни воркеру, и оставить его ждать было бы нечему — фоновой
      // очереди заведения у нас нет.
      provisionChildDatabase(control, childId, options.dataDir);
    } catch (error) {
      // Ребёнок остаётся в базе со статусом `failed`: родитель видит его в
      // списке и понимает, что заведение сорвалось, а не гадает, куда он делся.
      process.stderr.write(`база ребёнка ${childId} не заведена: ${(error as Error).message}\n`);
      return reply.code(503).send({ error: 'База ребёнка не заведена, попробуйте позже' });
    }

    const child = readChild(control, childId);
    if (child === undefined) {
      return reply.code(503).send({ error: 'База ребёнка не заведена, попробуйте позже' });
    }
    return reply.code(201).send({ child: withDevices(child) });
  });

  app.post('/api/family/children/:id/provision', (request, reply) => {
    const parent = requireParent(request, reply);
    if (parent === undefined) return reply;

    const childId = (request.params as { id: string }).id;
    const child = readChild(control, childId);
    // Повтор нужен как раз `failed`/`provisioning`, поэтому общий
    // `authorizeChild` здесь не подходит: он намеренно допускает только
    // обслуживаемого `ready`-ребёнка. Чужой и отсутствующий снаружи всё равно
    // неразличимы.
    if (child === undefined || child.parentId !== parent.parentId || child.retiredAt !== undefined) {
      return fail(reply, new AuthError('no-child', 'Ребёнок не найден'));
    }

    try {
      // Вызов идемпотентен: после потерянного успешного ответа `ready`-ребёнок
      // с уже лежащей базой просто вернётся как есть, а оборванные состояния
      // продолжатся с безопасной точки протокола заведения.
      provisionChildDatabase(control, child.id, options.dataDir);
    } catch (error) {
      process.stderr.write(`база ребёнка ${child.id} повторно не заведена: ${(error as Error).message}\n`);
      return reply.code(503).send({ error: 'База ребёнка не заведена, попробуйте позже' });
    }

    const provisioned = readChild(control, child.id);
    if (provisioned === undefined) {
      return reply.code(503).send({ error: 'База ребёнка не заведена, попробуйте позже' });
    }
    return reply.send({ child: withDevices(provisioned) });
  });

  app.post('/api/family/children/:id/devices', (request, reply) => {
    const parent = requireParent(request, reply);
    if (parent === undefined) return reply;

    const body = readDeviceBody(request.body);
    if (body === undefined) {
      return reply.code(400).send({ error: 'Нужно поле kind: browser или agent' });
    }
    if (body.label.trim().length > MAX_DEVICE_LABEL_LENGTH) {
      return reply.code(400).send({
        error: `Подпись устройства длиннее ${MAX_DEVICE_LABEL_LENGTH} знаков`,
      });
    }

    let child: ChildSummary;
    try {
      // Принадлежность проверяет общий `authorizeChild`: у чужого и
      // несуществующего ребёнка снаружи обязан быть один и тот же ответ.
      child = authorizeChild(control, { kind: 'parent', parent }, (request.params as { id: string }).id);
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      return fail(reply, error);
    }

    const invite = issueDeviceInvite(control, child.id, body.kind, body.label, now());
    return reply.code(201).send({
      device: readDevice(control, invite.deviceId),
      // Единственный ответ, где открытый токен виден вообще. Ссылка отдаётся
      // путём, а не целым адресом: за обратным прокси серверу неизвестна ни
      // схема, ни внешнее имя, и склеенный им `http://` увёл бы родителя мимо
      // TLS. Целый адрес собирает клиент — он-то по нему и пришёл.
      invite: { token: invite.token, expiresAt: invite.expiresAt, path: `/join/${invite.token}` },
    });
  });

  app.post('/api/family/devices/:id/revoke', (request, reply) => {
    const parent = requireParent(request, reply);
    if (parent === undefined) return reply;

    const deviceId = deviceIdParam(request.params);
    const device = deviceId === undefined ? undefined : readDevice(control, deviceId);
    // Выведенный ребёнок отзыву не помеха: его устройства всё равно уже не
    // предъявители, но и отказывать в уборке за ними причины нет. Поэтому
    // принадлежность проверяется напрямую, а не через `authorizeChild`.
    const child = device === undefined ? undefined : readChild(control, device.childId);
    if (device === undefined || child === undefined || child.parentId !== parent.parentId) {
      return fail(reply, new AuthError('no-child', 'Устройство не найдено'));
    }

    // Повторный отзыв — не ошибка: родитель мог нажать дважды, а состояние от
    // этого не меняется. `revoked` показывает, сработал ли именно этот запрос.
    const revoked = revokeDevice(control, device.id, now());
    return reply.send({ revoked, device: readDevice(control, device.id) });
  });

  app.post('/api/family/pin', (request, reply) => {
    const parent = requireParent(request, reply);
    if (parent === undefined) return reply;

    const pepper = readPinPepper(options.pinPepper);
    if (pepper === undefined) {
      return reply.code(503).send({ error: 'PIN недоступен: серверный pepper не настроен' });
    }

    const pin = readPinBody(request.body);
    if (pin === undefined || readParentPin(pin) === undefined) {
      return reply.code(400).send({ error: 'PIN должен состоять из 6-12 цифр' });
    }

    setParentPin(control, parent.parentId, hashParentPin(pin, pepper));
    return reply.send({ pinConfigured: true });
  });
}

/** Заглушка управления семьёй на сервере без управляющей базы или карты тем. */
export function registerUnavailableFamily(app: FastifyInstance, reason: string): void {
  const send = (_request: unknown, reply: FastifyReply): FastifyReply =>
    reply.code(503).send({ error: `Управление семьёй недоступно: ${reason}` });
  app.get('/api/family', send);
  app.post('/api/family/children', send);
  app.post('/api/family/children/:id/provision', send);
  app.post('/api/family/children/:id/devices', send);
  app.post('/api/family/devices/:id/revoke', send);
  app.post('/api/family/pin', send);
}
