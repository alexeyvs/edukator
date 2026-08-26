import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { buildTopicGraph, syncTopicState, type Topic, type TopicGraph } from '../server/curriculum.js';
import { openDatabase, writeProfile } from '../server/db.js';
import {
  createLearningProducer,
  MAX_LEARNING_TASK_BATCHES,
  MAX_READY_LEARNING_MATERIALS,
  prepareLearningMaterials,
  RECENT_LEARNING_ERRORS,
  selectLearningTopics,
  type LearningPackage,
  type LearningProduceRequest,
} from '../server/learning-prep.js';
import { CodexUnavailableError, type CodexRequest } from '../server/codex/client.js';
import { CodexConcurrency } from '../server/codex/concurrency.js';
import type { LearningMaterialContent } from '../server/codex/learning-material-schema.js';
import type { GeneratedTask } from '../server/codex/task-schema.js';
import { TEST_DEEP_HINT } from './generated-task-fixture.js';
import { storeTasks } from '../server/codex/bank.js';
import { everyRefillFailed, runWarmupCycle } from '../server/codex/worker.js';
import { claimLearningMaterial } from '../server/learning.js';
import { readDailyGate } from '../server/daily-gate.js';

const NOW = new Date('2026-08-09T10:00:00.000Z');

function topic(id: string, examWeight = 3): Topic {
  return {
    id,
    subject: id.startsWith('math') ? 'math' : id.startsWith('russian') ? 'russian' : 'english',
    title: `Тема ${id}`,
    examWeight,
    difficulty: 2,
    prereqs: [],
    answerFormat: 'number',
    promptSeed: `Карта ${id}`,
  };
}

const topics = [
  topic('math.best', 3), topic('math.other', 2),
  topic('russian.best', 3), topic('english.best', 3),
];

const content: LearningMaterialContent = {
  introduction: 'Новая понятная подача.',
  objectives: ['Применить правило'],
  sections: [
    { title: 'Идея', blocks: [{ type: 'paragraph', content: 'Объяснение.' }] },
    { title: 'Правило', blocks: [{ type: 'formula', content: 'a+b' }] },
    { title: 'Пример', blocks: [{ type: 'example', content: 'Пример решения.' }] },
  ],
  summary: ['Вспомни правило.', 'Проверь результат.'],
};

let sequence = 0;
function task(label: string): GeneratedTask {
  sequence += 1;
  return {
    instruction: `Самостоятельный вопрос ${label}-${sequence}`,
    material: '', material_format: 'none', choices: [], word_tiles: [], answer: '4', accept: ['4'],
    hint: 'Вспомни правило. Затем проверь шаги.', deep_hint: TEST_DEEP_HINT,
    explain: 'Получается четыре.',
    joke: 'Сошлось.', difficulty: 2,
  };
}

function learningPackage(label: string): LearningPackage {
  return { content, tasks: Array.from({ length: 5 }, (_, index) => task(`${label}-${index}`)) };
}

function triage(db: Database, subject: Topic['subject'], topicId: string): void {
  db.prepare(
    `INSERT INTO runs (subject, kind, topic_id, started_at, finished_at, summary)
     VALUES (?, 'triage', ?, ?, ?, '{}')`,
  ).run(subject, topicId, NOW.toISOString(), NOW.toISOString());
}

function completedRunCoverage(db: Database, subject: Topic['subject'], topicIds: string[]): void {
  const runId = Number(db.prepare(
    `INSERT INTO runs (subject, kind, topic_id, started_at, finished_at, summary)
     VALUES (?, 'run', ?, ?, ?, '{}')`,
  ).run(subject, topicIds[0], NOW.toISOString(), NOW.toISOString()).lastInsertRowid);
  const insertAttempt = db.prepare(
    `INSERT INTO attempts (task_id, topic_id, run_id, answer, is_correct)
     VALUES (?, ?, ?, '4', 1)`,
  );
  for (const topicId of topicIds) {
    const stored = storeTasks(db, topicId, [task(`coverage-${topicId}`)]).stored[0];
    if (stored === undefined) throw new Error(`Не удалось сохранить задание покрытия ${topicId}`);
    insertAttempt.run(stored.id, topicId, runId);
  }
}

