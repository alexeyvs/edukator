import type { Database } from 'better-sqlite3';
import type { Topic, TopicGraph } from './curriculum.js';
import { readProfile, SUBJECTS, type Profile, type Subject } from './db.js';
import {
  claimLearningMaterial,
  rejectLearningMaterial,
  retireLearningMaterial,
} from './learning.js';
import { isGap, readTopicStates, stateOf } from './mastery.js';
import { questionFingerprint } from './normalize.js';
import { rankTopics } from './scheduler.js';
import { recentQuestions, reserveLearningTasks } from './codex/bank.js';
import {
  CodexUnavailableError,
  type CodexRunner,
} from './codex/client.js';
import type { CodexConcurrency } from './codex/concurrency.js';
import { codexConcurrency } from './codex/concurrency.js';
import { generateTaskBatch } from './codex/generate.js';
import {
  generateLearningMaterial,
  validateLearningMaterial,
  type LearningErrorContext,
} from './codex/learning-material.js';
import type { LearningMaterialContent } from './codex/learning-material-schema.js';
import { taskPromptText, type GeneratedTask } from './codex/task-schema.js';
import { validateTaskBatch } from './codex/validate.js';

export const MAX_READY_LEARNING_MATERIALS = 3;
export const MAX_LEARNING_TASK_BATCHES = 4;
export const RECENT_LEARNING_ERRORS = 5;

export interface LearningTopicCandidate {
  topic: Topic;
  mastery: number;
  priority: number;
  recommendationReason: string;
}

export interface LearningProduceRequest {
  topic: Topic;
  prerequisites: Topic[];
  profile: Profile;
  recentErrors: LearningErrorContext[];
  previousApproaches: string[];
  recent: string[];
}

export interface LearningPackage {
  content: LearningMaterialContent;
  tasks: GeneratedTask[];
}

export type LearningProducer = (request: LearningProduceRequest) => Promise<LearningPackage>;
export type LearningLog = (message: string) => void;

export interface LearningPreparationItem {
  topicId: string;
  materialId: number;
  ready: boolean;
  recovered: boolean;
  stored: number;
  error?: string;
}

export interface LearningPreparationReport {
  candidates: string[];
  retired: number[];
  prepared: LearningPreparationItem[];
  codexUnavailable: boolean;
}

function completedTriageSubjects(db: Database): Set<Subject> {
  return new Set(db.prepare<[], { subject: Subject }>(
    `SELECT DISTINCT subject FROM runs
      WHERE kind = 'triage' AND finished_at IS NOT NULL AND summary IS NOT NULL`,
  ).all().map((row) => row.subject));
}

function closedTopics(db: Database): Set<string> {
  return new Set(db.prepare<[], { topic_id: string }>(
    'SELECT topic_id FROM topic_state WHERE closed_at IS NOT NULL',
  ).all().map((row) => row.topic_id));
}

/** Лучшая подтверждённая пробельная тема каждого уже прошедшего триаж предмета. */
export function selectLearningTopics(
  db: Database,
  graph: TopicGraph,
  now: Date = new Date(),
): LearningTopicCandidate[] {
  const triaged = completedTriageSubjects(db);
  if (triaged.size === 0) return [];
  const states = readTopicStates(db);
  const closed = closedTopics(db);
  const profile = readProfile(db);
  const candidates: LearningTopicCandidate[] = [];

  for (const subject of SUBJECTS) {
    if (!triaged.has(subject)) continue;
    const ranked = rankTopics(graph, states, { now, examDate: profile.examDate }, subject).find(({ topic, state }) =>
      !closed.has(topic.id) && isGap(topic, state, now));
    if (ranked === undefined) continue;
    candidates.push({
      topic: ranked.topic,
      mastery: ranked.state.mastery,
      priority: ranked.priority,
      recommendationReason: ranked.state.attempts === 0
        ? `Важная тема ещё не проверялась на практике`
        : `Тема остаётся пробелом: освоение ${Math.round(ranked.state.mastery * 100)}%`,
    });
  }
  return candidates.sort((left, right) => right.priority - left.priority || left.topic.id.localeCompare(right.topic.id))
    .slice(0, MAX_READY_LEARNING_MATERIALS);
}

