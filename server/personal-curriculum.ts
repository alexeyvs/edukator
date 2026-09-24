/** Постоянные темы ребёнка поверх опубликованных назначенных курсов. */
import type { Database } from 'better-sqlite3';
import { buildTopicGraph, type CourseMetadata, type Topic, type TopicGraph } from './curriculum.js';
import type { CurriculumSnapshot, SnapshotCourse } from './curriculum-provider.js';

interface PersonalTopicRow {
  id: string;
  subject: string;
  title: string;
  prompt_seed: string;
  difficulty: number;
  exam_weight: number;
  answer_format: Topic['answerFormat'];
  course_title: string | null;
  grade: string | null;
}

function activeRows(db: Database, subject?: string): PersonalTopicRow[] {
  return db.prepare<[string | null, string | null], PersonalTopicRow>(
    `SELECT pt.id, pt.subject, pt.title, pt.prompt_seed, pt.difficulty,
            pt.exam_weight, pt.answer_format, pc.title AS course_title, pc.grade
       FROM personal_topics pt
       LEFT JOIN personal_courses pc ON pc.id = pt.subject
      WHERE pt.active = 1 AND (? IS NULL OR pt.subject = ?)
      ORDER BY pt.created_at, pt.id`,
  ).all(subject ?? null, subject ?? null);
}

function topicFromRow(row: PersonalTopicRow, graph: TopicGraph): Topic {
  const course = graph.courses.get(row.subject);
  return {
    id: row.id,
    subject: row.subject,
    title: row.title,
    promptSeed: row.prompt_seed,
    difficulty: row.difficulty,
    examWeight: row.exam_weight,
    answerFormat: row.answer_format,
    prereqs: [],
    courseTitle: course?.title ?? row.course_title ?? row.subject,
    grade: course?.grade ?? row.grade ?? '',
  };
}

function metadataFor(graph: TopicGraph, rows: readonly PersonalTopicRow[]): CourseMetadata[] {
  const metadata = [...graph.courses.values()];
  const present = new Set(metadata.map((course) => course.courseId));
  for (const row of rows) {
    if (present.has(row.subject)) continue;
    metadata.push({
      courseId: row.subject,
      title: row.course_title ?? row.subject,
      grade: row.grade ?? '',
      revisionId: null,
    });
    present.add(row.subject);
  }
  return metadata;
}

export function personalCurriculumKey(db: Database): string {
  return JSON.stringify(activeRows(db));
}

export function mergePersonalCurriculum(db: Database, base: CurriculumSnapshot): CurriculumSnapshot {
  const rows = activeRows(db);
  if (rows.length === 0) return base;
  const graph = buildTopicGraph(
    [...base.graph.order, ...rows.map((row) => topicFromRow(row, base.graph))],
    metadataFor(base.graph, rows),
  );
  const known = new Set(base.courses.map((course) => course.courseId));
  const courses: SnapshotCourse[] = [...base.courses];
  for (const course of graph.courses.values()) {
    if (known.has(course.courseId)) continue;
    courses.push({ ...course, revisionId: 0 });
    known.add(course.courseId);
  }
  return { ...base, courses, graph };
}

/** Для уже начатого забега: опубликованная редакция закреплена, личные темы постоянны. */
export function mergePersonalRunGraph(db: Database, base: TopicGraph, subject: string): TopicGraph {
  const rows = activeRows(db, subject);
  if (rows.length === 0) return base;
  return buildTopicGraph(
    [...base.order, ...rows.map((row) => topicFromRow(row, base))],
    metadataFor(base, rows),
  );
}

export function personalOnlyGraph(db: Database, subject: string): TopicGraph {
  const empty = buildTopicGraph([]);
  const rows = activeRows(db, subject);
  if (rows.length === 0) throw new Error(`Личный предмет «${subject}» не найден`);
  return buildTopicGraph(rows.map((row) => topicFromRow(row, empty)), metadataFor(empty, rows));
}