describe('отбор и подготовка учебных материалов', () => {
  let tempDir: string;
  let db: Database;
  let graph: TopicGraph;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-learning-prep-'));
    db = openDatabase(join(tempDir, 'test.db'));
    graph = buildTopicGraph(topics);
    syncTopicState(db, graph);
    writeProfile(db, { name: 'Тимофей', interests: ['Minecraft'] });
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('держит буквальные пределы материалов и истории ошибок', () => {
    expect(MAX_READY_LEARNING_MATERIALS).toBe(3);
    expect(MAX_LEARNING_TASK_BATCHES).toBe(4);
    expect(RECENT_LEARNING_ERRORS).toBe(5);
  });

  it('ничего не выбирает до триажа, затем берёт лучший пробел каждого предмета', () => {
    expect(selectLearningTopics(db, graph, NOW)).toEqual([]);
    triage(db, 'math', 'math.best');
    expect(selectLearningTopics(db, graph, NOW).map(({ topic: item }) => item.id))
      .toEqual(['math.best']);
    triage(db, 'russian', 'russian.best');
    triage(db, 'english', 'english.best');
    expect(selectLearningTopics(db, graph, NOW).map(({ topic: item }) => item.id).sort())
      .toEqual(['english.best', 'math.best', 'russian.best']);
  });

  it('готовит разбор без триажа после достаточного покрытия обычными забегами', () => {
    completedRunCoverage(db, 'math', ['math.best', 'math.other']);

    expect(selectLearningTopics(db, graph, NOW).map(({ topic: item }) => item.id))
      .toEqual(['math.best']);
  });

  it('исключает закрытые и переставшие быть пробелами темы', () => {
    triage(db, 'math', 'math.best');
    db.prepare('UPDATE topic_state SET closed_at = ? WHERE topic_id = ?')
      .run(NOW.toISOString(), 'math.best');
    expect(selectLearningTopics(db, graph, NOW)[0]?.topic.id).toBe('math.other');
    db.prepare(
      `UPDATE topic_state SET mastery = 0.9, attempts = 2, confidence = 0.9,
       last_seen = ?, next_review = ? WHERE topic_id = ?`,
    ).run(NOW.toISOString(), NOW.toISOString(), 'math.other');
    expect(selectLearningTopics(db, graph, NOW)).toEqual([]);
  });

  // Третий потребитель суточной квоты, и он берёт темы из того же списка
  // пробелов, что бракуются в обычном прогреве: теория, методист и пять
  // вопросов на тему, которую генератор не вытягивает, — это самый дорогой из
  // трёх заходов на неё за обход.
  it('не берётся за тему, отложенную отступом', async () => {
    triage(db, 'math', 'math.best');
    triage(db, 'russian', 'russian.best');
    const requests: string[] = [];

    const report = await prepareLearningMaterials({
      db,
      graph,
      now: () => NOW,
      blocked: (topicId) => topicId === 'math.best',
      produce: (request) => {
        requests.push(request.topic.id);
        return Promise.resolve(learningPackage(request.topic.id));
      },
    });

    expect(requests).toEqual(['russian.best']);
    expect(report.prepared.map((item) => item.topicId)).toEqual(['russian.best']);
    // Claim не заводится: строка «preparing» держит предмет занятым и после
    // снятия отступа.
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM learning_materials WHERE topic_id = 'math.best'",
    ).get()).toEqual({ n: 0 });
  });

  it('публикует по одному полному материалу на предмет через общий бюджет', async () => {
    triage(db, 'math', 'math.best');
    triage(db, 'russian', 'russian.best');
    const budget = new CodexConcurrency(1);
    const requests: LearningProduceRequest[] = [];
    const report = await prepareLearningMaterials({
      db, graph, now: () => NOW, budget,
      produce: (request) => {
        expect(budget.active).toBe(1);
        requests.push(request);
        return Promise.resolve(learningPackage(request.topic.id));
      },
    });
    expect(report.prepared).toHaveLength(2);
    expect(report.prepared.every((item) => item.ready && item.stored === 5)).toBe(true);
    expect(requests.map(({ topic: item }) => item.subject).sort()).toEqual(['math', 'russian']);
    expect(db.prepare("SELECT COUNT(*) AS n FROM learning_materials WHERE status = 'ready'").get())
      .toEqual({ n: 2 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM task_bank WHERE status = 'lesson_reserved'").get())
      .toEqual({ n: 10 });

    const repeat = await prepareLearningMaterials({
      db, graph, now: () => new Date(NOW.getTime() + 1),
      produce: () => Promise.reject(new Error('не должен вызываться')),
    });
    expect(repeat.prepared).toEqual([]);
  });

  it('ставит время фактической публикации и не блокирует доступ после третьего забега', async () => {
    triage(db, 'math', 'math.best');
    storeTasks(db, 'math.best', Array.from({ length: 8 }, () => task('warm')));
    const insertRun = db.prepare(
      `INSERT INTO runs (subject, kind, topic_id, started_at, finished_at, summary)
       VALUES ('math', 'run', 'math.best', ?, ?, '{}')`,
    );
    insertRun.run('2026-08-09T08:00:00.000Z', '2026-08-09T08:30:00.000Z');
    insertRun.run('2026-08-09T09:00:00.000Z', '2026-08-09T09:30:00.000Z');

    let current = new Date('2026-08-09T10:00:00.000Z');
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let publish: ((value: LearningPackage) => void) | undefined;
    const generated = new Promise<LearningPackage>((resolve) => {
      publish = resolve;
    });
    let generationStartedAt: string | undefined;
    const cycle = runWarmupCycle({
      db,
      graph: buildTopicGraph([topic('math.best')]),
      now: () => current,
      learningProduce: () => {
        generationStartedAt = current.toISOString();
        markStarted?.();
        return generated;
      },
    });
    await started;

    const thirdFinishedAt = '2026-08-09T10:05:00.000Z';
    insertRun.run('2026-08-09T10:01:00.000Z', thirdFinishedAt);
    current = new Date('2026-08-09T10:06:00.000Z');
    publish?.(learningPackage('after-cutoff'));
    await cycle;

    expect(generationStartedAt).toBe('2026-08-09T10:00:00.000Z');
    expect(db.prepare('SELECT ready_at FROM learning_materials').get()).toEqual({
      ready_at: current.toISOString(),
    });
    expect(readDailyGate(db, current)).toMatchObject({
      completed: 3,
      learning: { materialId: null, required: false, passed: false },
      unlocked: true,
    });
  });

  it('двум соединениям не позволяет захватить разные темы одного предмета', () => {
    const second = openDatabase(join(tempDir, 'test.db'));
    try {
      const first = claimLearningMaterial(db, {
        subject: 'math', topicId: 'math.best', recommendationReason: 'Первый пробел',
        masteryBefore: 0, now: NOW,
      });
      expect(first).toBeDefined();
      expect(claimLearningMaterial(second, {
        subject: 'math', topicId: 'math.other', recommendationReason: 'Второй пробел',
        masteryBefore: 0, now: NOW,
      })).toBeUndefined();
      expect(second.prepare(
        "SELECT COUNT(*) AS n FROM learning_materials WHERE status IN ('preparing','ready','active')",
      ).get()).toEqual({ n: 1 });
    } finally {
      second.close();
    }
  });

  it('передаёт предпосылки, профиль и пять последних ошибок', async () => {
    const prereq = topic('math.prereq', 2);
    const dependent = { ...topic('math.dependent'), prereqs: [prereq.id] };
    graph = buildTopicGraph([prereq, dependent]);
    syncTopicState(db, graph);
    triage(db, 'math', dependent.id);
    db.prepare('UPDATE topic_state SET closed_at = ? WHERE topic_id = ?').run(NOW.toISOString(), prereq.id);
    for (let index = 0; index < 7; index += 1) {
      const stored = storeTasks(db, dependent.id, [task(`ошибка-${index}`)]).stored[0];
      if (stored === undefined) throw new Error('задача не сохранена');
      db.prepare(
        `INSERT INTO attempts (task_id, topic_id, answer, is_correct, created_at)
         VALUES (?, ?, ?, 0, ?)`,
      ).run(stored.id, dependent.id, `ответ-${index}`, new Date(NOW.getTime() + index).toISOString());
    }
    const corrected = storeTasks(db, dependent.id, [task('исправленная-ошибка')]).stored[0];
    if (corrected === undefined) throw new Error('задача исправления не сохранена');
    db.prepare(
      `INSERT INTO attempts
        (task_id, topic_id, answer, is_correct, is_current, created_at)
       VALUES (?, ?, 'старый ошибочный ответ', 0, 0, ?)`,
    ).run(corrected.id, dependent.id, new Date(NOW.getTime() + 100).toISOString());
    db.prepare(
      `INSERT INTO attempts (task_id, topic_id, answer, is_correct, created_at)
       VALUES (?, ?, 'исправленный ответ', 1, ?)`,
    ).run(corrected.id, dependent.id, new Date(NOW.getTime() + 101).toISOString());
    const neutral = storeTasks(db, dependent.id, [task('нейтральная-ошибка')]).stored[0];
    if (neutral === undefined) throw new Error('нейтральная задача не сохранена');
    db.prepare(
      `INSERT INTO attempts
        (task_id, topic_id, answer, is_correct, affects_progress, created_at)
       VALUES (?, ?, 'ответ повтора', 0, 0, ?)`,
    ).run(neutral.id, dependent.id, new Date(NOW.getTime() + 102).toISOString());
    let captured: LearningProduceRequest | undefined;
    await prepareLearningMaterials({
      db, graph, now: () => NOW,
      produce: (request) => {
        captured = request;
        return Promise.resolve(learningPackage('context'));
      },
    });
    expect(captured?.prerequisites.map(({ id }) => id)).toEqual([prereq.id]);
    expect(captured?.profile).toMatchObject({ name: 'Тимофей', interests: ['Minecraft'] });
    expect(captured?.recentErrors).toHaveLength(5);
    expect(captured?.recentErrors.map(({ answer }) => answer)).toEqual([
      'ответ-2', 'ответ-3', 'ответ-4', 'ответ-5', 'ответ-6',
    ]);
    expect(captured?.recentErrors.map(({ answer }) => answer))
      .not.toContain('старый ошибочный ответ');
    expect(captured?.recentErrors.map(({ answer }) => answer)).not.toContain('ответ повтора');
  });

  it('восстанавливает зависший claim, а недоступность codex включает backoff воркера', async () => {
    triage(db, 'math', 'math.best');
    const failed = await prepareLearningMaterials({
      db, graph, now: () => NOW,
      produce: () => Promise.reject(new CodexUnavailableError('codex не найден')),
    });
    expect(failed.codexUnavailable).toBe(true);
    expect(failed.prepared[0]).toMatchObject({ ready: false, recovered: false });
    expect(db.prepare('SELECT status FROM learning_materials').get()).toEqual({ status: 'preparing' });

    const restored = await prepareLearningMaterials({
      db, graph, now: () => new Date(NOW.getTime() + 30 * 60 * 1000 + 1),
      produce: () => Promise.resolve(learningPackage('restored')),
    });
    expect(restored.prepared[0]).toMatchObject({ ready: true, recovered: true, stored: 5 });
    expect(db.prepare('SELECT status FROM learning_materials ORDER BY id').all())
      .toEqual([{ status: 'rejected' }, { status: 'ready' }]);
  });

  it('освобождает зависший claim другой слабой темы до фильтрации предмета', async () => {
    triage(db, 'math', 'math.best');
    const stale = claimLearningMaterial(db, {
      subject: 'math', topicId: 'math.other', recommendationReason: 'Старый приоритет',
      masteryBefore: 0, now: NOW,
    });
    expect(stale).toBeDefined();

    const report = await prepareLearningMaterials({
      db, graph, now: () => new Date(NOW.getTime() + 30 * 60 * 1000 + 1),
      produce: () => Promise.resolve(learningPackage('новый-приоритет')),
    });
    expect(report.prepared[0]).toMatchObject({ topicId: 'math.best', ready: true });
    expect(db.prepare('SELECT topic_id, status FROM learning_materials ORDER BY id').all()).toEqual([
      { topic_id: 'math.other', status: 'rejected' },
      { topic_id: 'math.best', status: 'ready' },
    ]);
  });

  it('retire возвращает задания в банк, когда тема перестала быть пробелом', async () => {
    triage(db, 'math', 'math.best');
    await prepareLearningMaterials({
      db, graph, now: () => NOW, produce: () => Promise.resolve(learningPackage('old')),
    });
    db.prepare("UPDATE topic_state SET mastery = 0.9, attempts = 2 WHERE topic_id LIKE 'math.%'").run();
    const report = await prepareLearningMaterials({
      db, graph, now: () => new Date(NOW.getTime() + 1),
    });
    expect(report.retired).toHaveLength(1);
    expect(db.prepare('SELECT status FROM learning_materials').get()).toEqual({ status: 'retired' });
    expect(db.prepare("SELECT COUNT(*) AS n FROM task_bank WHERE status = 'valid'").get())
      .toEqual({ n: 5 });
  });

  it('после failed создаёт другую подачу, если тема осталась приоритетной', async () => {
    triage(db, 'math', 'math.best');
    db.prepare(
      `INSERT INTO learning_materials
       (subject, topic_id, status, content, recommendation_reason, mastery_before, finished_at)
       VALUES ('math', 'math.best', 'failed', ?, 'Слабая тема', 0, ?)`,
    ).run(JSON.stringify({ ...content, introduction: 'Старая аналогия с пиццей.' }), NOW.toISOString());
    let previous: string[] = [];
    const report = await prepareLearningMaterials({
      db, graph, now: () => new Date(NOW.getTime() + 1),
      produce: (request) => {
        previous = request.previousApproaches;
        return Promise.resolve(learningPackage('new-approach'));
      },
    });
    expect(previous).toEqual(['Старая аналогия с пиццей.']);
    expect(report.prepared[0]).toMatchObject({ ready: true });
  });

  it('атомарно отбраковывает комплект при дедупликации', async () => {
    triage(db, 'math', 'math.best');
    const duplicate = task('повтор');
    storeTasks(db, 'math.best', [duplicate]);
    const report = await prepareLearningMaterials({
      db, graph, now: () => NOW,
      produce: () => Promise.resolve({ content, tasks: [duplicate, ...learningPackage('fresh').tasks.slice(0, 4)] }),
    });
    expect(report.prepared[0]).toMatchObject({ ready: false, stored: 0, error: expect.stringContaining('отпечатком') });
    expect(db.prepare('SELECT status, content FROM learning_materials').get())
      .toEqual({ status: 'rejected', content: null });
    expect(db.prepare("SELECT COUNT(*) AS n FROM task_bank WHERE status = 'lesson_reserved'").get())
      .toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM learning_tasks').get()).toEqual({ n: 0 });
  });

  // Та же причина, что и у босса: заход фазы порога материал не готовит, иначе
  // диспетчер заказывал бы его дважды за один обход ребёнка.
  it('не зовёт методиста, когда фаза подготовки материала выключена', async () => {
    triage(db, 'math', 'math.best');
    storeTasks(db, 'math.best', Array.from({ length: 8 }, () => task('warm')));
    const report = await runWarmupCycle({
      db, graph: buildTopicGraph([topic('math.best')]), prepareLearning: false,
      learningProduce: () => Promise.reject(new Error('методиста звать было нельзя')),
    });

    expect(report.learningPreparation).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM learning_materials').get()).toEqual({ n: 0 });
  });

  it('встраивается после обычного прогрева и учитывается общим backoff', async () => {
    triage(db, 'math', 'math.best');
    storeTasks(db, 'math.best', Array.from({ length: 8 }, () => task('warm')));
    const report = await runWarmupCycle({
      db, graph: buildTopicGraph([topic('math.best')]),
      learningProduce: () => Promise.reject(new Error('методист отклонил')),
    });
    expect(report.learningPreparation?.prepared[0]).toMatchObject({ stored: 0, error: 'методист отклонил' });
    expect(everyRefillFailed(report)).toBe(true);
  });

  it('запускает подготовку материала только после пополнения обычного банка', async () => {
    triage(db, 'math', 'math.best');
    const order: string[] = [];
    const report = await runWarmupCycle({
      db,
      graph: buildTopicGraph([topic('math.best')]),
      now: () => new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
      produce: () => {
        order.push('bank');
        return Promise.resolve(Array.from({ length: 8 }, () => task('ordinary')));
      },
      learningProduce: () => {
        order.push('learning');
        return Promise.resolve(learningPackage('after-bank'));
      },
    });
    expect(order).toEqual(['bank', 'learning']);
    expect(report.refilled[0]).toMatchObject({ stored: 8 });
    expect(report.learningPreparation?.prepared[0]).toMatchObject({ ready: true, stored: 5 });
  });
});

