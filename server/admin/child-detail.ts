/**
 * Слой 3 статистики оператора: карточка **одного** названного ребёнка.
 *
 * Слой 2 отвечает на вопрос «что происходит вообще», а этот — на жалобу: «у
 * ребёнка не выдаются задания», «висит разбор», «босс не начинается». Поэтому
 * здесь нет ни обхода, ни кеша: открывается ровно та база, которую назвали,
 * читается один раз и закрывается (`readChildDatabase`). Кеш тут был бы вреден
 * прямо: по жалобе смотрят состояние **сейчас**, а пятиминутной давности снимок
 * отвечал бы на вопрос «что было до того, как я попросил перезапустить».
 *
 * **Содержания нет и здесь.** Ни `question`, ни `answer`, ни `resolution`, ни
 * `content` материала, ни `recommendation_reason` не выбираются ни одним
 * запросом: карточка показывает состояние и счётчики. Прочитать написанное
 * ребёнком можно только имперсонацией, а она попадает в `admin_audit` с именем
 * оператора и временем. Новое поле карточки обязано держаться того же правила.
 */
import type { Database } from 'better-sqlite3';
import {
  readChild,
  type ChildStatus,
  type ChildSummary,
} from '../control-db.js';
import type { TopicGraph } from '../curriculum.js';
import type { Subject } from '../db.js';
import { readDailyGate, type DailyGateState } from '../daily-gate.js';
import { readChildDatabase } from './child-readonly.js';

/** Банк и прогресс по одной теме: строка таблицы «почему нечего выдать». */
export interface AdminTopicCard {
  topicId: string;
  /** Название из карты тем. Его нет у темы, выпавшей из карты после правки. */
  title?: string;
  subject?: Subject;
  courseTitle?: string;
  grade?: string;
  revisionId?: number | null;
  mastery: number;
  attempts: number;
  /** Тема закрыта победой над боссом: заданий по ней больше не просят. */
  closedAt?: string;
  bank: {
    valid: number;
    pending: number;
    rejected: number;
    used: number;
    /** Занятое боссом и разбором: обычной выдаче эти задания не видны. */
    reserved: number;
  };
}

/** Персональный материал: где он застрял и сколько попыток теста было. */
export interface AdminMaterialCard {
  id: number;
  topicId: string;
  subject: Subject;
  status: string;
  createdAt: string;
  readyAt?: string;
  openedAt?: string;
  finishedAt?: string;
  /** Заданий теста зарезервировано: неполный набор — признак сорвавшейся сборки. */
  tasks: number;
  /** Сколько раз ребёнок проходил тест: повторы до зачёта считаются здесь же. */
  runs: number;
}

export interface AdminDisputeCard {
  id: number;
  attemptId: number;
  topicId: string;
  status: 'open' | 'upheld' | 'rejected';
  createdAt: string;
  resolvedAt?: string;
}

export interface AdminBossCard {
  id: number;
  topicId: string;
  status: string;
  createdAt: string;
  activatedAt?: string;
  finishedAt?: string;
  tasks: number;
}

/** Что известно о ребёнке из `control.db`: оно есть и тогда, когда базы нет. */
export interface AdminChildCard {
  generatedAt: string;
  childId: string;
  parentId: string;
  name: string;
  status: ChildStatus;
  createdAt: string;
  lastActivityAt?: string;
  retiredAt?: string;
}

/** Что прочитано из самой базы ребёнка. */
export interface AdminChildInside {
  schemaVersion: number;
  topics: AdminTopicCard[];
  materials: AdminMaterialCard[];
  disputes: AdminDisputeCard[];
  bosses: AdminBossCard[];
  gate: DailyGateState;
}

/**
 * Карточка ребёнка. Три состояния, и сводить их к одному нельзя:
 *
 * - `read` — база прочитана;
 * - `stale` — схема не той версии, база **не** читалась и не менялась: ребёнок
 *   не заходил с прошлого обновления, и миграция принадлежит его первому заходу,
 *   а не отчёту оператора;
 * - `failed` — базы нет или она не открылась. У застрявшего `provisioning` так и
 *   должно быть, и пустая карточка вместо причины отправила бы оператора искать
 *   поломку не там.
 */
