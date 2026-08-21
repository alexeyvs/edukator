import { describe, expect, it } from 'vitest';
import { ImpersonationRefusals } from '../server/admin/impersonation-refusals.js';

describe('счётчик отказанных попыток записи', () => {
  it('считает отказы по оператору', () => {
    const refusals = new ImpersonationRefusals();
    expect(refusals.record('админ-1')).toBe(1);
    expect(refusals.record('админ-1')).toBe(2);
    expect(refusals.record('админ-2')).toBe(1);
    expect(refusals.count('админ-1')).toBe(2);
    expect(refusals.count('админ-2')).toBe(1);
  });

  it('называет ноль, а не пустоту, у оператора без отказов', () => {
    const refusals = new ImpersonationRefusals();
    expect(refusals.count('админ-1')).toBe(0);
    expect(refusals.take('админ-1')).toBe(0);
  });

  it('забирает счётчик вместе с обнулением', () => {
    const refusals = new ImpersonationRefusals();
    refusals.record('админ-1');
    refusals.record('админ-1');
    expect(refusals.take('админ-1')).toBe(2);
    // Следующий заход начинается с нуля: иначе отказы прошлого приписались бы
    // к записи о конце следующего.
    expect(refusals.count('админ-1')).toBe(0);
    expect(refusals.record('админ-1')).toBe(1);
  });

  it('не трогает соседнего оператора', () => {
    const refusals = new ImpersonationRefusals();
    refusals.record('админ-1');
    refusals.record('админ-2');
    refusals.take('админ-1');
    expect(refusals.count('админ-2')).toBe(1);
  });
});
