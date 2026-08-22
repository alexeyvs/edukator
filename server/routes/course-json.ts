import type { TopicGraph } from '../curriculum.js';
import type { CourseId } from '../db.js';
import type { Tenant } from '../tenant-registry.js';

export interface CourseJson {
  courseId: CourseId;
  courseTitle: string;
  grade: string;
  revision: number | null;
}

/** Единые публичные метаданные курса для карточек учебного HTTP API. */
export function courseJson(graph: TopicGraph, courseId: CourseId): CourseJson {
  const course = graph.courses.get(courseId);
  if (course === undefined) throw new Error(`Курс «${courseId}» отсутствует в снимке программы`);
  const value = {
    courseId: course.courseId,
    courseTitle: course.title,
    grade: course.grade,
    revision: course.revisionId,
  };
  return value;
}

/** Даёт домену самому вернуть штатный 404, если run не существует. */
export function operationGraph(tenant: Tenant, runId: number): TopicGraph {
  const exists = tenant.db.prepare<[number], { found: number }>(
    'SELECT 1 AS found FROM runs WHERE id = ?',
  ).get(runId);
  return exists === undefined ? tenant.curriculum.graph : tenant.graphForRun(runId);
}
