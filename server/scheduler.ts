import type { Database } from 'better-sqlite3';
import { readProfile, type Subject } from './db.js';
import type { Topic, TopicGraph } from './curriculum.js';
import {
  GAP_MASTERY,
  daysBetween,
  newTopicState,
  readTopicStates,
  type TopicState,
} from './mastery.js';

/**
 * Предпосылка считается освоенной с того же порога, с которого тема перестаёт
 * быть пробелом: разные пороги означали бы, что тема одновременно и «слабая»,
 * и «достаточная, чтобы строить на ней следующую».
 */
export const PREREQ_MASTERY = GAP_MASTERY;

/**
 * Потолок просрочки повторения в интервалах: тема, забытая на два интервала,
 * уже максимально срочная. Без потолка заброшенная на полгода тема с нулевым
 * весом обгоняла бы всё остальное.
 */
export const OVERDUE_CAP = 2;

/** За сколько дней до экзамена начинает расти срочность тяжёлых тем. */
export const EXAM_HORIZON_DAYS = 30;

/** Во сколько раз экзамен поднимает тему максимального веса в день X. */
export const EXAM_URGENCY_GAIN = 2;

/** Максимальный `exam_weight` по схеме карты тем. */
const MAX_EXAM_WEIGHT = 3;

/**
 * Надбавка к спросу предмета при распределении забегов дня: даже освоенный
 * предмет не выпадает из ротации совсем — экзаменов три, а не один.
 */
export const SUBJECT_FLOOR = 0.5;

export interface ScheduleOptions {
  now?: Date;
  /** ISO-дата `YYYY-MM-DD` из профиля либо `null`, пока она неизвестна. */
  examDate?: string | null;
  /** Предмет предыдущего забега: следующий будет другим, если есть из чего выбрать. */
  lastSubject?: Subject | null;
}

/** Тема с посчитанными множителями: `priority` — то, по чему идёт сортировка. */
export interface RankedTopic {
  topic: Topic;
  state: TopicState;
  /** Все предпосылки освоены. Неготовая тема имеет нулевой приоритет. */
  ready: boolean;
  /** Произведение срочности повторения и срочности к дате экзамена. */
  urgency: number;
  priority: number;
}

export interface PlannedRun {
  subject: Subject;
  topic: Topic;
  priority: number;
}

/**
 * Состояние темы из карты. Недостающая строка — это ещё не выполненная
 * синхронизация, а не опечатка: состав тем задаёт карта, поэтому здесь
 * (в отличие от `readTopicState`) отсутствие строки равно нулевому состоянию.
 */
