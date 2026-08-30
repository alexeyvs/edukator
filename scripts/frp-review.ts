/**
 * Машинная отбраковка черновика курса перед публикацией. Импорт из ФРП
 * публикует курсы без человека — значит непубликуемое обязано отсекаться
 * правилом, а не глазами оператора. Пять проверок ниже — единственное, что
 * стоит между сомнительной картой тем и живым занятием ребёнка.
 *
 * Каждая проверка складывает свои причины в общий список, а не бросает на
 * первой находке: отчёт по курсу обязан назвать всё разом, иначе разбираться
 * придётся в пять заходов.
 */

import { buildTopicGraph, type Topic } from '../server/curriculum.js';
import type { CatalogRevisionTopic } from '../server/course-catalog.js';

/** Меньше тем — курс явно недособран моделью, а не просто короткий. */
export const MIN_IMPORT_TOPICS = 8;
/** Доля страниц источника, обязанная получить хотя бы одну ссылку темы. */
export const MIN_IMPORT_COVERAGE = 0.6;
/**
 * Доля прежних `topic_id`, обязанная сохраниться в новой карте legacy-курса:
 * дети продолжают заниматься по назначенному курсу, и потеря идентификатора
 * темы стирает их прогресс на ней так же, как удаление курса.
 */
export const MIN_KEPT_TOPIC_IDS = 0.5;

export interface ReviewInput {
  courseId: string;
  topics: readonly CatalogRevisionTopic[];
  source: { id: number; pages: number };
  previousTopicIds?: readonly string[];
}

export interface ReviewResult {
  ok: boolean;
  problems: string[];
  coverage: number;
  keptRatio: number | undefined;
}

/** Только активные темы попадают в публикацию — см. `readRevisionGraph`. */
function activeTopicsOf(topics: readonly CatalogRevisionTopic[]): CatalogRevisionTopic[] {
  return topics.filter((topic) => topic.active);
}

/**
 * Проверка 1: тем меньше минимума. Короткий черновик — признак, что модель
 * не прочитала источник до конца, а не то, что тема курса и правда мала.
 */
function checkTopicCount(topics: readonly CatalogRevisionTopic[], problems: string[]): void {
  if (topics.length < MIN_IMPORT_TOPICS) {
    problems.push(
      `в черновике ${String(topics.length)} тем — меньше минимума ${String(MIN_IMPORT_TOPICS)}`,
    );
  }
}

/**
 * Проверка 2: у каждой темы обязана быть хотя бы одна ссылка на страницу
 * ровно того источника, что ей передан, и в его границах. Ссылка на чужой
 * источник или за его пределами — то же расхождение, что галлюцинация текста:
 * тему нечем перепроверить по оригиналу.
 */
function checkSourceRefs(
  topics: readonly CatalogRevisionTopic[],
  source: { id: number; pages: number },
  problems: string[],
): void {
  for (const topic of topics) {
    const refs = topic.sourceRefs ?? [];
    if (refs.length === 0) {
      problems.push(`тема «${topic.id}» не ссылается ни на одну страницу источника`);
      continue;
    }
    for (const ref of refs) {
      if (ref.sourceId !== source.id) {
        problems.push(
          `тема «${topic.id}» ссылается на источник ${String(ref.sourceId)} вместо ${String(source.id)}`,
        );
        continue;
      }
      if (ref.pageFrom < 1 || ref.pageTo > source.pages || ref.pageFrom > ref.pageTo) {
        problems.push(
          `тема «${topic.id}» ссылается на страницы ${String(ref.pageFrom)}–${String(ref.pageTo)} ` +
            `за пределами источника (${String(source.pages)} страниц)`,
        );
      }
    }
  }
}

/**
 * Покрытие — доля страниц источника, попавших хотя бы в один `sourceRef`.
 * Низкое покрытие при достаточном числе тем — признак того же дефекта, что и
 * ссылка за границу: модель прочитала начало и досочинила остальное по
 * знаниям, а не по тексту.
 */
function computeCoverage(
  topics: readonly CatalogRevisionTopic[],
  source: { id: number; pages: number },
): number {
  if (source.pages <= 0) return 0;
  const covered = new Set<number>();
  for (const topic of topics) {
    for (const ref of topic.sourceRefs ?? []) {
      if (ref.sourceId !== source.id) continue;
      const from = Math.max(1, ref.pageFrom);
      const to = Math.min(source.pages, ref.pageTo);
      for (let page = from; page <= to; page += 1) covered.add(page);
    }
  }
  return covered.size / source.pages;
}

/**
 * Проверка 4: граф проверяется до публикации намеренно. `buildTopicGraph`
 * ловит циклы, висячие prereqs и предпосылку с недостаточным exam_weight, но
 * зовут его провайдер и чтение — то есть опубликованная битая редакция
 * сломалась бы уже у ребёнка, на первом же занятии.
 */
function checkGraph(topics: readonly CatalogRevisionTopic[], courseId: string, problems: string[]): void {
  const asTopics: Topic[] = topics.map((topic) => ({
    id: topic.id,
    subject: courseId,
    title: topic.title,
    examWeight: topic.examWeight,
    difficulty: topic.difficulty,
    prereqs: topic.prereqs,
    answerFormat: topic.answerFormat,
    promptSeed: topic.promptSeed,
  }));
  try {
    buildTopicGraph(asTopics);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Проверка 5: только для курса, у которого уже есть история занятий
 * (`previousTopicIds` передан). Новая редакция, потерявшая слишком много
 * прежних `topic_id`, стирает накопленный прогресс детей на этих темах — как
 * если бы курс сняли и назначили заново.
 */
function computeKeptRatio(
  topics: readonly CatalogRevisionTopic[],
  previousTopicIds: readonly string[],
): number {
  if (previousTopicIds.length === 0) return 1;
  const currentIds = new Set(topics.map((topic) => topic.id));
  const kept = previousTopicIds.filter((id) => currentIds.has(id)).length;
  return kept / previousTopicIds.length;
}

export function reviewDraft(input: ReviewInput): ReviewResult {
  const problems: string[] = [];
  const activeTopics = activeTopicsOf(input.topics);

  checkTopicCount(activeTopics, problems);
  checkSourceRefs(activeTopics, input.source, problems);

  const coverage = computeCoverage(activeTopics, input.source);
  if (coverage < MIN_IMPORT_COVERAGE) {
    problems.push(
      `покрытие источника ${String(Math.round(coverage * 100))}% — ниже минимума ` +
        `${String(Math.round(MIN_IMPORT_COVERAGE * 100))}%`,
    );
  }

  checkGraph(activeTopics, input.courseId, problems);

  let keptRatio: number | undefined;
  if (input.previousTopicIds !== undefined) {
    keptRatio = computeKeptRatio(activeTopics, input.previousTopicIds);
    if (keptRatio < MIN_KEPT_TOPIC_IDS) {
      problems.push(
        `новая редакция сохраняет только ${String(Math.round(keptRatio * 100))}% прежних тем — ` +
          'прогресс детей на остальных будет потерян',
      );
    }
  }

  return { ok: problems.length === 0, problems, coverage, keptRatio };
}
