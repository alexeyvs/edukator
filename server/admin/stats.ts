/**
 * Слой 2 статистики оператора: обход всех детских баз по одной, с кешем.
 *
 * Это дорогой слой, и цена у него линейна по числу семей: каждая база
 * открывается отдельным соединением `readonly`, отвечает на десяток агрегатов и
 * тут же закрывается (`sweepChildDatabases`). Реестра арендаторов обход не
 * касается, поэтому потолок в 32 аренды не при чём и живым детям он не мешает.
 *
 * Отсюда же кеш: без него открытый на стене экран статистики читал бы все базы
 * при каждом обновлении страницы. Результат живёт `ADMIN_STATS_TTL_MS` и
 * показывается с отметкой времени; пересчёт — явным `refresh`, то есть кнопкой,
 * а не заходом.
 *
 * **Содержания здесь нет вовсе.** Ни один запрос не выбирает ни `question`, ни
 * `answer`, ни `resolution`, ни `content` учебного материала: статистика
 * показывает состояние, а прочитать написанное ребёнком можно только
 * имперсонацией, которая записана в аудит. Новый агрегат обязан держаться того
 * же правила — иначе тексты чужих детей утекут в отчёт, который никем не
 * запрашивался поимённо.
 *
 * Агрегат намеренно не кладётся в `control.db`: управляющая база не знает о
 * занятиях ничего, и таблица с их итогами протащила бы её в доменные модули.
 */
import type { Database } from 'better-sqlite3';
import {
  listAllChildren,
  type ChildStatus,
  type ChildSummary,
} from '../control-db.js';
import type { TopicGraph } from '../curriculum.js';
import { SUBJECTS, type Subject } from '../db.js';
import { moscowDate, moscowDayBounds } from '../moscow-time.js';
import { readStreak } from '../streak.js';
import { readSubjectCalibrations } from '../subject-calibration.js';
import {
  sweepChildDatabases,
  type ChildDatabaseMeta,
  type ChildReadFailure,
} from './child-readonly.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** Сколько живёт посчитанный отчёт. Пересчёт до срока — только явным `refresh`. */
export const ADMIN_STATS_TTL_MS = 5 * 60 * 1000;

/**
 * Сколько дней молчания считается уходом. Две недели — не порог терпения, а
 * граница, за которой пропуск перестаёт объясняться каникулами или болезнью:
 * недельное окно записывало бы в ушедшие всякого, кто уехал к бабушке.
 */
export const CHURN_SILENCE_DAYS = 14;

/** Сколько худших тем показывать: список нужен для решения, а не для чтения. */
export const WORST_TOPICS_LIMIT = 10;

/**
 * Ниже какого числа ответов тема в список худших не попадает. Один неверный
 * ответ даёт точность 0% и без порога занимал бы весь список темами, по которым
 * никто ещё толком не занимался.
 */
export const WORST_TOPIC_MIN_ANSWERS = 5;

/** Ребёнок, чью базу обход не смотрел вовсе, и почему. */
export interface AdminSkippedChild {
  childId: string;
  /** `provisioning`/`failed` — базы ещё (или уже) нет; `retired` — выведен. */
  reason: Exclude<ChildStatus, 'ready'> | 'retired';
}

/** Активное время по `attempts.duration_ms`: суммируются все версии ответа. */
export interface AdminActiveTime {
  total: number;
  last7Days: number;
  today: number;
}

/** Освоение предмета: среднее по темам, которых ребёнок касался. */
export interface AdminSubjectMastery {
  subject: Subject;
  average: number;
  topics: number;
}

export interface AdminBossCounts {
  won: number;
  lost: number;
  failed: number;
  /** Готовящиеся, готовые и идущие бои: незавершённые. */
  live: number;
}

export interface AdminIntegrityCounts {
  reviews: number;
  needsRetry: number;
  retryItems: number;
}

export interface AdminDisputeCounts {
  total: number;
  upheld: number;
  rejected: number;
  open: number;
}

export interface AdminBankCounts {
  valid: number;
  pending: number;
  rejected: number;
  used: number;
  /** Зарезервированное боссом и разбором: обычной выдаче оно не видно. */
  reserved: number;
  /** Прирост банка за московские сутки — против расхода вызовов за них же. */
  addedToday: number;
}

