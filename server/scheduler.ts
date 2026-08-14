import type { Database } from 'better-sqlite3';
import { moscowDayBounds } from './moscow-time.js';
import { readProfile, type Subject } from './db.js';
import type { Topic, TopicGraph } from './curriculum.js';
import {
  GAP_MASTERY,
  clamp01,
  daysBetween,
  readTopicStates,
  stateOf,
  type TopicState,
} from './mastery.js';

/**
 * Предпосылка считается освоенной с того же порога, с которого тема перестаёт
 * быть пробелом: разные пороги означали бы, что тема одновременно и «слабая»,
 * и «достаточная, чтобы строить на ней следующую».
 */
export const PREREQ_MASTERY = GAP_MASTERY;

/**
 * Нижняя граница множителя готовности предпосылок. Тема с нетронутым
 * фундаментом получает не ноль, а этот пол, иначе срочность к экзамену не может
 * её разблокировать в принципе. Значения 0.15 и 0.2 в симуляции неразличимы.
 */
export const PREREQ_SOFT_FLOOR = 0.2;

/**
 * Потолок просрочки повторения в интервалах: тема, забытая на два интервала,
 * уже максимально срочная. Без потолка заброшенная на полгода тема с нулевым
 * весом обгоняла бы всё остальное.
 */
export const OVERDUE_CAP = 2;

/** За сколько дней до экзамена начинает расти срочность тяжёлых тем. */
export const EXAM_HORIZON_DAYS = 30;

/**
 * Надбавка к множителю срочности для темы максимального веса в день экзамена:
 * итоговый множитель равен `1 + EXAM_URGENCY_GAIN`, то есть втрое против
 * спокойного месяца.
 */
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
  /**
   * Забеги, уже назначенные предметам до этого плана. Метод делителей делит
   * спрос предмета на этот счётчик, а сервер выдаёт забеги по одному, а не днём
   * целиком: без переданного счёта каждый вызов начинал бы делёж заново, и
   * третий предмет выпадал бы из дня — ровно то, ради чего делители и вводились.
   */
  assigned?: ReadonlyMap<Subject, number>;
  /** Темы, уже использованные сегодня: повторять их в следующем плане нельзя. */
  used?: ReadonlySet<string>;
}

/** Тема с посчитанными множителями: `priority` — то, по чему идёт сортировка. */
export interface RankedTopic {
  topic: Topic;
  state: TopicState;
  /** Все предпосылки освоены. */
  ready: boolean;
  /** Множитель готовности предпосылок: 1 при `ready`, иначе от `PREREQ_SOFT_FLOOR` до 1. */
  readiness: number;
  /** Произведение срочности повторения и срочности к дате экзамена. */
  urgency: number;
  priority: number;
}

export interface PlannedRun {
  subject: Subject;
  topic: Topic;
  priority: number;
}

/** Все предпосылки темы перевалили порог освоения. */
export function prereqsReady(topic: Topic, states: Map<string, TopicState>): boolean {
  return topic.prereqs.every((id) => stateOf(states, id).mastery >= PREREQ_MASTERY);
}

/**
 * Насколько тема открыта предпосылками: 1 — все освоены, иначе средняя
 * готовность предпосылок, но не ниже `PREREQ_SOFT_FLOOR`.
 *
 * Множитель мягкий, а не затвор 0/1, потому что жёсткий ноль обнулял приоритет
 * целиком и `examUrgency` не мог его перебить: тема с неосвоенным фундаментом
 * не всплывала никогда, сколько бы ни оставалось до экзамена. На собранных
 * картах цепочки предпосылок доходят до девяти уровней.
 *
 * Замер на реальных картах (40 дней по 3 забега, 5 прогонов, темы с
 * `exam_weight ≥ 2`) — пропущено тем / освоено из 58:
 *
 * | точность | затвор 0/1 | мягкий множитель |
 * |----------|------------|------------------|
 * | 50%      | 11.0 / 33.4| 5.4 / 40.4       |
 * | 60%      | 4.8 / 48.8 | 3.2 / 50.6       |
 * | 75%      | 1.4 / 55.6 | 0.0 / 57.0       |
 *
 * Пропуски при слабой успеваемости уменьшаются вдвое, но не исчезают: остаток —
 * это нехватка бюджета (120 забегов на 69 тем при повторениях), а не затвор.
 */
