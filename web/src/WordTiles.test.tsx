// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WordTiles } from './WordTiles';
import './test-setup';

afterEach(cleanup);

describe('расстановка слов', () => {
  it('различает дубли, синхронизирует строку и даёт кнопки для клавиатуры', () => {
    const onChange = vi.fn();
    render(
      <WordTiles
        taskId={7}
        words={['to', 'be', 'or', 'to']}
        answer=""
        onAnswerChange={onChange}
      />,
    );

    expect(screen.getAllByRole('button', { name: /Перетащить слово «to»/u })).toHaveLength(2);
    expect(onChange).toHaveBeenLastCalledWith('to be or to');
    onChange.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Передвинуть «be» вправо' }));

    expect(onChange).toHaveBeenCalledWith('to or be to');
    expect(screen.getByText('Слово «be» теперь на позиции 3.')).toBeInTheDocument();
  });

  it('в результате сохраняет порядок ученика и блокирует все перемещения', () => {
    const onChange = vi.fn();
    render(
      <WordTiles
        taskId={8}
        words={['winter.', 'Moscow', 'is', 'cold']}
        answer="Moscow is cold winter."
        onAnswerChange={onChange}
        readOnly
      />,
    );

    const list = screen.getByRole('list', { name: 'Порядок слов' });
    expect(within(list).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      '⠿Moscow', '⠿is', '⠿cold', '⠿winter.',
    ]);
    expect(screen.queryByRole('button', { name: /Передвинуть/u })).not.toBeInTheDocument();
    for (const handle of screen.getAllByRole('button', { name: /Перетащить слово/u })) {
      expect(handle).toBeDisabled();
    }
    expect(onChange).toHaveBeenLastCalledWith('Moscow is cold winter.');
  });
});
