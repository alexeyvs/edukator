import { describe, expect, it } from 'vitest';
import { XP_BASE, XP_NO_HINT, taskXp } from '../server/xp.js';

describe('XP за задание', () => {
  it('держит калибровочные константы спеки', () => {
    expect(XP_BASE).toBe(10);
    expect(XP_NO_HINT).toBe(5);

    expect([1, 2, 3].map((difficulty) => taskXp({
      difficulty,
      correct: true,
      hintUsed: true,
    }))).toEqual([10, 20, 30]);
    expect([1, 2, 3].map((difficulty) => taskXp({
      difficulty,
      correct: true,
      hintUsed: false,
    }))).toEqual([15, 25, 35]);
  });

  it('не начисляет XP за неверный ответ независимо от сложности', () => {
    for (const difficulty of [1, 2, 3]) {
      expect(taskXp({ difficulty, correct: false, hintUsed: false })).toBe(0);
      expect(taskXp({ difficulty, correct: false, hintUsed: true })).toBe(0);
    }
  });

  it('отвергает сложность вне 1..3', () => {
    for (const difficulty of [0, 4, 1.5, Number.NaN]) {
      expect(() => taskXp({ difficulty, correct: true, hintUsed: false }))
        .toThrow(/сложность/i);
    }
  });
});
