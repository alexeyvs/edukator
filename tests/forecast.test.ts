import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../server/db.js';
import { buildTopicGraph, type Topic, type TopicGraph } from '../server/curriculum.js';
import { newTopicState, type TopicState } from '../server/mastery.js';
import {
  MAX_BAND,
  MAX_SCORE,
  MIN_SCORE,
  SCORE_ANCHORS,
  computeForecast,
  forecastBand,
  forecastFor,
  forecastTrend,
  masteryRatio,
  readSnapshots,
  recordForecasts,
  scoreFromRatio,
  writeForecastSnapshot,
} from '../server/forecast.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function at(day: number): Date {
  return new Date(Date.UTC(2026, 7, 7, 12) + day * DAY_MS);
}

function topic(id: string, patch: Partial<Topic> = {}): Topic {
  return {
    id,
    subject: 'math',
    title: id,
    examWeight: 2,
    difficulty: 2,
    prereqs: [],
    answerFormat: 'number',
    promptSeed: 'seed',
    ...patch,
  };
}

function state(id: string, patch: Partial<TopicState> = {}): TopicState {
  return { ...newTopicState(id), ...patch };
}

/** Тема, проверенная `attempts` раз только что: уверенность максимальна на `now`. */
function seen(id: string, mastery: number, attempts: number, day = 0): TopicState {
  return state(id, { mastery, attempts, lastSeen: at(day).toISOString() });
}

function stateMap(...states: TopicState[]): Map<string, TopicState> {
  return new Map(states.map((item) => [item.topicId, item]));
}

function graphOf(topics: Topic[]): TopicGraph {
  return buildTopicGraph(topics);
}

describe('masteryRatio', () => {
  it('взвешивает mastery по exam_weight', () => {
    const topics = [topic('a', { examWeight: 3 }), topic('b', { examWeight: 1 })];
    const states = stateMap(seen('a', 1, 3), seen('b', 0, 3));

    // (3·1 + 1·0) / (3 + 1)
    expect(masteryRatio(topics, states)).toBeCloseTo(0.75, 10);
  });

  it('не учитывает темы с exam_weight меньше 1', () => {
    const topics = [topic('a', { examWeight: 2 }), topic('junk', { examWeight: 0 })];
    const states = stateMap(seen('a', 0.5, 3), seen('junk', 1, 3));

    expect(masteryRatio(topics, states)).toBeCloseTo(0.5, 10);
  });

  it('считает тему без состояния неосвоенной', () => {
    expect(masteryRatio([topic('a', { examWeight: 2 })], new Map())).toBe(0);
  });

  it('возвращает null, когда ни одной темы с exam_weight ≥ 1 нет', () => {
    const topics = [topic('junk', { examWeight: 0 }), topic('junk2', { examWeight: 0 })];

    expect(masteryRatio(topics, stateMap(seen('junk', 1, 3)))).toBeNull();
  });

  it('возвращает null на пустом списке тем', () => {
    expect(masteryRatio([], new Map())).toBeNull();
  });
});

describe('scoreFromRatio', () => {
  it('держит калибровочные константы спеки', () => {
    expect(MAX_BAND).toBe(1);
    expect(MIN_SCORE).toBe(2);
    expect(MAX_SCORE).toBe(5);
    expect(SCORE_ANCHORS.map((anchor) => anchor.score)).toEqual([2, 3, 4, 5]);
  });

  it('отображает опорные точки ровно в 2.0 / 3.0 / 4.0 / 5.0', () => {
    expect(SCORE_ANCHORS.map((anchor) => anchor.ratio)).toEqual([0.3, 0.45, 0.6, 0.8]);
    for (const anchor of SCORE_ANCHORS) {
      expect(scoreFromRatio(anchor.ratio)).toBeCloseTo(anchor.score, 10);
    }
  });

  it('интерполирует линейно между опорными точками', () => {
    // Середина отрезка 0.45→0.60 (оценки 3→4) даёт ровно 3.5.
    expect(scoreFromRatio(0.525)).toBeCloseTo(3.5, 10);
    // И четверть отрезка 0.30→0.45 — 2.25.
    expect(scoreFromRatio(0.3375)).toBeCloseTo(2.25, 10);
  });

  it('монотонно не убывает на всей шкале', () => {
    let previous = -Infinity;
    for (let ratio = 0; ratio <= 1.0001; ratio += 0.005) {
      const score = scoreFromRatio(Math.min(ratio, 1));
      expect(score).toBeGreaterThanOrEqual(previous);
      previous = score;
    }
  });

  it('насыщается по краям, не выходя за шкалу 2..5', () => {
    expect(scoreFromRatio(0)).toBe(MIN_SCORE);
    expect(scoreFromRatio(0.1)).toBe(MIN_SCORE);
    expect(scoreFromRatio(0.9)).toBe(MAX_SCORE);
    expect(scoreFromRatio(1)).toBe(MAX_SCORE);
  });

  it('отвергает долю вне 0..1', () => {
    expect(() => scoreFromRatio(1.5)).toThrow(/0\.\.1/);
    expect(() => scoreFromRatio(-0.1)).toThrow(/0\.\.1/);
    expect(() => scoreFromRatio(Number.NaN)).toThrow(/0\.\.1/);
  });
});

