/** Фоновая подготовка всех тем родительского дня через общий конвейер разборов. */
import type { Database } from 'better-sqlite3';
import type { Topic, TopicGraph } from './curriculum.js';
import { readProfile } from './db.js';
import { activeDailyTopicSet, activateDailyTopicSet, dailyTopicSets } from './daily-topics.js';
import { claimLearningMaterial, rejectLearningMaterial } from './learning.js';
import { createLearningProducer, type LearningProducer } from './learning-prep.js';
import { readTopicStates, stateOf } from './mastery.js';
import { recentQuestions, reserveLearningTasks } from './codex/bank.js';
import type { CodexRunner } from './codex/client.js';
import { CodexConcurrency, codexConcurrency } from './codex/concurrency.js';

export interface PrepareDailyTopicsOptions {
  db: Database;
  graph: TopicGraph;
  now?: () => Date;
  producer?: LearningProducer;
  run?: CodexRunner;
  budget?: CodexConcurrency;
  log?: (message: string) => void;
}

/** Повторные запуски переживают рестарт сервера, поскольку считаются по claim в БД. */
export const MAX_DAILY_TOPIC_ATTEMPTS = 4;

function attemptsFor(db: Database, itemId: number): number {
  return db.prepare<[number], { count: number }>(
    'SELECT COUNT(*) AS count FROM learning_materials WHERE daily_item_id = ?',
  ).get(itemId)?.count ?? 0;
}

function topicFor(db: Database, graph: TopicGraph, topicId: string): Topic {
  const known = graph.byId.get(topicId);
  if (known !== undefined) {
    const course = graph.courses.get(known.subject);
    const courseTitle = known.courseTitle ?? course?.title;
    return { ...known,
      ...(courseTitle === undefined ? {} : { courseTitle }),
      grade: known.grade || course?.grade || '' };
  }
  const row = db.prepare<[string], {
    id: string; subject: string; title: string; prompt_seed: string;
    difficulty: number; exam_weight: number; answer_format: Topic['answerFormat'];
    course_title: string | null; grade: string | null;
  }>(
    `SELECT pt.id, pt.subject, pt.title, pt.prompt_seed, pt.difficulty,
            pt.exam_weight, pt.answer_format, pc.title AS course_title, pc.grade
       FROM personal_topics pt LEFT JOIN personal_courses pc ON pc.id = pt.subject
      WHERE pt.id = ?`,
  ).get(topicId);
  if (row === undefined) throw new Error(`Личная тема «${topicId}» не найдена`);
  const grades = [...new Set([...graph.courses.values()].map((course) => course.grade).filter(Boolean))];
  return {
    id: row.id,
    subject: row.subject,
    title: row.title,
    promptSeed: row.prompt_seed,
    difficulty: row.difficulty,
    examWeight: row.exam_weight,
    answerFormat: row.answer_format,
    prereqs: [],
    courseTitle: graph.courses.get(row.subject)?.title ?? row.course_title ?? row.subject,
    grade: graph.courses.get(row.subject)?.grade || row.grade || (grades.length === 1 ? grades[0] : '') || '',
  };
}

