// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BrandLink } from './BrandMark';
import './test-setup';

afterEach(cleanup);

describe('логотип Эдукатора', () => {
  it('ведёт на главную и называет ссылку, не озвучивая декоративный маршрут', () => {
    render(<BrandLink />);

    const link = screen.getByRole('link', { name: 'Эдукатор' });
    expect(link).toHaveAttribute('href', '/');
    expect(link.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(link).not.toHaveTextContent('Э');
  });

  it('принимает назначение и подпись экрана, с которого возвращает', () => {
    render(<BrandLink href="/?runId=7&kind=lesson" label="Вернуться к тесту" />);

    expect(screen.getByRole('link', { name: 'Вернуться к тесту' }))
      .toHaveAttribute('href', '/?runId=7&kind=lesson');
  });
});
