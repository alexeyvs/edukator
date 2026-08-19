import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../server/db.js';
import { buildTopicGraph, syncTopicState, type Topic, type TopicGraph } from '../server/curriculum.js';
import { storeTasks } from '../server/codex/bank.js';
import { CodexConcurrency } from '../server/codex/concurrency.js';
import type { DisputeContext, DisputeReview } from '../server/codex/dispute.js';
import type { GeneratedTask } from '../server/codex/task-schema.js';
import { openDispute, submitAnswer } from '../server/session.js';
import {
  DISPUTE_RETRY_MAX_MS,
  DISPUTE_RETRY_MS,
  DisputeCoordinator,
  type DisputeCoordinatorOptions,
} from '../server/dispute-coordinator.js';

function topic(id: string, patch: Partial<Topic> = {}): Topic {
  return {
    id,
    subject: 'math',
    title: `Тема ${id}`,
    examWeight: 3,
    difficulty: 2,
    prereqs: [],
    answerFormat: 'number',
    promptSeed: `Спрашивай по теме ${id}.`,
    ...patch,
  };
}

const GRAPH: TopicGraph = buildTopicGraph([topic('math.a')]);

let counter = 0;

function task(): GeneratedTask {
  counter += 1;
  return {
    instruction: `Задание ${counter}: в инвентаре 90 монет, половину потратил. Сколько осталось?`,
    material: '',
    material_format: 'none',
    choices: [],
    answer: '45',
    accept: ['45', '45 монет'],
    hint: 'Половина от девяноста.',
    explain: '90 : 2 = 45 — вот и весь фокус.',
    joke: 'Кошелёк похудел вдвое, зато ты нет.',
    difficulty: 2,
  };
}