export function prereqsReadiness(topic: Topic, states: Map<string, TopicState>): number {
  if (topic.prereqs.length === 0) return 1;
  if (prereqsReady(topic, states)) return 1;

  const total = topic.prereqs.reduce(
    (sum, id) => sum + Math.min(1, stateOf(states, id).mastery / PREREQ_MASTERY),
    0,
  );

  return Math.max(PREREQ_SOFT_FLOOR, total / topic.prereqs.length);
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
  const readiness = prereqsReadiness(topic, states);
  const urgency = reviewUrgency(state, now) * examUrgency(topic, now, options.examDate);

  return {
    topic,
    state,
    ready,
    readiness,
    urgency,
    priority: topic.examWeight * (1 - state.mastery) * readiness * urgency,
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
  // Умолчание из `options.used` — симметрично `assigned` у `selectSubject`.
  // Поле описано как «темы, уже занятые сегодня», и читающий его вызывающий без
  // этого получал бы их обратно молча: отсев работал только через позиционный
  // аргумент, который заполняет один `planRuns`.
  exclude: ReadonlySet<string> = options.used ?? new Set(),
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
  exclude: ReadonlySet<string> = options.used ?? new Set(),
  assigned: ReadonlyMap<Subject, number> = options.assigned ?? new Map(),
): Subject | null {
  const available = graph.subjects.filter(
    (subject) => selectTopic(graph, states, subject, options, exclude) !== null,
  );
  if (available.length === 0) return null;

  // Предметы в `available` различны, так что отсев ровно одного из двух и более
  // всегда оставляет хотя бы один кандидат — пустого `pool` здесь не бывает.
  const last = options.lastSubject ?? null;
  const pool = available.length > 1 ? available.filter((subject) => subject !== last) : available;

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
  const used = new Set<string>(options.used ?? []);
  const assigned = new Map<Subject, number>(options.assigned ?? []);
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
      `SELECT subject FROM runs WHERE kind <> 'lesson'
       ORDER BY started_at DESC, id DESC LIMIT 1`,
    )
    .get();
  return row?.subject ?? null;
}

/**
 * Забеги каждого предмета, начатые в сутки `now`. Сутки — местные: день ученика
 * кончается по его часам, а в UTC граница уезжала бы на смещение пояса и делёж
 * дня перезапускался бы посреди вечернего занятия. В запрос границы уходят всё
 * равно в ISO — сравнение по `started_at` строковое. Вчерашний перекос в счёт не
 * идёт, делёж дня начинается заново.
 */
export function runsAssignedToday(db: Database, now: Date = new Date()): Map<Subject, number> {
  const [start, next] = moscowDayBounds(now);
  const rows = db
    .prepare<[string, string], { subject: Subject; runs: number }>(
      `SELECT subject, COUNT(*) AS runs FROM runs
       WHERE kind <> 'lesson' AND started_at >= ? AND started_at < ? GROUP BY subject`,
    )
    .all(start, next);

  return new Map(rows.map((row) => [row.subject, row.runs]));
}

/** Темы забегов, уже начатых в текущие московские сутки. */
export function topicsUsedToday(db: Database, now: Date = new Date()): Set<string> {
  const [start, next] = moscowDayBounds(now);
  const rows = db
    .prepare<[string, string], { topic_id: string }>(
      `SELECT DISTINCT topic_id FROM runs
       WHERE kind <> 'lesson' AND started_at >= ? AND started_at < ?`,
    )
    .all(start, next);
  return new Set(rows.map((row) => row.topic_id));
}

