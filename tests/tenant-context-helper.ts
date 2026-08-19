/**
 * Аренда для тестов маршрутов, которым нужна только база и признак подмены
 * файла: реестр, управляющая база и разбор предъявителя к их предмету
 * отношения не имеют.
 */
import type { Database } from 'better-sqlite3';
import { DisputeCoordinator } from '../server/dispute-coordinator.js';
import { loadCurriculum } from '../server/curriculum.js';
import {
  SINGLE_TENANT_CHILD_ID,
  singleTenantContext,
  type TenantContextResolver,
} from '../server/routes/tenant-context.js';
import type { Tenant } from '../server/tenant-registry.js';
import { createIntegrityCoordinator, type IntegrityCoordinator } from '../server/integrity.js';

export interface FakeTenantOptions {
  /** Привязано ли соединение к текущему файлу базы; по умолчанию да. */
  available?: () => boolean;
  /** Координатор споров; нужен только маршруту занятия. */
  disputes?: DisputeCoordinator;
  /** Координатор проверки осмысленности. */
  integrity?: IntegrityCoordinator;
}

/** Аренда поверх готового соединения. Путь и отпечаток здесь ничего не значат. */
export function fakeTenant(db: Database, options: FakeTenantOptions = {}): Tenant {
  const available = options.available ?? ((): boolean => true);
  // Координатор заводится по требованию: он читает карту тем с диска, а нужен
  // одному маршруту из восьми.
  let disputes = options.disputes;
  let integrity = options.integrity;
  return {
    childId: SINGLE_TENANT_CHILD_ID,
    path: ':memory:',
    db,
    file: '0:0',
    available,
    get disputes(): DisputeCoordinator {
      disputes ??= new DisputeCoordinator({
        db,
        graph: loadCurriculum(),
        available,
        background: () => undefined,
        log: () => undefined,
        review: () => Promise.reject(new Error('разбор спора в этом тесте не вызывается')),
      });
      return disputes;
    },
    get integrity(): IntegrityCoordinator {
      integrity ??= createIntegrityCoordinator({
        db,
        graph: loadCurriculum(),
        available,
        background: () => undefined,
        log: () => undefined,
        review: () => Promise.reject(new Error('проверка ответа в этом тесте не вызывается')),
        complete: () => ({}),
      });
      return integrity;
    },
  };
}

/** Разрешение аренды для маршрутов: один и тот же детский предъявитель. */
export function fakeContext(db: Database, options: FakeTenantOptions = {}): TenantContextResolver {
  return singleTenantContext(fakeTenant(db, options));
}