export type AdminChildDetail =
  | (AdminChildCard & { state: 'read' } & AdminChildInside)
  | (AdminChildCard & { state: 'stale'; schemaVersion: number })
  | (AdminChildCard & { state: 'failed'; reason: string });

export interface AdminChildDetailOptions {
  dataDir: string;
  graph?: TopicGraph;
  graphForChild?: (childId: string) => TopicGraph;
  childId: string;
  now?: Date;
}

interface TopicRow {
  topic_id: string;
  mastery: number;
  attempts: number;
  closed_at: string | null;
  valid: number;
  pending: number;
  rejected: number;
  used: number;
  reserved: number;
}

interface MaterialRow {
  id: number;
  topic_id: string;
  subject: Subject;
  status: string;
  created_at: string;
  ready_at: string | null;
  opened_at: string | null;
  finished_at: string | null;
  tasks: number;
  runs: number;
}

interface DisputeRow {
  id: number;
  attempt_id: number;
  topic_id: string;
  status: 'open' | 'upheld' | 'rejected';
  created_at: string;
  resolved_at: string | null;
}

interface BossRow {
  id: number;
  topic_id: string;
  status: string;
  created_at: string;
  activated_at: string | null;
  finished_at: string | null;
  tasks: number;
}

/** Темы, по которым есть что показать: тронутые ребёнком или с заданиями в банке. */
function readTopics(db: Database, graph: TopicGraph): AdminTopicCard[] {
  const rows = db
    .prepare<[], TopicRow>(
      `SELECT ts.topic_id, ts.mastery, ts.attempts, ts.closed_at,
              COALESCE(SUM(CASE WHEN tb.status = 'valid' THEN 1 ELSE 0 END), 0) AS valid,
              COALESCE(SUM(CASE WHEN tb.status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
              COALESCE(SUM(CASE WHEN tb.status = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected,
              COALESCE(SUM(CASE WHEN tb.status = 'used' THEN 1 ELSE 0 END), 0) AS used,
              COALESCE(SUM(CASE WHEN tb.status IN ('boss_reserved', 'lesson_reserved')
                                THEN 1 ELSE 0 END), 0) AS reserved
         FROM topic_state ts
         LEFT JOIN task_bank tb ON tb.topic_id = ts.topic_id
        GROUP BY ts.topic_id
        -- Нетронутых тем в карточке нет: их сотни, и «нет заданий по теме, до
        -- которой не дошли» — не жалоба, а нормальное состояние карты.
       HAVING ts.attempts > 0 OR COUNT(tb.id) > 0
        ORDER BY ts.topic_id`,
    )
    .all();
  return rows.map((row) => {
    const topic = graph.byId.get(row.topic_id);
    const course = topic === undefined ? undefined : graph.courses.get(topic.subject);
    return {
      topicId: row.topic_id,
      ...(topic === undefined ? {} : {
        title: topic.title,
        subject: topic.subject,
        courseTitle: course?.title ?? topic.subject,
        grade: course?.grade ?? '',
        revisionId: course?.revisionId ?? null,
      }),
      mastery: row.mastery,
      attempts: row.attempts,
      ...(row.closed_at === null ? {} : { closedAt: row.closed_at }),
      bank: {
        valid: row.valid,
        pending: row.pending,
        rejected: row.rejected,
        used: row.used,
        reserved: row.reserved,
      },
    };
  });
}