/** Точность по теме. Доля не считается здесь: её собирают уже по всем детям. */
export interface AdminTopicAnswers {
  topicId: string;
  answers: number;
  correct: number;
}

/**
 * Всё, что читается из одной детской базы. Отдаётся наружу целиком: карточка
 * ребёнка третьего слоя открывает его базу заново, а список семей на первом
 * экране этих чисел не знает.
 */
export interface AdminChildStats {
  childId: string;
  schemaVersion: number;
  /** Из `control.db`: по нему считается, на какой неделе ребёнок отвалился. */
  createdAt: string;
  lastAttemptAt?: string;
  activeMs: AdminActiveTime;
  finishedRuns: number;
  answers: number;
  correct: number;
  mastery: AdminSubjectMastery[];
  calibrated: Subject[];
  streak: { current: number; best: number };
  boss: AdminBossCounts;
  integrity: AdminIntegrityCounts;
  disputes: AdminDisputeCounts;
  bank: AdminBankCounts;
  /** Темы, которыми занимались, но годных заданий в банке не осталось. */
  emptyBankTopics: string[];
  topicAnswers: AdminTopicAnswers[];
}

/** Ушедшие по неделям от заведения: `week` — сколько полных недель продержались. */
export interface AdminChurnWeek {
  week: number;
  children: number;
}

export interface AdminEngagement {
  activeToday: number;
  active7Days: number;
  active30Days: number;
  activeMsTotal: number;
  activeMs7Days: number;
  streaks: { withCurrent: number; longestCurrent: number; longestEver: number };
  churned: number;
  churnByWeek: AdminChurnWeek[];
}

export interface AdminSubjectMasteryTotal extends AdminSubjectMastery {
  /** Скольких детей это среднее описывает. */
  children: number;
}

export interface AdminLearningPicture {
  finishedRuns: number;
  answers: number;
  correct: number;
  /** Доли нет, пока нет ни одного ответа: ноль означал бы «все мимо». */
  accuracy?: number;
  mastery: AdminSubjectMasteryTotal[];
  calibrated: Array<{ subject: Subject; children: number }>;
  boss: AdminBossCounts;
  integrity: AdminIntegrityCounts;
  disputes: AdminDisputeCounts & { upheldShare?: number };
}

export interface AdminWorstTopic extends AdminTopicAnswers {
  accuracy: number;
}

export interface AdminContentQuality {
  /** Расход вызовов codex за московские сутки — по всем детям сразу. */
  codexCalls: number;
  tasksAdded: number;
  /** Вызовов на одно новое задание: косвенная доля брака проверяющего. */
  callsPerTask?: number;
  emptyBanks: Array<{ topicId: string; children: number }>;
  worstTopics: AdminWorstTopic[];
}

/** База, отложенная по версии схемы, как её видит оператор. Пути здесь нет. */
export interface AdminStaleDatabase {
  childId: string;
  /** `user_version` файла как есть, без миграции. */
  schemaVersion: number;
}

export interface AdminStats {
  generatedAt: string;
  /** Московские сутки, за которые считаны расход квоты и прирост банка. */
  day: string;
  engagement: AdminEngagement;
  learning: AdminLearningPicture;
  content: AdminContentQuality;
  children: AdminChildStats[];
  /** Базы со схемой не той версии: не читались и не менялись. */
  stale: AdminStaleDatabase[];
  failed: ChildReadFailure[];
  skipped: AdminSkippedChild[];
}

export interface AdminStatsOptions {
  dataDir: string;
  graph: TopicGraph;
  now?: Date;
}

interface ActivityRow {
  total_ms: number;
  week_ms: number;
  today_ms: number;
  last_at: string | null;
}

interface AnswersRow {
  answers: number;
  correct: number;
}

interface TopicMasteryRow {
  topic_id: string;
  mastery: number;
}

/** Одна строка агрегата с гарантированным ответом: `COUNT` пустоты не даёт. */
function requireRow<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new Error(`База ребёнка не ответила на подсчёт: ${what}`);
  return row;
}

