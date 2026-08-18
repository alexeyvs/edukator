import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { buildTopicGraph, syncTopicState, type Topic, type TopicGraph } from '../server/curriculum.js';
import { openDatabase, type Subject } from '../server/db.js';
import { readSubjectCalibrations } from '../server/subject-calibration.js';

const NOW = '2026-08-18T10:00:00.000Z';

function topic(id: string, subject: Subject, examWeight = 1): Topic {
  return {
    id,
    subject,
    title: `Тема ${id}`,
    examWeight,
    difficulty: 2,
    prereqs: [],
    answerFormat: 'number',
    promptSeed: `Карта ${id}`,
  };
}

function addRun(
  db: Database,
  subject: Subject,
  topicIds: readonly string[],
  options: { finished?: boolean; current?: boolean; affectsProgress?: boolean } = {},
): number {
  const finished = options.finished ?? true;
  const runId = Number(db.prepare(
    `INSERT INTO runs (subject, kind, topic_id, started_at, finished_at, summary)
     VALUES (?, 'run', ?, ?, ?, ?)`,
  ).run(
    subject,
    topicIds[0],
    NOW,
    finished ? NOW : null,
    finished ? '{}' : null,
  ).lastInsertRowid);
  const insertTask = db.prepare(
    `INSERT INTO task_bank (topic_id, question, answer, difficulty, status)
     VALUES (?, ?, '1', 2, 'used')`,
  );
  const insertAttempt = db.prepare(
    `INSERT INTO attempts
       (task_id, topic_id, run_id, answer, is_correct, is_current, affects_progress)
     VALUES (?, ?, ?, '1', 1, ?, ?)`,
  );
  topicIds.forEach((topicId, index) => {
    const taskId = Number(insertTask.run(topicId, `${runId}:${index}`).lastInsertRowid);
    insertAttempt.run(
      taskId,
      topicId,
      runId,
      options.current === false ? 0 : 1,
      options.affectsProgress === false ? 0 : 1,
    );
  });
  return runId;
}

describe('калибровка предмета', () => {
  let tempDir: string;
  let db: Database;
  let graph: TopicGraph;
  const mathTopics = Array.from({ length: 13 }, (_, index) => `math.${index + 1}`);

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-subject-calibration-'));
    db = openDatabase(join(tempDir, 'test.db'));
    graph = buildTopicGraph([
      ...mathTopics.map((id) => topic(id, 'math')),
      topic('math.outside-exam', 'math', 0),
      topic('russian.1', 'russian'),
      topic('russian.2', 'russian'),
      topic('english.1', 'english'),
    ]);
    syncTopicState(db, graph);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('приравнивает к триажу покрытие двенадцати экзаменационных тем', () => {
    addRun(db, 'math', mathTopics.slice(0, 11));
    expect(readSubjectCalibrations(db, graph).get('math')).toEqual({
      triagePassed: false,
      coveredTopics: 11,
      targetTopics: 12,
      calibrated: false,
    });

    addRun(db, 'math', [mathTopics[11] as string]);
    expect(readSubjectCalibrations(db, graph).get('math')).toEqual({
      triagePassed: false,
      coveredTopics: 12,
      targetTopics: 12,
      calibrated: true,
    });
  });

  it('не засчитывает незавершённые забеги, старые ответы и темы вне экзамена', () => {
    addRun(db, 'math', mathTopics.slice(0, 10));
    addRun(db, 'math', [mathTopics[10] as string], { finished: false });
    addRun(db, 'math', [mathTopics[11] as string], { current: false });
    addRun(db, 'math', [mathTopics[12] as string], { affectsProgress: false });
    addRun(db, 'math', ['math.outside-exam']);

    expect(readSubjectCalibrations(db, graph).get('math')).toMatchObject({
      coveredTopics: 10,
      calibrated: false,
    });
  });

  it('снижает цель для небольшой карты и сохраняет завершённый триаж', () => {
    addRun(db, 'russian', ['russian.1', 'russian.2']);
    expect(readSubjectCalibrations(db, graph).get('russian')).toEqual({
      triagePassed: false,
      coveredTopics: 2,
      targetTopics: 2,
      calibrated: true,
    });

    db.prepare(
      `INSERT INTO runs (subject, kind, topic_id, started_at, finished_at, summary)
       VALUES ('english', 'triage', 'english.1', ?, ?, '{}')`,
    ).run(NOW, NOW);
    expect(readSubjectCalibrations(db, graph).get('english')).toEqual({
      triagePassed: true,
      coveredTopics: 0,
      targetTopics: 1,
      calibrated: true,
    });
  });
});