describe('координатор разбора споров', () => {
  let tempDir: string;
  /** Две базы: координатор — вещь на арендатора, и проверять его надо на двух. */
  let first: Database;
  let second: Database;
  /** Фоновые разборы: тест их дожидается, вместо того чтобы гадать о таймингах. */
  let pending: Promise<void>[];
  let logged: string[];
  let stops: (() => Promise<void>)[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-disputes-'));
    first = openDatabase(join(tempDir, 'первый.db'));
    second = openDatabase(join(tempDir, 'второй.db'));
    for (const db of [first, second]) syncTopicState(db, GRAPH);
    pending = [];
    logged = [];
    stops = [];
  });

  afterEach(async () => {
    // Разборы дожидаются до закрытия базы: иначе штатное завершение теста
    // превратилось бы в случайный `database connection is not open`.
    for (const stop of stops) await stop();
    first.close();
    second.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function coordinator(
    db: Database,
    patch: Partial<DisputeCoordinatorOptions> = {},
  ): DisputeCoordinator {
    const created = new DisputeCoordinator({
      db,
      graph: GRAPH,
      background: (job): void => {
        pending.push(job());
      },
      log: (message): void => {
        logged.push(message);
      },
      // Свой бюджет на тест: процессный переносил бы занятые места между тестами.
      disputeBudget: new CodexConcurrency(1),
      ...patch,
    });
    stops.push(() => created.stop());
    return created;
  }

  /** Ответ, который нормализатор не засчитывает, хотя по смыслу он верный. */
  function disputed(db: Database): number {
    const { stored } = storeTasks(db, 'math.a', [task()]);
    const taskId = stored[0]?.id;
    if (taskId === undefined) throw new Error('задание не легло в банк');
    db.prepare("UPDATE task_bank SET status = 'used' WHERE id = ?").run(taskId);
    const attempt = submitAnswer(db, GRAPH, { taskId, answer: 'сорок пять' });
    expect(attempt.correct).toBe(false);
    return openDispute(db, attempt.attemptId).id;
  }

  function statusOf(db: Database, id: number): string | undefined {
    return db
      .prepare<[number], { status: string }>('SELECT status FROM disputes WHERE id = ?')
      .get(id)?.status;
  }

  /** Ждёт условия, вместо того чтобы гадать о длине паузы повтора. */
  async function waitFor(condition: () => boolean): Promise<void> {
    for (let i = 0; i < 400; i += 1) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('условие не наступило за отведённое время');
  }

  it('разбирает заказанный спор и пишет вердикт в свою базу', async () => {
    const id = disputed(first);
    const seen: DisputeContext[] = [];
    const disputes = coordinator(first, {
      review: (context): Promise<DisputeReview> => {
        seen.push(context);
        return Promise.resolve({ studentCorrect: true, note: 'то же число словами' });
      },
    });

    disputes.schedule(id);
    await Promise.all(pending);

    expect(seen).toHaveLength(1);
    expect(statusOf(first, id)).toBe('upheld');
  });

  it('восстанавливает незакрытые споры при открытии базы', async () => {
    // Спор переживает процесс в SQLite: после перезапуска его нельзя оставлять
    // без исполнителя только потому, что браузер уже потерял attempt_id.
    const id = disputed(first);
    const disputes = coordinator(first, {
      review: (): Promise<DisputeReview> =>
        Promise.resolve({ studentCorrect: false, note: 'это другое число' }),
    });

    disputes.restore();
    await Promise.all(pending);

    expect(statusOf(first, id)).toBe('rejected');
  });

  it('восстановление разбирает споры только своей базы', async () => {
    const mine = disputed(first);
    const alien = disputed(second);
    // Номера у разных детей совпадают: общий набор `reviewing` заставил бы один
    // спор ждать другого, а вердикт мог бы уйти не в ту базу.
    expect(mine).toBe(alien);
    const disputes = coordinator(first, {
      review: (): Promise<DisputeReview> =>
        Promise.resolve({ studentCorrect: true, note: 'то же число словами' }),
    });

    disputes.restore();
    await Promise.all(pending);

    expect(statusOf(first, mine)).toBe('upheld');
    expect(statusOf(second, alien)).toBe('open');
  });

  it('идущий разбор одного арендатора не мешает разбору другого', async () => {
    const mine = disputed(first);
    const alien = disputed(second);
    let release: (() => void) | undefined;
    const hanging = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = coordinator(first, {
      review: async (): Promise<DisputeReview> => {
        await hanging;
        return { studentCorrect: true, note: 'то же число словами' };
      },
    });
    const quick = coordinator(second, {
      review: (): Promise<DisputeReview> =>
        Promise.resolve({ studentCorrect: false, note: 'это другое число' }),
    });

    slow.schedule(mine);
    quick.schedule(alien);
    // Ждать `pending` целиком нельзя: первый разбор висит до `release`, и это
    // ровно то состояние, в котором проверяется независимость второго.
    await waitFor(() => statusOf(second, alien) === 'rejected');

    expect(statusOf(first, mine)).toBe('open');
    release?.();
    await Promise.all(pending);
    expect(statusOf(first, mine)).toBe('upheld');
  });

  it('повторный заказ того же спора не поднимает второй разбор', async () => {
    // Состояние спора клиент узнаёт повторным запросом: без набора идущих
    // разборов каждое нажатие кнопки поднимало бы ещё один codex на минуты.
    const id = disputed(first);
    let calls = 0;
    let release: (() => void) | undefined;
    const hanging = new Promise<void>((resolve) => {
      release = resolve;
    });
    const disputes = coordinator(first, {
      // Свободное место в бюджете нарочно есть: повтор должен отсекаться
      // набором идущих разборов, а не занятым codex.
      disputeBudget: new CodexConcurrency(2),
      review: async (): Promise<DisputeReview> => {
        calls += 1;
        await hanging;
        return { studentCorrect: true, note: 'то же число словами' };
      },
    });

    disputes.schedule(id);
    disputes.schedule(id);
    release?.();
    await Promise.all(pending);

    expect(calls).toBe(1);
    expect(logged.some((line) => line.includes('отложен'))).toBe(false);
    expect(statusOf(first, id)).toBe('upheld');
  });

  it('неудачный разбор оставляет спор открытым и повторяет его', async () => {
    const id = disputed(first);
    let calls = 0;
    const disputes = coordinator(first, {
      disputeRetryMs: 1,
      review: (): Promise<DisputeReview> => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error('codex не найден'))
          : Promise.resolve({ studentCorrect: true, note: 'то же число словами' });
      },
    });

    disputes.schedule(id);
    await Promise.all(pending);

    expect(statusOf(first, id)).toBe('open');
    expect(logged.some((line) => line.includes(`разбор спора ${String(id)} не выполнен`))).toBe(true);

    await waitFor(() => calls > 1);
    await Promise.all(pending);
    expect(statusOf(first, id)).toBe('upheld');
  });

  it('занятый бюджет откладывает разбор, а спор оставляет открытым', async () => {
    const id = disputed(first);
    const budget = new CodexConcurrency(1);
    let release: (() => void) | undefined;
    const busy = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = budget.tryRun(() => busy);
    const disputes = coordinator(first, {
      disputeBudget: budget,
      review: (): Promise<DisputeReview> =>
        Promise.resolve({ studentCorrect: true, note: 'то же число словами' }),
    });

    disputes.schedule(id);

    expect(statusOf(first, id)).toBe('open');
    expect(logged.some((line) => line.includes('отложен: заняты все 1 места codex'))).toBe(true);
    release?.();
    await held;
  });

  it('не заказывает разбор, когда файл базы заменён', async () => {
    // Заменённую базу этот процесс не переоткроет: разбор лишь занимал бы
    // бюджет codex, а вердикт ушёл бы в отвязанный файл.
    const id = disputed(first);
    let calls = 0;
    const disputes = coordinator(first, {
      available: (): boolean => false,
      review: (): Promise<DisputeReview> => {
        calls += 1;
        return Promise.resolve({ studentCorrect: true, note: 'то же число словами' });
      },
    });

    disputes.schedule(id);
    disputes.restore();
    await Promise.all(pending);

    expect(calls).toBe(0);
    expect(statusOf(first, id)).toBe('open');
  });

  it('останавливается, дождавшись идущего разбора, и больше ничего не заказывает', async () => {
    const id = disputed(first);
    let calls = 0;
    let release: (() => void) | undefined;
    const hanging = new Promise<void>((resolve) => {
      release = resolve;
    });
    const disputes = coordinator(first, {
      review: async (): Promise<DisputeReview> => {
        calls += 1;
        await hanging;
        return { studentCorrect: true, note: 'то же число словами' };
      },
    });

    disputes.schedule(id);
    release?.();
    await disputes.stop();

    // Вердикт записан до возврата из `stop`: закрытие базы раньше дало бы
    // `database connection is not open` посреди транзакции разбора.
    expect(statusOf(first, id)).toBe('upheld');

    const another = disputed(first);
    disputes.schedule(another);
    await Promise.all(pending);
    expect(calls).toBe(1);
    expect(statusOf(first, another)).toBe('open');
  });

  it('держит калибровочные константы спеки', () => {
    expect(DISPUTE_RETRY_MAX_MS).toBe(15 * 60_000);
    expect(DISPUTE_RETRY_MS).toBe(1_000);
  });
});
