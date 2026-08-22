// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../http';
import { testAdminApi } from './test-admin-api';
import { AdminCoursesScreen } from './AdminCoursesScreen';
import '../test-setup';

afterEach(cleanup);

const course = {
  id: 'география-5', title: 'География мира', grade: '5 класс', status: 'published' as const,
  activeRevisionId: 7, createdAt: '2026-08-22T10:00:00.000Z',
  updatedAt: '2026-08-22T10:00:00.000Z', archivedAt: null,
};

describe('каталог курсов оператора', () => {
  it('показывает произвольные курсы и создаёт новый без предметного union', async () => {
    const onCourse = vi.fn();
    const createCourse = vi.fn().mockResolvedValue({
      course: { ...course, id: 'астрономия-9', title: 'Астрономия', grade: '9 класс' },
      draft: { id: 8 },
    });
    const api = testAdminApi({ courses: vi.fn().mockResolvedValue({ courses: [course] }), createCourse });
    render(<AdminCoursesScreen api={api} onBack={vi.fn()} onCourse={onCourse} onSignedOut={vi.fn()} />);

    expect(await screen.findByText('География мира')).toBeInTheDocument();
    expect(screen.getByText('5 класс ·', { exact: false })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Название'), { target: { value: 'Астрономия' } });
    fireEvent.change(screen.getByLabelText('Класс'), { target: { value: '9 класс' } });
    fireEvent.change(screen.getByLabelText('ID (необязательно)'), { target: { value: 'астрономия-9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Создать курс' }));

    await waitFor(() => expect(createCourse).toHaveBeenCalledWith({
      id: 'астрономия-9', title: 'Астрономия', grade: '9 класс',
    }));
    expect(onCourse).toHaveBeenCalledWith('астрономия-9');
  });

  it('обрабатывает недоступность, повтор и закончившуюся сессию', async () => {
    const courses = vi.fn()
      .mockRejectedValueOnce(new Error('Каталог временно недоступен'))
      .mockRejectedValueOnce(new HttpError({ status: 401, message: 'Нужно войти' }));
    const onSignedOut = vi.fn();
    render(<AdminCoursesScreen api={testAdminApi({ courses })} onBack={vi.fn()} onCourse={vi.fn()} onSignedOut={onSignedOut} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Каталог временно недоступен');
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await waitFor(() => expect(onSignedOut).toHaveBeenCalledWith('expired'));
  });
});
