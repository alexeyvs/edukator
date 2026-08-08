import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../server/db.js';
import {
  buildTopicGraph,
  syncTopicState,
  type Topic,
  type TopicGraph,
} from '../server/curriculum.js';
import { countAvailable, storeTasks } from '../server/codex/bank.js';
import type { GeneratedTask } from '../server/codex/task-schema.js';
import type { DisputeContext, DisputeReview, DisputeReviewer } from '../server/codex/dispute.js';
import { readTopicState } from '../server/mastery.js';
import { planFromDatabase } from '../server/scheduler.js';
import { checkAnswer } from '../server/normalize.js';
import {
  SessionError,
  nextTask,
  openDispute,
  openDisputes,
  resolveDispute,
  submitAnswer,
} from '../server/session.js';

function topic(id: string, patch: Partial<Topic> = {}): Topic {
  return {
    id,
    subject: id.startsWith('math') ? 'math' : id.startsWith('russian') ? 'russian' : 'english',
    title: `Тема ${id}`,
    examWeight: 3,
    difficulty: 2,
    prereqs: [],
    answerFormat: 'number',
    promptSeed: `Спрашивай по теме ${id}.`,
    ...patch,
  };
}

let counter = 0;

function task(patch: Partial<GeneratedTask> = {}): GeneratedTask {
  counter += 1;
  return {
    instruction: `Задание ${counter}: в инвентаре 90 монет, половину потратил. Сколько осталось?`, material: '', material_format: 'none', choices: [],
    answer: '45',
    accept: ['45', '45 монет'],
    hint: 'Половина от девяноста.',
    explain: '90 : 2 = 45 — вот и весь фокус.',
    joke: 'Кошелёк похудел вдвое, зато ты нет.',
    difficulty: 2,
    ...patch,
  };
}

/** Разбирающий-заглушка: настоящий codex в тестах не зовётся ни разу. */
function reviewer(verdict: DisputeReview | Error): {
  calls: DisputeContext[];
  review: DisputeReviewer;
} {
  const calls: DisputeContext[] = [];
  return {
    calls,
    review: (context): Promise<DisputeReview> => {
      calls.push(context);
      return verdict instanceof Error ? Promise.reject(verdict) : Promise.resolve(verdict);
    },
  };
}

