import type { Database } from 'better-sqlite3';
import { readRevisionGraph } from './course-catalog.js';
import { buildTopicGraph, type CourseMetadata, type Topic, type TopicGraph } from './curriculum.js';
import {
  readCurriculumGeneration,
  type CurriculumGeneration,
} from './curriculum-generation.js';
import type { CourseId } from './db.js';

export interface SnapshotCourse extends CourseMetadata {
  revisionId: number;
}

export interface CurriculumSnapshot {
  childId: string;
  generation: Readonly<CurriculumGeneration>;
  courses: readonly SnapshotCourse[];
  revisionIds: ReadonlyMap<CourseId, number>;
  graph: TopicGraph;
}

interface AssignedCourseRow {
  course_id: string;
  active_revision_id: number;
}

interface CachedSnapshot {
  generation: CurriculumGeneration;
  snapshot: CurriculumSnapshot;
}

function immutableMap<K, V>(source: ReadonlyMap<K, V>): Map<K, V> {
  const copy = new Map(source);
  return new Proxy(copy, {
    get(target, property): unknown {
      if (property === 'set' || property === 'delete' || property === 'clear') {
        return (): never => {
          throw new TypeError('CurriculumSnapshot неизменяем');
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function immutableGraph(graph: TopicGraph): TopicGraph {
  const topics = graph.order.map((topic): Topic => Object.freeze({
    ...topic,
    prereqs: Object.freeze([...topic.prereqs]) as string[],
  }));
  const byId = immutableMap(new Map<string, Topic>(topics.map((topic) => [topic.id, topic])));
  const bySubjectMutable = new Map<CourseId, Topic[]>();
  for (const topic of topics) {
    bySubjectMutable.set(topic.subject, [...(bySubjectMutable.get(topic.subject) ?? []), topic]);
  }
  for (const list of bySubjectMutable.values()) Object.freeze(list);
  const dependents = new Map<string, string[]>();
  for (const [topicId, ids] of graph.dependents) dependents.set(topicId, Object.freeze([...ids]) as string[]);
  const courses = new Map<CourseId, CourseMetadata>();
  for (const [courseId, metadata] of graph.courses) courses.set(courseId, Object.freeze({ ...metadata }));
  return Object.freeze({
    byId,
    order: Object.freeze(topics) as Topic[],
    dependents: immutableMap(dependents),
    bySubject: immutableMap(bySubjectMutable),
    courses: immutableMap(courses),
    subjects: Object.freeze([...graph.subjects]) as CourseId[],
  });
}

function sameGeneration(left: CurriculumGeneration, right: CurriculumGeneration): boolean {
  return left.catalog === right.catalog && left.child === right.child;
}

export class CurriculumProvider {
  readonly #cache = new Map<string, CachedSnapshot>();

  constructor(readonly db: Database) {}

  /**
   * Карта одной редакции для уже начатой операции. Она намеренно не проверяет
   * текущее назначение ребёнка: снятие курса не должно ломать сохранённый run.
   * У legacy-run без revision ID берётся активная редакция курса.
   */
  graphFor(courseId: CourseId, revisionId: number | null): TopicGraph {
    const row = revisionId === null
      ? this.db.prepare<[string], { revision_id: number }>(
          'SELECT active_revision_id AS revision_id FROM courses WHERE id = ? AND active_revision_id IS NOT NULL',
        ).get(courseId)
      : this.db.prepare<[number, string], { revision_id: number }>(
          'SELECT id AS revision_id FROM course_revisions WHERE id = ? AND course_id = ?',
        ).get(revisionId, courseId);
    if (row === undefined) {
      throw new Error(
        revisionId === null
          ? `У курса «${courseId}» нет активной редакции`
          : `Редакция ${String(revisionId)} не принадлежит курсу «${courseId}»`,
      );
    }
    return readRevisionGraph(this.db, row.revision_id);
  }

  get(childId: string): CurriculumSnapshot {
    const generation = readCurriculumGeneration(this.db, childId);
    const cached = this.#cache.get(childId);
    if (cached !== undefined && sameGeneration(cached.generation, generation)) return cached.snapshot;

    const exists = this.db
      .prepare<[string], { found: number }>('SELECT 1 AS found FROM children WHERE id = ?')
      .get(childId);
    if (exists === undefined) throw new Error(`Ребёнка ${childId} нет в управляющей базе`);

    const assigned = this.db
      .prepare<[string], AssignedCourseRow>(
        `SELECT c.id AS course_id, c.active_revision_id
           FROM child_courses cc
           JOIN courses c ON c.id = cc.course_id
          WHERE cc.child_id = ? AND cc.unassigned_at IS NULL
            AND c.status = 'published' AND c.active_revision_id IS NOT NULL
          ORDER BY cc.assigned_at, c.id`,
      )
      .all(childId);
    const allTopics: Topic[] = [];
    const metadata: SnapshotCourse[] = [];
    for (const row of assigned) {
      const excluded = new Set(
        this.db
          .prepare<[string, string], { topic_id: string }>(
            `SELECT topic_id FROM child_topic_exclusions
              WHERE child_id = ? AND course_id = ?`,
          )
          .all(childId, row.course_id)
          .map((item) => item.topic_id),
      );
      const revisionGraph = readRevisionGraph(this.db, row.active_revision_id);
      for (const topic of revisionGraph.order) {
        if (excluded.has(topic.id)) continue;
        allTopics.push({ ...topic, prereqs: topic.prereqs.filter((id) => !excluded.has(id)) });
      }
      const course = revisionGraph.courses.get(row.course_id);
      if (course === undefined) throw new Error(`У курса «${row.course_id}» нет метаданных`);
      metadata.push({ ...course, revisionId: row.active_revision_id });
    }

    const graph = immutableGraph(buildTopicGraph(allTopics, metadata));
    const courses = Object.freeze(metadata.map((course) => Object.freeze({ ...course })));
    const revisionIds = immutableMap(
      new Map<CourseId, number>(courses.map((course) => [course.courseId, course.revisionId])),
    );
    const snapshot: CurriculumSnapshot = Object.freeze({
      childId,
      generation: Object.freeze({ ...generation }),
      courses,
      revisionIds,
      graph,
    });
    this.#cache.set(childId, { generation, snapshot });
    return snapshot;
  }

  clear(): void {
    this.#cache.clear();
  }
}