describe('computeForecast', () => {
  it('считает долю, оценку и полосу разом', () => {
    const topics = [topic('a', { examWeight: 2 }), topic('b', { examWeight: 2 })];
    const forecast = computeForecast(topics, stateMap(seen('a', 0.6, 6), seen('b', 0.6, 6)), at(0));

    expect(forecast).not.toBeNull();
    expect(forecast?.ratio).toBeCloseTo(0.6, 10);
    expect(forecast?.score).toBeCloseTo(4, 10);
    expect(forecast?.weight).toBe(4);
  });

  it('сужает полосу по мере роста confidence', () => {
    const topics = [topic('a'), topic('b')];
    const mastery = 0.6;

    const untested = computeForecast(topics, stateMap(state('a', { mastery }), state('b', { mastery })), at(0));
    const shaky = computeForecast(topics, stateMap(seen('a', mastery, 1), seen('b', mastery, 1)), at(0));
    const solid = computeForecast(topics, stateMap(seen('a', mastery, 12), seen('b', mastery, 12)), at(0));

    expect(untested?.band).toBeCloseTo(MAX_BAND, 10);
    expect(shaky?.band).toBeLessThan(untested?.band ?? 0);
    expect(solid?.band).toBeLessThan(shaky?.band ?? 0);
    expect(solid?.band).toBeGreaterThan(0);
  });

  it('расширяет полосу тем сильнее, чем тяжелее непроверенные темы', () => {
    const light = [topic('a', { examWeight: 3 }), topic('b', { examWeight: 1 })];
    const heavy = [topic('a', { examWeight: 1 }), topic('b', { examWeight: 3 })];
    // «a» проверена, «b» — нет: полоса шире там, где непроверенная тема тяжелее.
    const states = stateMap(seen('a', 0.6, 12), state('b', { mastery: 0.6 }));

    const forecastLight = computeForecast(light, states, at(0));
    const forecastHeavy = computeForecast(heavy, states, at(0));

    expect(forecastHeavy?.band).toBeGreaterThan(forecastLight?.band ?? 0);
  });

  it('расширяет полосу по мере затухания confidence', () => {
    const topics = [topic('a')];
    const states = stateMap(seen('a', 0.6, 12));

    const fresh = computeForecast(topics, states, at(0));
    const stale = computeForecast(topics, states, at(60));

    expect(stale?.band).toBeGreaterThan(fresh?.band ?? 0);
  });

  it('держит границы полосы внутри шкалы 2..5', () => {
    const topics = [topic('a')];

    const bottom = computeForecast(topics, stateMap(state('a', { mastery: 0 })), at(0));
    const top = computeForecast(topics, stateMap(state('a', { mastery: 1 })), at(0));

    expect(bottom?.low).toBe(MIN_SCORE);
    expect(bottom?.high).toBeLessThanOrEqual(MAX_SCORE);
    expect(top?.high).toBe(MAX_SCORE);
    expect(top?.low).toBeGreaterThanOrEqual(MIN_SCORE);
  });

  it('возвращает null при нулевой сумме весов', () => {
    expect(computeForecast([topic('junk', { examWeight: 0 })], new Map(), at(0))).toBeNull();
    expect(computeForecast([], new Map(), at(0))).toBeNull();
  });
});