describe('занятие', () => {
  let tempDir: string;
  let seedDir: string;
  let db: Database;
  let graph: TopicGraph;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-session-'));
    // Пустой каталог посева: откат на посевной банк проверяет свой тест, а
    // здесь он должен молчать, чтобы «заданий нет» означало именно это.
    seedDir = join(tempDir, 'seed-bank');
    db = openDatabase(join(tempDir, 'session.db'));
    graph = buildTopicGraph([topic('math.a'), topic('russian.a'), topic('english.a')]);
    syncTopicState(db, graph);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Кладёт задание в банк и сразу выдаёт его: дальше на него можно отвечать. */
  function issue(topicId = 'math.a', patch: Partial<GeneratedTask> = {}, runId?: number): number {
    const { stored } = storeTasks(db, topicId, [task(patch)]);
    const id = stored[0]?.id;
    if (id === undefined) throw new Error('задание не легло в банк');
    db.prepare("UPDATE task_bank SET status = 'used', issued_run_id = ? WHERE id = ?")
      .run(runId ?? null, id);
    return id;
  }

  describe('выдача задания', () => {
    it('отдаёт задание выбранной планировщиком темы без ответа и вариантов', () => {
      storeTasks(db, 'math.a', [task()]);
      storeTasks(db, 'russian.a', [task()]);
      storeTasks(db, 'english.a', [task()]);

      const result = nextTask(db, graph, { seedDir });

      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      // Ответ, засчитываемые записи и разбор до ответа не уезжают: иначе
      // смотреть их проще, чем решать.
      expect(Object.keys(result.task).sort()).toEqual([
        'answerFormat',
        'choices',
        'difficulty',
        'hint',
        'id',
        'instruction',
        'material',
        'materialFormat',
        'question',
        'subject',
        'topicId',
        'topicTitle',
      ]);
      expect(JSON.stringify(result.task)).not.toContain('45');
    });

    // Перезагрузка страницы не должна сжигать очередь: выданное задание помечено
    // `used` безвозвратно, и без повторной выдачи несколько обновлений подряд
    // опустошили бы тему, ни разу не спросив ученика.
    it('повторяет выданное задание, пока на него не ответили', () => {
      storeTasks(db, 'math.a', [task(), task()]);
      storeTasks(db, 'russian.a', [task(), task()]);
      storeTasks(db, 'english.a', [task(), task()]);

      const first = nextTask(db, graph, { seedDir });
      const second = nextTask(db, graph, { seedDir });

      expect(first.status).toBe('ok');
      expect(second.status).toBe('ok');
      if (first.status !== 'ok' || second.status !== 'ok') return;
      expect(second.task.id).toBe(first.task.id);
      expect(countAvailable(db, first.task.topicId)).toBe(1);
    });

    it('резервирует другое задание при предзагрузке показанного', () => {
      const runId = Number(
        db.prepare('INSERT INTO runs (subject, topic_id, started_at) VALUES (?, ?, ?)')
          .run('math', 'math.a', new Date().toISOString()).lastInsertRowid,
      );
      storeTasks(db, 'math.a', [task(), task()]);

      const shown = nextTask(db, graph, { runId, seedDir });
      expect(shown.status).toBe('ok');
      if (shown.status !== 'ok') return;
      const prefetched = nextTask(db, graph, {
        runId,
        seedDir,
        excludeTaskId: shown.task.id,
      });

      expect(prefetched.status).toBe('ok');
      if (prefetched.status !== 'ok') return;
      expect(prefetched.task.id).not.toBe(shown.task.id);
      const reloaded = nextTask(db, graph, { runId, seedDir });
      expect(reloaded.status).toBe('ok');
      if (reloaded.status !== 'ok') return;
      expect(reloaded.task).toMatchObject({ id: shown.task.id });
    });

    it('не выдаёт одно задание дважды после ответа на него', () => {
      storeTasks(db, 'math.a', [task(), task()]);
      storeTasks(db, 'russian.a', [task(), task()]);
      storeTasks(db, 'english.a', [task(), task()]);

      const first = nextTask(db, graph, { seedDir });
      expect(first.status).toBe('ok');
      if (first.status !== 'ok') return;
      submitAnswer(db, graph, { taskId: first.task.id, answer: '45' });

      const second = nextTask(db, graph, { seedDir });
      expect(second.status).toBe('ok');
      if (second.status !== 'ok') return;
      expect(second.task.id).not.toBe(first.task.id);
    });

    // Одна пустая тема не повод свернуть занятие: ответить по ней ученик не
    // может, состояние её не меняется, и планировщик предложил бы её снова.
    it('переходит к следующей теме плана, когда по первой заданий нет', () => {
      storeTasks(db, 'russian.a', [task()]);
      storeTasks(db, 'english.a', [task()]);

      const result = nextTask(db, graph, { seedDir });

      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.task.topicId).not.toBe('math.a');
    });

    // Посев покрывает шесть тем предмета из двадцати с лишним, так что окно
    // фиксированного размера регулярно целиком состоит из пустых тем, а
    // остальной банк остаётся недостижимым — занятие встаёт на ровном месте.
    it('добирается до темы, стоящей в плане далеко не первой', () => {
      const many = buildTopicGraph(
        ['math', 'russian', 'english'].flatMap((subject) =>
          ['a', 'b', 'c', 'd'].map((suffix, index) =>
            topic(`${subject}.${suffix}`, { examWeight: index === 3 ? 1 : 5 }),
          ),
        ),
      );
      syncTopicState(db, many);
      storeTasks(db, 'english.d', [task()]);

      const plan = planFromDatabase(db, many, many.byId.size);
      const position = plan.findIndex((run) => run.topic.id === 'english.d');
      expect(position).toBeGreaterThan(4);

      const result = nextTask(db, many, { seedDir });

      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.task.topicId).toBe('english.d');
    });

    // Дефект одного задания не должен останавливать занятие целиком: строка
    // `used` без попытки находится снова и снова, и пятисотка была бы вечной.
    it('обходит тему, задание которой не читается, и говорит об этом', () => {
      const brokenId = issue('math.a');
      db.prepare("UPDATE task_bank SET accept = 'не json' WHERE id = ?").run(brokenId);
      storeTasks(db, 'russian.a', [task()]);
      storeTasks(db, 'english.a', [task()]);
      const written: string[] = [];

      const result = nextTask(db, graph, { seedDir, log: (message) => written.push(message) });

      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.task.topicId).not.toBe('math.a');
      expect(written.join('\n')).toMatch(/math\.a/u);
    });

    // Сорвались все темы плана без единого исключения — дело не в банке, а в
    // самой базе. Молчаливое «заданий нет» отправило бы разбираться в очередь.
    it('не выдаёт «нет задания», когда сорвался весь план', () => {
      db.exec('DROP TABLE task_bank');
      const written: string[] = [];

      expect(() => nextTask(db, graph, { seedDir, log: (message) => written.push(message) })).toThrow(
        /task_bank/u,
      );
      expect(written).not.toHaveLength(0);
    });

    it('сообщает «нет задания», когда очередь темы и посев пусты', () => {
      const result = nextTask(db, graph, { seedDir });

      expect(result).toEqual({ status: 'no-task', topicId: expect.any(String) });
    });

    // `runs.topic_id` — тема, ради которой забег начат. Планировщик считает её
    // использованной сегодня, поэтому выдача должна явно вернуть её в начало
    // плана, но не закреплять за ней весь забег.
    it('начинает с темы забега, хотя план её сегодня больше не предложит', () => {
      const now = new Date('2026-08-07T18:00:00.000Z');
      storeTasks(db, 'russian.a', [task(), task()]);
      storeTasks(db, 'math.a', [task()]);
      storeTasks(db, 'english.a', [task()]);
      const runId = Number(
        db.prepare('INSERT INTO runs (subject, topic_id, started_at) VALUES (?, ?, ?)').run(
          'russian',
          'russian.a',
          now.toISOString(),
        ).lastInsertRowid,
      );

      const result = nextTask(db, graph, { runId, seedDir, now });

      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.task.topicId).toBe('russian.a');
    });

    it('распределяет полный забег между темами предмета', () => {
      const runGraph = buildTopicGraph([
        topic('math.a'),
        topic('math.b'),
        topic('math.c'),
      ]);
      syncTopicState(db, runGraph);
      for (const topicId of ['math.a', 'math.b', 'math.c']) {
        storeTasks(db, topicId, Array.from({ length: 12 }, () => task()));
      }
      const runId = Number(
        db.prepare('INSERT INTO runs (subject, topic_id, started_at) VALUES (?, ?, ?)')
          .run('math', 'math.a', new Date().toISOString()).lastInsertRowid,
      );
      const used = new Set<string>();

      for (let answered = 0; answered < 12; answered += 1) {
        const result = nextTask(db, runGraph, { runId, seedDir });
        expect(result.status).toBe('ok');
        if (result.status !== 'ok') return;
        used.add(result.task.topicId);
        submitAnswer(db, runGraph, { taskId: result.task.id, runId, answer: 'не знаю' });
      }

      expect([...used].sort()).toEqual(['math.a', 'math.b', 'math.c']);
    });

    it('сообщает «нет темы», когда планировщику нечего предложить', () => {
      const empty = buildTopicGraph([topic('math.a', { examWeight: 0 })]);
      syncTopicState(db, empty);

      expect(nextTask(db, empty, { seedDir })).toEqual({ status: 'no-topic' });
    });

    it('не выдаёт задание чужого предмета при ограничении предметом или забегом', () => {
      storeTasks(db, 'russian.a', [task()]);
      const runId = Number(
        db.prepare('INSERT INTO runs (subject, topic_id, started_at) VALUES (?, ?, ?)')
          .run('math', 'math.a', new Date().toISOString()).lastInsertRowid,
      );

      expect(nextTask(db, graph, { subject: 'math', seedDir })).toEqual({
        status: 'no-task',
        topicId: 'math.a',
      });
      expect(nextTask(db, graph, { runId, seedDir })).toEqual({
        status: 'no-task',
        topicId: 'math.a',
      });
      expect(
        db.prepare("SELECT status FROM task_bank WHERE topic_id = 'russian.a'").get(),
      ).toEqual({ status: 'valid' });
    });
  });

  describe('приём ответа', () => {
    it('засчитывает верный ответ и двигает модель знаний вверх', () => {
      const id = issue();

      const result = submitAnswer(db, graph, { taskId: id, answer: '45 монет' });

      expect(result.correct).toBe(true);
      expect(result.explain).toContain('90 : 2');
      expect(result.state.mastery).toBeGreaterThan(0);
      expect(result.state.attempts).toBe(1);

      const row = db
        .prepare<[number], { answer: string; is_correct: number }>(
          'SELECT answer, is_correct FROM attempts WHERE id = ?',
        )
        .get(result.attemptId);
      expect(row).toEqual({ answer: '45 монет', is_correct: 1 });
    });

    it('неверный ответ двигает модель знаний в другую сторону', () => {
      const first = submitAnswer(db, graph, { taskId: issue(), answer: '45' });
      const second = submitAnswer(db, graph, { taskId: issue(), answer: '30' });

      expect(second.correct).toBe(false);
      expect(second.reason).toBe('mismatch');
      expect(second.state.mastery).toBeLessThan(first.state.mastery);
      expect(readTopicState(db, 'math.a').mastery).toBe(second.state.mastery);
    });

    it('учитывает подсказку: с ней рост слабее', () => {
      // Темы разные, но состояние у обеих нулевое, так что сравниваются именно
      // сдвиги за одну попытку.
      const plain = submitAnswer(db, graph, { taskId: issue('russian.a'), answer: '45' });
      const hinted = submitAnswer(db, graph, {
        taskId: issue('math.a'),
        answer: '45',
        hintUsed: true,
        durationMs: 4200,
      });

      expect(hinted.state.mastery).toBeLessThan(plain.state.mastery);
      const row = db
        .prepare<[number], { hint_used: number; duration_ms: number }>(
          'SELECT hint_used, duration_ms FROM attempts WHERE id = ?',
        )
        .get(hinted.attemptId);
      expect(row).toEqual({ hint_used: 1, duration_ms: 4200 });
    });

    it('пишет попытку и счётчики забега вместе, начисляя XP и возвращая прогресс', () => {
      const runGraph = buildTopicGraph([
        topic('math.a'),
        topic('math.b'),
        topic('russian.a'),
        topic('english.a'),
      ]);
      syncTopicState(db, runGraph);
      const runId = Number(
        db.prepare('INSERT INTO runs (subject, topic_id, started_at) VALUES (?, ?, ?)')
          .run('math', 'math.a', new Date().toISOString()).lastInsertRowid,
      );
      const taskId = issue('math.b', { difficulty: 3 }, runId);

      const result = submitAnswer(db, runGraph, { taskId, runId, answer: '45' });

      expect(result.xp).toBe(35);
      expect(result.progress).toEqual({ total: 1, correct: 1, target: 12, done: false });
      expect(
        db.prepare<[number], { run_id: number }>('SELECT run_id FROM attempts WHERE id = ?')
          .get(result.attemptId),
      ).toEqual({ run_id: runId });
      expect(
        db.prepare<[number], { total: number; correct: number }>(
          'SELECT total, correct FROM runs WHERE id = ?',
        ).get(runId),
      ).toEqual({ total: 1, correct: 1 });
    });

    it('не даёт забегу присвоить задание другого забега того же предмета', () => {
      const insertRun = db.prepare(
        'INSERT INTO runs (subject, topic_id, started_at) VALUES (?, ?, ?)',
      );
      const firstRun = Number(insertRun.run('math', 'math.a', new Date().toISOString()).lastInsertRowid);
      const secondRun = Number(insertRun.run('math', 'math.a', new Date().toISOString()).lastInsertRowid);
      storeTasks(db, 'math.a', [task()]);
      const next = nextTask(db, graph, { runId: firstRun, seedDir });
      expect(next.status).toBe('ok');
      if (next.status !== 'ok') return;

      expect(() => submitAnswer(db, graph, {
        taskId: next.task.id,
        runId: secondRun,
        answer: '45',
      })).toThrow(expect.objectContaining({ code: 'task-not-in-run' }));
      expect(submitAnswer(db, graph, {
        taskId: next.task.id,
        runId: firstRun,
        answer: '45',
      }).correct).toBe(true);
    });

    it('не выдаёт и не принимает тринадцатое задание забега', () => {
      const runId = Number(
        db.prepare('INSERT INTO runs (subject, topic_id, started_at, total) VALUES (?, ?, ?, 12)')
          .run('math', 'math.a', new Date().toISOString()).lastInsertRowid,
      );
      const taskId = issue('math.a', {}, runId);

      expect(() => nextTask(db, graph, { runId, seedDir }))
        .toThrow(expect.objectContaining({ code: 'run-complete' }));
      expect(() => submitAnswer(db, graph, { taskId, runId, answer: '45' }))
        .toThrow(expect.objectContaining({ code: 'run-complete' }));
      expect(db.prepare('SELECT COUNT(*) AS n FROM attempts').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT total FROM runs WHERE id = ?').get(runId)).toEqual({ total: 12 });
    });

    it('не пускает триаж в обычную выдачу и запрещает подсказку в его ответе', () => {
      const runId = Number(
        db.prepare(
          "INSERT INTO runs (subject, kind, topic_id, started_at) VALUES (?, 'triage', ?, ?)",
        ).run('math', 'math.a', new Date().toISOString()).lastInsertRowid,
      );
      expect(() => nextTask(db, graph, { runId, seedDir }))
        .toThrow(expect.objectContaining({ code: 'task-not-in-run' }));
      const taskId = issue('math.a', {}, runId);
      expect(() => submitAnswer(db, graph, { taskId, runId, answer: '45', hintUsed: true }))
        .toThrow(expect.objectContaining({ code: 'task-not-in-run' }));
    });

    it('не связывает задание чужого предмета с забегом и не принимает ответ в закрытый', () => {
      const runId = Number(
        db.prepare('INSERT INTO runs (subject, topic_id, started_at) VALUES (?, ?, ?)')
          .run('math', 'math.a', new Date().toISOString()).lastInsertRowid,
      );
      const foreignTask = issue('russian.a');

      expect(() =>
        submitAnswer(db, graph, { taskId: foreignTask, runId, answer: '45' }),
      ).toThrow(expect.objectContaining({ code: 'task-not-in-run' }));
      expect(db.prepare('SELECT COUNT(*) AS n FROM attempts').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT total, correct FROM runs WHERE id = ?').get(runId)).toEqual({
        total: 0,
        correct: 0,
      });

      db.prepare('UPDATE runs SET finished_at = ? WHERE id = ?')
        .run(new Date().toISOString(), runId);
      const ownTask = issue('math.a');
      expect(() =>
        submitAnswer(db, graph, { taskId: ownTask, runId, answer: '45' }),
      ).toThrow(expect.objectContaining({ code: 'run-finished' }));
      expect(db.prepare('SELECT COUNT(*) AS n FROM attempts').get()).toEqual({ n: 0 });
    });

    it('откатывает попытку и модель, если счётчик забега записать не удалось', () => {
      const runId = Number(
        db.prepare('INSERT INTO runs (subject, topic_id, started_at) VALUES (?, ?, ?)')
          .run('math', 'math.a', new Date().toISOString()).lastInsertRowid,
      );
      const taskId = issue('math.a', {}, runId);
      db.exec(`
        CREATE TRIGGER тестовый_отказ_счётчика
        BEFORE UPDATE ON runs
        BEGIN
          SELECT RAISE(ABORT, 'счётчик недоступен');
        END;
      `);

      expect(() =>
        submitAnswer(db, graph, { taskId, runId, answer: '45' }),
      ).toThrow(/счётчик недоступен/u);
      expect(db.prepare('SELECT COUNT(*) AS n FROM attempts').get()).toEqual({ n: 0 });
      expect(readTopicState(db, 'math.a').attempts).toBe(0);
      expect(db.prepare('SELECT total, correct FROM runs WHERE id = ?').get(runId)).toEqual({
        total: 0,
        correct: 0,
      });
    });

    // Часы на ноутбуке ходят и назад: поправка NTP, ручной перевод времени.
    // Без подтяжки отметки `applyAttempt` бросает обычной ошибкой, та изнутри
    // транзакции откатывает уже вставленную попытку — ответ теряется, наружу
    // уходит пятисотка, и повторная отправка даёт ровно то же, пока часы не
    // догонят сохранённое `last_seen`.
    it('принимает ответ после шага часов назад, не теряя попытку', () => {
      const first = new Date('2026-08-08T12:00:00.000Z');
      submitAnswer(db, graph, { taskId: issue(), answer: '45', at: first });

      const stepped = new Date(first.getTime() - 5 * 60 * 1000);
      const second = submitAnswer(db, graph, { taskId: issue(), answer: '30', at: stepped });

      expect(second.correct).toBe(false);
      expect(second.state.attempts).toBe(2);
      // Отметка подтянута к последней известной, а не записана из прошлого:
      // иначе пересчёт истории спором проигрывал бы попытки в другом порядке.
      expect(second.state.lastSeen).toBe(first.toISOString());
      const rows = db
        .prepare<[], { created_at: string }>('SELECT created_at FROM attempts ORDER BY id')
        .all();
      expect(rows.map((row) => row.created_at)).toEqual([
        first.toISOString(),
        first.toISOString(),
      ]);
    });

    it('отказывает по несуществующему заданию', () => {
      expect(() => submitAnswer(db, graph, { taskId: 4242, answer: '45' })).toThrow(SessionError);
      try {
        submitAnswer(db, graph, { taskId: 4242, answer: '45' });
      } catch (error) {
        expect((error as SessionError).code).toBe('task-not-found');
      }
    });

    it('отказывает по заданию, которое ученику не выдавали', () => {
      const { stored } = storeTasks(db, 'math.a', [task()]);
      const id = stored[0]?.id ?? 0;

      try {
        submitAnswer(db, graph, { taskId: id, answer: '45' });
        expect.unreachable('ответ на невыданное задание должен быть отклонён');
      } catch (error) {
        expect((error as SessionError).code).toBe('task-not-issued');
      }
      expect(db.prepare('SELECT COUNT(*) AS n FROM attempts').get()).toEqual({ n: 0 });
    });

    it('отказывает по повторному ответу на то же задание', () => {
      const id = issue();
      const first = submitAnswer(db, graph, { taskId: id, answer: '45' });

      try {
        submitAnswer(db, graph, { taskId: id, answer: '30' });
        expect.unreachable('повторный ответ должен быть отклонён');
      } catch (error) {
        expect((error as SessionError).code).toBe('already-answered');
      }
      // Ни второй попытки, ни второго сдвига модели: иначе одно задание
      // засчиталось бы дважды.
      expect(db.prepare('SELECT COUNT(*) AS n FROM attempts').get()).toEqual({ n: 1 });
      expect(readTopicState(db, 'math.a').mastery).toBe(first.state.mastery);
    });

    // Иначе задание остаётся `used` без попытки, `issuedTask` выдаёт его снова
    // на каждый запрос, и занятие встаёт на нём навсегда.
    it('отбраковывает выданное задание, эталон которого нечем сверить', () => {
      const id = issue();
      // Порча после выдачи: `nextTask` такое задание уже не выдал бы, а это
      // ученик держит на экране.
      db.prepare("UPDATE task_bank SET answer = 'сорок пять' WHERE id = ?").run(id);
      const logged: string[] = [];

      try {
        submitAnswer(db, graph, { taskId: id, answer: '45', log: (m) => logged.push(m) });
        expect.unreachable('ответ на негодное задание должен быть отклонён');
      } catch (error) {
        expect((error as SessionError).code).toBe('task-defective');
        // Наружу — только факт: причина называет эталонный ответ.
        expect((error as SessionError).message).not.toContain('сорок пять');
      }

      expect(logged.join('\n')).toContain('сорок пять');
      // Пометка пережила откат транзакции, попытки и сдвига модели не случилось.
      expect(
        db.prepare<[number], { status: string }>('SELECT status FROM task_bank WHERE id = ?')
          .get(id)?.status,
      ).toBe('rejected');
      expect(db.prepare('SELECT COUNT(*) AS n FROM attempts').get()).toEqual({ n: 0 });
      expect(readTopicState(db, 'math.a').attempts).toBe(0);
      // И следующий запрос выдаёт уже не его, а соседнее задание темы.
      // `seedDir` обязателен: без него перебор уходит в посев репозитория,
      // тем которого в синтетической карте нет, и `no-task` прошёл бы за
      // «выдано другое».
      const spare = storeTasks(db, 'math.a', [task({ instruction: 'Сколько будет 20 + 25?' })]);
      const next = nextTask(db, graph, { seedDir });
      expect(next.status).toBe('ok');
      expect(next.status === 'ok' ? next.task.id : 0).toBe(spare.stored[0]?.id);
    });
  });

  describe('разбор спора', () => {
    /** Ответ, который нормализатор не засчитывает, хотя по смыслу он верный. */
    function disputed(): { attemptId: number; taskId: number; mastery: number } {
      const taskId = issue();
      const attempt = submitAnswer(db, graph, { taskId, answer: 'сорок пять' });
      expect(attempt.correct).toBe(false);
      return { attemptId: attempt.attemptId, taskId, mastery: attempt.state.mastery };
    }

    it('подтверждённый спор возвращает баллы и пополняет accept[]', async () => {
      const { attemptId, taskId, mastery } = disputed();
      const { calls, review } = reviewer({ studentCorrect: true, note: 'то же число словами' });
      const { id, created } = openDispute(db, attemptId);
      expect(created).toBe(true);

      const result = await resolveDispute(db, graph, id, review);

      expect(result.status).toBe('upheld');
      expect(result.accept).toContain('сорок пять');
      expect(calls[0]?.given).toBe('сорок пять');
      expect(calls[0]?.expected).toBe('45');

      const stored = db
        .prepare<[number], { accept: string }>('SELECT accept FROM task_bank WHERE id = ?')
        .get(taskId);
      expect(JSON.parse(stored?.accept ?? '[]')).toContain('сорок пять');
      expect(
        db.prepare('SELECT is_correct FROM attempts WHERE id = ?').get(attemptId),
      ).toEqual({ is_correct: 1 });
      // Модель пересчитана по истории: попытка стала верной, mastery выросла.
      expect(result.state?.mastery).toBeGreaterThan(mastery);
      expect(readTopicState(db, 'math.a').mastery).toBe(result.state?.mastery);
    });

    it('подтверждённый спор возвращает верный ответ в счётчик забега', async () => {
      const runId = Number(
        db.prepare('INSERT INTO runs (subject, topic_id, started_at) VALUES (?, ?, ?)')
          .run('math', 'math.a', new Date().toISOString()).lastInsertRowid,
      );
      const taskId = issue('math.a', {}, runId);
      const attempt = submitAnswer(db, graph, {
        taskId,
        runId,
        answer: 'сорок пять',
      });
      const dispute = openDispute(db, attempt.attemptId);
      const { review } = reviewer({ studentCorrect: true, note: 'то же число словами' });

      await resolveDispute(db, graph, dispute.id, review);

      expect(db.prepare('SELECT total, correct FROM runs WHERE id = ?').get(runId)).toEqual({
        total: 1,
        correct: 1,
      });
    });

    it('не открывает новый спор после завершения забега', () => {
      const runId = Number(
        db.prepare('INSERT INTO runs (subject, topic_id, started_at) VALUES (?, ?, ?)')
          .run('math', 'math.a', new Date().toISOString()).lastInsertRowid,
      );
      const taskId = issue('math.a', {}, runId);
      const attempt = submitAnswer(db, graph, {
        taskId,
        runId,
        answer: 'сорок пять',
      });
      db.prepare('UPDATE runs SET finished_at = ? WHERE id = ?')
        .run(new Date().toISOString(), runId);

      expect(() => openDispute(db, attempt.attemptId))
        .toThrow(expect.objectContaining({ code: 'run-finished' }));
      expect(db.prepare('SELECT COUNT(*) AS n FROM disputes').get()).toEqual({ n: 0 });
    });

    it('после подтверждения нормализатор засчитывает тот же ответ сам', async () => {
      const { attemptId, taskId } = disputed();
      const { review } = reviewer({ studentCorrect: true, note: 'то же число словами' });
      await resolveDispute(db, graph, openDispute(db, attemptId).id, review);

      const stored = db
        .prepare<[number], { answer: string; accept: string }>(
          'SELECT answer, accept FROM task_bank WHERE id = ?',
        )
        .get(taskId);

      // Ради этого спор и разбирается: задание починилось само, и следующий
      // такой же ответ на него сверка засчитает без всякой модели.
      expect(
        checkAnswer(
          'сорок пять',
          { answer: stored?.answer ?? '', accept: JSON.parse(stored?.accept ?? '[]') as string[] },
          'number',
        ).correct,
      ).toBe(true);
    });

    // Иначе каждый подтверждённый спор по уже известной записи раздувал бы
    // `accept[]` копиями, неотличимыми для нормализатора.
    it('не дописывает в accept[] то, что там уже есть', async () => {
      const taskId = issue();
      // «45 монет» уже лежит в accept[], но с другим регистром и пробелами.
      const attempt = submitAnswer(db, graph, { taskId, answer: '  45  Монет ' });
      expect(attempt.correct).toBe(true);
      // Спорить о засчитанной попытке нельзя, поэтому она отмечается неверной
      // руками: важно только то, как разбор обходится с уже известной записью.
      db.prepare('UPDATE attempts SET is_correct = 0 WHERE id = ?').run(attempt.attemptId);
      const { review } = reviewer({ studentCorrect: true, note: 'та же запись' });

      const result = await resolveDispute(
        db,
        graph,
        openDispute(db, attempt.attemptId).id,
        review,
      );

      expect(result.status).toBe('upheld');
      expect(result.accept).toEqual(['45', '45 монет']);
      const stored = db
        .prepare<[number], { accept: string }>('SELECT accept FROM task_bank WHERE id = ?')
        .get(taskId);
      expect(JSON.parse(stored?.accept ?? '[]')).toEqual(['45', '45 монет']);
    });

    // Выгруженный посев читается тем же `parseTaskBatch`, что и ответ модели:
    // непригодная запись в `accept[]` сделала бы файл предмета неразбираемым.
    it('не дописывает в accept[] запись, которую разбор батча потом отвергнет', async () => {
      const cases: { given: string; why: string }[] = [
        { given: '45 и 46', why: 'два числа на числовой теме' },
        { given: '   ', why: 'пустой ответ' },
      ];

      for (const { given, why } of cases) {
        const taskId = issue();
        const attempt = submitAnswer(db, graph, { taskId, answer: given });
        expect(attempt.correct, why).toBe(false);
        const { review } = reviewer({ studentCorrect: true, note: 'ученик прав' });

        const result = await resolveDispute(
          db,
          graph,
          openDispute(db, attempt.attemptId).id,
          review,
        );

        expect(result.status, why).toBe('upheld');
        expect(result.accept, why).toEqual(['45', '45 монет']);
        const stored = db
          .prepare<[number], { accept: string }>('SELECT accept FROM task_bank WHERE id = ?')
          .get(taskId);
        expect(JSON.parse(stored?.accept ?? '[]'), why).toEqual(['45', '45 монет']);
        // Баллы всё равно возвращаются: спор подтверждён, чинить нечего только банк.
        expect(
          db.prepare('SELECT is_correct FROM attempts WHERE id = ?').get(attempt.attemptId),
          why,
        ).toEqual({ is_correct: 1 });
      }
    });

    it('не превращает choice-дистрактор в допустимый ответ после подтверждённого спора', async () => {
      graph = buildTopicGraph([
        topic('math.a', { answerFormat: 'choice' }),
        topic('russian.a'),
        topic('english.a'),
      ]);
      const taskId = issue('math.a', {
        instruction: 'Выбери результат сложения.',
        choices: ['четыре', 'пять'],
        answer: 'четыре',
        accept: ['четыре'],
      });
      const attempt = submitAnswer(db, graph, { taskId, answer: 'пять' });
      expect(attempt.correct).toBe(false);
      const { review } = reviewer({ studentCorrect: true, note: 'ошибочный вердикт проверки' });

      const result = await resolveDispute(db, graph, openDispute(db, attempt.attemptId).id, review);

      expect(result.status).toBe('upheld');
      expect(result.accept).toEqual(['четыре']);
      const stored = db.prepare<[number], { accept: string }>(
        'SELECT accept FROM task_bank WHERE id = ?',
      ).get(taskId);
      expect(JSON.parse(stored?.accept ?? '[]')).toEqual(['четыре']);
    });

    it('отклонённый спор не трогает ни модель, ни задание', async () => {
      const { attemptId, taskId, mastery } = disputed();
      const { review } = reviewer({ studentCorrect: false, note: 'это другое число' });

      const result = await resolveDispute(db, graph, openDispute(db, attemptId).id, review);

      expect(result.status).toBe('rejected');
      expect(result.accept).not.toContain('сорок пять');
      const stored = db
        .prepare<[number], { accept: string }>('SELECT accept FROM task_bank WHERE id = ?')
        .get(taskId);
      expect(JSON.parse(stored?.accept ?? '[]')).toEqual(['45', '45 монет']);
      expect(readTopicState(db, 'math.a').mastery).toBe(mastery);
      expect(
        db.prepare('SELECT is_correct FROM attempts WHERE id = ?').get(attemptId),
      ).toEqual({ is_correct: 0 });
    });

    it('повторное нажатие кнопки не заводит второй спор', async () => {
      const { attemptId } = disputed();
      const { review } = reviewer({ studentCorrect: true, note: 'прав' });

      const first = openDispute(db, attemptId);
      expect(openDispute(db, attemptId)).toEqual({ id: first.id, status: 'open', created: false });
      expect(openDisputes(db)).toEqual([first.id]);

      await resolveDispute(db, graph, first.id, review);

      // После подтверждения попытка стала верной, но кнопка обязана отдавать
      // вердикт по спору, а не отказ «спорить не о чем».
      expect(openDispute(db, attemptId)).toEqual({
        id: first.id,
        status: 'upheld',
        created: false,
      });
    });

    it('закрытый спор второй раз не разбирается', async () => {
      const { attemptId } = disputed();
      const { calls, review } = reviewer({ studentCorrect: true, note: 'прав' });
      const { id } = openDispute(db, attemptId);
      await resolveDispute(db, graph, id, review);

      const repeat = await resolveDispute(db, graph, id, review);

      expect(calls).toHaveLength(1);
      expect(repeat.status).toBe('upheld');
      expect(repeat.state).toBeNull();
    });

    // Ради этой ветви спор и перечитывается заново под записью: проверка до
    // вызова модели видит его открытым, а закрыть его успевают, пока вызов идёт.
    // Второй вердикт иначе удвоил бы `accept[]` и пересчитал модель дважды.
    it('спор, закрытый пока шёл вызов модели, второй раз не применяется', async () => {
      const { attemptId, taskId } = disputed();
      const { id } = openDispute(db, attemptId);

      // Закрытие происходит внутри вызова модели — ровно там, где его успевает
      // сделать параллельный разбор.
      const review = async (): Promise<DisputeReview> => {
        db.prepare("UPDATE disputes SET status = 'upheld', resolution = 'первый' WHERE id = ?")
          .run(id);
        db.prepare('UPDATE task_bank SET accept = ? WHERE id = ?')
          .run(JSON.stringify(['сорок пять']), taskId);
        return { studentCorrect: true, note: 'второй' };
      };

      const result = await resolveDispute(db, graph, id, review);

      expect(result.resolution).toBe('первый');
      expect(result.state).toBeNull();
      expect(result.accept).toEqual(['сорок пять']);
      const stored = db
        .prepare<[number], { accept: string }>('SELECT accept FROM task_bank WHERE id = ?')
        .get(taskId);
      expect(JSON.parse(stored?.accept ?? '[]')).toEqual(['сорок пять']);
    });

    it('ошибка разбирающего оставляет спор открытым', async () => {
      const { attemptId } = disputed();
      const { review } = reviewer(new Error('codex недоступен'));
      const { id } = openDispute(db, attemptId);

      await expect(resolveDispute(db, graph, id, review)).rejects.toThrow(/codex недоступен/);
      expect(openDisputes(db)).toEqual([id]);
    });

    it('отказывает по несуществующей попытке и по засчитанной', () => {
      const correct = submitAnswer(db, graph, { taskId: issue(), answer: '45' });

      try {
        openDispute(db, 4242);
        expect.unreachable('спор по несуществующей попытке должен быть отклонён');
      } catch (error) {
        expect((error as SessionError).code).toBe('attempt-not-found');
      }
      try {
        openDispute(db, correct.attemptId);
        expect.unreachable('спор по засчитанной попытке должен быть отклонён');
      } catch (error) {
        expect((error as SessionError).code).toBe('attempt-correct');
      }
    });

    it('отказывает по несуществующему спору', async () => {
      const { review } = reviewer({ studentCorrect: true, note: '' });

      await expect(resolveDispute(db, graph, 4242, review)).rejects.toThrow(SessionError);
    });
  });
});
