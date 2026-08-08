// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';
import './test-setup';

describe('App', () => {
  it('подключён к общему прогону компонентных тестов', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: 'Эдукатор' })).toBeInTheDocument();
  });
});
