import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CodexRequest } from '../server/codex/client.js';
import {
  integrityReviewer,
  parseIntegrityReview,
  reviewIntegrity,
} from '../server/codex/integrity.js';
import type { IntegrityPromptItem } from '../server/codex/prompt.js';

const ITEM: IntegrityPromptItem = {
  id: 7,
  topicTitle: 'Обыкновенные дроби',
  answerFormat: 'number',
  question: 'Вычисли значение выражения.',
  material: '1/2 + 1/4',
  choices: [],
  expected: '0,75',
  attempts: [{ answer: 'Gg', durationMs: 1_000 }],
  signal: 'В числовом ответе нет числа.',
};

describe('вердикт проверки осмысленности', () => {
  it('принимает по одному решению для каждого отмеченного ответа', () => {
    const result = parseIntegrityReview({
      items: [
        { id: 2, decision: 'junk', confidence: 0.96, reason: 'Случайные буквы вместо числа.' },
        { id: 5, decision: 'meaningful', confidence: 0.8, reason: 'Видна попытка вычисления.' },
      ],
    }, [2, 5]);

    expect(result.map((item) => item.decision)).toEqual(['junk', 'meaningful']);
  });

  it('отвергает пропущенный, лишний или повторный id', () => {
    expect(() => parseIntegrityReview({
      items: [{ id: 2, decision: 'junk', confidence: 1, reason: 'Нет решения.' }],
    }, [2, 5])).toThrow(/не для всех/u);
    expect(() => parseIntegrityReview({
      items: [{ id: 7, decision: 'junk', confidence: 1, reason: 'Нет решения.' }],
    }, [2])).toThrow(/неожиданный/u);
    expect(() => parseIntegrityReview({
      items: [
        { id: 2, decision: 'junk', confidence: 1, reason: 'Нет решения.' },
        { id: 2, decision: 'junk', confidence: 1, reason: 'Ответ повторён.' },
      ],
    }, [2])).toThrow(/повторный/u);
  });

  it('отвергает уверенность вне диапазона и неизвестное решение', () => {
    expect(() => parseIntegrityReview({
      items: [{ id: 2, decision: 'junk', confidence: 1.1, reason: 'Нет решения.' }],
    }, [2])).toThrow(/не соответствует схеме/u);
    expect(() => parseIntegrityReview({
      items: [{ id: 2, decision: 'wrong', confidence: 1, reason: 'Нет решения.' }],
    }, [2])).toThrow(/не соответствует схеме/u);
  });

  it('запускает отдельную роль Codex со схемой и удаляет временный каталог', async () => {
    let request: CodexRequest | undefined;
    const review = integrityReviewer({
      model: 'модель-проверки',
      timeoutMs: 12_345,
      run: (current) => {
        request = current;
        expect(existsSync(current.schemaPath)).toBe(true);
        expect(current.prompt).toContain('Gg');
        return Promise.resolve(JSON.stringify({
          items: [{
            id: 7,
            decision: 'junk',
            confidence: 0.98,
            reason: `  ${'Случайный ответ. '.repeat(30)}  `,
          }],
        }));
      },
    });

    const result = await review([ITEM]);

    expect(result[0]).toMatchObject({ id: 7, decision: 'junk', confidence: 0.98 });
    expect(result[0]?.reason.length).toBeLessThanOrEqual(300);
    expect(request).toMatchObject({ model: 'модель-проверки', timeoutMs: 12_345 });
    expect(existsSync(dirname(request?.schemaPath ?? ''))).toBe(false);
  });

  it('удаляет временный каталог, когда вызов Codex завершился ошибкой', async () => {
    let workDir = '';

    await expect(reviewIntegrity([ITEM], {
      run: (request) => {
        workDir = dirname(request.schemaPath);
        return Promise.reject(new Error('codex недоступен'));
      },
    })).rejects.toThrow('codex недоступен');

    expect(workDir).not.toBe('');
    expect(existsSync(workDir)).toBe(false);
  });
});