export async function prepareDailyTopics(options: PrepareDailyTopicsOptions): Promise<void> {
  const at = options.now?.() ?? new Date();
  const pending = dailyTopicSets(options.db, at).preparing;
  if (pending === null) return;
  const producer = options.producer ?? createLearningProducer({
    ...(options.run === undefined ? {} : { run: options.run }),
    ...(options.log === undefined ? {} : { log: options.log }),
  });
  const budget = options.budget ?? codexConcurrency;
  const profile = readProfile(options.db);
  const states = readTopicStates(options.db);
  const stillPreparing = options.db.prepare<[number], { id: number }>(
    "SELECT id FROM daily_topic_sets WHERE id = ? AND status = 'preparing'",
  );
  for (const item of pending.items) {
    if (stillPreparing.get(pending.id) === undefined) return;
    if (item.status === 'ready' || attemptsFor(options.db, item.id) >= MAX_DAILY_TOPIC_ATTEMPTS) continue;
    if (item.status === 'error') {
      options.db.prepare("UPDATE daily_topic_items SET status = 'preparing', material_id = NULL WHERE id = ?")
        .run(item.id);
    }
    const currentRevision = options.graph.courses.get(item.subject)?.revisionId ?? null;
    if (currentRevision !== item.courseRevisionId) {
      options.db.prepare("UPDATE daily_topic_items SET status = 'error', last_error = ? WHERE id = ?")
        .run('Редакция предмета изменилась. Проверьте и назначьте темы заново.', item.id);
      continue;
    }
    // После рестарта claim без готового теста не имеет исполнителя. Отменяем его
    // перед повтором; сохранённый готовый материал при этом не трогаем.
    if (item.materialId !== null && item.materialStatus === 'preparing') {
      rejectLearningMaterial(options.db, item.materialId, { now: options.now?.() ?? new Date() });
    }
    let topic: Topic;
    try {
      topic = topicFor(options.db, options.graph, item.topicId);
    } catch (error) {
      options.db.prepare("UPDATE daily_topic_items SET status = 'error', last_error = ? WHERE id = ?")
        .run(error instanceof Error ? error.message : String(error), item.id);
      continue;
    }
    const revision = item.courseRevisionId;
    const claim = claimLearningMaterial(options.db, {
      subject: topic.subject,
      topicId: topic.id,
      courseRevisionId: revision,
      dailyItemId: item.id,
      recommendationReason: 'Тема назначена родителем по школьным занятиям',
      masteryBefore: stateOf(states, topic.id).mastery,
      now: options.now?.() ?? new Date(),
    });
    if (claim === undefined) continue;
    options.db.prepare('UPDATE daily_topic_items SET material_id = ? WHERE id = ?')
      .run(claim.materialId, item.id);
    try {
      const result = await budget.run(() => producer({
        topic,
        prerequisites: topic.prereqs.flatMap((id) => {
          const prerequisite = options.graph.byId.get(id);
          return prerequisite === undefined ? [] : [prerequisite];
        }),
        profile,
        recentErrors: [],
        previousApproaches: [],
        recent: recentQuestions(options.db, topic.id, undefined, revision),
      }));
      if (stillPreparing.get(pending.id) === undefined) {
        rejectLearningMaterial(options.db, claim.materialId, { now: options.now?.() ?? new Date() });
        return;
      }
      const published = reserveLearningTasks(
        options.db,
        claim.materialId,
        result.content,
        result.tasks,
        options.now?.() ?? new Date(),
      );
      if (!published.ready) throw new Error('Не получилось собрать пять неповторяющихся вопросов');
      options.db.prepare("UPDATE daily_topic_items SET status = 'ready', last_error = NULL WHERE id = ?")
        .run(item.id);
      options.log?.(`дневная тема «${topic.title}» готова`);
    } catch (error) {
      rejectLearningMaterial(options.db, claim.materialId, { now: options.now?.() ?? new Date() });
      const message = error instanceof Error ? error.message : String(error);
      const retry = attemptsFor(options.db, item.id) < MAX_DAILY_TOPIC_ATTEMPTS;
      options.db.prepare('UPDATE daily_topic_items SET status = ?, last_error = ? WHERE id = ?')
        .run(retry ? 'preparing' : 'error', message.slice(0, 1000), item.id);
      options.log?.(`дневная тема «${topic.title}»: ${message}; ${retry ? 'повторим автоматически' : 'попытки исчерпаны'}`);
    }
  }
  // Новый запрос родителя мог отменить этот набор во время await. Решение
  // принимает транзакция по текущему статусу и московской дате.
  if (activeDailyTopicSet(options.db, options.now?.() ?? new Date())?.id !== pending.id) {
    activateDailyTopicSet(options.db, pending.id, options.now?.() ?? new Date());
  }
}
