import type { Database } from 'better-sqlite3';
import type { TopicGraph } from './curriculum.js';
import type { Subject } from './db.js';
import { MIN_FORECAST_WEIGHT } from './forecast.js';
import { TRIAGE_TARGET } from './triage.js';

export interface SubjectCalibration {
  triagePassed: boolean;
  coveredTopics: number;
  targetTopics: number;
  calibrated: boolean;
}

interface CoveredTopicRow {
  subject: Subject;
  topic_id: string;
}

/**
 * Триаж нужен только для первичной калибровки. Завершённые обычные забеги
 * заменяют его, когда охватили столько же разных экзаменационных тем, сколько
 * проверил бы полный триаж.
 */
export function readSubjectCalibrations(
  db: Database,
  graph: TopicGraph,
): Map<Subject, SubjectCalibration> {
  const triaged = new Set(db.prepare<[], { subject: Subject }>(
    `SELECT DISTINCT subject FROM runs
      WHERE kind = 'triage' AND finished_at IS NOT NULL AND summary IS NOT NULL`,
  ).all().map(({ subject }) => subject));
  const covered = new Map<Subject, Set<string>>(graph.subjects.map((subject) => [subject, new Set()]));
  const rows = db.prepare<[], CoveredTopicRow>(
    `SELECT DISTINCT runs.subject, attempts.topic_id
       FROM runs JOIN attempts ON attempts.run_id = runs.id
      WHERE runs.kind = 'run' AND runs.finished_at IS NOT NULL AND runs.summary IS NOT NULL
        AND attempts.is_current = 1 AND attempts.affects_progress = 1`,
  ).all();

  for (const row of rows) {
    const topic = graph.byId.get(row.topic_id);
    if (topic?.subject !== row.subject || topic.examWeight < MIN_FORECAST_WEIGHT) continue;
    covered.get(row.subject)?.add(topic.id);
  }

  return new Map(graph.subjects.map((subject) => {
    const targetTopics = Math.min(
      TRIAGE_TARGET,
      (graph.bySubject.get(subject) ?? []).filter(
        (topic) => topic.examWeight >= MIN_FORECAST_WEIGHT,
      ).length,
    );
    const coveredTopics = covered.get(subject)?.size ?? 0;
    const triagePassed = triaged.has(subject);
    return [subject, {
      triagePassed,
      coveredTopics,
      targetTopics,
      calibrated: triagePassed || (targetTopics > 0 && coveredTopics >= targetTopics),
    }];
  }));
}

export function calibratedSubjects(db: Database, graph: TopicGraph): Set<Subject> {
  return new Set([...readSubjectCalibrations(db, graph)]
    .filter(([, calibration]) => calibration.calibrated)
    .map(([subject]) => subject));
}
