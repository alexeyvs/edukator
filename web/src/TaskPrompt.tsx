import katex from 'katex';
import 'katex/dist/katex.min.css';
import { memo, type ChangeEvent, type ReactNode } from 'react';
import type { RunTask } from './run-api';

export interface TaskPromptProps {
  task: Omit<RunTask, 'hint'>;
  answer: string;
  onAnswerChange: (answer: string) => void;
  answerId: string;
  headingId: string;
  hint?: string;
  hintVisible?: boolean;
  /** Оставляет условие после отправки, не позволяя ответить второй раз. */
  readOnly?: boolean;
}

export const SafeFormula = memo(function SafeFormula({
  source,
  inline = false,
}: {
  source: string;
  inline?: boolean;
}) {
  try {
    const html = katex.renderToString(source, {
      displayMode: !inline,
      output: 'htmlAndMathml',
      trust: false,
      throwOnError: true,
      strict: 'error',
      maxSize: 12,
      maxExpand: 1_000,
    });
    return inline
      ? <span className="task-math-inline" dangerouslySetInnerHTML={{ __html: html }} />
      : <div className="task-math" dangerouslySetInnerHTML={{ __html: html }} />;
  } catch {
    return inline
      ? <code className="task-math-source-inline" aria-label="Формула в исходной записи">{source}</code>
      : <pre className="task-math-source" aria-label="Формула в исходной записи">{source}</pre>;
  }
});

const FORMULA_DELIMITERS = /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/gu;

/** Безопасно смешивает обычный текст с LaTeX в \(...\) и \[...\]. */
export function SafeRichText({ source }: { source: string }) {
  const parts: ReactNode[] = [];
  let start = 0;
  for (const match of source.matchAll(FORMULA_DELIMITERS)) {
    const index = match.index;
    if (index > start) parts.push(source.slice(start, index));
    const inline = match[1] !== undefined;
    parts.push(
      <SafeFormula
        inline={inline}
        key={`${String(index)}:${match[0]}`}
        source={(match[1] ?? match[2]) as string}
      />,
    );
    start = index + match[0].length;
  }
  if (start < source.length) parts.push(source.slice(start));
  return <div className="safe-rich-text">{parts}</div>;
}

function ChoiceAnswer({ task, answer, onAnswerChange, readOnly }: Pick<TaskPromptProps, 'task' | 'answer' | 'onAnswerChange' | 'readOnly'>) {
  return (
    <fieldset className="choice-group">
      <legend>Выбери один вариант</legend>
      {task.choices?.map((choice, index) => {
        const id = `task-choice-${task.id}-${index}`;
        return (
          <label className="choice-card" key={choice} htmlFor={id}>
            <input
              id={id}
              type="radio"
              name={`task-${task.id}-choice`}
              value={choice}
              checked={answer === choice}
              disabled={readOnly}
              onChange={(event: ChangeEvent<HTMLInputElement>) => onAnswerChange(event.target.value)}
            />
            <span className="choice-letter" aria-hidden="true">{String.fromCharCode(65 + index)}</span>
            <span>{choice}</span>
          </label>
        );
      })}
    </fieldset>
  );
}

export function TaskPrompt({ task, answer, onAnswerChange, answerId, headingId, hint, hintVisible = false, readOnly = false }: TaskPromptProps) {
  const instruction = task.instruction ?? task.question;
  const materialFormat = task.material_format ?? 'none';
  const material = task.material ?? '';
  const label = task.answer_format === 'number'
    ? 'Число'
    : task.answer_format === 'choice' ? 'Вариант ответа' : 'Ответ';

  return (
    <>
      <h1 id={headingId} className="task-instruction">{instruction}</h1>
      {materialFormat !== 'none' && (
        <section className={`material-sheet ${materialFormat === 'math' ? 'math' : 'text'}`} aria-label="Материал задания">
          {materialFormat === 'math' ? <SafeFormula source={material} /> : <p>{material}</p>}
        </section>
      )}
      {task.answer_format === 'choice' && (task.choices?.length ?? 0) > 0 ? (
        <ChoiceAnswer task={task} answer={answer} onAnswerChange={onAnswerChange} readOnly={readOnly} />
      ) : (
        <div className="answer-field">
          <label htmlFor={answerId}>{label}</label>
          <input
            id={answerId}
            type="text"
            autoComplete="off"
            placeholder={task.answer_format === 'number' ? 'Введи число' : 'Напиши ответ'}
            value={answer}
            readOnly={readOnly}
            onChange={(event) => onAnswerChange(event.target.value)}
          />
        </div>
      )}
      {hintVisible && hint !== undefined && (
        <aside className="hint"><span>Подсказка</span><p>{hint}</p></aside>
      )}
    </>
  );
}
