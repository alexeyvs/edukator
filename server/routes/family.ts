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
 * Оператор под заходом сюда тоже не пишет. Аренды у этих маршрутов нет, и
 * второй замок имперсонации (`PRAGMA query_only` на соединении с базой ребёнка)
 * их не прикрывает: семья, устройства и PIN лежат в `control.db`. Поэтому
 * первый замок выписан здесь руками — и проверять его обязательно отдельным
 * тестом, потому что общая матрица допуска этих маршрутов не видит.
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
  isMutating,
  resolveBearer,
  type ImpersonationMark,
} from '../auth.js';
import { hashParentPin, readParentPin, readPinPepper } from '../parent-pin.js';
import { provisionChildDatabase } from '../data-dir.js';
import {
  assignCourseWithExclusions,
  listCourseAssignments,
  unassignCourse,
  type CourseAssignment,
} from '../course-assignments.js';
import { listCourses, readRevisionTopics } from '../course-catalog.js';
import { isCourseId, type CourseId } from '../db.js';

const FAMILY_COURSE_ID_MAX_LENGTH = 80;
const FAMILY_TOPIC_ID_MAX_LENGTH = 180;
const FAMILY_EXCLUSIONS_MAX = 500;

export interface FamilyRoutesOptions {
  control: Database;
  /** Каталог данных: в нём заводится база нового ребёнка. */
  dataDir: string;
  /**
   * Серверный pepper для PIN. Без него PIN не поставить: хеш, посчитанный «как
   * нибудь», перебирается по дампу базы за секунды.
   */
  pinPepper?: string;
  /**
   * Отказ первого замка имперсонации. Проброшен насквозь по той же причине, что
   * и у аренды: считает отказы тот, кто пишет запись о конце захода.
   */
  onReadOnly?: (impersonation: ImpersonationMark) => void;
  /** Голый http разрешён как свой источник. Только локальная разработка. */
  insecureCookies?: boolean;
  now?: () => Date;
}

/** Ребёнок в ответе: состояние базы и список устройств, без единого токена. */
interface FamilyChild extends ChildSummary {
  devices: DeviceSummary[];
  courses: readonly CourseAssignment[];
}

interface FamilyCourseBody {
  excludedTopicIds?: string[];
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

function courseIdParam(params: unknown): CourseId | undefined {
  const courseId = (params as { courseId?: unknown }).courseId;
  return typeof courseId === 'string' && courseId.length <= FAMILY_COURSE_ID_MAX_LENGTH && isCourseId(courseId)
    ? courseId
    : undefined;
}

function readCourseBody(body: unknown): FamilyCourseBody | undefined {
  if (body === undefined) return {};
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const fields = body as Record<string, unknown>;
  if (Object.keys(fields).some((key) => key !== 'excludedTopicIds')) return undefined;
  const raw = fields['excludedTopicIds'];
  if (raw === undefined) return {};
  if (
    !Array.isArray(raw) ||
    raw.length > FAMILY_EXCLUSIONS_MAX ||
    raw.some((item) => typeof item !== 'string' || item.length === 0 || item.length > FAMILY_TOPIC_ID_MAX_LENGTH) ||
    new Set(raw).size !== raw.length
  ) return undefined;
  return { excludedTopicIds: raw as string[] };
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
      assertSameOrigin(request.method, request.headers, false, options.insecureCookies === true);
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
    // Первый замок имперсонации стоит и здесь, хотя аренды у этих маршрутов
    // нет. Второй замок их не прикрывает вовсе: `PRAGMA query_only` стоит на
    // соединении с базой ребёнка, а состав семьи, устройства и PIN живут в
    // `control.db`. Без этой проверки оператор под заходом заводил бы чужих
    // детей и выпускал бы ссылки на чужие устройства — то есть выдавал бы себе
    // постоянный токен, переживающий пятнадцатиминутный срок захода.
    if (bearer.impersonation !== undefined && isMutating(request.method)) {
      options.onReadOnly?.(bearer.impersonation);
      fail(
        reply,
        new AuthError(
          'read-only',
          `Оператор ${bearer.impersonation.adminId} смотрит чужую семью и не меняет её`,
        ),
      );
      return undefined;
    }
    return bearer.parent;
  }

