// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChildDailyTopics } from './ChildDailyTopics';
import type { DailyTopicsApi } from './daily-topics-api';
import './test-setup';

afterEach(cleanup);

describe('темы на день в кабинете родителя', () => {
  it('показывает ход подготовки без ограничения московской полуночью', async () => {
    const api: DailyTopicsApi = {
      read: vi.fn().mockResolvedValue({ active: null, preparing: {
        id: 1, day: '2026-09-23', status: 'preparing', sourceText: 'Дроби\nЛуна',
        items: [
          { id: 1, position: 1, topicId: 'math.fractions', subject: 'math', subjectTitle: 'Математика',
            courseRevisionId: 1, title: 'Дроби', materialId: 1, status: 'ready', materialStatus: 'ready',
            lastError: null, firstScore: null, firstTotal: null, firstRunId: null },
          { id: 2, position: 2, topicId: 'personal-moon', subject: 'astronomy', subjectTitle: 'Астрономия',
            courseRevisionId: null, title: 'Луна', materialId: null, status: 'preparing', materialStatus: null,
            lastError: null, firstScore: null, firstTotal: null, firstRunId: null },
        ],
      } }),
      preview: vi.fn(), confirm: vi.fn(), retry: vi.fn(), cancel: vi.fn(),
    };
    render(<ChildDailyTopics childId="child-1" courses={[]} api={api} />);
    fireEvent.click(screen.getByText('Темы из школы на сегодня'));
    expect(await screen.findByText('Готовим темы · 1 из 2 готово')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Подготовка тем' })).toHaveAttribute('value', '1');
    expect(screen.getByText(/исправляем замечания автоматически/)).toBeInTheDocument();
    expect(screen.queryByText('Повторить ошибки подготовки')).not.toBeInTheDocument();
    expect(screen.queryByText(/После полуночи по Москве назначение сегодня не включится/)).not.toBeInTheDocument();
  });

  it('показывает предпросмотр, разрешает исправить предмет и отправляет весь набор', async () => {
    const preview = vi.fn().mockResolvedValue([
      { title: 'Дроби', subjectId: 'math', subjectTitle: 'Математика', topicId: 'math.fractions' },
      { title: 'Луна', subjectId: null, subjectTitle: 'Астрономия', topicId: null },
    ]);
    const confirm = vi.fn().mockResolvedValue({});
    const api: DailyTopicsApi = {
      read: vi.fn().mockResolvedValue({ active: null, preparing: null }),
      preview, confirm,
      retry: vi.fn().mockResolvedValue({ active: null, preparing: null }),
      cancel: vi.fn().mockResolvedValue({ active: null, preparing: null }),
    };
    render(<ChildDailyTopics childId="child-1" courses={[{
      courseId: 'math', title: 'Математика', grade: '5', revisionId: 1,
      topics: [{ id: 'math.fractions', title: 'Дроби', prereqs: [] }],
    }]} api={api} />);
    fireEvent.click(screen.getByText('Темы из школы на сегодня'));
    fireEvent.change(screen.getByLabelText('Список тем'), { target: { value: 'Дроби; Луна' } });
    fireEvent.click(screen.getByText('Разобрать список'));
    await waitFor(() => expect(preview).toHaveBeenCalledWith('child-1', 'Дроби; Луна'));
    expect(await screen.findByText('Проверьте темы и предметы')).toBeInTheDocument();
    const subjects = screen.getAllByLabelText('Предмет');
    fireEvent.change(subjects[1]!, { target: { value: 'math' } });
    fireEvent.click(screen.getByText('Назначить все темы'));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    const [childId, sourceText, requestKey, items] = confirm.mock.calls[0]!;
    expect(childId).toBe('child-1');
    expect(sourceText).toBe('Дроби; Луна');
    expect(requestKey).toBeTypeOf('string');
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ title: 'Луна', subjectId: 'math', topicId: null });
  });
});
