// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminCourseCard, AdminCourseDraft } from '../admin-api';
import { HttpError } from '../http';
import { AdminCourseEditor } from './AdminCourseEditor';
import { testAdminApi } from './test-admin-api';
import '../test-setup';

afterEach(cleanup);
beforeEach(() => vi.spyOn(window, 'confirm').mockReturnValue(true));

const revision = {
  id: 11, courseId: 'history-6', revisionNumber: 2, status: 'draft' as const,
  basedOnRevisionId: 10, editVersion: 3, publishedBy: null,
  createdAt: '2026-08-22T10:00:00.000Z', publishedAt: null,
};
const topic = {
  id: 'history-6.ancient', title: 'Древний мир', examWeight: 2, difficulty: 1,
  prereqs: [], answerFormat: 'text' as const, promptSeed: 'Древние государства', active: true, position: 0,
};
const card: AdminCourseCard = {
  course: {
    id: 'history-6', title: 'История', grade: '6 класс', status: 'published',
    activeRevisionId: 10, createdAt: '2026-08-20T10:00:00.000Z',
    updatedAt: '2026-08-22T10:00:00.000Z', archivedAt: null,
  },
  revisions: [{ ...revision, topics: [topic] }, {
    ...revision, id: 10, revisionNumber: 1, status: 'published', editVersion: 2,
    basedOnRevisionId: null, publishedBy: 'admin', publishedAt: '2026-08-21T10:00:00.000Z', topics: [topic],
  }],
};
const draft: AdminCourseDraft = { revision: { ...revision, editVersion: 4 }, topics: [topic] };

function baseApi(overrides = {}) {
  return testAdminApi({
    course: vi.fn().mockResolvedValue(card),
    courseSources: vi.fn().mockResolvedValue({ sources: [] }),
    courseBuild: vi.fn().mockResolvedValue({ revisionId: 11, job: null }),
    ...overrides,
  });
}

describe('редактор курса', () => {
  it('редактирует карту тем и публикует ручной курс без PDF', async () => {
    const replaceCourseTopics = vi.fn().mockResolvedValue(draft);
    const publishCourse = vi.fn().mockResolvedValue({ revision, idempotent: false });
    const api = baseApi({ replaceCourseTopics, publishCourse });
    render(<AdminCourseEditor api={api} courseId="history-6" onBack={vi.fn()} onSignedOut={vi.fn()} />);

    expect(await screen.findByDisplayValue('Древний мир')).toBeInTheDocument();
    expect(screen.getByText('Источников нет — ручной курс можно публиковать без PDF')).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue('Древний мир'), { target: { value: 'Античный мир' } });
    fireEvent.click(screen.getByRole('button', { name: 'Добавить тему' }));
    const titles = screen.getAllByLabelText('Название');
    fireEvent.change(titles[2] as HTMLElement, { target: { value: 'Средние века' } });
    const seeds = screen.getAllByLabelText('Основа промпта');
    fireEvent.change(seeds[1] as HTMLElement, { target: { value: 'Европа и Азия' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить карту тем' }));

    await waitFor(() => expect(replaceCourseTopics).toHaveBeenCalled());
    expect(replaceCourseTopics.mock.calls[0]?.[1]).toMatchObject({
      revisionId: 11, editVersion: 3,
      topics: [{ title: 'Античный мир' }, { title: 'Средние века', clientId: expect.any(String) }],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Опубликовать редакцию' }));
    await waitFor(() => expect(publishCourse).toHaveBeenCalledWith('history-6', expect.objectContaining({
      revisionId: 11, editVersion: 4, idempotencyKey: expect.any(String),
    })));
  });

  it('показывает прогресс, диагностику страниц и retry, блокируя публикацию', async () => {
    const retryCourseSource = vi.fn().mockResolvedValue({
      jobId: 4,
      status: { sourceId: 5, sourceStatus: 'processing', job: { id: 4, status: 'queued', attempts: 2, currentPage: 2, error: null }, pages: [] },
    });
    const api = baseApi({
      courseSources: vi.fn().mockResolvedValue({ sources: [{
        id: 5, courseId: 'history-6', revisionId: 11, uploadName: 'учебник.pdf', sha256: 'a'.repeat(64),
        pageCount: 2, status: 'processing', error: null, createdAt: '2026-08-22T10:00:00.000Z',
      }] }),
      courseSourceStatus: vi.fn().mockResolvedValue({
        sourceId: 5, sourceStatus: 'processing',
        job: { id: 4, status: 'running', attempts: 1, currentPage: 2, error: null },
        pages: [{ pageNumber: 1, status: 'ready', error: null }, { pageNumber: 2, status: 'failed', error: 'Слишком мало текста' }],
      }),
      retryCourseSource,
    });
    render(<AdminCourseEditor api={api} courseId="history-6" onBack={vi.fn()} onSignedOut={vi.fn()} />);

    expect(await screen.findByText('учебник.pdf')).toBeInTheDocument();
    expect(await screen.findByLabelText('Страницы-основания')).toHaveTextContent('Слишком мало текста');
    expect(screen.getByRole('button', { name: 'Опубликовать редакцию' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Повторить OCR' }));
    await waitFor(() => expect(retryCourseSource).toHaveBeenCalledWith('history-6', 5));
    expect(await screen.findByText('OCR поставлен на повтор')).toBeInTheDocument();
  });

  it('объясняет optimistic conflict и позволяет обновить данные', async () => {
    const course = vi.fn().mockResolvedValue(card);
    const api = baseApi({
      course,
      updateCourse: vi.fn().mockRejectedValue(new HttpError({ status: 409, message: 'Черновик уже изменён' })),
    });
    render(<AdminCourseEditor api={api} courseId="history-6" onBack={vi.fn()} onSignedOut={vi.fn()} />);

    await screen.findByDisplayValue('История');
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Конфликт: Черновик уже изменён');
    fireEvent.click(screen.getByRole('button', { name: 'Обновить данные' }));
    await waitFor(() => expect(course).toHaveBeenCalledTimes(2));
  });
});