  /**
   * Отказ допуска. Код едет рядом с текстом по той же причине, что и у
   * `failAuth`: «только просмотр», «доступ закрыт» и «запрос пришёл не со
   * страницы» отвечают одним 403, и без кода клиент показал бы работающий
   * замок экраном поломки.
   */
  function fail(reply: FastifyReply, error: AuthError): FastifyReply {
    return reply
      .code(AUTH_STATUS[error.code])
      .send({ error: AUTH_MESSAGE[error.code], code: error.code });
  }

  /** Ребёнок со своими устройствами. Отпечатков и токенов в этом виде нет. */
  function withDevices(child: ChildSummary): FamilyChild {
    const publishedCourseIds = new Set(
      listCourses(control)
        .filter((course) => course.status === 'published' && course.activeRevisionId !== null)
        .map((course) => course.id),
    );
    return {
      ...child,
      devices: listDevices(control, child.id),
      courses: listCourseAssignments(control, child.id)
        .filter((assignment) => publishedCourseIds.has(assignment.courseId)),
    };
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

  app.get('/api/family/courses', (request, reply) => {
    const parent = requireParent(request, reply);
    if (parent === undefined) return reply;

    const courses = listCourses(control)
      .filter((course) => course.status === 'published' && course.activeRevisionId !== null)
      .map((course) => ({
        courseId: course.id,
        title: course.title,
        grade: course.grade,
        revisionId: course.activeRevisionId as number,
        topics: readRevisionTopics(control, course.activeRevisionId as number)
          .filter((topic) => topic.active)
          .map((topic) => ({ id: topic.id, title: topic.title, prereqs: topic.prereqs })),
      }));
    return reply.send({ courses });
  });

  app.put('/api/family/children/:childId/courses/:courseId', (request, reply) => {
    const parent = requireParent(request, reply);
    if (parent === undefined) return reply;

    let child: ChildSummary;
    try {
      child = authorizeChild(
        control,
        { kind: 'parent', parent },
        (request.params as { childId: string }).childId,
      );
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      return fail(reply, error);
    }
    const courseId = courseIdParam(request.params);
    const body = readCourseBody(request.body);
    if (courseId === undefined || body === undefined) {
      return reply.code(400).send({ error: 'Некорректное назначение курса' });
    }
    const course = listCourses(control).find((item) => item.id === courseId);
    if (course?.status !== 'published' || course.activeRevisionId === null) {
      return reply.code(404).send({ error: 'Курс не найден' });
    }
    if (body.excludedTopicIds !== undefined) {
      const activeTopicIds = new Set(
        readRevisionTopics(control, course.activeRevisionId)
          .filter((topic) => topic.active)
          .map((topic) => topic.id),
      );
      if (body.excludedTopicIds.some((topicId) => !activeTopicIds.has(topicId))) {
        return reply.code(400).send({ error: 'Исключать можно только активные темы курса' });
      }
    }

    const previous = listCourseAssignments(control, child.id);
    const wasAssigned = previous.some((assignment) => assignment.courseId === courseId);
    const assignment = assignCourseWithExclusions(control, child.id, courseId, body.excludedTopicIds, now());
    return reply.send({ assignment, idempotent: wasAssigned && body.excludedTopicIds === undefined });
  });

  app.delete('/api/family/children/:childId/courses/:courseId', (request, reply) => {
    const parent = requireParent(request, reply);
    if (parent === undefined) return reply;

    let child: ChildSummary;
    try {
      child = authorizeChild(
        control,
        { kind: 'parent', parent },
        (request.params as { childId: string }).childId,
      );
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      return fail(reply, error);
    }
    const courseId = courseIdParam(request.params);
    if (courseId === undefined) return reply.code(400).send({ error: 'Некорректный идентификатор курса' });
    const course = listCourses(control).find((item) => item.id === courseId);
    if (course?.status !== 'published' || course.activeRevisionId === null) {
      return reply.code(404).send({ error: 'Курс не найден' });
    }
    const active = listCourseAssignments(control, child.id).some((item) => item.courseId === courseId);
    const assignment = unassignCourse(control, child.id, courseId, now());
    return reply.send({ assignment: assignment ?? null, idempotent: !active });
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
  app.get('/api/family/courses', send);
  app.post('/api/family/children', send);
  app.post('/api/family/children/:id/provision', send);
  app.post('/api/family/children/:id/devices', send);
  app.post('/api/family/devices/:id/revoke', send);
  app.post('/api/family/pin', send);
  app.put('/api/family/children/:childId/courses/:courseId', send);
  app.delete('/api/family/children/:childId/courses/:courseId', send);
}
