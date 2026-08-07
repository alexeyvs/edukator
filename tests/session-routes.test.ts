import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import { buildServer } from '../server/index.js';
import { openDatabase, SUBJECTS } from '../server/db.js';
import { loadCurriculum } from '../server/curriculum.js';
import { storeTasks } from '../server/codex/bank.js';
import type { DisputeContext, DisputeReview } from '../server/codex/dispute.js';
import type { GeneratedTask } from '../server/codex/task-schema.js';

/** Карта из одной темы на предмет: без всех трёх файлов карта не грузится. */
function writeCurriculum(dir: string): void {
  for (const subject of SUBJECTS) {
    writeFileSync(
      join(dir, `${subject}.json`),
      JSON.stringify({
        subject,
        topics: [
          {
            id: `${subject}.a`,
            subject,
            title: `Тема ${subject}`,
            exam_weight: 3,
            difficulty: 2,
            prereqs: [],
            answer_format: 'number',
            prompt_seed: `Спрашивай по теме ${subject}.`,
          },
        ],
      }),
    );
  }
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

describe('маршруты занятия', () => {
  let tempDir: string;
  let seedDir: string;
  let app: FastifyInstance;
  let db: Database;
  let verdict: DisputeReview;
  const reviewed: DisputeContext[] = [];
  /** Фоновые разборы: тест их дожидается, вместо того чтобы гадать о таймингах. */
  const pending: Promise<void>[] = [];
  const logged: string[] = [];

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-session-routes-'));
    const curriculumDir = join(tempDir, 'curriculum');
    seedDir = join(tempDir, 'seed-bank');
    mkdirSync(curriculumDir);
    mkdirSync(seedDir);
    writeCurriculum(curriculumDir);
    process.env.EDUKATOR_DB = join(tempDir, 'session.db');

    verdict = { studentCorrect: true, note: 'то же число словами' };
    reviewed.length = 0;
    pending.length = 0;
    logged.length = 0;

    app = buildServer(curriculumDir, {
      seedDir,
      review: (context): Promise<DisputeReview> => {
        reviewed.push(context);
        return Promise.resolve(verdict);
      },
      background: (job): void => {
        pending.push(job());
      },
      log: (message): void => {
        logged.push(message);
      },
    });
    await app.ready();

    db = openDatabase(process.env.EDUKATOR_DB);
    for (const subject of SUBJECTS) storeTasks(db, `${subject}.a`, [task(), task()]);
  });

  afterEach(async () => {
    db.close();
    await app.close();
    delete process.env.EDUKATOR_DB;
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Выданное задание: дальше на него можно отвечать. */
  async function next(): Promise<Record<string, unknown>> {
    const response = await app.inject({ method: 'GET', url: '/api/session/next' });
    expect(response.statusCode).toBe(200);
    return (response.json() as { task: Record<string, unknown> }).task;
  }

  function answer(body: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: '/api/session/answer', payload: body });
  }

  describe('GET /api/session/next', () => {
    it('отдаёт задание без ответа и засчитываемых записей', async () => {
      const issued = await next();

      expect(Object.keys(issued).sort()).toEqual([
        'answer_format',
        'difficulty',
        'hint',
        'id',
        'question',
        'subject',
        'topic_id',
        'topic_title',
      ]);
      // Ни эталона, ни разбора, ни реакции: всё это выдаёт ответ на задание.
      expect(JSON.stringify(issued)).not.toContain('45');
      expect(JSON.stringify(issued)).not.toContain('90 : 2');
    });

    it('отвечает 503, когда готовых заданий нет', async () => {
      db.prepare('DELETE FROM task_bank').run();

      const response = await app.inject({ method: 'GET', url: '/api/session/next' });

      expect(response.statusCode).toBe(503);
      expect((response.json() as { error: string }).error).toMatch(/нет готовых заданий/);
    });

    it('отвечает 503, когда планировщику нечего предложить', async () => {
      // Освоенная тема получает нулевой приоритет, и предлагать становится нечего.
      db.prepare('UPDATE topic_state SET mastery = 1').run();

      const response = await app.inject({ method: 'GET', url: '/api/session/next' });

      expect(response.statusCode).toBe(503);
      expect((response.json() as { error: string }).error).toMatch(/нечего предложить/);
    });
  });

  describe('POST /api/session/answer', () => {
    it('засчитывает верный ответ и отдаёт разбор с реакцией', async () => {
      const issued = await next();

      const response = await answer({ task_id: issued['id'], answer: '45 монет' });
      const body = response.json() as Record<string, never>;

      expect(response.statusCode).toBe(200);
      expect(body['correct']).toBe(true);
      expect(body['explain']).toContain('90 : 2');
      expect(body['joke']).not.toBe('');
      expect((body['topic'] as unknown as { mastery: number }).mastery).toBeGreaterThan(0);
    });

    it('на неверном ответе двигает модель знаний в другую сторону', async () => {
      const first = await answer({ task_id: (await next())['id'], answer: '45' });
      const second = await answer({ task_id: (await next())['id'], answer: '30' });

      const before = (first.json() as { topic: { mastery: number; id: string } }).topic;
      const after = (second.json() as { topic: { mastery: number; id: string } }).topic;

      expect((second.json() as { correct: boolean }).correct).toBe(false);
      // Планировщик чередует предметы, поэтому темы разные: сравниваются сдвиги
      // из одинакового нулевого состояния.
      expect(before.mastery).toBeGreaterThan(0);
      expect(after.mastery).toBe(0);
      expect(after.id).not.toBe(before.id);
    });

    it('отвечает 404 на несуществующее задание и 400 на кривое тело', async () => {
      expect((await answer({ task_id: 4242, answer: '45' })).statusCode).toBe(404);
      expect((await answer({ answer: '45' })).statusCode).toBe(400);
      expect((await answer({ task_id: '7', answer: '45' })).statusCode).toBe(400);
      expect((await answer({ task_id: 7 })).statusCode).toBe(400);
    });

    it('отвергает необязательные поля не того типа', async () => {
      const issued = await next();

      expect(
        (await answer({ task_id: issued['id'], answer: '45', hint_used: 'да' })).statusCode,
      ).toBe(400);
      expect(
        (await answer({ task_id: issued['id'], answer: '45', duration_ms: '5с' })).statusCode,
      ).toBe(400);
      // Ни одна из отклонённых попыток не записалась: задание всё ещё ждёт ответа.
      expect((await answer({ task_id: issued['id'], answer: '45' })).statusCode).toBe(200);
    });

    it('отвечает 409 на чужое задание — то, которое ученику не выдавали', async () => {
      const queued = db
        .prepare<[], { id: number }>("SELECT id FROM task_bank WHERE status = 'valid' LIMIT 1")
        .get();

      const response = await answer({ task_id: queued?.id, answer: '45' });

      expect(response.statusCode).toBe(409);
      expect((response.json() as { code: string }).code).toBe('task-not-issued');
    });

    it('отвечает 409 на повторный ответ по тому же заданию', async () => {
      const issued = await next();
      await answer({ task_id: issued['id'], answer: '45' });

      const repeat = await answer({ task_id: issued['id'], answer: '30' });

      expect(repeat.statusCode).toBe(409);
      expect((repeat.json() as { code: string }).code).toBe('already-answered');
    });
  });

  describe('POST /api/session/dispute', () => {
    /** Ответ, который сверка не засчитывает, хотя по смыслу он верный. */
    async function wrongAnswer(): Promise<{ attemptId: number; taskId: number }> {
      const issued = await next();
      const body = (await answer({ task_id: issued['id'], answer: 'сорок пять' })).json() as {
        attempt_id: number;
        correct: boolean;
      };
      expect(body.correct).toBe(false);
      return { attemptId: body.attempt_id, taskId: issued['id'] as number };
    }

    function dispute(body: Record<string, unknown>) {
      return app.inject({ method: 'POST', url: '/api/session/dispute', payload: body });
    }

    it('принимает спор и разбирает его фоном: баллы возвращаются, accept[] растёт', async () => {
      const { attemptId, taskId } = await wrongAnswer();

      const response = await dispute({ attempt_id: attemptId });
      expect(response.statusCode).toBe(202);
      expect((response.json() as { status: string }).status).toBe('open');
      await Promise.all(pending);

      expect(reviewed).toHaveLength(1);
      const stored = db
        .prepare<[number], { accept: string }>('SELECT accept FROM task_bank WHERE id = ?')
        .get(taskId);
      expect(JSON.parse(stored?.accept ?? '[]')).toContain('сорок пять');
      expect(db.prepare('SELECT is_correct FROM attempts WHERE id = ?').get(attemptId)).toEqual({
        is_correct: 1,
      });
      expect(
        db.prepare<[], { status: string }>('SELECT status FROM disputes').get()?.status,
      ).toBe('upheld');
    });

    it('отклонённый спор оставляет всё как было', async () => {
      verdict = { studentCorrect: false, note: 'это другое число' };
      const { attemptId, taskId } = await wrongAnswer();

      await dispute({ attempt_id: attemptId });
      await Promise.all(pending);

      const stored = db
        .prepare<[number], { accept: string }>('SELECT accept FROM task_bank WHERE id = ?')
        .get(taskId);
      expect(JSON.parse(stored?.accept ?? '[]')).toEqual(['45', '45 монет']);
      expect(db.prepare('SELECT is_correct FROM attempts WHERE id = ?').get(attemptId)).toEqual({
        is_correct: 0,
      });
    });

    it('повторное нажатие кнопки не заводит второй разбор', async () => {
      const { attemptId } = await wrongAnswer();
      await dispute({ attempt_id: attemptId });
      await Promise.all(pending);

      const repeat = await dispute({ attempt_id: attemptId });

      // Второе нажатие отдаёт вердикт по уже разобранному спору, а не отказ
      // «попытка засчитана»: засчитанной её сделал как раз этот разбор.
      expect(repeat.statusCode).toBe(200);
      expect((repeat.json() as { status: string }).status).toBe('upheld');
      expect(reviewed).toHaveLength(1);
      expect(db.prepare('SELECT COUNT(*) AS n FROM disputes').get()).toEqual({ n: 1 });
    });

    it('отвечает 404 на несуществующую попытку и 400 на засчитанную', async () => {
      const issued = await next();
      const correct = (await answer({ task_id: issued['id'], answer: '45' })).json() as {
        attempt_id: number;
      };

      expect((await dispute({ attempt_id: 4242 })).statusCode).toBe(404);
      expect((await dispute({ attempt_id: correct.attempt_id })).statusCode).toBe(400);
      expect((await dispute({})).statusCode).toBe(400);
    });

    it('не роняет сервер, когда разбирающий недоступен: спор остаётся открытым', async () => {
      const failing = buildServer(join(tempDir, 'curriculum'), {
        seedDir,
        review: (): Promise<DisputeReview> => Promise.reject(new Error('codex не найден')),
        background: (job): void => {
          pending.push(job());
        },
        log: (message): void => {
          logged.push(message);
        },
      });
      await failing.ready();
      const { attemptId } = await wrongAnswer();

      const response = await failing.inject({
        method: 'POST',
        url: '/api/session/dispute',
        payload: { attempt_id: attemptId },
      });
      await Promise.all(pending);

      expect(response.statusCode).toBe(202);
      expect(logged.some((message) => message.includes('codex не найден'))).toBe(true);
      expect(
        db.prepare<[], { status: string }>('SELECT status FROM disputes').get()?.status,
      ).toBe('open');
      await failing.close();
    });
  });

  it('отдаёт 503 на занятие, когда карта тем не загрузилась', async () => {
    const broken = buildServer(join(tempDir, 'нет-такого-каталога'));
    await broken.ready();

    const response = await broken.inject({ method: 'GET', url: '/api/session/next' });

    expect(response.statusCode).toBe(503);
    expect((response.json() as { error: string }).error).toMatch(/карта тем не загружена/);
    await broken.close();
  });

  it('карта тем и посев остаются доступными: /api/health не сломан занятием', async () => {
    expect(loadCurriculum(join(tempDir, 'curriculum')).byId.size).toBe(SUBJECTS.length);
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
  });
});
