// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FinishScreen } from './FinishScreen';
import type { FinishRunResponse } from './run-api';
import './test-setup';

afterEach(cleanup);

function summary(overrides: Partial<FinishRunResponse> = {}): FinishRunResponse {
  return {
    runId: 9,
    total: 12,
    correct: 8,
    xp: 180,
    touchedTopics: [],
    closedTopics: [],
    declinedTopics: [],
    forecast: {
      id: 3,
      subject: 'math',
      score: 3.4,
      band: 0.5,
      createdAt: '2026-08-08T12:00:00.000Z',
    },
    ...overrides,
  };
}

describe('финальный экран', () => {
  it('первый забег показывает прогноз без выдуманного нулевого сдвига', () => {
    render(<FinishScreen result={summary()} />);

    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('8')).toBeInTheDocument();
    expect(screen.getByText('180')).toBeInTheDocument();
    expect(screen.getByLabelText('Прогноз оценки')).toHaveTextContent('3.4');
    expect(screen.queryByText(/сдвиг прогноза/ui)).not.toBeInTheDocument();
  });

  it('пустой итог не роняет экран и объясняет отсутствие изменений', () => {
    render(<FinishScreen result={summary({ total: 0, correct: 0, xp: 0 })} />);

    expect(screen.getByRole('heading', { name: 'Вот что получилось' })).toBeInTheDocument();
    expect(screen.getByText('В этот раз без новых закрытых тем.')).toBeInTheDocument();
    expect(screen.getByText('Ни одна тема не просела.')).toBeInTheDocument();
  });

  it('поддерживает после большей половины верных и скрывает незрелую оценку', () => {
    render(<FinishScreen result={summary({
      total: 12,
      correct: 7,
      forecast: {
        id: 3,
        subject: 'math',
        score: 2,
        band: .9,
        createdAt: '2026-08-08T12:00:00.000Z',
      },
    })} />);

    expect(screen.getByText('Больше половины уже получается — хороший старт.')).toBeInTheDocument();
    expect(screen.getByLabelText('Предварительный прогноз')).toHaveTextContent('Оценку пока не ставим');
    expect(screen.queryByText('2.0')).not.toBeInTheDocument();
  });

  it('ранжирует темы триажа от худшей к лучшей', () => {
    render(<FinishScreen kind="triage" result={summary({
      touchedTopics: [
        { topicId: 'strong', title: 'Уверенная тема', before: 0, after: 0.8 },
        { topicId: 'weak', title: 'Слабая тема', before: 0, after: 0.2 },
      ],
    })} />);

    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      '1Слабая темаосвоенность 20%',
      '2Уверенная темаосвоенность 80%',
    ]);
  });
});