describe('forecastBand', () => {
  it('даёт полную полосу по непроверенной программе и сужает её с ростом confidence', () => {
    const topics = [topic('a'), topic('b')];

    const untested = forecastBand(topics, new Map(), at(0));
    const tested = forecastBand(topics, stateMap(seen('a', 0.5, 12), seen('b', 0.5, 12)), at(0));

    expect(untested).toBeCloseTo(MAX_BAND, 10);
    expect(tested).toBeLessThan(untested ?? 0);
    expect(tested).toBeGreaterThan(0);
  });

  it('совпадает с полосой, посчитанной внутри computeForecast', () => {
    const topics = [topic('a', { examWeight: 3 }), topic('b', { examWeight: 1 })];
    const states = stateMap(seen('a', 0.4, 4), state('b', { mastery: 0.9 }));

    expect(forecastBand(topics, states, at(3))).toBeCloseTo(
      computeForecast(topics, states, at(3))?.band ?? -1,
      10,
    );
  });

  it('возвращает null, когда взвешивать нечего', () => {
    expect(forecastBand([], new Map(), at(0))).toBeNull();
    expect(forecastBand([topic('junk', { examWeight: 0 })], new Map(), at(0))).toBeNull();
  });
});

describe('forecastFor', () => {
  const graph = graphOf([
    topic('math.a', { subject: 'math', examWeight: 2 }),
    topic('rus.a', { subject: 'russian', examWeight: 2 }),
  ]);

  it('считает прогноз по одному предмету', () => {
    const states = stateMap(seen('math.a', 1, 6), seen('rus.a', 0, 6));

    expect(forecastFor(graph, states, 'math', at(0))?.ratio).toBeCloseTo(1, 10);
    expect(forecastFor(graph, states, 'russian', at(0))?.ratio).toBeCloseTo(0, 10);
  });

  it('считает общий прогноз по всем предметам', () => {
    const states = stateMap(seen('math.a', 1, 6), seen('rus.a', 0, 6));
    const overall = forecastFor(graph, states, 'overall', at(0));

    expect(overall?.subject).toBe('overall');
    expect(overall?.ratio).toBeCloseTo(0.5, 10);
  });

  it('возвращает null для предмета, которого нет в карте', () => {
    expect(forecastFor(graph, new Map(), 'english', at(0))).toBeNull();
  });
});

