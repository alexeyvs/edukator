// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LearningScreen } from './LearningScreen';
import type { LearningApi, LearningMaterialView } from './learning-api';
import './test-setup';

afterEach(cleanup);

const MATERIAL: LearningMaterialView = {
  id: 21,
  subject: 'math',
  topic: { id: 'math.fractions', title: 'Обыкновенные дроби' },
  recommendationReason: 'В последних заданиях путаются знаменатели',
  estimatedMinutes: 12,
  status: 'active',
  progress: { total: 0, correct: 0, target: 5, done: false },
  content: {
    introduction: 'Дробь показывает, сколько равных частей взяли.',
    objectives: ['Находить числитель и знаменатель'],
    sections: [
      { title: 'Части дроби', blocks: [{ type: 'paragraph', content: '<img src=x onerror=alert(1)>' }] },
      { title: 'Запись', blocks: [{ type: 'formula', content: '\\frac{a}{b}' }] },
      { title: 'Проверка', blocks: [
        { type: 'example', content: 'В дроби 3/4 взяли три части.' },
        { type: 'warning', content: 'Не складывай знаменатели.' },
      ] },
    ],
    summary: ['Знаменатель — число всех равных частей.', 'Числитель — число взятых частей.'],
  },
};

function apiWith(material: LearningMaterialView = MATERIAL): LearningApi {
  return {
    read: vi.fn().mockResolvedValue(material),
    open: vi.fn().mockResolvedValue({ materialId: material.id, resumed: true, material }),
    startTest: vi.fn().mockResolvedValue({
      materialId: material.id,
      runId: 31,
      resumed: false,
      progress: material.progress,
    }),
    finish: vi.fn(),
  };
}

describe('экран персонального разбора', () => {
  it('продолжает открытый материал по порядку и безопасно рисует формулу без model HTML', async () => {
    const api = apiWith();
    const { container } = render(<LearningScreen materialId={21} api={api} navigate={vi.fn()} />);

    expect(await screen.findByRole('heading', { name: 'Обыкновенные дроби', level: 1 })).toBeInTheDocument();
    expect(api.open).toHaveBeenCalledWith(21);
    expect(screen.getByRole('heading', { name: 'Части дроби' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Запись' })).toBeInTheDocument();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('.katex')).not.toBeNull();
    expect(screen.getByText('Пример')).toBeInTheDocument();
    expect(screen.getByText('Обрати внимание')).toBeInTheDocument();
    expect(screen.queryByText(/таймер|осталось/iu)).not.toBeInTheDocument();
  });

  it('переходит к единственному тесту по явной кнопке', async () => {
    const api = apiWith();
    const navigate = vi.fn();
    render(<LearningScreen materialId={21} api={api} navigate={navigate} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Перейти к тесту' }));

    await waitFor(() => expect(api.startTest).toHaveBeenCalledWith(21));
    expect(navigate).toHaveBeenCalledWith('/?runId=31&kind=lesson');
  });

  it('после первого ответа сразу возвращает активный материал только в тест', async () => {
    const material = { ...MATERIAL, progress: { total: 1, correct: 1, target: 5, done: false } };
    const api = apiWith(material);
    const navigate = vi.fn();
    render(<LearningScreen materialId={21} api={api} navigate={navigate} />);

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/?runId=31&kind=lesson'));
    expect(screen.queryByRole('button', { name: 'Перейти к тесту' })).not.toBeInTheDocument();
  });
});
