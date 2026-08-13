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
          ? `Ты разобрал тему и подтвердил результат в ${result.total} вопросах.`
          : 'Перечитай эту же теорию и попробуй тот же тест ещё раз. Зачёт нужен для доступа к компьютеру.'}</p>
        <div className="finish-stats lesson-finish-stats">
          <div><strong>{result.correct}/{result.total}</strong><span>верных ответов</span></div>
          <div><strong>{masteryPercent(result.masteryAfter)}</strong><span>знание темы</span></div>
          <div><strong>{delta >= 0 ? '+' : ''}{Math.round(delta * 100)} п.п.</strong><span>изменение знания</span></div>
        </div>
        <p className="lesson-score-note">
          Порог зачёта — {result.passScore} из {result.total}.
        </p>
        <a
          className="primary finish-home"
          href={passed ? '/' : `/?learningId=${result.materialId}`}
        >
          {passed ? 'Вернуться к плану' : 'Повторить разбор'}
        </a>
      </section>
    </main>
  );
}