function retireResolvedMaterials(
  db: Database,
  graph: TopicGraph,
  now: Date,
): number[] {
  const states = readTopicStates(db);
  const rows = db.prepare<[], { id: number; topic_id: string }>(
    `SELECT id, topic_id FROM learning_materials
      WHERE status IN ('preparing', 'ready') ORDER BY id`,
  ).all();
  const retired: number[] = [];
  for (const row of rows) {
    const topic = graph.byId.get(row.topic_id);
    if (topic !== undefined && isGap(topic, stateOf(states, topic.id), now)) continue;
    if (retireLearningMaterial(db, row.id, { now })) retired.push(row.id);
  }
  return retired;
}

interface LiveMaterial {
  subject: Subject;
  topicId: string;
  status: 'preparing' | 'ready' | 'active';
}

function liveMaterials(db: Database): Map<Subject, LiveMaterial> {
  return new Map(db.prepare<[], { subject: Subject; topic_id: string; status: LiveMaterial['status'] }>(
    `SELECT subject, topic_id, status FROM learning_materials
      WHERE status IN ('preparing', 'ready', 'active') ORDER BY id`,
  ).all().map((row) => [row.subject, {
    subject: row.subject,
    topicId: row.topic_id,
    status: row.status,
  }]));
}

function recentErrors(db: Database, topicId: string): LearningErrorContext[] {
  return db.prepare<[string, number], LearningErrorContext>(
    `SELECT task_bank.question, attempts.answer
       FROM attempts JOIN task_bank ON task_bank.id = attempts.task_id
      WHERE attempts.topic_id = ? AND attempts.is_correct = 0
      ORDER BY attempts.created_at DESC, attempts.id DESC LIMIT ?`,
  ).all(topicId, RECENT_LEARNING_ERRORS).reverse();
}

function previousApproaches(db: Database, topicId: string): string[] {
  return db.prepare<[string], { content: string }>(
    `SELECT content FROM learning_materials
      WHERE topic_id = ? AND status = 'failed' AND content IS NOT NULL
      ORDER BY finished_at DESC, id DESC LIMIT 3`,
  ).all(topicId).flatMap(({ content }) => {
    try {
      const value = JSON.parse(content) as { introduction?: unknown };
      return typeof value.introduction === 'string' ? [value.introduction] : [];
    } catch {
      return [];
    }
  });
}

export function createLearningProducer(options: {
  run?: CodexRunner;
  model?: string;
  log?: LearningLog;
} = {}): LearningProducer {
  return async (request): Promise<LearningPackage> => {
    const common = {
      ...(options.run === undefined ? {} : { run: options.run }),
      ...(options.model === undefined ? {} : { model: options.model }),
    };
    const content = await generateLearningMaterial({
      topic: request.topic,
      prerequisites: request.prerequisites,
      profile: request.profile,
      recentErrors: request.recentErrors,
      previousApproaches: request.previousApproaches,
      ...common,
    });
    const verdict = await validateLearningMaterial({ topic: request.topic, material: content, ...common });
    if (!verdict.accepted) throw new Error(`Материал отклонён методистом: ${verdict.reason}`);

    const gathered: GeneratedTask[] = [];
    const fingerprints = new Set(request.recent.map(questionFingerprint));
    for (let batch = 0; batch < MAX_LEARNING_TASK_BATCHES && gathered.length < 5; batch += 1) {
      const generated = await generateTaskBatch({
        topic: request.topic,
        difficulty: request.topic.difficulty,
        profile: request.profile,
        recent: [...request.recent, ...gathered.map(taskPromptText)],
        count: 5 - gathered.length,
        lessonContent: content,
        ...common,
      });
      const checked = await validateTaskBatch({ topic: request.topic, tasks: generated.tasks, ...common });
      for (const rejection of checked.rejected) {
        options.log?.(`воркер: вопрос материала «${request.topic.id}» отбракован (${rejection.reason})`);
      }
      for (const task of checked.accepted) {
        const fingerprint = questionFingerprint(taskPromptText(task));
        if (fingerprint === '' || fingerprints.has(fingerprint)) continue;
        fingerprints.add(fingerprint);
        gathered.push(task);
        if (gathered.length === 5) break;
      }
    }
    if (gathered.length !== 5) {
      throw new Error(`Тест материала собран не полностью: ${gathered.length} из 5 вопросов`);
    }
    return { content, tasks: gathered };
  };
}

