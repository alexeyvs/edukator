import type { FinishLearningResponse } from './learning-api';

function masteryPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function LearningFinishScreen({ result }: { result: FinishLearningResponse }) {
  const passed = result.outcome === 'passed';
  const delta = result.masteryAfter - result.masteryBefore;
  return (
    <main className="run-shell">
      <section className={`run-card lesson-finish ${passed ? 'passed' : 'failed'}`}>
        <p className="finish-kicker">Тест по слабой теме завершён</p>
        <span className="lesson-outcome-mark" aria-hidden="true">{passed ? '✓' : '↗'}</span>
        <h1>{passed ? 'Зачёт' : 'Тему стоит повторить'}</h1>
        <p className="finish-lead">{passed
          ? 'Ты разобрал тему и подтвердил результат в пяти вопросах.'
          : 'Попытка засчитана. Новый разбор появится, если тема останется в приоритете.'}</p>
        <div className="finish-stats lesson-finish-stats">
          <div><strong>{result.correct}/5</strong><span>верных ответов</span></div>
          <div><strong>{masteryPercent(result.masteryAfter)}</strong><span>знание темы</span></div>
          <div><strong>{delta >= 0 ? '+' : ''}{Math.round(delta * 100)} п.п.</strong><span>изменение знания</span></div>
        </div>
        <p className="lesson-score-note">Порог зачёта — 4 из 5.</p>
        <a className="primary finish-home" href="/">Вернуться к плану</a>
      </section>
    </main>
  );
}
