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
import { storeTasks } from '../server/codex/bank.js';
import type { GeneratedTask } from '../server/codex/task-schema.js';
import type { DisputeContext, DisputeReview, DisputeReviewer } from '../server/codex/dispute.js';
import { readTopicState } from '../server/mastery.js';
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
    question: `Задание ${counter}: в инвентаре 90 монет, половину потратил. Сколько осталось?`,
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
  function issue(topicId = 'math.a', patch: Partial<GeneratedTask> = {}): number {
    const { stored } = storeTasks(db, topicId, [task(patch)]);
    const id = stored[0]?.id;
    if (id === undefined) throw new Error('задание не легло в банк');
    db.prepare("UPDATE task_bank SET status = 'used' WHERE id = ?").run(id);
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
        'difficulty',
        'hint',
        'id',
        'question',
        'subject',
        'topicId',
        'topicTitle',
      ]);
      expect(JSON.stringify(result.task)).not.toContain('45');
    });

    it('не выдаёт одно задание дважды', () => {
      storeTasks(db, 'math.a', [task(), task()]);
      storeTasks(db, 'russian.a', [task(), task()]);
      storeTasks(db, 'english.a', [task(), task()]);

      const first = nextTask(db, graph, { seedDir });
      const second = nextTask(db, graph, { seedDir });

      expect(first.status).toBe('ok');
      expect(second.status).toBe('ok');
      if (first.status !== 'ok' || second.status !== 'ok') return;
      expect(second.task.id).not.toBe(first.task.id);
    });

    it('сообщает «нет задания», когда очередь темы и посев пусты', () => {
      const result = nextTask(db, graph, { seedDir });

      expect(result).toEqual({ status: 'no-task', topicId: expect.any(String) });
    });

    it('сообщает «нет темы», когда планировщику нечего предложить', () => {
      const empty = buildTopicGraph([topic('math.a', { examWeight: 0 })]);
      syncTopicState(db, empty);

      expect(nextTask(db, empty, { seedDir })).toEqual({ status: 'no-topic' });
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
