import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import { buildServer, type ServerOptions } from '../server/index.js';
import { openDatabase, SUBJECTS } from '../server/db.js';
import { loadCurriculum } from '../server/curriculum.js';
import { storeTasks } from '../server/codex/bank.js';
import type { DisputeContext, DisputeReview } from '../server/codex/dispute.js';
import type { GeneratedTask } from '../server/codex/task-schema.js';
import { DISPUTE_RETRY_MAX_MS, MAX_ANSWER_LENGTH } from '../server/routes/session.js';
import { MAX_DISPUTE_CONCURRENCY } from '../server/codex/concurrency.js';

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
  /**
   * Серверы, поднятые внутри отдельных тестов. Закрываются в `afterEach`, а не
   * последней строкой тела: упавшая проверка до неё не доходит, и соединение с
   * базой вместе с файлами `-wal`/`-shm` жило бы до конца прогона.
   */
  const extra: FastifyInstance[] = [];

  /** Сервер со своими настройками, закрываемый вместе с тестом. */
  function extraServer(options: ServerOptions = {}, dir?: string): FastifyInstance {
    const instance = buildServer(dir ?? join(tempDir, 'curriculum'), options);
    extra.push(instance);
    return instance;
  }

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
    extra.length = 0;

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
    for (const instance of extra) await instance.close();
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
        'choices',
        'difficulty',
        'hint',
        'id',
        'instruction',
        'material',
        'material_format',
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
      expect((response.json() as { code: string }).code).toBe('no-task');
    });

    // Порча посева на старте сервер не роняет; посреди занятия она приезжала бы
    // ученику пятисоткой с абсолютным путём в теле ответа.
    it('отвечает 503, а не 500, когда посевной файл испорчен', async () => {
      db.prepare('DELETE FROM task_bank').run();
      writeFileSync(join(seedDir, 'math.json'), 'не json');

      const response = await app.inject({ method: 'GET', url: '/api/session/next' });

      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain(seedDir);
    });

    it('отвечает 503, когда планировщику нечего предложить', async () => {
      // Освоенная тема получает нулевой приоритет, и предлагать становится нечего.
      db.prepare('UPDATE topic_state SET mastery = 1').run();

      const response = await app.inject({ method: 'GET', url: '/api/session/next' });

      expect(response.statusCode).toBe(503);
      expect((response.json() as { error: string }).error).toMatch(/нечего предложить/);
      expect((response.json() as { code: string }).code).toBe('no-topic');
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

    // Проверялись только отказы на кривых значениях, а годные до занятия не
    // доезжали ни в одном тесте: подстановка `{hintUsed: false, durationMs: 0}`
    // была бы невидима, и каждая попытка с подсказкой считалась бы решённой без
    // неё — а `hint_used` идёт прямо в модель знаний.
    it('доносит hint_used и duration_ms до записи попытки', async () => {
      const issued = await next();

      const response = await answer({
        task_id: issued['id'],
        answer: '45',
        hint_used: true,
        duration_ms: 4200,
      });

      expect(response.statusCode).toBe(200);
      const row = db
        .prepare('SELECT hint_used, duration_ms FROM attempts WHERE task_id = ?')
        .get(issued['id']) as { hint_used: number; duration_ms: number };
      expect(row).toEqual({ hint_used: 1, duration_ms: 4200 });
    });

    it('записывает попытку без подсказки, когда поля не присланы', async () => {
      const issued = await next();

      await answer({ task_id: issued['id'], answer: '45' });

      const row = db
        .prepare('SELECT hint_used, duration_ms FROM attempts WHERE task_id = ?')
        .get(issued['id']) as { hint_used: number; duration_ms: number };
      expect(row).toEqual({ hint_used: 0, duration_ms: 0 });
    });

    it('отвергает необязательные поля не того типа', async () => {
      const issued = await next();

      expect(
        (await answer({ task_id: issued['id'], answer: '45', hint_used: 'да' })).statusCode,
      ).toBe(400);
      expect(
        (await answer({ task_id: issued['id'], answer: '45', duration_ms: '5с' })).statusCode,
      ).toBe(400);
      // `1e999` разбирается в `Infinity` и доезжает до `duration_ms INTEGER`
      // как есть: SQLite типы не навязывает, а `CHECK (duration_ms >= 0)`
      // бесконечность пропускает.
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/session/answer',
            headers: { 'content-type': 'application/json' },
            payload: `{"task_id":${String(issued['id'])},"answer":"45","duration_ms":1e999}`,
          })
        ).statusCode,
      ).toBe(400);
      // Тот же довод, что и про `Infinity`: `1e300` переживает `Math.round`, а
      // дробное и отрицательное доезжают до `duration_ms INTEGER` как есть.
      for (const duration of [1e300, 0.5, -1]) {
        expect(
          (await answer({ task_id: issued['id'], answer: '45', duration_ms: duration })).statusCode,
        ).toBe(400);
      }
      // Ни одна из отклонённых попыток не записалась: задание всё ещё ждёт ответа.
      expect((await answer({ task_id: issued['id'], answer: '45' })).statusCode).toBe(200);
    });

    // Ответ ученика — слово, фраза или число: без предела в `attempts` уезжает
    // мегабайт (умолчание `bodyLimit` Fastify), и он же потом идёт в промпт.
    it('отвергает ответ длиннее предела и не записывает попытку', async () => {
      const issued = await next();
      const long = 'я'.repeat(MAX_ANSWER_LENGTH + 1);

      expect((await answer({ task_id: issued['id'], answer: long })).statusCode).toBe(400);
      expect(
        (await answer({ task_id: issued['id'], answer: 'я'.repeat(MAX_ANSWER_LENGTH) })).statusCode,
      ).toBe(200);
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

    // Набор «уже разбирается» держит только повтор по одному и тому же спору, а
    // разных открытых споров бывает сколько угодно — и каждый это ещё один
    // процесс codex на минуты.
    it('не заводит больше одного разбора в выделенном слоте', async () => {
      const release: (() => void)[] = [];
      const blocking = extraServer({
        seedDir,
        review: (context): Promise<DisputeReview> => {
          reviewed.push(context);
          return new Promise<DisputeReview>((resolve) => {
            release.push(() => resolve(verdict));
          });
        },
        background: (job): void => {
          pending.push(job());
        },
        log: (message): void => {
          logged.push(message);
        },
      });
      await blocking.ready();

      const attempts: number[] = [];
      for (let index = 0; index <= MAX_DISPUTE_CONCURRENCY; index += 1) {
        attempts.push((await wrongAnswer()).attemptId);
      }
      const disputeAt = (attemptId: number) =>
        blocking.inject({
          method: 'POST',
          url: '/api/session/dispute',
          payload: { attempt_id: attemptId },
        });
      for (const attemptId of attempts) await disputeAt(attemptId);

      expect(reviewed).toHaveLength(MAX_DISPUTE_CONCURRENCY);
      expect(logged.some((message) => message.includes('отложен'))).toBe(true);

      for (const resolve of release) resolve();
      await Promise.all(pending);

      // Отложенный спор остался открытым и попадает на разбор со следующим
      // нажатием кнопки — места к тому времени освободились.
      const retry = await disputeAt(attempts[MAX_DISPUTE_CONCURRENCY] ?? 0);
      expect((retry.json() as { status: string }).status).toBe('open');
      release[release.length - 1]?.();
      await Promise.all(pending);

      expect(reviewed).toHaveLength(MAX_DISPUTE_CONCURRENCY + 1);
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
      const failing = extraServer({
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
    });

    it('держит долгий предел автоматических повторов спора', () => {
      expect(DISPUTE_RETRY_MAX_MS).toBe(15 * 60_000);
    });

    it('после перезапуска сам подхватывает оставшийся открытым спор', async () => {
      const failing = extraServer({
        seedDir,
        review: (): Promise<DisputeReview> => Promise.reject(new Error('codex не найден')),
        background: (job): void => {
          pending.push(job());
        },
      });
      await failing.ready();
      const { attemptId } = await wrongAnswer();
      await failing.inject({
        method: 'POST',
        url: '/api/session/dispute',
        payload: { attempt_id: attemptId },
      });
      await Promise.all(pending);
      await failing.close();
      extra.splice(extra.indexOf(failing), 1);
      pending.length = 0;

      const recovered = extraServer({
        seedDir,
        review: (context): Promise<DisputeReview> => {
          reviewed.push(context);
          return Promise.resolve(verdict);
        },
        background: (job): void => {
          pending.push(job());
        },
      });
      await recovered.ready();
      await Promise.all(pending);

      expect(reviewed).toHaveLength(1);
      expect(
        db.prepare<[], { status: string }>('SELECT status FROM disputes').get()?.status,
      ).toBe('upheld');
    });

    // Провалившийся разбор иначе не повторился бы никогда: второй раз спор уже
    // заведён, и по признаку «завели сейчас» на разбор он больше не попадал бы.
    it('ставит на разбор заново спор, оставшийся открытым после отказа', async () => {
      let available = false;
      const flaky = extraServer({
        seedDir,
        review: (context): Promise<DisputeReview> => {
          reviewed.push(context);
          return available
            ? Promise.resolve(verdict)
            : Promise.reject(new Error('codex не найден'));
        },
        background: (job): void => {
          pending.push(job());
        },
        log: (message): void => {
          logged.push(message);
        },
      });
      await flaky.ready();
      const { attemptId, taskId } = await wrongAnswer();

      const press = () =>
        flaky.inject({
          method: 'POST',
          url: '/api/session/dispute',
          payload: { attempt_id: attemptId },
        });

      expect((await press()).statusCode).toBe(202);
      await Promise.all(pending);
      expect(reviewed).toHaveLength(1);

      available = true;
      const repeat = await press();
      await Promise.all(pending);

      expect(repeat.statusCode).toBe(200);
      expect(reviewed).toHaveLength(2);
      expect(db.prepare('SELECT COUNT(*) AS n FROM disputes').get()).toEqual({ n: 1 });
      expect(
        db.prepare<[], { status: string }>('SELECT status FROM disputes').get()?.status,
      ).toBe('upheld');
      const stored = db
        .prepare<[number], { accept: string }>('SELECT accept FROM task_bank WHERE id = ?')
        .get(taskId);
      expect(JSON.parse(stored?.accept ?? '[]')).toContain('сорок пять');
    });

    // Разбор идёт минутами, а состояние спора клиент узнаёт этим же запросом:
    // без защёлки каждое нажатие поднимало бы ещё один процесс codex, минуя
    // предел одновременных вызовов, который живёт в воркере.
    it('не ставит на разбор спор, разбор которого уже идёт', async () => {
      let release: (() => void) | undefined;
      const slow = extraServer({
        seedDir,
        review: (context): Promise<DisputeReview> => {
          reviewed.push(context);
          return new Promise<DisputeReview>((resolve) => {
            release = (): void => resolve(verdict);
          });
        },
        background: (job): void => {
          pending.push(job());
        },
      });
      await slow.ready();
      const { attemptId } = await wrongAnswer();

      const press = () =>
        slow.inject({
          method: 'POST',
          url: '/api/session/dispute',
          payload: { attempt_id: attemptId },
        });

      expect((await press()).statusCode).toBe(202);
      for (let i = 0; i < 4; i += 1) expect((await press()).statusCode).toBe(200);

      // Ни один повтор не дошёл до модели, пока первый разбор не закончился.
      expect(reviewed).toHaveLength(1);

      release?.();
      await Promise.all(pending);
      expect(reviewed).toHaveLength(1);
      expect(
        db.prepare<[], { status: string }>('SELECT status FROM disputes').get()?.status,
      ).toBe('upheld');
    });

    it('не пишет вердикт в отвязанную базу, если EDUKATOR_DB заменили за время разбора', async () => {
      let release: (() => void) | undefined;
      const slow = extraServer({
        seedDir,
        disputeRetryMs: 1,
        review: (context): Promise<DisputeReview> => {
          reviewed.push(context);
          return new Promise<DisputeReview>((resolve) => {
            release = (): void => resolve(verdict);
          });
        },
        background: (job): void => {
          pending.push(job());
        },
        log: (message): void => {
          logged.push(message);
        },
      });
      await slow.ready();
      const { attemptId } = await wrongAnswer();

      const response = await slow.inject({
        method: 'POST',
        url: '/api/session/dispute',
        payload: { attempt_id: attemptId },
      });
      expect(response.statusCode).toBe(202);
      const disputeId = (response.json() as { dispute_id: number }).dispute_id;
      expect(reviewed).toHaveLength(1);

      const path = join(tempDir, 'session.db');
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
      openDatabase(path).close();

      release?.();
      await Promise.all(pending);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));

      // Старое соединение всё ещё читает отвязанный inode, но не имеет
      // права закрыть в нём спор: такая запись пропадёт после перезапуска.
      expect(
        db.prepare<[number], { status: string }>('SELECT status FROM disputes WHERE id = ?')
          .get(disputeId)?.status,
      ).toBe('open');
      expect(reviewed).toHaveLength(1);
      expect(logged.join('\n')).toContain('файл базы заменён во время разбора');
    });

    it('перед закрытием сервера дожидается фонового разбора', async () => {
      let release: (() => void) | undefined;
      const slow = extraServer({
        seedDir,
        review: (): Promise<DisputeReview> =>
          new Promise<DisputeReview>((resolve) => {
            release = (): void => resolve(verdict);
          }),
      });
      await slow.ready();
      const { attemptId } = await wrongAnswer();
      expect(
        (await slow.inject({
          method: 'POST',
          url: '/api/session/dispute',
          payload: { attempt_id: attemptId },
        })).statusCode,
      ).toBe(202);

      let closed = false;
      const closing = slow.close().then(() => {
        closed = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closed).toBe(false);

      release?.();
      await closing;
      expect(
        db.prepare<[], { status: string }>('SELECT status FROM disputes').get()?.status,
      ).toBe('upheld');
    });
  });

  // Негодное задание не должно вставать поперёк занятия навсегда: без пометки
  // оно остаётся `used` без попытки, `issuedTask` выдаёт его снова, и ученик
  // получает ту же ошибку до конца занятия. Причина при этом называет эталонный
  // ответ, а его ученик видеть не должен, — она уходит в журнал.
  it('отбраковывает задание, которое нечем сверить, и не выдаёт его снова', async () => {
    // Повреждённый `accept[]`: сверять ответ нечем, и виновато само задание.
    const broken = db
      .prepare<[], { id: number }>(
        `UPDATE task_bank SET status = 'used', accept = '{'
          WHERE topic_id = 'math.a' RETURNING id`,
      )
      .get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/session/answer',
      payload: { task_id: broken?.id, answer: '45' },
    });

    expect(response.statusCode).toBe(409);
    expect((response.json() as { code: string }).code).toBe('task-defective');
    // Причина называет содержимое банка: она уходит в журнал, а не ученику.
    expect(response.body).not.toContain('accept');
    expect(logged.join('\n')).toContain('отбраковано при приёме ответа');
    expect(
      db
        .prepare<[number], { status: string }>('SELECT status FROM task_bank WHERE id = ?')
        .get(broken?.id ?? 0)?.status,
    ).toBe('rejected');
  });

  // Тема, пропавшая из карты, — расхождение карты с базой, а не негодное
  // задание: `syncTopicState` ровно поэтому ничего не удаляет, а `rejected`
  // выкинул бы целые задания из выгружаемого посева навсегда.
  it('не бракует задание темы, которой не стало в карте', async () => {
    const otherDir = join(tempDir, 'curriculum-b');
    mkdirSync(otherDir);
    for (const subject of SUBJECTS) {
      const raw = JSON.parse(
        readFileSync(join(tempDir, 'curriculum', `${subject}.json`), 'utf8'),
      ) as { topics: { id: string }[] };
      const topics = raw.topics.map((entry) => ({ ...entry, id: `${subject}.b` }));
      writeFileSync(join(otherDir, `${subject}.json`), JSON.stringify({ subject, topics }));
    }

    // Задание темы, которой в карте этого сервера нет: `topicOf` бросает обычным
    // Error, и Fastify по умолчанию положил бы его текст в тело ответа.
    const stale = db
      .prepare<[], { id: number }>(
        "UPDATE task_bank SET status = 'used' WHERE topic_id = 'math.a' RETURNING id",
      )
      .get();
    const other = extraServer(
      {
        seedDir,
        log: (message): void => {
          logged.push(message);
        },
      },
      otherDir,
    );
    await other.ready();

    const response = await other.inject({
      method: 'POST',
      url: '/api/session/answer',
      payload: { task_id: stale?.id, answer: '45' },
    });

    expect(response.statusCode).toBe(500);
    expect((response.json() as { error: string }).error).toBe('Внутренняя ошибка сервера');
    expect(response.body).not.toContain('math.a');
    expect(
      db
        .prepare<[number], { status: string }>('SELECT status FROM task_bank WHERE id = ?')
        .get(stale?.id ?? 0)?.status,
    ).toBe('used');
  });

  // Текст исключения называет локальные пути и содержимое базы, а сервер слушает
  // всю домашнюю сеть без пароля.
  it('на поломке отвечает 500 без внутренних подробностей', async () => {
    const issued = db
      .prepare<[], { id: number }>(
        "UPDATE task_bank SET status = 'used' WHERE topic_id = 'math.a' RETURNING id",
      )
      .get();
    // Поломка, а не дефект одного задания: сверять ответ не с чем не потому, что
    // задание негодное, а потому, что база нечитаема.
    db.exec('DROP TABLE attempts');

    const response = await app.inject({
      method: 'POST',
      url: '/api/session/answer',
      payload: { task_id: issued?.id, answer: '45' },
    });

    expect(response.statusCode).toBe(500);
    expect((response.json() as { error: string }).error).toBe('Внутренняя ошибка сервера');
    expect(response.body).not.toContain('attempts');
  });

  it('отдаёт 503 на занятие, когда карта тем не загрузилась', async () => {
    const broken = extraServer({}, join(tempDir, 'нет-такого-каталога'));
    await broken.ready();

    const response = await broken.inject({ method: 'GET', url: '/api/session/next' });

    expect(response.statusCode).toBe(503);
    expect((response.json() as { error: string }).error).toMatch(/карта тем не загружена/);
    expect((response.json() as { code: string }).code).toBe('restart-required');
  });

  // Все три адреса, а не один: незарегистрированный маршрут отвечает 404 от
  // Fastify, и клиент прочитал бы отказ по состоянию как опечатку в пути —
  // ровно то, ради чего заглушка и заведена.
  it('отдаёт 503 и на приём ответа, и на спор, а не молчаливое 404', async () => {
    const broken = extraServer({}, join(tempDir, 'нет-такого-каталога'));
    await broken.ready();

    for (const url of ['/api/session/answer', '/api/session/dispute']) {
      const response = await broken.inject({ method: 'POST', url, payload: {} });

      expect(response.statusCode, url).toBe(503);
      expect((response.json() as { error: string }).error, url).toMatch(/карта тем не загружена/);
    }
  });

  it('карта тем и посев остаются доступными: /api/health не сломан занятием', async () => {
    expect(loadCurriculum(join(tempDir, 'curriculum')).byId.size).toBe(SUBJECTS.length);
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
  });
});