function readMaterials(db: Database): AdminMaterialCard[] {
  return db
    .prepare<[], MaterialRow>(
      `SELECT m.id, m.topic_id, m.subject, m.status, m.created_at,
              m.ready_at, m.opened_at, m.finished_at,
              (SELECT COUNT(*) FROM learning_tasks lt WHERE lt.material_id = m.id) AS tasks,
              (SELECT COUNT(*) FROM learning_runs lr WHERE lr.material_id = m.id) AS runs
         FROM learning_materials m
        ORDER BY m.created_at DESC, m.id DESC`,
    )
    .all()
    .map((row) => ({
      id: row.id,
      topicId: row.topic_id,
      subject: row.subject,
      status: row.status,
      createdAt: row.created_at,
      ...(row.ready_at === null ? {} : { readyAt: row.ready_at }),
      ...(row.opened_at === null ? {} : { openedAt: row.opened_at }),
      ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
      tasks: row.tasks,
      runs: row.runs,
    }));
}

function readDisputes(db: Database): AdminDisputeCard[] {
  return db
    .prepare<[], DisputeRow>(
      // Тема берётся у попытки: сам спор её не хранит, а без темы открытый спор
      // не отличить от чужого — оператор ищет, где именно встало занятие.
      `SELECT d.id, d.attempt_id, a.topic_id, d.status, d.created_at, d.resolved_at
         FROM disputes d
         JOIN attempts a ON a.id = d.attempt_id
        ORDER BY d.created_at DESC, d.id DESC`,
    )
    .all()
    .map((row) => ({
      id: row.id,
      attemptId: row.attempt_id,
      topicId: row.topic_id,
      status: row.status,
      createdAt: row.created_at,
      ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
    }));
}

function readBosses(db: Database): AdminBossCard[] {
  return db
    .prepare<[], BossRow>(
      `SELECT b.id, b.topic_id, b.status, b.created_at, b.activated_at, b.finished_at,
              (SELECT COUNT(*) FROM boss_tasks bt WHERE bt.batch_id = b.id) AS tasks
         FROM boss_batches b
        ORDER BY b.created_at DESC, b.id DESC`,
    )
    .all()
    .map((row) => ({
      id: row.id,
      topicId: row.topic_id,
      status: row.status,
      createdAt: row.created_at,
      ...(row.activated_at === null ? {} : { activatedAt: row.activated_at }),
      ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
      tasks: row.tasks,
    }));
}

function cardOf(child: ChildSummary, now: Date): AdminChildCard {
  return {
    generatedAt: now.toISOString(),
    childId: child.id,
    parentId: child.parentId,
    name: child.name,
    status: child.status,
    createdAt: child.createdAt,
    ...(child.lastActivityAt === undefined ? {} : { lastActivityAt: child.lastActivityAt }),
    ...(child.retiredAt === undefined ? {} : { retiredAt: child.retiredAt }),
  };
}

/**
 * Карточка названного ребёнка. `undefined` — такого ребёнка нет в управляющей
 * базе; отличать «нет такого» от «не ваш» здесь не от кого, но и открывать по
 * имени из адреса файл рядом с `children/` нельзя: путь считает
 * `readChildDatabase` из непрозрачного `id` и проверяет по `CHILD_ID_PATTERN`.
 */
export function readChildDetail(
  control: Database,
  options: AdminChildDetailOptions,
): AdminChildDetail | undefined {
  const child = readChild(control, options.childId);
  if (child === undefined) return undefined;
  const now = options.now ?? new Date();
  const card = cardOf(child, now);

  let result;
  try {
    const graph = options.graphForChild?.(child.id) ?? options.graph;
    if (graph === undefined) throw new Error(`Программа ребёнка ${child.id} недоступна`);
    result = readChildDatabase(options.dataDir, child.id, (db, meta): AdminChildInside => ({
      schemaVersion: meta.schemaVersion,
      topics: readTopics(db, graph),
      materials: readMaterials(db),
      disputes: readDisputes(db),
      bosses: readBosses(db),
      gate: readDailyGate(db, now),
    }));
  } catch (error) {
    // Отказ базы одного ребёнка — сама жалоба, а не помеха отчёту: карточка
    // остаётся с тем, что знает `control.db`, и называет причину.
    return {
      ...card,
      state: 'failed',
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (result.state === 'stale') {
    return { ...card, state: 'stale', schemaVersion: result.schemaVersion };
  }
  return { ...card, state: 'read', ...result.value };
}
