// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import './test-setup';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

describe('App', () => {
  it('подключён к общему прогону компонентных тестов', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
    render(<App />);

    expect(screen.getByRole('link', { name: 'Эдукатор' })).toBeInTheDocument();
  });

  it('не даёт прямой ссылке на забег обойти первое знакомство', async () => {
    window.history.replaceState({}, '', '/?runId=7');
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        name: 'Ученик',
        interests: [],
        examDate: null,
        partnerName: '',
        introduction: 'Давай познакомимся.',
      }),
    })));

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Сначала познакомимся' }))
      .toBeInTheDocument();
    expect(screen.queryByLabelText('Загрузка задания')).not.toBeInTheDocument();
  });
});
