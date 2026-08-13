// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LearningFinishScreen } from './LearningFinishScreen';
import type { FinishLearningResponse } from './learning-api';
import './test-setup';

afterEach(cleanup);

function result(outcome: 'passed' | 'failed'): FinishLearningResponse {
  return {
    runId: 31,
    materialId: 21,
    outcome,
    total: 5,
    correct: outcome === 'passed' ? 4 : 3,
    xp: outcome === 'passed' ? 100 : 75,
    masteryBefore: .32,
    masteryAfter: outcome === 'passed' ? .61 : .42,
    passScore: 4,
    touchedTopics: [],
    closedTopics: [],
    declinedTopics: [],
    forecast: { id: 8, subject: 'math', score: 3.8, band: .4, createdAt: '2026-08-09T12:00:00.000Z' },
  };
}

describe('итог персонального разбора', () => {
  it.each([
    ['passed', 'Зачёт', '4/5', '61%', '+29 п.п.'],
    ['failed', 'Тему стоит повторить', '3/5', '42%', '+10 п.п.'],
  ] as const)('показывает %s, счёт и изменение mastery', (outcome, heading, score, mastery, delta) => {
    render(<LearningFinishScreen result={result(outcome)} />);

    expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    expect(screen.getByText(score)).toBeInTheDocument();
    expect(screen.getByText(mastery)).toBeInTheDocument();
    expect(screen.getByText(delta)).toBeInTheDocument();
    expect(screen.getByText('Порог зачёта — 4 из 5.')).toBeInTheDocument();
    const action = outcome === 'passed'
      ? screen.getByRole('link', { name: 'Вернуться к плану' })
      : screen.getByRole('link', { name: 'Повторить разбор' });
    expect(action).toHaveAttribute('href', outcome === 'passed' ? '/' : '/?learningId=21');
  });

  it('после незачёта отправляет перечитать ту же теорию перед новой попыткой', () => {
    render(<LearningFinishScreen result={result('failed')} />);

    expect(screen.getByText(
      'Перечитай эту же теорию и попробуй тот же тест ещё раз. Зачёт нужен для доступа к компьютеру.',
    )).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Вернуться к плану' })).not.toBeInTheDocument();
  });
});
