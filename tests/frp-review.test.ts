import { describe, expect, it } from 'vitest';
import {
  MIN_IMPORT_COVERAGE, MIN_IMPORT_TOPICS, MIN_KEPT_TOPIC_IDS, reviewDraft,
} from '../scripts/frp-review.js';
import type { CatalogRevisionTopic } from '../server/course-catalog.js';

function topic(index: number, overrides: Partial<CatalogRevisionTopic> = {}): CatalogRevisionTopic {
  return {
    id: `topic-${String(index)}`, title: `Тема ${String(index)}`,
    examWeight: 2, difficulty: 2, prereqs: [], answerFormat: 'number',
    promptSeed: 'Генерируй задания', active: true, position: index,
    sourceRefs: [{ sourceId: 1, pageFrom: index, pageTo: index }],
    ...overrides,
  };
}

const source = { id: 1, pages: 10 };
const ten = (): CatalogRevisionTopic[] => Array.from({ length: 10 }, (_, i) => topic(i + 1));

describe('reviewDraft', () => {
  it('пропускает исправный черновик', () => {
    expect(reviewDraft({ courseId: 'geo-5', topics: ten(), source }).ok).toBe(true);
  });

  it('бракует черновик, где тем меньше порога', () => {
    const topics = Array.from({ length: MIN_IMPORT_TOPICS - 1 }, (_, i) => topic(i + 1));
    const result = reviewDraft({ courseId: 'geo-5', topics, source });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/тем/u);
  });

  it('бракует ссылку за границу источника', () => {
    const topics = ten();
    topics[0] = topic(1, { sourceRefs: [{ sourceId: 1, pageFrom: 1, pageTo: 99 }] });
    const result = reviewDraft({ courseId: 'geo-5', topics, source });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/страниц/u);
  });

  it('бракует ссылку на чужой источник', () => {
    const topics = ten();
    topics[0] = topic(1, { sourceRefs: [{ sourceId: 42, pageFrom: 1, pageTo: 1 }] });
    expect(reviewDraft({ courseId: 'geo-5', topics, source }).ok).toBe(false);
  });

  it('бракует тему вовсе без ссылок на страницы', () => {
    const topics = ten();
    topics[0] = topic(1, { sourceRefs: [] });
    expect(reviewDraft({ courseId: 'geo-5', topics, source }).ok).toBe(false);
  });

  it('бракует низкое покрытие куска', () => {
    // Десять тем, но все ссылаются на одну страницу из десяти: модель прочитала
    // начало и досочинила остальное.
    const topics = Array.from({ length: 10 }, (_, i) =>
      topic(i + 1, { sourceRefs: [{ sourceId: 1, pageFrom: 1, pageTo: 1 }] }));
    const result = reviewDraft({ courseId: 'geo-5', topics, source });
    expect(result.ok).toBe(false);
    expect(result.coverage).toBeLessThan(MIN_IMPORT_COVERAGE);
  });

  it('бракует цикл в prereqs до публикации, а не после', () => {
    const topics = ten();
    topics[0] = topic(1, { prereqs: ['topic-2'] });
    topics[1] = topic(2, { prereqs: ['topic-1'] });
    const result = reviewDraft({ courseId: 'geo-5', topics, source });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/цикл/u);
  });

  it('бракует потерю накопленного прогресса на legacy-курсе', () => {
    const previousTopicIds = Array.from({ length: 20 }, (_, i) => `старая-${String(i)}`);
    const result = reviewDraft({ courseId: 'math', topics: ten(), source, previousTopicIds });
    expect(result.ok).toBe(false);
    expect(result.keptRatio).toBeLessThan(MIN_KEPT_TOPIC_IDS);
  });

  it('на новом курсе доля сохранённых тем не считается вовсе', () => {
    expect(reviewDraft({ courseId: 'geo-5', topics: ten(), source }).keptRatio).toBeUndefined();
  });

  it('называет все причины разом, а не первую', () => {
    const topics = [topic(1, { sourceRefs: [{ sourceId: 42, pageFrom: 1, pageTo: 1 }] })];
    expect(reviewDraft({ courseId: 'geo-5', topics, source }).problems.length).toBeGreaterThan(1);
  });

  it('держит калибровочные константы спеки', () => {
    expect(MIN_IMPORT_TOPICS).toBe(8);
    expect(MIN_IMPORT_COVERAGE).toBe(0.6);
    expect(MIN_KEPT_TOPIC_IDS).toBe(0.5);
  });
});