/**
 * Темы всех незакрытых обычных забегов, самый свежий первым.
 * Триаж выбирает темы своей политикой, а boss-забег обслуживает только `boss.ts`.
 * Отдельный
 * запрос, а не `topicsUsedToday`: та отвечает на вопрос «что сегодня уже
 * занято» и законно включает законченное, а здесь нужен ровно идущий забег.
 * Законченная тема, оказавшись впереди, перехватывала бы выдачу заданий —
 * `nextTask` берёт первую тему, по которой есть задание, — и грелась бы вместо
 * той, по которой ученик занимается прямо сейчас.
 *
 * Порядок задан явно: `DISTINCT` без `ORDER BY` возвращает строки как придётся,
 * а перенесённый забег не должен обойти начатый только что.
 */
export function activeRunTopics(db: Database, _now: Date = new Date()): string[] {
  const rows = db
    .prepare<[], { topic_id: string }>(
      `SELECT topic_id FROM runs
       WHERE finished_at IS NULL AND kind = 'run'
       ORDER BY started_at DESC, id DESC`,
    )
    .all();
  return [...new Set(rows.map((row) => row.topic_id))];
}

interface DatabaseSelection {
  plan: PlannedRun[];
  active: Topic[];
}

/**
 * Единая выборка тем обычного занятия: закрытие навсегда убирает тему и из
 * будущего плана, и из старого незавершённого забега. Само состояние остаётся
 * в базе — оно по-прежнему нужно прогнозу и истории.
 */
function selectionFromDatabase(
  db: Database,
  graph: TopicGraph,
  count: number,
  now: Date,
): DatabaseSelection {
  const closed = new Set(
    db
      .prepare<[], { topic_id: string }>(
        'SELECT topic_id FROM topic_state WHERE closed_at IS NOT NULL ORDER BY topic_id',
      )
      .all()
      .map((row) => row.topic_id),
  );
  const used = topicsUsedToday(db, now);
  for (const topicId of closed) used.add(topicId);
  const startedIds = activeRunTopics(db, now).filter((id) => !closed.has(id));
  for (const topicId of startedIds) used.add(topicId);

  const plan = planRuns(graph, readTopicStates(db), count, {
    now,
    examDate: readProfile(db).examDate,
    lastSubject: lastRunSubject(db),
    assigned: runsAssignedToday(db, now),
    used,
  });
  const started = startedIds
    .map((id) => graph.byId.get(id))
    .filter((topic): topic is Topic => topic !== undefined);

  const seen = new Set<string>();
  const active: Topic[] = [];
  for (const topic of [...started, ...plan.map((run) => run.topic)]) {
    if (seen.has(topic.id)) continue;
    seen.add(topic.id);
    active.push(topic);
  }
  return { plan, active };
}

/**
 * План забегов по данным базы: состояния тем, дата экзамена из профиля,
 * предмет последнего забега и уже начатые сегодня забеги берутся оттуда,
 * карта тем — снаружи.
 */
export function planFromDatabase(
  db: Database,
  graph: TopicGraph,
  count: number,
  now: Date = new Date(),
): PlannedRun[] {
  return selectionFromDatabase(db, graph, count, now).plan;
}

/**
 * Темы, по которым занятие идёт прямо сейчас: сначала темы всех незакрытых
 * забегов, потом план ближайших. Для сегодняшнего забега тема уже исключена из
 * `planRuns`; перенесённый забег также ставится первым, чтобы выдача и долив
 * готовили задания именно для него.
 *
 * Реализация одна на всех: и воркер, и выдача занятия спрашивают состав тем
 * здесь. Своя копия у любого из них означала бы, что греется одно, а
 * показывается другое.
 */
export function activeTopics(
  db: Database,
  graph: TopicGraph,
  count: number,
  now: Date = new Date(),
): Topic[] {
  return selectionFromDatabase(db, graph, count, now).active;
}
