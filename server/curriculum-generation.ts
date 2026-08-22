import type { Database } from 'better-sqlite3';

interface GenerationState {
  catalog: number;
  children: Map<string, number>;
}

const states = new WeakMap<Database, GenerationState>();

function stateFor(db: Database): GenerationState {
  const existing = states.get(db);
  if (existing !== undefined) return existing;
  const created: GenerationState = { catalog: 0, children: new Map() };
  states.set(db, created);
  return created;
}

export interface CurriculumGeneration {
  catalog: number;
  child: number;
}

export function readCurriculumGeneration(db: Database, childId: string): CurriculumGeneration {
  const state = stateFor(db);
  return { catalog: state.catalog, child: state.children.get(childId) ?? 0 };
}

export function invalidateCatalogCurricula(db: Database): void {
  stateFor(db).catalog += 1;
}

export function invalidateChildCurriculum(db: Database, childId: string): void {
  const state = stateFor(db);
  state.children.set(childId, (state.children.get(childId) ?? 0) + 1);
}