function statusCounts(
  db: Database,
  table: 'boss_batches' | 'learning_materials' | 'disputes' | 'task_bank' | 'integrity_reviews',
): Map<string, number> {
  const rows = db
    .prepare<[], { status: string; count: number }>(
      `SELECT status, COUNT(*) AS count FROM ${table} GROUP BY status`,
    )
    .all();
  return new Map(rows.map((row) => [row.status, row.count]));
}

/** Итог по одной базе. Соединение живёт только внутри вызова. */
function readChildStats(
  db: Database,
  meta: ChildDatabaseMeta,
  child: ChildSummary,
  graph: TopicGraph,
  now: Date,
): AdminChildStats {
  const [dayStart] = moscowDayBounds(now);
  const weekStart = new Date(now.getTime() - 7 * DAY_MS).toISOString();

  // Активное время суммирует **все** версии ответа, как и родительская сводка:
  // на исправление ошибки ребёнок тоже потратил время.
  const activity = requireRow(
    db
      .prepare<[string, string], ActivityRow>(
        `SELECT COALESCE(SUM(duration_ms), 0) AS total_ms,
                COALESCE(SUM(CASE WHEN created_at >= ? THEN duration_ms ELSE 0 END), 0) AS week_ms,
                COALESCE(SUM(CASE WHEN created_at >= ? THEN duration_ms ELSE 0 END), 0) AS today_ms,
                MAX(created_at) AS last_at
           FROM attempts`,
      )
      .get(weekStart, dayStart),
    'активное время',
  );

  // Точность — только по текущим версиям ответов, влияющим на прогресс: это тот
  // же источник истины, из которого забег собирает свой итог.
  const answers = requireRow(
    db
      .prepare<[], AnswersRow>(
        `SELECT COUNT(*) AS answers, COALESCE(SUM(is_correct), 0) AS correct
           FROM attempts WHERE is_current = 1 AND affects_progress = 1`,
      )
      .get(),
    'ответы',
  );

  const finishedRuns = requireRow(
    db
      .prepare<[], { count: number }>(
        `SELECT COUNT(*) AS count FROM runs
          WHERE kind = 'run' AND finished_at IS NOT NULL AND summary IS NOT NULL`,
      )
      .get(),
    'завершённые забеги',
  ).count;

  const masterySums = new Map<Subject, { sum: number; topics: number }>();
  const masteryRows = db
    .prepare<[], TopicMasteryRow>('SELECT topic_id, mastery FROM topic_state WHERE attempts > 0')
    .all();
  for (const row of masteryRows) {
    const subject = graph.byId.get(row.topic_id)?.subject;
    if (subject === undefined) continue;
    const bucket = masterySums.get(subject) ?? { sum: 0, topics: 0 };
    bucket.sum += row.mastery;
    bucket.topics += 1;
    masterySums.set(subject, bucket);
  }

  const calibrations = readSubjectCalibrations(db, graph);
  const bossStatuses = statusCounts(db, 'boss_batches');
  const disputeStatuses = statusCounts(db, 'disputes');
  const bankStatuses = statusCounts(db, 'task_bank');
  const reviewStatuses = statusCounts(db, 'integrity_reviews');

  const retryItems = requireRow(
    db
      .prepare<[], { count: number }>(
        `SELECT COUNT(*) AS count FROM integrity_items WHERE status = 'retry_required'`,
      )
      .get(),
    'отмеченные ответы',
  ).count;

  const addedToday = requireRow(
    db
      .prepare<[string], { count: number }>(
        'SELECT COUNT(*) AS count FROM task_bank WHERE created_at >= ?',
      )
      .get(dayStart),
    'прирост банка',
  ).count;

  // Пустой банк ищется только среди тем, которыми ребёнок занимался: у карты
  // тем их сотни, и «нет заданий по теме, до которой не дошли» — не событие.
  const emptyBankTopics = db
    .prepare<[], { topic_id: string }>(
      `SELECT ts.topic_id FROM topic_state ts
        WHERE ts.attempts > 0 AND ts.closed_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM task_bank tb
             WHERE tb.topic_id = ts.topic_id AND tb.status = 'valid')
        ORDER BY ts.topic_id`,
    )
    .all()
    .map((row) => row.topic_id);

  const topicAnswers = db
    .prepare<[], AdminTopicAnswers & { topic_id: string }>(
      `SELECT topic_id, COUNT(*) AS answers, COALESCE(SUM(is_correct), 0) AS correct
         FROM attempts
        WHERE is_current = 1 AND affects_progress = 1
        GROUP BY topic_id ORDER BY topic_id`,
    )
    .all()
    .map((row) => ({ topicId: row.topic_id, answers: row.answers, correct: row.correct }));

  const streak = readStreak(db, now);
  const reserved = (bankStatuses.get('boss_reserved') ?? 0) + (bankStatuses.get('lesson_reserved') ?? 0);

  return {
    childId: meta.childId,
    schemaVersion: meta.schemaVersion,
    createdAt: child.createdAt,
    ...(activity.last_at === null ? {} : { lastAttemptAt: activity.last_at }),
    activeMs: {
      total: activity.total_ms,
      last7Days: activity.week_ms,
      today: activity.today_ms,
    },
    finishedRuns,
    answers: answers.answers,
    correct: answers.correct,
    mastery: SUBJECTS.flatMap((subject) => {
      const bucket = masterySums.get(subject);
      return bucket === undefined || bucket.topics === 0
        ? []
        : [{ subject, average: bucket.sum / bucket.topics, topics: bucket.topics }];
    }),
    calibrated: [...calibrations]
      .filter(([, calibration]) => calibration.calibrated)
      .map(([subject]) => subject),
    streak: { current: streak.current, best: streak.best },
    boss: {
      won: bossStatuses.get('won') ?? 0,
      lost: bossStatuses.get('lost') ?? 0,
      failed: bossStatuses.get('failed') ?? 0,
      live:
        (bossStatuses.get('preparing') ?? 0) +
        (bossStatuses.get('ready') ?? 0) +
        (bossStatuses.get('active') ?? 0),
    },
    integrity: {
      reviews: [...reviewStatuses.values()].reduce((sum, count) => sum + count, 0),
      needsRetry: reviewStatuses.get('needs_retry') ?? 0,
      retryItems,
    },
    disputes: {
      total: [...disputeStatuses.values()].reduce((sum, count) => sum + count, 0),
      upheld: disputeStatuses.get('upheld') ?? 0,
      rejected: disputeStatuses.get('rejected') ?? 0,
      open: disputeStatuses.get('open') ?? 0,
    },
    bank: {
      valid: bankStatuses.get('valid') ?? 0,
      pending: bankStatuses.get('pending') ?? 0,
      rejected: bankStatuses.get('rejected') ?? 0,
      used: bankStatuses.get('used') ?? 0,
      reserved,
      addedToday,
    },
    emptyBankTopics,
    topicAnswers,
  };
}