describe('снимки прогноза', () => {
  let dir: string;
  let db: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'edukator-forecast-'));
    db = openDatabase(join(dir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const graph = graphOf([
    topic('math.a', { subject: 'math', examWeight: 2 }),
    topic('rus.a', { subject: 'russian', examWeight: 2 }),
  ]);

  function snapshot(scope: 'math' | 'overall', ratio: number, day: number): void {
    const forecast = computeForecast([topic('a')], stateMap(seen('a', ratio, 12, day)), at(day));
    if (forecast === null) throw new Error('фикстура: прогноз не посчитался');
    writeForecastSnapshot(db, scope, forecast, at(day));
  }

  it('записывает снимок и читает его обратно', () => {
    snapshot('math', 0.6, 0);

    const [row] = readSnapshots(db, 'math');
    expect(row?.subject).toBe('math');
    expect(row?.score).toBeCloseTo(4, 6);
    expect(row?.band).toBeGreaterThan(0);
    expect(row?.createdAt).toBe(at(0).toISOString());
  });

  it('читает снимки только запрошенного предмета в хронологическом порядке', () => {
    snapshot('math', 0.8, 1);
    snapshot('overall', 0.3, 0);
    snapshot('math', 0.3, 0);

    expect(readSnapshots(db, 'math').map((row) => row.createdAt)).toEqual([
      at(0).toISOString(),
      at(1).toISOString(),
    ]);
  });

  it('ограничивает выборку периодом', () => {
    snapshot('math', 0.3, 0);
    snapshot('math', 0.45, 5);
    snapshot('math', 0.6, 10);

    const window = readSnapshots(db, 'math', { since: at(1), until: at(9) });
    expect(window.map((row) => row.createdAt)).toEqual([at(5).toISOString()]);
  });

  it('включает границы периода, а не отсекает их', () => {
    snapshot('math', 0.3, 0);
    snapshot('math', 0.45, 5);

    expect(readSnapshots(db, 'math', { since: at(0), until: at(5) })).toHaveLength(2);
    expect(readSnapshots(db, 'math', { since: at(5) }).map((row) => row.createdAt)).toEqual([
      at(5).toISOString(),
    ]);
    expect(readSnapshots(db, 'math', { until: at(0) }).map((row) => row.createdAt)).toEqual([
      at(0).toISOString(),
    ]);
  });

  it('считает тренд как разницу между первым и последним снимком', () => {
    snapshot('math', 0.3, 0);
    snapshot('math', 0.6, 10);

    const trend = forecastTrend(db, 'math');
    expect(trend?.count).toBe(2);
    expect(trend?.first.score).toBeCloseTo(2, 6);
    expect(trend?.last.score).toBeCloseTo(4, 6);
    expect(trend?.delta).toBeCloseTo(2, 6);
  });

  it('считает тренд по одному снимку с нулевым сдвигом', () => {
    snapshot('math', 0.6, 0);

    const trend = forecastTrend(db, 'math');
    expect(trend?.count).toBe(1);
    expect(trend?.delta).toBe(0);
    expect(trend?.first).toEqual(trend?.last);
  });

  it('возвращает null, когда снимков за период нет', () => {
    expect(forecastTrend(db, 'math')).toBeNull();

    snapshot('math', 0.6, 0);
    expect(forecastTrend(db, 'math', { since: at(1) })).toBeNull();
  });

  it('пишет снимки по каждому предмету карты и общий', () => {
    const written = recordForecasts(db, graph, at(0));

    expect(written.map((item) => item.subject)).toEqual(['overall', 'math', 'russian']);
    expect(readSnapshots(db, 'overall')).toHaveLength(1);
    expect(readSnapshots(db, 'math')).toHaveLength(1);
    expect(readSnapshots(db, 'english')).toHaveLength(0);
  });

  it('не пишет ничего по карте без экзаменационных тем', () => {
    const empty = graphOf([topic('math.junk', { subject: 'math', examWeight: 0 })]);

    expect(recordForecasts(db, empty, at(0))).toEqual([]);
    expect(readSnapshots(db, 'overall')).toHaveLength(0);
  });

  it('откатывает весь пакет, если один из предметных снимков не записался', () => {
    db.exec(`
      CREATE TRIGGER fail_math_forecast
      BEFORE INSERT ON forecast_snapshots
      WHEN NEW.subject = 'math'
      BEGIN
        SELECT RAISE(ABORT, 'test failure');
      END;
    `);

    expect(() => recordForecasts(db, graph, at(0))).toThrow(/test failure/);
    expect(readSnapshots(db, 'overall')).toEqual([]);
    expect(readSnapshots(db, 'math')).toEqual([]);
    expect(readSnapshots(db, 'russian')).toEqual([]);
  });

  it('отвергает снимок с оценкой вне шкалы 2..5', () => {
    const broken = { ratio: 0.6, score: 7, band: 0, low: 7, high: 7, weight: 2, untestedWeight: 0 };

    expect(() => writeForecastSnapshot(db, 'math', broken, at(0))).toThrow(/2\.\.5/);
    expect(() => writeForecastSnapshot(db, 'math', { score: Number.NaN, band: 0 }, at(0))).toThrow(
      /2\.\.5/,
    );
  });

  it('отвергает снимок с полосой погрешности вне диапазона 0..1', () => {
    expect(() => writeForecastSnapshot(db, 'math', { score: 4, band: -0.1 }, at(0))).toThrow(
      /полос/i,
    );
    expect(() =>
      writeForecastSnapshot(db, 'math', { score: 4, band: Number.NaN }, at(0)),
    ).toThrow(/полос/i);
    expect(() => writeForecastSnapshot(db, 'math', { score: 4, band: 1.1 }, at(0))).toThrow(
      /полос/i,
    );
    expect(readSnapshots(db, 'math')).toHaveLength(0);
  });
});
