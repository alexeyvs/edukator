import katex from 'katex';
import 'katex/dist/katex.min.css';
import { memo, type ChangeEvent } from 'react';
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

export const SafeFormula = memo(function SafeFormula({ source }: { source: string }) {
  try {
    const html = katex.renderToString(source, {
      displayMode: true,
      output: 'htmlAndMathml',
      trust: false,
      throwOnError: true,
      strict: 'error',
      maxSize: 12,
      maxExpand: 1_000,
    });
    return <div className="task-math" dangerouslySetInnerHTML={{ __html: html }} />;
  } catch {
    return <pre className="task-math-source" aria-label="Формула в исходной записи">{source}</pre>;
  }
});

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
            autoComplete="off"
            inputMode={task.answer_format === 'number' ? 'decimal' : undefined}
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