/** Почему ребёнка не читали: у незаведённой и выведенной базы разный смысл. */
function skipReason(child: ChildSummary): AdminSkippedChild['reason'] | undefined {
  if (child.retiredAt !== undefined) return 'retired';
  return child.status === 'ready' ? undefined : child.status;
}

function accuracyOf(answers: number, correct: number): number | undefined {
  return answers === 0 ? undefined : correct / answers;
}

/**
 * Считает слой 2 целиком: список детей берётся из `control.db`, а числа — из их
 * баз. Отказ одной базы не отменяет остальных, он попадает в `failed[]`.
 */
export function collectAdminStats(control: Database, options: AdminStatsOptions): AdminStats {
  const now = options.now ?? new Date();
  const children = listAllChildren(control);
  const byId = new Map(children.map((child) => [child.id, child]));
  const skipped: AdminSkippedChild[] = [];
  const readable: string[] = [];
  for (const child of children) {
    const reason = skipReason(child);
    if (reason === undefined) readable.push(child.id);
    else skipped.push({ childId: child.id, reason });
  }

  const sweep = sweepChildDatabases(options.dataDir, readable, (db, meta) => {
    const child = byId.get(meta.childId);
    if (child === undefined) throw new Error(`Ребёнок ${meta.childId} исчез из управляющей базы`);
    return readChildStats(db, meta, child, options.graph, now);
  });
  const reports = sweep.reports.map((report) => report.value);

  const todayStart = moscowDayBounds(now)[0];
  const since7 = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const since30 = new Date(now.getTime() - 30 * DAY_MS).toISOString();
  const churnBefore = new Date(now.getTime() - CHURN_SILENCE_DAYS * DAY_MS).toISOString();

  const churnWeeks = new Map<number, number>();
  let churned = 0;
  for (const report of reports) {
    // Молчащий дольше двух недель ребёнок считается ушедшим, а никогда не
    // отвечавший — ушедшим на нулевой неделе: заведён и не начал.
    //
    // Окно молчания отмеряется и ему — от заведения. Без этого вся сегодняшняя
    // когорта заведённых попадала бы в «отвалившиеся» в ту же минуту, и число,
    // по которому судят как раз о первом занятии, росло бы ровно от удачных
    // регистраций.
    const last = report.lastAttemptAt;
    if ((last ?? report.createdAt) >= churnBefore) continue;
    churned += 1;
    const until = last === undefined ? report.createdAt : last;
    const lived = Date.parse(until) - Date.parse(report.createdAt);
    const week = Math.max(0, Math.floor(lived / WEEK_MS));
    churnWeeks.set(week, (churnWeeks.get(week) ?? 0) + 1);
  }

  const masteryTotals = new Map<Subject, { sum: number; topics: number; children: number }>();
  const calibratedChildren = new Map<Subject, number>();
  const emptyBanks = new Map<string, number>();
  const topicTotals = new Map<string, AdminTopicAnswers>();
  const learning: AdminLearningPicture = {
    finishedRuns: 0,
    answers: 0,
    correct: 0,
    mastery: [],
    calibrated: [],
    boss: { won: 0, lost: 0, failed: 0, live: 0 },
    integrity: { reviews: 0, needsRetry: 0, retryItems: 0 },
    disputes: { total: 0, upheld: 0, rejected: 0, open: 0 },
  };
  const engagement: AdminEngagement = {
    activeToday: 0,
    active7Days: 0,
    active30Days: 0,
    activeMsTotal: 0,
    activeMs7Days: 0,
    streaks: { withCurrent: 0, longestCurrent: 0, longestEver: 0 },
    churned,
    churnByWeek: [...churnWeeks]
      .sort(([left], [right]) => left - right)
      .map(([week, count]) => ({ week, children: count })),
  };
  let tasksAdded = 0;

  for (const report of reports) {
    const last = report.lastAttemptAt;
    if (last !== undefined) {
      if (last >= todayStart) engagement.activeToday += 1;
      if (last >= since7) engagement.active7Days += 1;
      if (last >= since30) engagement.active30Days += 1;
    }
    engagement.activeMsTotal += report.activeMs.total;
    engagement.activeMs7Days += report.activeMs.last7Days;
    if (report.streak.current > 0) engagement.streaks.withCurrent += 1;
    engagement.streaks.longestCurrent = Math.max(
      engagement.streaks.longestCurrent,
      report.streak.current,
    );
    engagement.streaks.longestEver = Math.max(engagement.streaks.longestEver, report.streak.best);

    learning.finishedRuns += report.finishedRuns;
    learning.answers += report.answers;
    learning.correct += report.correct;
    for (const key of ['won', 'lost', 'failed', 'live'] as const) {
      learning.boss[key] += report.boss[key];
    }
    for (const key of ['reviews', 'needsRetry', 'retryItems'] as const) {
      learning.integrity[key] += report.integrity[key];
    }
    for (const key of ['total', 'upheld', 'rejected', 'open'] as const) {
      learning.disputes[key] += report.disputes[key];
    }
    for (const subject of report.mastery) {
      const bucket = masteryTotals.get(subject.subject) ?? { sum: 0, topics: 0, children: 0 };
      // Среднее по детям считается по темам, а не по средним: ребёнок с одной
      // темой иначе весил бы столько же, сколько прошедший половину карты.
      bucket.sum += subject.average * subject.topics;
      bucket.topics += subject.topics;
      bucket.children += 1;
      masteryTotals.set(subject.subject, bucket);
    }
    for (const subject of report.calibrated) {
      calibratedChildren.set(subject, (calibratedChildren.get(subject) ?? 0) + 1);
    }
    for (const topicId of report.emptyBankTopics) {
      emptyBanks.set(topicId, (emptyBanks.get(topicId) ?? 0) + 1);
    }
    for (const topic of report.topicAnswers) {
      const total = topicTotals.get(topic.topicId) ?? {
        topicId: topic.topicId,
        answers: 0,
        correct: 0,
      };
      total.answers += topic.answers;
      total.correct += topic.correct;
      topicTotals.set(topic.topicId, total);
    }
    tasksAdded += report.bank.addedToday;
  }

  const accuracy = accuracyOf(learning.answers, learning.correct);
  learning.mastery = SUBJECTS.flatMap((subject) => {
    const bucket = masteryTotals.get(subject);
    return bucket === undefined || bucket.topics === 0
      ? []
      : [{
          subject,
          average: bucket.sum / bucket.topics,
          topics: bucket.topics,
          children: bucket.children,
        }];
  });
  learning.calibrated = SUBJECTS.flatMap((subject) => {
    const count = calibratedChildren.get(subject);
    return count === undefined ? [] : [{ subject, children: count }];
  });
  if (accuracy !== undefined) learning.accuracy = accuracy;
  const upheldShare = accuracyOf(learning.disputes.total, learning.disputes.upheld);
  if (upheldShare !== undefined) learning.disputes.upheldShare = upheldShare;

  const day = moscowDate(now);
  const codexCalls = requireRow(
    control
      .prepare<[string], { calls: number }>(
        'SELECT COALESCE(SUM(calls), 0) AS calls FROM codex_quota WHERE day = ?',
      )
      .get(day),
    'расход квоты',
  ).calls;

  const worstTopics = [...topicTotals.values()]
    .filter((topic) => topic.answers >= WORST_TOPIC_MIN_ANSWERS)
    .map((topic) => ({ ...topic, accuracy: topic.correct / topic.answers }))
    // Ничья разрешается числом ответов, потом именем темы: без этого две темы с
    // одинаковой точностью менялись бы местами от запроса к запросу.
    .sort((left, right) =>
      left.accuracy - right.accuracy ||
      right.answers - left.answers ||
      left.topicId.localeCompare(right.topicId))
    .slice(0, WORST_TOPICS_LIMIT);

  return {
    generatedAt: now.toISOString(),
    day,
    engagement,
    learning,
    content: {
      codexCalls,
      tasksAdded,
      ...(tasksAdded === 0 ? {} : { callsPerTask: codexCalls / tasksAdded }),
      emptyBanks: [...emptyBanks]
        .sort(([leftId, leftCount], [rightId, rightCount]) =>
          rightCount - leftCount || leftId.localeCompare(rightId))
        .map(([topicId, count]) => ({ topicId, children: count })),
      worstTopics,
    },
    children: reports,
    // Путь файла наружу не уходит: в ответе он не нужен ничему, а каталог
    // данных — это подробность машины, которой в теле HTTP не место.
    stale: sweep.stale.map(({ childId, schemaVersion }) => ({ childId, schemaVersion })),
    failed: sweep.failed,
    skipped,
  };
}

