import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { buildTopicGraph } from '../server/curriculum.js';
import { openDatabase } from '../server/db.js';
import {
  activateDailyTopicSet, cancelDailyTopics, confirmDailyTopics, dailyMaterialAllowed,
  dailyTopicSets, type DailyTopicInput,
} from '../server/daily-topics.js';
import { MAX_DAILY_TOPIC_ATTEMPTS, prepareDailyTopics } from '../server/daily-topic-prep.js';
import { previewDailyTopics } from '../server/daily-topic-preview.js';
import { readDailyGate } from '../server/daily-gate.js';
import { mergePersonalCurriculum } from '../server/personal-curriculum.js';
import type { CurriculumSnapshot } from '../server/curriculum-provider.js';

const at = new Date('2026-09-23T10:00:00.000Z');
const nextDay = new Date('2026-09-23T21:00:00.000Z');
const graph = buildTopicGraph([{
  id: 'math.fractions', subject: 'math', title: 'Дроби', examWeight: 2,
  difficulty: 2, prereqs: [], answerFormat: 'number', promptSeed: 'Дроби',
}], [{ courseId: 'math', title: 'Математика', grade: '5', revisionId: 7 }]);
const input = (title: string, subjectId: string | null = 'math'): DailyTopicInput => ({
  title, subjectId, subjectTitle: subjectId === null ? 'Астрономия' : 'Математика', topicId: null,
});

const content = {
  introduction: 'Разберём тему.', objectives: ['Понять правило'],
  sections: [
    { title: 'Идея', blocks: [{ type: 'paragraph' as const, content: 'Основное объяснение.' }] },
    { title: 'Правило', blocks: [{ type: 'formula' as const, content: 'a+b' }] },
    { title: 'Пример', blocks: [{ type: 'example' as const, content: 'Пример решения.' }] },
  ],
  summary: ['Проверь ответ.', 'Повтори правило.'],
};

function producer() {
  return async (request: { topic: { id: string } }) => ({
    content,
    tasks: Array.from({ length: 5 }, (_, index) => ({
      instruction: `Вопрос ${request.topic.id} ${index}`, material: '', material_format: 'none' as const,
      choices: [], answer: '4', accept: ['4'], hint: 'Подумай ещё раз.',
      explain: 'Получится четыре.', joke: 'Сошлось.', difficulty: 2,
    })),
  });
}

