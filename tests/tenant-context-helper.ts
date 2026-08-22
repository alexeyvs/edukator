/**
 * Аренда для тестов маршрутов, которым нужна только база и признак подмены
 * файла: реестр, управляющая база и разбор предъявителя к их предмету
 * отношения не имеют.
 */
import type { Database } from 'better-sqlite3';
import { DisputeCoordinator } from '../server/dispute-coordinator.js';
import { loadCurriculum } from '../server/curriculum.js';
import { AuthError } from '../server/auth.js';
import type { ChildSummary } from '../server/control-db.js';
import type { TenantContextResolver } from '../server/routes/tenant-context.js';
import type { Tenant } from '../server/tenant-registry.js';
import type { IntegrityCoordinator } from '../server/integrity.js';

/**
 * Идентификатор ребёнка тестовой аренды. Вид настоящий (шестнадцатеричный, не
 * короче восьми знаков): формат `childId` проверяется до всякой базы, и
 * выдуманное «test» отвергалось бы разбором раньше, чем дошло до маршрута.
 */
export const FAKE_CHILD_ID = '00000000';

export interface FakeTenantOptions {
  /** Привязано ли соединение к текущему файлу базы; по умолчанию да. */
  available?: () => boolean;
  /** Координатор споров; нужен только маршруту занятия. */
  disputes?: DisputeCoordinator;
  /** Координатор проверки осмысленности; нужен только integrity-маршрутам. */
  integrity?: IntegrityCoordinator;
}

/** Аренда поверх готового соединения. Путь и отпечаток здесь ничего не значат. */
export function fakeTenant(db: Database, options: FakeTenantOptions = {}): Tenant {
  const available = options.available ?? ((): boolean => true);
  const graph = loadCurriculum();
  const courses = Object.freeze(graph.subjects.map((courseId) => Object.freeze({
    ...(graph.courses.get(courseId) as NonNullable<ReturnType<typeof graph.courses.get>>),
    revisionId: 0,
  })));
  // Координатор заводится по требованию: он читает карту тем с диска, а нужен
  // одному маршруту из восьми.
  let disputes = options.disputes;
  return {
    childId: FAKE_CHILD_ID,
    path: ':memory:',
    db,
    curriculum: Object.freeze({
      childId: FAKE_CHILD_ID,
      generation: Object.freeze({ catalog: 0, child: 0 }),
      courses,
      revisionIds: new Map(),
      graph,
    }),
    graphForRun: () => graph,
    file: '0:0',
    available,
    get disputes(): DisputeCoordinator {
      disputes ??= new DisputeCoordinator({
        db,
        graph,
        available,
        background: () => undefined,
        log: () => undefined,
        review: () => Promise.reject(new Error('разбор спора в этом тесте не вызывается')),
      });
      return disputes;
    },
    integrity: options.integrity ?? {
      begin: () => ({ status: 'checking', flagged: 0 }),
      status: () => null,
      retry: () => { throw new Error('повтор integrity в этом тесте не вызывается'); },
      approve: () => { throw new Error('подтверждение integrity в этом тесте не вызывается'); },
      stop: () => Promise.resolve(),
    },
  };
}

/**
 * Разрешение аренды для маршрутов: один и тот же детский предъявитель.
 *
 * Проверять оно умеет ровно одно — что названный в адресе ребёнок тот самый:
 * маршрут, потерявший `:childId`, обязан покраснеть и здесь, а не только на
 * рабочем разрешении. Всё остальное (cookie, принадлежность, источник) — дело
 * `server/auth.ts` и его собственных тестов.
 */
export function fakeContext(db: Database, options: FakeTenantOptions = {}): TenantContextResolver {
  const tenant = fakeTenant(db, options);
  const child: ChildSummary = {
    id: tenant.childId,
    parentId: tenant.childId,
    name: 'Ученик',
    status: 'ready',
    createdAt: new Date(0).toISOString(),
  };
  return (_request, context) => {
    if (context.childId !== undefined && context.childId !== tenant.childId) {
      throw new AuthError('no-child', `Ребёнок ${context.childId} не обслуживается`);
    }
    if (!context.allow.includes('browser')) {
      throw new AuthError('forbidden', 'Предъявителю browser сюда нельзя');
    }
    return {
      bearer: {
        kind: 'browser',
        child: {
          childId: tenant.childId,
          parentId: tenant.childId,
          deviceId: 1,
          kind: 'browser',
          name: child.name,
        },
      },
      child,
      tenant,
    };
  };
}