describe('производитель полного комплекта', () => {
  it('проверяет материал независимо и строит пять вопросов по его содержимому', async () => {
    const generatedTasks = Array.from({ length: 5 }, (_, index) => task(`codex-${index}`));
    const verdicts = generatedTasks.map(() => ({
      answer: '4', unambiguous: true, natural: true, on_topic: true,
      age_appropriate: true, hint_safe: true, hint_useful: true,
      deep_hint_safe: true, deep_hint_useful: true, word_order_valid: true, note: '',
    }));
    const answers = [
      JSON.stringify(content),
      JSON.stringify({ accepted: true, accurate: true, complete: true, age_appropriate: true, grounded: true, note: '' }),
      JSON.stringify({ items: generatedTasks }),
      JSON.stringify({ items: verdicts }),
    ];
    const calls: CodexRequest[] = [];
    const producer = createLearningProducer({
      run: (request) => {
        calls.push(request);
        const answer = answers.shift();
        return answer === undefined ? Promise.reject(new Error('лишний вызов')) : Promise.resolve(answer);
      },
    });
    const result = await producer({
      topic: topic('math.best'), prerequisites: [], profile: { name: 'Тимофей', interests: [], examDate: null, partnerName: 'Байт' },
      recentErrors: [], previousApproaches: [], recent: [],
    });
    expect(result.tasks).toHaveLength(5);
    expect(calls).toHaveLength(4);
    expect(calls[1]?.model).toBe('gpt-5.6-sol');
    expect(calls[2]?.prompt).toContain('# Учебный материал для теста');
  });

  it('добирает пять разных вопросов после смысловой отбраковки и дубля между батчами', async () => {
    const first = [task('принят-1'), task('принят-2'), task('отклонён')];
    const second = [first[0] as GeneratedTask, task('принят-3'), task('принят-4')];
    const third = [task('принят-5')];
    const accepted = (items: readonly GeneratedTask[]) => items.map(() => ({
      answer: '4', unambiguous: true, natural: true, on_topic: true,
      age_appropriate: true, hint_safe: true, hint_useful: true,
      deep_hint_safe: true, deep_hint_useful: true, word_order_valid: true, note: '',
    }));
    const firstVerdicts = accepted(first);
    if (firstVerdicts[2] !== undefined) firstVerdicts[2].natural = false;
    const answers = [
      JSON.stringify(content),
      JSON.stringify({ accepted: true, accurate: true, complete: true, age_appropriate: true, grounded: true, note: '' }),
      JSON.stringify({ items: first }), JSON.stringify({ items: firstVerdicts }),
      JSON.stringify({ items: second }), JSON.stringify({ items: accepted(second) }),
      JSON.stringify({ items: third }), JSON.stringify({ items: accepted(third) }),
    ];
    const producer = createLearningProducer({
      run: () => Promise.resolve(answers.shift() ?? '{}'),
    });
    const result = await producer({
      topic: topic('math.best'), prerequisites: [],
      profile: { name: 'Тимофей', interests: [], examDate: null, partnerName: 'Байт' },
      recentErrors: [], previousApproaches: [], recent: [],
    });
    expect(result.tasks).toHaveLength(5);
    expect(new Set(result.tasks.map(({ instruction }) => instruction)).size).toBe(5);
    expect(answers).toEqual([]);
  });

  it('после четырёх батчей без новых вопросов оставляет claim чисто rejected', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'edukator-learning-exhausted-'));
    const db = openDatabase(join(tempDir, 'test.db'));
    try {
      const graph = buildTopicGraph([topic('math.best')]);
      syncTopicState(db, graph);
      triage(db, 'math', 'math.best');
      const duplicate = task('уже-видели');
      storeTasks(db, 'math.best', [duplicate]);
      const verdict = {
        answer: '4', unambiguous: true, natural: true, on_topic: true,
        age_appropriate: true, hint_safe: true, hint_useful: true,
        deep_hint_safe: true, deep_hint_useful: true, word_order_valid: true, note: '',
      };
      const answers = [
        JSON.stringify(content),
        JSON.stringify({ accepted: true, accurate: true, complete: true, age_appropriate: true, grounded: true, note: '' }),
        ...Array.from({ length: MAX_LEARNING_TASK_BATCHES }, () => [
          JSON.stringify({ items: [duplicate] }), JSON.stringify({ items: [verdict] }),
        ]).flat(),
      ];
      const report = await prepareLearningMaterials({
        db, graph, now: () => NOW,
        run: () => Promise.resolve(answers.shift() ?? '{}'),
      });
      expect(report.prepared[0]).toMatchObject({ ready: false, stored: 0 });
      expect(report.prepared[0]?.error).toMatch(/0 из 5 вопросов/u);
      expect(db.prepare('SELECT status, content FROM learning_materials').get())
        .toEqual({ status: 'rejected', content: null });
      expect(db.prepare("SELECT COUNT(*) AS n FROM task_bank WHERE status = 'lesson_reserved'").get())
        .toEqual({ n: 0 });
      expect(answers).toEqual([]);
    } finally {
      db.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
