// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskPrompt } from './TaskPrompt';
import type { RunTask } from './run-api';
import './test-setup';

afterEach(cleanup);

function task(overrides: Partial<RunTask> = {}): RunTask {
  return {
    id: 7,
    topic_id: 'math.a',
    topic_title: 'Дроби',
    subject: 'math',
    question: 'Старое условие',
    instruction: 'Вычисли значение',
    material: '2 + 2',
    material_format: 'text',
    choices: [],
    hint: 'Вспомни правило.\nЗатем проверь каждый шаг.',
    difficulty: 2,
    answer_format: 'number',
    ...overrides,
  };
}

function prompt(value = '', onChange = vi.fn(), overrides: Partial<RunTask> = {}) {
  return render(
    <TaskPrompt
      task={task(overrides)}
      answer={value}
      onAnswerChange={onChange}
      answerId="answer"
      headingId="question"
    />,
  );
}

describe('структурированное задание', () => {
  it('не запирает числовой ответ в десятичной клавиатуре', () => {
    prompt();

    const input = screen.getByLabelText('Число');
    expect(input).not.toHaveAttribute('inputmode');
    expect(input).toHaveAttribute('type', 'text');
  });

  it('разделяет инструкцию и многострочный текстовый материал', () => {
    prompt('', vi.fn(), { material: 'Прочитай отрывок.\nНайди главную мысль.' });

    expect(screen.getByRole('heading', { name: 'Вычисли значение' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Материал задания' }))
      .toHaveTextContent('Прочитай отрывок. Найди главную мысль.');
  });

  it('рендерит безопасную display-формулу через KaTeX', () => {
    prompt('', vi.fn(), { material_format: 'math', material: String.raw`\frac{3}{4}+\frac{1}{4}` });

    const sheet = screen.getByRole('region', { name: 'Материал задания' });
    expect(sheet.querySelector('.katex-display')).not.toBeNull();
    expect(sheet.querySelector('math')).not.toBeNull();
  });

  it('при ошибке KaTeX показывает исходник как текст', () => {
    prompt('', vi.fn(), { material_format: 'math', material: String.raw`\notacommand{` });

    expect(screen.getByLabelText('Формула в исходной записи')).toHaveTextContent(String.raw`\notacommand{`);
    expect(screen.getByLabelText('Формула в исходной записи').innerHTML).not.toContain('<script');
  });

  it('показывает radio-карточки и передаёт текст выбранного варианта', () => {
    const onChange = vi.fn();
    prompt('', onChange, { answer_format: 'choice', choices: ['Три', 'Четыре', 'Пять'] });

    expect(screen.getAllByRole('radio')).toHaveLength(3);
    fireEvent.click(screen.getByRole('radio', { name: /Четыре/u }));
    expect(onChange).toHaveBeenCalledWith('Четыре');
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('B')).toBeInTheDocument();
    expect(screen.getByText('C')).toBeInTheDocument();
  });

  it('сохраняет plain-text fallback и показывает подсказку одним блоком', () => {
    const legacy = task();
    delete legacy.instruction;
    delete legacy.material;
    delete legacy.material_format;
    render(
      <TaskPrompt
        task={legacy}
        answer=""
        onAnswerChange={vi.fn()}
        answerId="answer"
        headingId="question"
        hint={'Сначала найди правило.\nПотом проверь ход решения.'}
        hintVisible
      />,
    );

    expect(screen.getByRole('heading', { name: 'Старое условие' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Материал задания' })).not.toBeInTheDocument();
    expect(screen.getByText(/Сначала найди правило/u).textContent).toBe(
      'Сначала найди правило.\nПотом проверь ход решения.',
    );
  });

  it('оставляет текстовый ввод старому choice без структурированных вариантов', () => {
    const legacyChoice = task({ answer_format: 'choice', choices: [] });
    delete legacyChoice.instruction;
    render(
      <TaskPrompt
        task={legacyChoice}
        answer=""
        onAnswerChange={vi.fn()}
        answerId="answer"
        headingId="question"
      />,
    );

    expect(screen.getByLabelText('Вариант ответа')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });
});
