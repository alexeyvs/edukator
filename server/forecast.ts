import type { Database } from 'better-sqlite3';
import type { Subject } from './db.js';
import type { Topic, TopicGraph } from './curriculum.js';
import { confidenceAt, newTopicState, readTopicStates, type TopicState } from './mastery.js';

/** Прогноз считается либо по одному предмету, либо по всем сразу. */
export type ForecastScope = Subject | 'overall';

/**
 * Опорные точки отображения освоенности в школьную оценку — из спеки.
 * Между ними идёт линейная интерполяция, по краям — насыщение.
 */
export const SCORE_ANCHORS = [
  { ratio: 0.3, score: 2 },
  { ratio: 0.45, score: 3 },
  { ratio: 0.6, score: 4 },
  { ratio: 0.8, score: 5 },
] as const;

type Anchor = (typeof SCORE_ANCHORS)[number];

const FIRST_ANCHOR: Anchor = SCORE_ANCHORS[0];
const LAST_ANCHOR = SCORE_ANCHORS[SCORE_ANCHORS.length - 1] as Anchor;

export const MIN_SCORE = FIRST_ANCHOR.score;
export const MAX_SCORE = LAST_ANCHOR.score;

/**
 * Полуширина полосы погрешности при полностью непроверенной программе: балл в
 * каждую сторону. Прогноз по нулю данных — это «где-то между тройкой и
 * пятёркой», и полоса обязана это показывать, а не изображать точность.
 */
export const MAX_BAND = 1;

/** Темы легче этого веса на вступительном не встречаются и в прогноз не идут. */
export const MIN_FORECAST_WEIGHT = 1;

/** Прогноз без привязки к предмету: всё, что считается по темам и состояниям. */
export interface ForecastValue {
  /** Взвешенная освоенность 0..1 — то, что отображается в оценку. */
  ratio: number;
  /** Оценка 2..5. */
  score: number;
  /** Полуширина полосы погрешности в баллах. */
  band: number;
  /** Границы полосы, уже прижатые к шкале 2..5. */
  low: number;
  high: number;
  /** Сумма `exam_weight` учтённых тем и та её часть, что не подтверждена попытками. */
  weight: number;
  untestedWeight: number;
}

export interface Forecast extends ForecastValue {
  subject: ForecastScope;
}

export interface ForecastSnapshot {
  id: number;
  subject: ForecastScope;
  score: number;
  band: number;
  /** ISO-время снимка. */
  createdAt: string;
}

export interface ForecastTrend {
  subject: ForecastScope;
  snapshots: ForecastSnapshot[];
  first: ForecastSnapshot;
  last: ForecastSnapshot;
  /** Сдвиг оценки за период; при единственном снимке — ноль. */
  delta: number;
  count: number;
}

/** Период выборки снимков; границы включаются. */
export interface SnapshotWindow {
  since?: Date | string;
  until?: Date | string;
}

function stateOf(states: Map<string, TopicState>, topicId: string): TopicState {
  return states.get(topicId) ?? newTopicState(topicId);
}

function examTopics(topics: readonly Topic[]): Topic[] {
  return topics.filter((topic) => topic.examWeight >= MIN_FORECAST_WEIGHT);
}

/**
 * `Σ(exam_weight × mastery) / Σ(exam_weight)` по темам, которые вообще бывают на
 * экзамене. `null` — взвешивать нечего: в карте нет ни одной такой темы, и
 * ноль здесь означал бы «двойка», а не «неизвестно».
 */
export function masteryRatio(
  topics: readonly Topic[],
  states: Map<string, TopicState>,
): number | null {
  let weight = 0;
  let earned = 0;

  for (const topic of examTopics(topics)) {
    weight += topic.examWeight;
    earned += topic.examWeight * stateOf(states, topic.id).mastery;
  }

  return weight === 0 ? null : earned / weight;
}

/**
 * Кусочно-линейное отображение освоенности в оценку по опорным точкам спеки.
 * За крайними точками — насыщение: ниже 0.30 всё равно двойка, выше 0.80 —
 * пятёрка, шкала дальше не тянется.
 */
export function scoreFromRatio(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    throw new Error(`Прогноз: освоенность вне 0..1 (${ratio})`);
  }

  if (ratio <= FIRST_ANCHOR.ratio) return FIRST_ANCHOR.score;
  if (ratio >= LAST_ANCHOR.ratio) return LAST_ANCHOR.score;

  for (let index = 1; index < SCORE_ANCHORS.length; index += 1) {
    const left = SCORE_ANCHORS[index - 1] as Anchor;
    const right = SCORE_ANCHORS[index] as Anchor;
    if (ratio > right.ratio) continue;

    const share = (ratio - left.ratio) / (right.ratio - left.ratio);
    return left.score + share * (right.score - left.score);
  }

  // Недостижимо: насыщение выше уже покрыло всё, что правее последней точки.
  return LAST_ANCHOR.score;
}

/**
 * Полуширина полосы: доля веса, не подтверждённого попытками, умноженная на
 * `MAX_BAND`. Уверенность берётся на момент `now`, а не из базы, поэтому
 * заброшенная тема снова расширяет полосу — знание о ней устарело.
 */
export function forecastBand(
  topics: readonly Topic[],
  states: Map<string, TopicState>,
  now: Date = new Date(),
): number | null {
  let weight = 0;
  let untested = 0;

  for (const topic of examTopics(topics)) {
    weight += topic.examWeight;
    untested += topic.examWeight * (1 - confidenceAt(stateOf(states, topic.id), now));
  }

  return weight === 0 ? null : (untested / weight) * MAX_BAND;
}

