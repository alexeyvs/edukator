// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminCourseCard, AdminCourseDraft, AdminUploadOptions } from '../admin-api';
import { HttpError } from '../http';
import { AdminCourseEditor } from './AdminCourseEditor';
import { testAdminApi } from './test-admin-api';
import '../test-setup';

afterEach(() => { cleanup(); vi.useRealTimers(); });
beforeEach(() => vi.spyOn(window, 'confirm').mockReturnValue(true));

const revision = {
  id: 11, courseId: 'history-6', revisionNumber: 2, status: 'draft' as const,
  basedOnRevisionId: 10, editVersion: 3, publishedBy: null,
  title: 'История', grade: '6 класс',
  createdAt: '2026-08-22T10:00:00.000Z', publishedAt: null,
};
const topic = {
  id: 'history-6.ancient', title: 'Древний мир', examWeight: 2, difficulty: 1,
  prereqs: [], answerFormat: 'text' as const, promptSeed: 'Древние государства', active: true, position: 0,
  sourceRefs: [],
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
    fireEvent.change(screen.getAllByLabelText('Вес')[0] as HTMLElement, { target: { value: '3' } });
    fireEvent.change(screen.getAllByLabelText('Сложность')[0] as HTMLElement, { target: { value: '2' } });
    fireEvent.change(screen.getAllByLabelText('Ответ')[0] as HTMLElement, { target: { value: 'number' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Античный мир history-6\.ancient/u }));
    fireEvent.click(screen.getAllByLabelText('Тема активна')[1] as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить карту тем' }));

    await waitFor(() => expect(replaceCourseTopics).toHaveBeenCalled());
    expect(replaceCourseTopics.mock.calls[0]?.[1]).toMatchObject({
      revisionId: 11, editVersion: 3,
      topics: [{ title: 'Античный мир' }, {
        title: 'Средние века', clientId: expect.any(String), prereqs: ['history-6.ancient'],
      }],
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

    expect((await screen.findAllByText('учебник.pdf')).length).toBeGreaterThan(0);
    expect(await screen.findByLabelText('Страницы-основания')).toHaveTextContent('Слишком мало текста');
    expect(screen.getByRole('progressbar', { name: 'Прогресс OCR' })).toHaveAttribute('aria-valuenow', '2');
    expect(screen.getByText(/2 из 2 \(100%\)/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Опубликовать редакцию' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Повторить OCR' }));
    await waitFor(() => expect(retryCourseSource).toHaveBeenCalledWith('history-6', 5));
    expect(await screen.findByText('OCR поставлен на повтор')).toBeInTheDocument();
  });

  it('показывает недоступную диагностику и дубликат PDF', async () => {
    const source = {
      id: 7, courseId: 'history-6', revisionId: 11, uploadName: 'повтор.pdf', sha256: 'b'.repeat(64),
      pageCount: null, status: 'failed' as const, error: 'OCR недоступен', createdAt: '2026-08-22T10:00:00.000Z',
    };
    const uploadCourseSource = vi.fn().mockResolvedValue({ source, duplicate: true });
    const api = baseApi({
      uploadCourseSource,
      courseBuild: vi.fn().mockRejectedValue(new Error('сборка недоступна')),
      courseSources: vi.fn().mockResolvedValue({ sources: [source] }),
      courseSourceStatus: vi.fn().mockRejectedValue(new Error('статус недоступен')),
    });
    render(<AdminCourseEditor api={api} courseId="history-6" onBack={vi.fn()} onSignedOut={vi.fn()} />);

    expect(await screen.findByText('OCR недоступен')).toBeInTheDocument();
    expect(screen.getByText(/страницы считаются/i)).toBeInTheDocument();
    expect(screen.getByText('Диагностика страниц ещё не загружена')).toBeInTheDocument();
    expect(await screen.findByText('состояние недоступно')).toBeInTheDocument();

    const file = new File(['%PDF-1.7'], 'повтор.pdf', { type: 'application/pdf' });
    fireEvent.change(document.querySelector('input[type=file]') as HTMLInputElement, { target: { files: [file] } });
    await waitFor(() => expect(uploadCourseSource).toHaveBeenCalledWith(
      'history-6', file, expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
    expect(await screen.findByText('Такой PDF уже загружен')).toBeInTheDocument();
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

  it('проводит PDF через upload, build, delete и архивирует курс', async () => {
    const source = {
      id: 5, courseId: 'history-6', revisionId: 11, uploadName: 'учебник.pdf', sha256: 'a'.repeat(64),
      pageCount: 1, status: 'ready' as const, error: null, createdAt: '2026-08-22T10:00:00.000Z',
    };
    const updateCourse = vi.fn().mockResolvedValue({ course: card.course, revision: { ...revision, editVersion: 4 } });
    const uploadCourseSource = vi.fn().mockResolvedValue({ source, duplicate: false });
    const buildCourseDraft = vi.fn().mockResolvedValue({ revisionId: 11, status: 'running' });
    const deleteCourseSource = vi.fn().mockResolvedValue({ source });
    const archiveCourse = vi.fn().mockResolvedValue({ course: { ...card.course, status: 'archived' }, idempotent: false });
    const api = baseApi({
      updateCourse, uploadCourseSource, buildCourseDraft, deleteCourseSource, archiveCourse,
      courseSources: vi.fn().mockResolvedValue({ sources: [source] }),
      courseSourceStatus: vi.fn().mockResolvedValue({
        sourceId: 5, sourceStatus: 'ready', job: { id: 4, status: 'succeeded', attempts: 1, currentPage: null, error: null },
        pages: [{ pageNumber: 1, status: 'ready', error: null }],
      }),
    });
    render(<AdminCourseEditor api={api} courseId="history-6" onBack={vi.fn()} onSignedOut={vi.fn()} />);

    expect((await screen.findAllByText('учебник.pdf')).length).toBeGreaterThan(0);
    fireEvent.change(screen.getAllByLabelText('Название')[0] as HTMLElement, { target: { value: 'История мира' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(updateCourse).toHaveBeenCalled());

    const file = new File(['%PDF-1.7'], 'новый.pdf', { type: 'application/pdf' });
    fireEvent.change(document.querySelector('input[type=file]') as HTMLInputElement, { target: { files: [file] } });
    await waitFor(() => expect(uploadCourseSource).toHaveBeenCalledWith(
      'history-6', file, expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
    fireEvent.click(screen.getByRole('button', { name: 'Собрать по источникам' }));
    await waitFor(() => expect(buildCourseDraft).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Удалить' }));
    await waitFor(() => expect(deleteCourseSource).toHaveBeenCalledWith('history-6', 5));
    fireEvent.click(screen.getByRole('button', { name: 'В архив' }));
    await waitFor(() => expect(archiveCourse).toHaveBeenCalledWith('history-6'));
  });

  it('показывает передачу PDF, замечает остановку и позволяет отменить её', async () => {
    let uploadOptions: AdminUploadOptions | undefined;
    const uploadCourseSource = vi.fn((_courseId: string, _file: File, options?: AdminUploadOptions) => {
      uploadOptions = options;
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new DOMException('Загрузка отменена', 'AbortError')));
      });
    });
    const api = baseApi({ uploadCourseSource });
    render(<AdminCourseEditor api={api} courseId="history-6" onBack={vi.fn()} onSignedOut={vi.fn()} />);
    await screen.findByDisplayValue('История');

    const file = new File(['12345678'], 'большой учебник.pdf', { type: 'application/pdf' });
    vi.useFakeTimers();
    fireEvent.change(document.querySelector('input[type=file]') as HTMLInputElement, { target: { files: [file] } });
    expect(uploadCourseSource).toHaveBeenCalled();
    act(() => uploadOptions?.onProgress?.({ loaded: 4, total: 8 }));

    expect(screen.getByRole('progressbar', { name: 'Загрузка PDF' })).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByText(/50%/u)).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(screen.getByRole('alert')).toHaveTextContent('Передача не движется уже 15 секунд');
    fireEvent.click(screen.getByRole('button', { name: 'Отменить загрузку' }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole('status')).toHaveTextContent('Загрузка PDF отменена');
  });

  it('после успешной сборки перечитывает темы, editVersion и страницы-основания', async () => {
    const source = {
      id: 5, courseId: 'history-6', revisionId: 11, uploadName: 'учебник.pdf', sha256: 'a'.repeat(64),
      pageCount: 2, status: 'ready' as const, error: null, createdAt: '2026-08-22T10:00:00.000Z',
    };
    const generatedTopic = { ...topic, title: 'Тема из OCR', sourceRefs: [{ sourceId: 5, pageFrom: 1, pageTo: 2 }] };
    const generatedCard = {
      ...card,
      revisions: card.revisions.map((item) => item.id === 11
        ? { ...item, editVersion: 4, topics: [generatedTopic] } : item),
    };
    const course = vi.fn().mockResolvedValueOnce(card).mockResolvedValue(generatedCard);
    const courseBuild = vi.fn()
      .mockResolvedValueOnce({ revisionId: 11, job: { status: 'running' } })
      .mockResolvedValueOnce({ revisionId: 11, job: { status: 'succeeded' } })
      .mockResolvedValue({ revisionId: 11, job: { status: 'succeeded' } });
    const api = baseApi({
      course, courseBuild,
      courseSources: vi.fn().mockResolvedValue({ sources: [source] }),
      courseSourceStatus: vi.fn().mockResolvedValue({
        sourceId: 5, sourceStatus: 'ready', job: null,
        pages: [{ pageNumber: 1, status: 'ready', error: null }, { pageNumber: 2, status: 'ready', error: null }],
      }),
    });
    render(<AdminCourseEditor api={api} courseId="history-6" onBack={vi.fn()} onSignedOut={vi.fn()} />);
    await screen.findByDisplayValue('Древний мир');
    await screen.findByText('running', { selector: 'strong' });

    expect(await screen.findByDisplayValue('Тема из OCR', {}, { timeout: 3_000 })).toBeInTheDocument();
    expect(screen.getByText('Черновик · версия 4')).toBeInTheDocument();
    expect(screen.getByLabelText('Первая страница учебник.pdf')).toHaveValue(1);
    expect(screen.getByLabelText('Последняя страница учебник.pdf')).toHaveValue(2);
  });

  it('создаёт новый черновик опубликованной редакции и обрабатывает 401', async () => {
    const publishedOnly = {
      ...card,
      revisions: card.revisions.filter((item) => item.status === 'published'),
    };
    const createCourseDraft = vi.fn().mockResolvedValue({ revision, topics: [topic] });
    const onSignedOut = vi.fn();
    const api = baseApi({
      course: vi.fn().mockResolvedValue(publishedOnly),
      createCourseDraft,
      archiveCourse: vi.fn().mockRejectedValue(new HttpError({ status: 401, message: 'Нужно войти' })),
    });
    render(<AdminCourseEditor api={api} courseId="history-6" onBack={vi.fn()} onSignedOut={onSignedOut} />);

    await screen.findByRole('heading', { name: 'Опубликованная редакция неизменяема' });
    fireEvent.click(screen.getByRole('button', { name: 'Создать черновик' }));
    await waitFor(() => expect(createCourseDraft).toHaveBeenCalledWith('history-6', 10));
    fireEvent.click(screen.getByRole('button', { name: 'В архив' }));
    await waitFor(() => expect(onSignedOut).toHaveBeenCalledWith('expired'));
  });
});