export interface PrepareLearningOptions {
  db: Database;
  graph: TopicGraph;
  now?: Date;
  produce?: LearningProducer;
  budget?: CodexConcurrency;
  run?: CodexRunner;
  model?: string;
  log?: LearningLog;
}

/** Поддерживает до трёх материалов, но не более одного живого на предмет. */
export async function prepareLearningMaterials(
  options: PrepareLearningOptions,
): Promise<LearningPreparationReport> {
  const now = options.now ?? new Date();
  const log = options.log ?? (() => undefined);
  const retired = retireResolvedMaterials(options.db, options.graph, now);
  const candidates = selectLearningTopics(options.db, options.graph, now);
  const live = liveMaterials(options.db);
  const producer = options.produce ?? createLearningProducer({
    log,
    ...(options.run === undefined ? {} : { run: options.run }),
    ...(options.model === undefined ? {} : { model: options.model }),
  });
  const budget = options.budget ?? codexConcurrency;
  const profile = readProfile(options.db);
  const prepared: LearningPreparationItem[] = [];
  let codexUnavailable = false;

  for (const candidate of candidates) {
    const current = live.get(candidate.topic.subject);
    if (
      codexUnavailable ||
      (current !== undefined && (current.status !== 'preparing' || current.topicId !== candidate.topic.id))
    ) continue;
    const claim = claimLearningMaterial(options.db, {
      subject: candidate.topic.subject,
      topicId: candidate.topic.id,
      recommendationReason: candidate.recommendationReason,
      masteryBefore: candidate.mastery,
      now,
    });
    if (claim === undefined) continue;
    live.set(candidate.topic.subject, {
      subject: candidate.topic.subject,
      topicId: candidate.topic.id,
      status: 'preparing',
    });
    try {
      const result = await budget.run(() => producer({
        topic: candidate.topic,
        prerequisites: candidate.topic.prereqs.flatMap((id) => {
          const topic = options.graph.byId.get(id);
          return topic === undefined ? [] : [topic];
        }),
        profile,
        recentErrors: recentErrors(options.db, candidate.topic.id),
        previousApproaches: previousApproaches(options.db, candidate.topic.id),
        recent: recentQuestions(options.db, candidate.topic.id),
      }));
      const published = reserveLearningTasks(
        options.db,
        claim.materialId,
        result.content,
        result.tasks,
        now,
      );
      if (!published.ready) {
        const error = 'полный тест столкнулся с уже сохранённым отпечатком';
        prepared.push({ topicId: candidate.topic.id, materialId: claim.materialId, ready: false,
          recovered: claim.recovered, stored: 0, error });
        log(`воркер: материал темы «${candidate.topic.id}» отклонён: ${error}`);
        continue;
      }
      prepared.push({ topicId: candidate.topic.id, materialId: claim.materialId, ready: true,
        recovered: claim.recovered, stored: published.stored.length });
      log(`воркер: материал темы «${candidate.topic.id}» готов`);
    } catch (error) {
      const unavailable = error instanceof CodexUnavailableError;
      codexUnavailable ||= unavailable;
      if (!unavailable) rejectLearningMaterial(options.db, claim.materialId, { now });
      const message = (error as Error).message;
      prepared.push({ topicId: candidate.topic.id, materialId: claim.materialId, ready: false,
        recovered: claim.recovered, stored: 0, error: message });
      log(`воркер: материал темы «${candidate.topic.id}» отложен: ${message}`);
    }
  }

  return {
    candidates: candidates.map(({ topic }) => topic.id),
    retired,
    prepared,
    codexUnavailable,
  };
}