/** Прогноз по списку тем. `null` — суммарный вес нулевой, считать не из чего. */
export function computeForecast(
  topics: readonly Topic[],
  states: Map<string, TopicState>,
  now: Date = new Date(),
): ForecastValue | null {
  let weight = 0;
  let earned = 0;
  let untestedWeight = 0;

  for (const topic of examTopics(topics)) {
    const state = stateOf(states, topic.id);
    weight += topic.examWeight;
    earned += topic.examWeight * state.mastery;
    untestedWeight += topic.examWeight * (1 - confidenceAt(state, now));
  }

  if (weight === 0) return null;

  const ratio = earned / weight;
  const score = scoreFromRatio(ratio);
  const band = (untestedWeight / weight) * MAX_BAND;

  return {
    ratio,
    score,
    band,
    low: Math.max(MIN_SCORE, score - band),
    high: Math.min(MAX_SCORE, score + band),
    weight,
    untestedWeight,
  };
}

/** Прогноз по предмету или по всей карте. `null` — тем для прогноза нет. */
export function forecastFor(
  graph: TopicGraph,
  states: Map<string, TopicState>,
  subject: ForecastScope,
  now: Date = new Date(),
): Forecast | null {
  const topics =
    subject === 'overall' ? [...graph.byId.values()] : (graph.bySubject.get(subject) ?? []);
  const value = computeForecast(topics, states, now);
  return value === null ? null : { subject, ...value };
}

interface SnapshotRow {
  id: number;
  subject: ForecastScope;
  score: number;
  band: number;
  created_at: string;
}

function toSnapshot(row: SnapshotRow): ForecastSnapshot {
  return { id: row.id, subject: row.subject, score: row.score, band: row.band, createdAt: row.created_at };
}

function isoOf(value: Date | string): string {
  return typeof value === 'string' ? value : value.toISOString();
}

/**
 * Пишет снимок прогноза. Отметка времени проставляется явно в ISO, а не
 * умолчанием схемы (`datetime('now')` даёт другой формат): по этой колонке идут
 * и сортировка, и выборка периода, а два формата в одной колонке сравнивались
 * бы как попало.
 */
export function writeForecastSnapshot(
  db: Database,
  subject: ForecastScope,
  forecast: Pick<ForecastValue, 'score' | 'band'>,
  at: Date = new Date(),
): ForecastSnapshot {
  if (!Number.isFinite(forecast.score) || forecast.score < MIN_SCORE || forecast.score > MAX_SCORE) {
    throw new Error(`Прогноз: оценка вне шкалы ${MIN_SCORE}..${MAX_SCORE} (${forecast.score})`);
  }
  if (!Number.isFinite(forecast.band) || forecast.band < 0) {
    throw new Error(`Прогноз: полоса погрешности отрицательна (${forecast.band})`);
  }

  const createdAt = at.toISOString();
  const info = db
    .prepare(
      `INSERT INTO forecast_snapshots (subject, score, band, created_at)
       VALUES (@subject, @score, @band, @createdAt)`,
    )
    .run({ subject, score: forecast.score, band: forecast.band, createdAt });

  return {
    id: Number(info.lastInsertRowid),
    subject,
    score: forecast.score,
    band: forecast.band,
    createdAt,
  };
}

/** Снимки предмета за период, в хронологическом порядке. */
export function readSnapshots(
  db: Database,
  subject: ForecastScope,
  window: SnapshotWindow = {},
): ForecastSnapshot[] {
  const since = window.since === undefined ? null : isoOf(window.since);
  const until = window.until === undefined ? null : isoOf(window.until);

  const rows = db
    .prepare<{ subject: string; since: string | null; until: string | null }, SnapshotRow>(
      `SELECT id, subject, score, band, created_at
         FROM forecast_snapshots
        WHERE subject = @subject
          AND (@since IS NULL OR created_at >= @since)
          AND (@until IS NULL OR created_at <= @until)
        ORDER BY created_at, id`,
    )
    .all({ subject, since, until });

  return rows.map(toSnapshot);
}

/**
 * Тренд оценки за период. Один снимок — валидный тренд с нулевым сдвигом:
 * «данные есть, движения пока нет» и «данных нет» — разные ответы для дашборда.
 */
export function forecastTrend(
  db: Database,
  subject: ForecastScope,
  window: SnapshotWindow = {},
): ForecastTrend | null {
  const snapshots = readSnapshots(db, subject, window);
  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  if (first === undefined || last === undefined) return null;

  return { subject, snapshots, first, last, delta: last.score - first.score, count: snapshots.length };
}

/**
 * Снимает прогноз по всей карте и по каждому её предмету одной транзакцией:
 * общая оценка и предметные — один момент времени, иначе тренд по «overall»
 * поехал бы относительно предметных.
 */
export function recordForecasts(
  db: Database,
  graph: TopicGraph,
  now: Date = new Date(),
): ForecastSnapshot[] {
  const states = readTopicStates(db);
  const scopes: ForecastScope[] = ['overall', ...graph.subjects];

  return db.transaction((): ForecastSnapshot[] => {
    const written: ForecastSnapshot[] = [];
    for (const scope of scopes) {
      const forecast = forecastFor(graph, states, scope, now);
      if (forecast === null) continue;
      written.push(writeForecastSnapshot(db, scope, forecast, now));
    }
    return written;
  })();
}
