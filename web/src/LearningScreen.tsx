import { useEffect, useState } from 'react';
import {
  browserLearningApi,
  type LearningApi,
  type LearningBlock,
  type LearningMaterialView,
} from './learning-api';
import { SafeFormula } from './TaskPrompt';
import { SUBJECT_MARKS, SUBJECT_NAMES } from './subject-meta';

export interface LearningScreenProps {
  materialId: number;
  api?: LearningApi;
  navigate?: (url: string) => void;
}

function defaultNavigate(url: string): void {
  window.location.assign(url);
}

function LearningContentBlock({ block }: { block: LearningBlock }) {
  if (block.type === 'formula') {
    return <div className="lesson-block lesson-formula"><SafeFormula source={block.content} /></div>;
  }
  if (block.type === 'example') {
    return <aside className="lesson-block lesson-example"><strong>Пример</strong><p>{block.content}</p></aside>;
  }
  if (block.type === 'warning') {
    return <aside className="lesson-block lesson-warning"><strong>Обрати внимание</strong><p>{block.content}</p></aside>;
  }
  return <p className="lesson-block lesson-paragraph">{block.content}</p>;
}

export function LearningScreen({
  materialId,
  api = browserLearningApi,
  navigate = defaultNavigate,
}: LearningScreenProps) {
  const [material, setMaterial] = useState<LearningMaterialView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let active = true;
    api.open(materialId)
      .then(async ({ material: opened }) => {
        if (!active) return;
        if (opened.progress.total > 0 || opened.content === null) {
          const started = await api.startTest(materialId);
          if (active) navigate(`/?runId=${started.runId}&kind=lesson`);
          return;
        }
        setMaterial(opened);
      })
      .catch((error: unknown) => {
        if (active) setProblem(error instanceof Error ? error.message : 'Не получилось открыть материал');
      });
    return () => { active = false; };
  }, [api, materialId, navigate]);

  async function startTest(): Promise<void> {
    setStarting(true);
    setProblem(null);
    try {
      const started = await api.startTest(materialId);
      navigate(`/?runId=${started.runId}&kind=lesson`);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Не получилось начать тест');
      setStarting(false);
    }
  }

  if (problem !== null && material === null) {
    return <main className="run-state"><p className="home-error" role="alert">{problem}</p></main>;
  }
  if (material === null) {
    return <main className="run-state" role="status"><p>Открываю разбор темы…</p></main>;
  }
  if (material.content === null) {
    return <main className="run-state" role="status"><p>Возвращаю в тест…</p></main>;
  }

  return (
    <main className={`lesson-shell lesson-${material.subject}`}>
      <header className="lesson-header">
        <a className="brand" href="/" aria-label="На главный экран">Э</a>
        <div><span>{SUBJECT_NAMES[material.subject]}</span><strong>{material.topic.title}</strong></div>
        <small>{material.estimatedMinutes} минут</small>
      </header>

      <article className="lesson-paper">
        <header className="lesson-lead">
          <div className="lesson-subject-mark" aria-hidden="true">{SUBJECT_MARKS[material.subject]}</div>
          <div>
            <p className="home-kicker">Разобрать слабое место</p>
            <h1>{material.topic.title}</h1>
            <p>{material.content.introduction}</p>
            <p className="lesson-reason">Почему сейчас: {material.recommendationReason}</p>
          </div>
        </header>

        <section className="lesson-objectives" aria-labelledby="lesson-objectives-title">
          <h2 id="lesson-objectives-title">После разбора ты сможешь</h2>
          <ul>{material.content.objectives.map((objective, index) => (
            <li key={`${objective}:${String(index)}`}>{objective}</li>
          ))}</ul>
        </section>

        <div className="lesson-thread">
          {material.content.sections.map((section, index) => (
            <section key={`${section.title}:${String(index)}`} aria-labelledby={`lesson-section-${String(index)}`}>
              <span className="lesson-section-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
              <div>
                <h2 id={`lesson-section-${String(index)}`}>{section.title}</h2>
                {section.blocks.map((block, blockIndex) => (
                  <LearningContentBlock key={`${block.type}:${String(blockIndex)}`} block={block} />
                ))}
              </div>
            </section>
          ))}
        </div>

        <section className="lesson-summary" aria-labelledby="lesson-summary-title">
          <p className="home-kicker">Короткая памятка</p>
          <h2 id="lesson-summary-title">Возьми с собой в тест</h2>
          <ul>{material.content.summary.map((item, index) => (
            <li key={`${item}:${String(index)}`}>{item}</li>
          ))}</ul>
        </section>

        {problem !== null && <p className="home-error" role="alert">{problem}</p>}
        <footer className="lesson-cta">
          <div>
            <strong>Готов проверить тему?</strong>
            <span>{material.progress.target} вопросов, зачёт — от {material.passScore} верных.</span>
          </div>
          <button className="primary" type="button" disabled={starting} onClick={() => void startTest()}>
            {starting ? 'Открываю тест…' : 'Перейти к тесту'}
          </button>
        </footer>
      </article>
    </main>
  );
}
