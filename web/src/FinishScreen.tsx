import type { FinishRunResponse, RunTopicChange } from './run-api';

export interface FinishScreenProps {
  result: FinishRunResponse;
  kind?: 'run' | 'triage';
}

function TopicList({ topics, empty }: { topics: RunTopicChange[]; empty: string }) {
  if (topics.length === 0) return <p className="empty-result">{empty}</p>;
  return (
    <ul className="topic-results">
      {topics.map((topic) => <li key={topic.topicId}>{topic.title}</li>)}
    </ul>
  );
}

function RunFinish({ result }: { result: FinishRunResponse }) {
  const hasDelta = Object.hasOwn(result, 'forecastDelta');
  const delta = result.forecastDelta ?? 0;

  return (
    <>
      <p className="finish-kicker">Забег завершён</p>
      <h1>Вот что получилось</h1>
      <div className="finish-stats" aria-label="Результат забега">
        <div><strong>{result.total}</strong><span>сделано</span></div>
        <div><strong>{result.correct}</strong><span>верно</span></div>
        <div><strong>{result.xp}</strong><span>XP</span></div>
      </div>

      <div className="finish-grid">
        <section>
          <h2>Закрытые темы</h2>
          <TopicList topics={result.closedTopics} empty="В этот раз без новых закрытых тем." />
        </section>
        <section>
          <h2>Стоит повторить</h2>
          <TopicList topics={result.declinedTopics} empty="Ни одна тема не просела." />
        </section>
      </div>

      <section className="forecast-result" aria-label="Прогноз оценки">
        <span>Прогноз</span>
        <strong>{result.forecast.score.toFixed(1)}</strong>
        {hasDelta && (
          <p>
            Сдвиг прогноза: {delta > 0 ? '+' : ''}{delta.toFixed(1)}
          </p>
        )}
      </section>
    </>
  );
}

function TriageFinish({ result }: { result: FinishRunResponse }) {
  const ranked = [...result.touchedTopics].sort((left, right) =>
    left.after - right.after || left.title.localeCompare(right.title, 'ru'));

  return (
    <>
      <p className="finish-kicker">Триаж завершён</p>
      <h1>Карта тем на старте</h1>
      <p className="finish-lead">
        От тем, которым сейчас нужнее внимание, к самым уверенным.
      </p>
      {ranked.length === 0 ? (
        <p className="empty-result">Темы пока не удалось ранжировать.</p>
      ) : (
        <ol className="triage-ranking">
          {ranked.map((topic, index) => (
            <li key={topic.topicId}>
              <span>{index + 1}</span>
              <div><strong>{topic.title}</strong><small>освоенность {Math.round(topic.after * 100)}%</small></div>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

export function FinishScreen({ result, kind = 'run' }: FinishScreenProps) {
  return (
    <main className="run-shell finish-shell">
      <header className="run-header">
        <a className="brand" href="/" aria-label="На главный экран">Э</a>
      </header>
      <article className="run-card finish-card">
        {kind === 'triage' ? <TriageFinish result={result} /> : <RunFinish result={result} />}
        <a className="primary finish-home" href="/">На главный экран</a>
      </article>
    </main>
  );
}
