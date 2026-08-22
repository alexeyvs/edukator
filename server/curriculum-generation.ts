import type { Database } from 'better-sqlite3';

interface GenerationState {
  catalog: number;
  children: Map<string, number>;
  dataVersion: number;
}

const states = new WeakMap<Database, GenerationState>();

function stateFor(db: Database): GenerationState {
  const existing = states.get(db);
  if (existing !== undefined) return existing;
  const dataVersion = Number(
    (db.prepare('PRAGMA data_version').get() as { data_version?: number } | undefined)?.data_version
      ?? 0,
  );
  const created: GenerationState = { catalog: 0, children: new Map(), dataVersion };
  states.set(db, created);
  return created;
}

export interface CurriculumGeneration {
  catalog: number;
  child: number;
}

export function readCurriculumGeneration(db: Database, childId: string): CurriculumGeneration {
  const state = stateFor(db);
  const dataVersion = Number(
    (db.prepare('PRAGMA data_version').get() as { data_version?: number } | undefined)?.data_version
      ?? state.dataVersion,
  );
  // Управляющую базу иногда меняет второй handle (CLI, тест, будущий worker).
  // SQLite data_version позволяет такому изменению не оставить snapshot вечным.
  if (dataVersion !== state.dataVersion) {
    state.dataVersion = dataVersion;
    state.catalog += 1;
  }
  return { catalog: state.catalog, child: state.children.get(childId) ?? 0 };
}

export function invalidateCatalogCurricula(db: Database): void {
  stateFor(db).catalog += 1;
}

export function invalidateChildCurriculum(db: Database, childId: string): void {
  const state = stateFor(db);
  state.children.set(childId, (state.children.get(childId) ?? 0) + 1);
}