function stateOf(states: Map<string, TopicState>, topicId: string): TopicState {
  return states.get(topicId) ?? newTopicState(topicId);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Тема открыта, только когда все её предпосылки перевалили порог освоения. */
export function prereqsReady(topic: Topic, states: Map<string, TopicState>): boolean {
  return topic.prereqs.every((id) => stateOf(states, id).mastery >= PREREQ_MASTERY);
}

/**
 * Насколько тема просрочена по интервальному повторению: 0 — сразу после
 * попытки, 1 — ровно в `next_review`. Непроверенная тема считается
 * просроченной на один интервал: повторять нечего, но и знать о ней нечего.
 */
function overdueRatio(state: TopicState, now: Date): number {
  if (state.lastSeen === null || state.nextReview === null) return 1;

  const interval = daysBetween(state.lastSeen, state.nextReview);
  if (interval <= 0) return OVERDUE_CAP;

  return daysBetween(state.lastSeen, now) / interval;
}

/**
 * Множитель срочности повторения: 1 сразу после попытки, 2 в `next_review`,
 * дальше растёт до потолка просрочки.
 */
export function reviewUrgency(state: TopicState, now: Date = new Date()): number {
  return 1 + Math.min(overdueRatio(state, now), OVERDUE_CAP);
}

function daysUntilExam(now: Date, examDate: string): number {
  const exam = Date.parse(examDate);
  if (!Number.isFinite(exam)) {
    throw new Error(`Планировщик: некорректная дата экзамена «${examDate}», ожидается YYYY-MM-DD`);
  }
  return daysBetween(now, new Date(exam));
}

/**
 * Множитель срочности к дате экзамена: до горизонта планирования единица,
 * дальше растёт квадратично и тем сильнее, чем тяжелее тема. Квадрат, а не
 * линия, — чтобы последняя неделя перевешивала аккуратное равномерное
 * повторение, а месяц назад не искажала план.
 */
export function examUrgency(
  topic: { examWeight: number },
  now: Date,
  examDate: string | null | undefined,
): number {
  if (examDate === null || examDate === undefined || examDate === '') return 1;

  const left = daysUntilExam(now, examDate);
  const pressure = clamp01((EXAM_HORIZON_DAYS - left) / EXAM_HORIZON_DAYS) ** 2;

  return 1 + pressure * (topic.examWeight / MAX_EXAM_WEIGHT) * EXAM_URGENCY_GAIN;
}

/**
 * `priority = exam_weight × (1 − mastery) × prereqs_ready × urgency`.
 * Ноль означает «предлагать нечего»: тема вне экзамена, освоенная полностью
 * или закрытая неосвоенной предпосылкой.
 */
export function topicPriority(
  topic: Topic,
  states: Map<string, TopicState>,
  options: ScheduleOptions = {},
): number {
  return rankTopic(topic, states, options).priority;
}

function rankTopic(
  topic: Topic,
  states: Map<string, TopicState>,
  options: ScheduleOptions,
): RankedTopic {
  const now = options.now ?? new Date();
  const state = stateOf(states, topic.id);
  const ready = prereqsReady(topic, states);
  const urgency = reviewUrgency(state, now) * examUrgency(topic, now, options.examDate);

  return {
    topic,
    state,
    ready,
    urgency,
    priority: topic.examWeight * (1 - state.mastery) * (ready ? 1 : 0) * urgency,
  };
}

/** Сравнение для сортировки: по приоритету, затем по весу, затем по `id` — ради воспроизводимости. */
function byPriority(left: RankedTopic, right: RankedTopic): number {
  return (
    right.priority - left.priority ||
    right.topic.examWeight - left.topic.examWeight ||
    left.topic.id.localeCompare(right.topic.id)
  );
}

/** Все темы карты (или одного предмета) по убыванию приоритета, включая нулевые. */
export function rankTopics(
  graph: TopicGraph,
  states: Map<string, TopicState>,
  options: ScheduleOptions = {},
  subject?: Subject,
): RankedTopic[] {
  const topics = subject === undefined ? [...graph.byId.values()] : (graph.bySubject.get(subject) ?? []);
  return topics.map((topic) => rankTopic(topic, states, options)).sort(byPriority);
}

/**
 * Тема забега: максимум приоритета внутри предмета. `null` — предлагать нечего:
 * предмета нет в карте, всё освоено или всё закрыто предпосылками.
 */
export function selectTopic(
  graph: TopicGraph,
  states: Map<string, TopicState>,
  subject: Subject,
  options: ScheduleOptions = {},
  exclude: ReadonlySet<string> = new Set(),
): RankedTopic | null {
  const best = rankTopics(graph, states, options, subject).find(
    (item) => item.priority > 0 && !exclude.has(item.topic.id),
  );
  return best ?? null;
}

/**
 * Отставание предмета: взвешенная недоосвоенность по темам, которые вообще
 * встречаются на экзамене (`exam_weight ≥ 1`). 0 — предмет освоен, 1 — не начат.
 */
export function subjectDeficit(
  graph: TopicGraph,
  states: Map<string, TopicState>,
  subject: Subject,
): number {
  let weight = 0;
  let deficit = 0;
  for (const topic of graph.bySubject.get(subject) ?? []) {
    if (topic.examWeight < 1) continue;
    weight += topic.examWeight;
    deficit += topic.examWeight * (1 - stateOf(states, topic.id).mastery);
  }
  return weight === 0 ? 0 : deficit / weight;
}

/**
 * Предмет следующего забега: самый отстающий из тех, где есть что предложить.
 * Предмет предыдущего забега пропускается — кроме случая, когда кандидаты
 * остались только в нём: сидеть без дела хуже, чем два раза подряд по математике.
 */
export function selectSubject(
  graph: TopicGraph,
  states: Map<string, TopicState>,
  options: ScheduleOptions = {},
  exclude: ReadonlySet<string> = new Set(),
  assigned: ReadonlyMap<Subject, number> = new Map(),
): Subject | null {
  const available = graph.subjects.filter(
    (subject) => selectTopic(graph, states, subject, options, exclude) !== null,
  );
  if (available.length === 0) return null;

  const last = options.lastSubject ?? null;
  const pool = available.length > 1 ? available.filter((subject) => subject !== last) : available;
  if (pool.length === 0) return null;

  // Спрос делится на число уже назначенных забегов: так отстающий получает
  // больше, но остальные предметы не выпадают из плана совсем.
  const demand = (subject: Subject): number =>
    (SUBJECT_FLOOR + subjectDeficit(graph, states, subject)) / (1 + (assigned.get(subject) ?? 0));

  return pool.reduce((best, subject) => (demand(subject) > demand(best) ? subject : best));
}

/**
 * План забегов: последовательность «предмет + тема». Тема внутри плана не
 * повторяется — иначе один и тот же максимум приоритета занял бы весь день,
 * ведь состояние между забегами плана ещё не обновилось.
 */
export function planRuns(
  graph: TopicGraph,
  states: Map<string, TopicState>,
  count: number,
  options: ScheduleOptions = {},
): PlannedRun[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`Планировщик: число забегов должно быть неотрицательным целым (${count})`);
  }

  const plan: PlannedRun[] = [];
  const used = new Set<string>();
  const assigned = new Map<Subject, number>();
  let last = options.lastSubject ?? null;

  for (let index = 0; index < count; index += 1) {
    const subject = selectSubject(graph, states, { ...options, lastSubject: last }, used, assigned);
    if (subject === null) break;

    const chosen = selectTopic(graph, states, subject, options, used);
    if (chosen === null) break;

    plan.push({ subject, topic: chosen.topic, priority: chosen.priority });
    used.add(chosen.topic.id);
    assigned.set(subject, (assigned.get(subject) ?? 0) + 1);
    last = subject;
  }

  return plan;
}

/** Предмет последнего начатого забега: чтобы день не начинался с того же, чем кончился прошлый. */
export function lastRunSubject(db: Database): Subject | null {
  const row = db
    .prepare<[], { subject: Subject }>(
      'SELECT subject FROM runs ORDER BY started_at DESC, id DESC LIMIT 1',
    )
    .get();
  return row?.subject ?? null;
}

/**
 * План забегов по данным базы: состояния тем, дата экзамена из профиля и
 * предмет последнего забега берутся оттуда, карта тем — снаружи.
 */
export function planFromDatabase(
  db: Database,
  graph: TopicGraph,
  count: number,
  now: Date = new Date(),
): PlannedRun[] {
  return planRuns(graph, readTopicStates(db), count, {
    now,
    examDate: readProfile(db).examDate,
    lastSubject: lastRunSubject(db),
  });
}