export interface AdminStatsCacheOptions {
  control: Database;
  dataDir: string;
  graph: TopicGraph;
  ttlMs?: number;
  now?: () => Date;
}

/**
 * Кеш отчёта. Держит последний посчитанный результат `ttlMs` и отдаёт его
 * целиком, вместе с его собственной отметкой времени: экран показывает «данные
 * на 12:41», и подмена отметки на нынешнюю выдавала бы пятиминутной давности
 * числа за свежие.
 */
export class AdminStatsCache {
  readonly #options: AdminStatsCacheOptions;

  readonly #ttlMs: number;

  readonly #now: () => Date;

  #cached: AdminStats | undefined;

  constructor(options: AdminStatsCacheOptions) {
    this.#options = options;
    this.#ttlMs = options.ttlMs ?? ADMIN_STATS_TTL_MS;
    this.#now = options.now ?? ((): Date => new Date());
  }

  /** Свежий отчёт или сохранённый, если он ещё не протух. */
  read(options: { refresh?: boolean } = {}): AdminStats {
    const now = this.#now();
    const cached = this.#cached;
    if (
      options.refresh !== true &&
      cached !== undefined &&
      now.getTime() - Date.parse(cached.generatedAt) < this.#ttlMs
    ) {
      return cached;
    }
    const stats = collectAdminStats(this.#options.control, {
      dataDir: this.#options.dataDir,
      graph: this.#options.graph,
      now,
    });
    this.#cached = stats;
    return stats;
  }
}
