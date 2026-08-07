import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../server/db.js';
import {
  ALPHA,
  BETA,
  CONFIDENCE_FLOOR,
  GAP_MASTERY,
  MAX_REVIEW_DAYS,
  MIN_REVIEW_DAYS,
  applyAttempt,
  confidenceAt,
  computeConfidence,
  daysBetween,
  isGap,
  newTopicState,
  nextMastery,
  readTopicState,
  readTopicStates,
  recomputeTopicState,
  recordAttempt,
  reviewIntervalDays,
  writeTopicState,
  type Attempt,
  type TopicState,
} from '../server/mastery.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function at(day: number): Date {
  return new Date(Date.UTC(2026, 7, 7, 12) + day * DAY_MS);
}

function attempt(patch: Partial<Attempt> = {}): Attempt {
  return { correct: true, difficulty: 2, hintUsed: false, at: at(0), ...patch };
}

describe('модель знаний', () => {
  // Остальные тесты строят ожидание из этих же констант, поэтому подмена любой
  // из них их не роняет. Числа заданы спекой, и здесь они прибиты буквально:
  // тихая «калибровка» α или порога пробела перекраивает весь учебный план.
  it('держит калибровочные константы спеки', () => {
    expect(ALPHA).toBe(0.35);
    expect(BETA).toBe(0.3);
    expect(GAP_MASTERY).toBe(0.6);
    expect(CONFIDENCE_FLOOR).toBe(0.5);
    expect(MIN_REVIEW_DAYS).toBe(1);
    expect(MAX_REVIEW_DAYS).toBe(21);
    // Множители сложности и подсказки — через наблюдаемое поведение.
    expect(nextMastery(0, attempt({ difficulty: 1 }))).toBeCloseTo(0.35 * 0.7, 12);
    expect(nextMastery(0, attempt({ difficulty: 3 }))).toBeCloseTo(0.35 * 1.3, 12);
    expect(nextMastery(0.5, attempt({ correct: false, difficulty: 1 })))
      .toBeCloseTo(0.5 - 0.3 * 1.3 * 0.5, 12);
    expect(nextMastery(0, attempt({ hintUsed: true }))).toBeCloseTo(0.35 * 0.5, 12);
    expect(computeConfidence(1, 0)).toBeCloseTo(1 - 0.75, 12);
    expect(computeConfidence(1, 1)).toBeCloseTo((1 - 0.75) * 0.98, 12);
  });

  describe('обновление mastery', () => {
    it('верный ответ поднимает mastery на α·(1 − mastery)', () => {
      expect(nextMastery(0.4, attempt())).toBeCloseTo(0.4 + ALPHA * 0.6, 12);
    });

    it('неверный ответ снижает mastery на β·mastery', () => {
      expect(nextMastery(0.4, attempt({ correct: false }))).toBeCloseTo(0.4 - BETA * 0.4, 12);
    });

    it('применяет множители сложности 0.7 / 1.0 / 1.3 к верному ответу', () => {
      const easy = nextMastery(0, attempt({ difficulty: 1 }));
      const medium = nextMastery(0, attempt({ difficulty: 2 }));
      const hard = nextMastery(0, attempt({ difficulty: 3 }));

      expect(easy).toBeCloseTo(ALPHA * 0.7, 12);
      expect(medium).toBeCloseTo(ALPHA * 1.0, 12);
      expect(hard).toBeCloseTo(ALPHA * 1.3, 12);
      expect(easy).toBeLessThan(medium);
      expect(medium).toBeLessThan(hard);
    });

    it('применяет множители сложности 1.3 / 1.0 / 0.7 к неверному ответу', () => {
      const easy = nextMastery(0.5, attempt({ correct: false, difficulty: 1 }));
      const medium = nextMastery(0.5, attempt({ correct: false, difficulty: 2 }));
      const hard = nextMastery(0.5, attempt({ correct: false, difficulty: 3 }));

      expect(easy).toBeCloseTo(0.5 - BETA * 1.3 * 0.5, 12);
      expect(medium).toBeCloseTo(0.5 - BETA * 1.0 * 0.5, 12);
      expect(hard).toBeCloseTo(0.5 - BETA * 0.7 * 0.5, 12);
      // Ошибка в лёгком задании информативнее: она стоит дороже.
      expect(easy).toBeLessThan(medium);
      expect(medium).toBeLessThan(hard);
    });

    it('вдвое ослабляет рост при использованной подсказке', () => {
      const solo = nextMastery(0.2, attempt());
      const hinted = nextMastery(0.2, attempt({ hintUsed: true }));

      expect(hinted - 0.2).toBeCloseTo((solo - 0.2) * 0.5, 12);
    });

    it('не смягчает падение подсказкой: неверно с подсказкой — то же падение', () => {
      const solo = nextMastery(0.5, attempt({ correct: false }));
      const hinted = nextMastery(0.5, attempt({ correct: false, hintUsed: true }));

      expect(hinted).toBeCloseTo(solo, 12);
    });

    it('держит mastery в границах 0..1 на любой серии попыток', () => {
      let mastery = 0.5;
      for (let index = 0; index < 500; index += 1) {
        const difficulty = (index % 3) + 1;
        mastery = nextMastery(mastery, attempt({ correct: index % 5 !== 0, difficulty }));
        expect(mastery).toBeGreaterThanOrEqual(0);
        expect(mastery).toBeLessThanOrEqual(1);
      }

      let onlyCorrect = 0;
      for (let index = 0; index < 500; index += 1) {
        onlyCorrect = nextMastery(onlyCorrect, attempt({ difficulty: 3 }));
      }
      expect(onlyCorrect).toBeLessThanOrEqual(1);
      expect(onlyCorrect).toBeGreaterThan(0.99);

      let onlyWrong = 1;
      for (let index = 0; index < 500; index += 1) {
        onlyWrong = nextMastery(onlyWrong, attempt({ correct: false, difficulty: 1 }));
      }
      expect(onlyWrong).toBeGreaterThanOrEqual(0);
      expect(onlyWrong).toBeLessThan(0.01);
    });

    it('отвергает сложность вне 1..3 и mastery вне 0..1', () => {
      expect(() => nextMastery(0.5, attempt({ difficulty: 0 }))).toThrow(/сложность/i);
      expect(() => nextMastery(0.5, attempt({ difficulty: 4 }))).toThrow(/сложность/i);
      expect(() => nextMastery(1.5, attempt())).toThrow(/mastery/i);
      expect(() => nextMastery(Number.NaN, attempt())).toThrow(/mastery/i);
    });
  });

  describe('confidence', () => {
    it('растёт как 1 − 0.75^n по числу попыток', () => {
      expect(computeConfidence(0, 0)).toBeCloseTo(0, 12);
      expect(computeConfidence(1, 0)).toBeCloseTo(0.25, 12);
      expect(computeConfidence(3, 0)).toBeCloseTo(1 - 0.75 ** 3, 12);
      expect(computeConfidence(10, 0)).toBeGreaterThan(computeConfidence(9, 0));
    });

    it('затухает как 0.98^d со временем', () => {
      const fresh = computeConfidence(5, 0);
      expect(computeConfidence(5, 1)).toBeCloseTo(fresh * 0.98, 12);
      expect(computeConfidence(5, 30)).toBeCloseTo(fresh * 0.98 ** 30, 12);
      expect(computeConfidence(5, 30)).toBeLessThan(computeConfidence(5, 10));
    });

    it('не даёт отрицательных дней и отрицательных попыток исказить формулу', () => {
      expect(computeConfidence(5, -3)).toBeCloseTo(computeConfidence(5, 0), 12);
      expect(() => computeConfidence(-1, 0)).toThrow(/попыт/i);
      expect(() => computeConfidence(3, Number.NaN)).toThrow(/дней/i);
      expect(() => computeConfidence(3, Number.POSITIVE_INFINITY)).toThrow(/дней/i);
    });

    it('считает дни между отметками времени дробно', () => {
      expect(daysBetween(at(0), at(3))).toBeCloseTo(3, 12);
      expect(daysBetween(at(0), new Date(at(0).getTime() + DAY_MS / 2))).toBeCloseTo(0.5, 12);
      // Часы назад — не отрицательное время, а «только что».
      expect(daysBetween(at(3), at(0))).toBe(0);
    });

    it('отвергает битую отметку времени, а не считает дни от NaN', () => {
      expect(() => daysBetween('не дата', at(0))).toThrow(/отметк/i);
      expect(() => daysBetween(at(0), 'вчера')).toThrow(/отметк/i);
      // Битая отметка в состоянии темы всплывает тем же способом.
      const broken = { ...newTopicState('math.fractions'), attempts: 2, lastSeen: 'позавчера' };
      expect(() => confidenceAt(broken, at(0))).toThrow(/отметк/i);
    });

    it('затухает от даты последней попытки, а не от даты записи', () => {
      const state = applyAttempt(newTopicState('math.fractions'), attempt());
      expect(confidenceAt(state, at(0))).toBeCloseTo(0.25, 12);
      expect(confidenceAt(state, at(10))).toBeCloseTo(0.25 * 0.98 ** 10, 12);
    });

    it('для темы без попыток уверенность нулевая независимо от даты', () => {
      const state = newTopicState('math.fractions');
      expect(confidenceAt(state, at(100))).toBe(0);
    });
  });

  describe('применение попытки', () => {
    it('обновляет mastery, счётчик попыток, confidence и отметки времени', () => {
      const before = newTopicState('math.fractions');
      const after = applyAttempt(before, attempt({ difficulty: 3 }));

      expect(after.attempts).toBe(1);
      expect(after.mastery).toBeCloseTo(ALPHA * 1.3, 12);
      expect(after.confidence).toBeCloseTo(0.25, 12);
      expect(after.lastSeen).toBe(at(0).toISOString());
      expect(after.nextReview).not.toBeNull();
      // Исходное состояние не мутируется: его читает планировщик того же забега.
      expect(before.attempts).toBe(0);
      expect(before.mastery).toBe(0);
    });

    it('копит уверенность по серии попыток в один день', () => {
      let state = newTopicState('math.fractions');
      for (let index = 0; index < 3; index += 1) {
        state = applyAttempt(state, attempt());
      }
      expect(state.attempts).toBe(3);
      expect(state.confidence).toBeCloseTo(1 - 0.75 ** 3, 12);
    });

    it('учитывает простой между попытками при пересчёте confidence', () => {
      const first = applyAttempt(newTopicState('math.fractions'), attempt());
      const second = applyAttempt(first, attempt({ at: at(20) }));

      // Свежая попытка считается по числу попыток без затухания.
      expect(second.confidence).toBeCloseTo(1 - 0.75 ** 2, 12);
      expect(second.lastSeen).toBe(at(20).toISOString());
    });

    it('отвергает битое время и попытку старше уже применённой истории', () => {
      const first = applyAttempt(newTopicState('math.fractions'), attempt({ at: at(5) }));
      expect(() => applyAttempt(first, attempt({ at: at(4) }))).toThrow(/старше последней/);
      expect(() => applyAttempt(first, attempt({ at: new Date(Number.NaN) }))).toThrow(/время попытки/);
      expect(() => applyAttempt({ ...first, lastSeen: 'не дата' }, attempt({ at: at(6) })))
        .toThrow(/время последней попытки/);
    });
  });

  describe('интервальное повторение', () => {
    it('растягивает интервал с ростом mastery', () => {
      const intervals = [0, 0.25, 0.5, 0.75, 1].map(reviewIntervalDays);
      for (let index = 1; index < intervals.length; index += 1) {
        expect(intervals[index]).toBeGreaterThan(intervals[index - 1] as number);
      }
      expect(intervals[0]).toBeCloseTo(MIN_REVIEW_DAYS, 12);
      expect(intervals[intervals.length - 1]).toBeCloseTo(MAX_REVIEW_DAYS, 12);
    });

    it('отодвигает next_review тем дальше, чем выше mastery', () => {
      const weak = applyAttempt({ ...newTopicState('math.fractions'), mastery: 0.1 }, attempt());
      const strong = applyAttempt({ ...newTopicState('math.fractions'), mastery: 0.9 }, attempt());

      expect(weak.nextReview).not.toBeNull();
      expect(strong.nextReview).not.toBeNull();
      expect(Date.parse(strong.nextReview as string)).toBeGreaterThan(
        Date.parse(weak.nextReview as string),
      );
    });

    it('отсчитывает next_review от времени попытки', () => {
      const state = applyAttempt(newTopicState('math.fractions'), attempt({ at: at(5) }));
      const expected = at(5).getTime() + reviewIntervalDays(state.mastery) * DAY_MS;
      expect(Date.parse(state.nextReview as string)).toBeCloseTo(expected, -1);
    });
  });

  describe('определение пробела', () => {
    const topic = { examWeight: 1 };

    it('считает пробелом слабую тему с достаточной уверенностью', () => {
      let state = newTopicState('math.fractions');
      for (let index = 0; index < 6; index += 1) {
        state = applyAttempt(state, attempt({ correct: index % 3 === 0 }));
      }

      expect(state.mastery).toBeLessThan(GAP_MASTERY);
      expect(confidenceAt(state, at(0))).toBeGreaterThanOrEqual(CONFIDENCE_FLOOR);
      expect(isGap(topic, state, at(0))).toBe(true);
    });

    it('не считает пробелом слабую тему, по которой мало данных', () => {
      const state = applyAttempt(newTopicState('math.fractions'), attempt({ correct: false }));

      expect(state.mastery).toBeLessThan(GAP_MASTERY);
      expect(confidenceAt(state, at(0))).toBeLessThan(CONFIDENCE_FLOOR);
      expect(isGap(topic, state, at(0))).toBe(false);
    });

    it('считает пробелом непроверенную тему с весом ≥ 2', () => {
      const untouched = newTopicState('math.fractions');

      expect(isGap({ examWeight: 2 }, untouched, at(0))).toBe(true);
      expect(isGap({ examWeight: 3 }, untouched, at(0))).toBe(true);
      expect(isGap({ examWeight: 1 }, untouched, at(0))).toBe(false);
      expect(isGap({ examWeight: 0 }, untouched, at(0))).toBe(false);
    });

    it('не считает пробелом освоенную тему', () => {
      let state = newTopicState('math.fractions');
      for (let index = 0; index < 8; index += 1) {
        state = applyAttempt(state, attempt({ difficulty: 3 }));
      }

      expect(state.mastery).toBeGreaterThanOrEqual(GAP_MASTERY);
      expect(isGap({ examWeight: 3 }, state, at(0))).toBe(false);
    });

    it('убирает тему из пробелов, когда уверенность затухла ниже порога', () => {
      let state = newTopicState('math.fractions');
      for (let index = 0; index < 6; index += 1) {
        state = applyAttempt(state, attempt({ correct: index % 3 === 0 }));
      }

      expect(isGap(topic, state, at(0))).toBe(true);
      // Через полгода данных фактически нет — «слабая тема» больше не подтверждена.
      expect(isGap(topic, state, at(200))).toBe(false);
    });
  });

  describe('хранение состояния', () => {
    let tempDir: string;
    let db: Database;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'edukator-mastery-'));
      db = openDatabase(join(tempDir, 'test.db'));
      db.prepare('INSERT INTO topic_state (topic_id) VALUES (?)').run('math.fractions');
    });

    afterEach(() => {
      db.close();
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('читает заведённую синхронизацией тему нулевой', () => {
      const state = readTopicState(db, 'math.fractions');
      expect(state).toEqual<TopicState>({
        topicId: 'math.fractions',
        mastery: 0,
        confidence: 0,
        attempts: 0,
        lastSeen: null,
        nextReview: null,
      });
    });

    it('записывает и перечитывает состояние без потерь', () => {
      const state = applyAttempt(newTopicState('math.fractions'), attempt({ difficulty: 3 }));
      writeTopicState(db, state);

      expect(readTopicState(db, 'math.fractions')).toEqual(state);
      expect(readTopicStates(db).get('math.fractions')).toEqual(state);
    });

    it('обновляет состояние по результату попытки', () => {
      const first = recordAttempt(db, 'math.fractions', attempt());
      const second = recordAttempt(db, 'math.fractions', attempt({ at: at(1) }));

      expect(first.attempts).toBe(1);
      expect(second.attempts).toBe(2);
      expect(second.mastery).toBeGreaterThan(first.mastery);
      expect(readTopicState(db, 'math.fractions')).toEqual(second);
    });

    it('отвергает попытку по неизвестной теме', () => {
      expect(() => recordAttempt(db, 'math.unknown', attempt())).toThrow(/math\.unknown/);
      expect(() => readTopicState(db, 'math.unknown')).toThrow(/math\.unknown/);
      expect(() => writeTopicState(db, newTopicState('math.unknown'))).toThrow(/math\.unknown/);
    });

    it('отдаёт пустую карту состояний на пустой базе', () => {
      db.prepare('DELETE FROM topic_state').run();
      expect(readTopicStates(db).size).toBe(0);
    });
  });

  describe('пересчёт по истории попыток', () => {
    let tempDir: string;
    let db: Database;

    /** Задание в банке: без него у попытки нет ни сложности, ни внешнего ключа. */
    function addTask(difficulty: number): number {
      const info = db
        .prepare(
          `INSERT INTO task_bank (topic_id, question, answer, difficulty)
           VALUES ('math.fractions', 'вопрос', '45', ?)`,
        )
        .run(difficulty);
      return Number(info.lastInsertRowid);
    }

    function addAttempt(
      correct: boolean,
      difficulty: number,
      day: number,
      hintUsed = false,
    ): void {
      db.prepare(
        `INSERT INTO attempts (task_id, topic_id, answer, is_correct, hint_used, created_at)
         VALUES (?, 'math.fractions', '45', ?, ?, ?)`,
      ).run(addTask(difficulty), correct ? 1 : 0, hintUsed ? 1 : 0, at(day).toISOString());
    }

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'edukator-mastery-replay-'));
      db = openDatabase(join(tempDir, 'test.db'));
      db.prepare('INSERT INTO topic_state (topic_id) VALUES (?)').run('math.fractions');
    });

    afterEach(() => {
      db.close();
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('повторяет цепочку попыток и совпадает с пошаговым применением', () => {
      addAttempt(true, 2, 0);
      addAttempt(false, 3, 1);
      addAttempt(true, 1, 2);

      const replayed = recomputeTopicState(db, 'math.fractions');

      let expected = newTopicState('math.fractions');
      expected = applyAttempt(expected, attempt({ correct: true, difficulty: 2, at: at(0) }));
      expected = applyAttempt(expected, attempt({ correct: false, difficulty: 3, at: at(1) }));
      expected = applyAttempt(expected, attempt({ correct: true, difficulty: 1, at: at(2) }));
      expect(replayed).toEqual(expected);
      expect(readTopicState(db, 'math.fractions')).toEqual(expected);
    });

    // Пересчёт идёт по всей истории темы, и штраф за подсказку обязан пережить
    // его: иначе разбор спора молча раздувал бы `mastery`, а на нём держатся и
    // план, и прогноз.
    it('сохраняет штраф за подсказку при пересчёте', () => {
      addAttempt(true, 2, 0, true);
      addAttempt(true, 2, 1, false);

      const replayed = recomputeTopicState(db, 'math.fractions');

      let expected = newTopicState('math.fractions');
      expected = applyAttempt(
        expected,
        attempt({ correct: true, difficulty: 2, at: at(0), hintUsed: true }),
      );
      expected = applyAttempt(
        expected,
        attempt({ correct: true, difficulty: 2, at: at(1), hintUsed: false }),
      );
      expect(replayed).toEqual(expected);

      // И это не то же самое, что цепочка без подсказки: иначе тест ничего не
      // держал бы.
      let unhinted = newTopicState('math.fractions');
      unhinted = applyAttempt(unhinted, attempt({ correct: true, difficulty: 2, at: at(0) }));
      unhinted = applyAttempt(unhinted, attempt({ correct: true, difficulty: 2, at: at(1) }));
      expect(replayed.mastery).toBeLessThan(unhinted.mastery);
    });

    it('видит исправленный результат попытки: ради этого пересчёт и нужен', () => {
      addAttempt(false, 2, 0);
      const wrong = recomputeTopicState(db, 'math.fractions');

      db.prepare('UPDATE attempts SET is_correct = 1').run();
      const fixed = recomputeTopicState(db, 'math.fractions');

      expect(wrong.mastery).toBe(0);
      expect(fixed.mastery).toBeGreaterThan(0);
      expect(fixed.attempts).toBe(1);
    });

    it('обнуляет состояние темы без попыток и падает на теме вне topic_state', () => {
      writeTopicState(db, applyAttempt(newTopicState('math.fractions'), attempt()));

      expect(recomputeTopicState(db, 'math.fractions')).toEqual(newTopicState('math.fractions'));
      expect(() => recomputeTopicState(db, 'math.unknown')).toThrow(/math\.unknown/);
    });
  });
});