describe('родительские темы на день', () => {
  let folder: string;
  let db: Database;
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'edukator-daily-topics-'));
    db = openDatabase(join(folder, 'child.db'));
    db.prepare('INSERT INTO topic_state (topic_id) VALUES (?)').run('math.fractions');
  });
  afterEach(() => { db.close(); rmSync(folder, { recursive: true, force: true }); });

  it('делит темы из одного абзаца и оставляет неизвестный предмет личным', async () => {
    const result = await previewDailyTopics('В математике прошли дроби и проценты; по астрономии — Луну', graph, {
      run: async () => JSON.stringify({ items: [
        { index: 0, title: 'Дроби', subject_id: 'math', subject_title: 'Математика', topic_id: 'math.fractions' },
        { index: 0, title: 'Проценты', subject_id: 'math', subject_title: 'Математика', topic_id: null },
        { index: 1, title: 'Луна', subject_id: null, subject_title: 'Астрономия', topic_id: null },
      ] }),
    });
    expect(result).toEqual([
      { ...input('Дроби'), topicId: 'math.fractions' }, input('Проценты'), input('Луна', null),
    ]);
  });

  it('готовит две темы одного предмета и свободную тему, затем включает весь набор', async () => {
    const set = confirmDailyTopics(db, graph, {
      sourceText: 'Дроби\nПроценты\nЛуна', requestKey: 'a',
      items: [
        { ...input('Дроби'), topicId: 'math.fractions' },
        input('Проценты'), input('Луна', null),
      ],
    }, at);
    expect(set.items).toHaveLength(3);
    expect(dailyTopicSets(db, at).active).toBeNull();
    expect(readDailyGate(db, at).mode).toBeUndefined();
    const seenGrades: Array<string | undefined> = [];
    await prepareDailyTopics({ db, graph, now: () => at, producer: async (request) => {
      seenGrades.push(request.topic.grade);
      return producer()(request);
    } });
    const active = dailyTopicSets(db, at).active;
    expect(active?.items.map((item) => item.materialStatus)).toEqual(['ready', 'ready', 'ready']);
    expect(active?.items.map((item) => item.materialId)).toHaveLength(3);
    expect(new Set(active?.items.map((item) => item.materialId)).size).toBe(3);
    expect(seenGrades).toEqual(['5', '5', '5']);
    expect(readDailyGate(db, at)).toMatchObject({ mode: 'parent_topics', required: 3, completed: 0, unlocked: false });
    const base: CurriculumSnapshot = {
      childId: 'child', generation: { catalog: 1, child: 1 }, graph,
      courses: [{ courseId: 'math', title: 'Математика', grade: '5', revisionId: 7 }],
      revisionIds: new Map([['math', 7]]),
    };
    const merged = mergePersonalCurriculum(db, base);
    expect(merged.graph.byId.has(active?.items[1]?.topicId ?? '')).toBe(true);
    expect(merged.graph.byId.has(active?.items[2]?.topicId ?? '')).toBe(true);
    expect(merged.graph.courses.has(active?.items[2]?.subject ?? '')).toBe(true);
  });

  it('оставляет старый набор действующим до готовности замены и переиспользует неизменный зачёт', async () => {
    const first = confirmDailyTopics(db, graph, {
      sourceText: 'Дроби', requestKey: 'first', items: [{ ...input('Дроби'), topicId: 'math.fractions' }],
    }, at);
    await prepareDailyTopics({ db, graph, now: () => at, producer: producer() });
    const materialId = dailyTopicSets(db, at).active?.items[0]?.materialId;
    expect(materialId).toBeTypeOf('number');
    db.prepare("UPDATE learning_materials SET status = 'passed' WHERE id = ?").run(materialId);
    const replacement = confirmDailyTopics(db, graph, {
      sourceText: 'Дроби\nПроценты', requestKey: 'replacement',
      items: [{ ...input('Дроби'), topicId: 'math.fractions' }, input('Проценты')],
    }, at);
    expect(replacement.items[0]?.materialId).toBe(materialId);
    expect(dailyTopicSets(db, at).active?.id).toBe(first.id);
    expect(readDailyGate(db, at)).toMatchObject({ required: 1, completed: 1, unlocked: true });
    await prepareDailyTopics({ db, graph, now: () => at, producer: producer() });
    expect(dailyTopicSets(db, at).active?.id).toBe(replacement.id);
    expect(readDailyGate(db, at)).toMatchObject({ required: 2, completed: 1, unlocked: false });
    cancelDailyTopics(db, at);
    expect(dailyTopicSets(db, at).active).toBeNull();
    expect(dailyMaterialAllowed(db, materialId as number, at)).toBe(false);
  });

  it('не включает неполный набор и переносит готовую подготовку через полночь', async () => {
    const set = confirmDailyTopics(db, graph, {
      sourceText: 'Проценты\nЛуна', requestKey: 'unfinished', items: [input('Проценты'), input('Луна', null)],
    }, at);
    let calls = 0;
    await prepareDailyTopics({ db, graph, now: () => at, producer: async (request) => {
      calls += 1;
      if (calls === 2) throw new Error('Модель недоступна');
      return producer()(request);
    } });
    expect(dailyTopicSets(db, at).active).toBeNull();
    expect(dailyTopicSets(db, at).preparing?.items.map((item) => item.status)).toEqual(['ready', 'preparing']);
    expect(dailyTopicSets(db, nextDay).preparing?.id).toBe(set.id);
    await prepareDailyTopics({ db, graph, now: () => nextDay, producer: producer() });
    expect(activateDailyTopicSet(db, set.id, nextDay)).toBe(false);
    expect(dailyTopicSets(db, nextDay).active).toMatchObject({ id: set.id, day: '2026-09-24' });
    expect(readDailyGate(db, nextDay)).toMatchObject({ mode: 'parent_topics', required: 2, completed: 0 });
  });

  it('сам повторяет ошибки и останавливается после ограниченного числа неудач', async () => {
    confirmDailyTopics(db, graph, {
      sourceText: 'Проценты', requestKey: 'auto-retry', items: [input('Проценты')],
    }, at);
    let calls = 0;
    const recover = async (request: { topic: { id: string } }) => {
      calls += 1;
      if (calls < 3) throw new Error('Методист нашёл ошибку');
      return producer()(request);
    };
    await prepareDailyTopics({ db, graph, now: () => at, producer: recover });
    expect(dailyTopicSets(db, at).preparing?.items[0]).toMatchObject({
      status: 'preparing', lastError: 'Методист нашёл ошибку',
    });
    await prepareDailyTopics({ db, graph, now: () => at, producer: recover });
    await prepareDailyTopics({ db, graph, now: () => at, producer: recover });
    expect(dailyTopicSets(db, at).active?.items[0]?.status).toBe('ready');
    expect(calls).toBe(3);

    confirmDailyTopics(db, graph, {
      sourceText: 'Луна', requestKey: 'exhausted', items: [input('Луна', null)],
    }, at);
    for (let attempt = 0; attempt < MAX_DAILY_TOPIC_ATTEMPTS + 1; attempt += 1) {
      await prepareDailyTopics({ db, graph, now: () => at,
        producer: async () => { throw new Error('Не удалось исправить'); } });
    }
    expect(dailyTopicSets(db, at).preparing?.items[0]).toMatchObject({ status: 'error' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM learning_materials WHERE daily_item_id = ?')
      .get(dailyTopicSets(db, at).preparing?.items[0]?.id)).toEqual({ count: MAX_DAILY_TOPIC_ATTEMPTS });
  });

  it('не публикует материал, если родитель отменил набор во время генерации', async () => {
    confirmDailyTopics(db, graph, {
      sourceText: 'Проценты', requestKey: 'cancel-during-prep', items: [input('Проценты')],
    }, at);
    let finish: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => { finish = resolve; });
    const preparation = prepareDailyTopics({ db, graph, now: () => at, producer: async (request) => {
      await waiting;
      return producer()(request);
    } });
    cancelDailyTopics(db, at);
    finish?.();
    await preparation;
    expect(dailyTopicSets(db, at)).toEqual({ active: null, preparing: null });
    expect(db.prepare("SELECT status FROM learning_materials WHERE daily_item_id IS NOT NULL").get())
      .toEqual({ status: 'rejected' });
  });
});
