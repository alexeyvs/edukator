import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from 'better-sqlite3';
import {
  CODEX_DAILY_QUOTA,
  createChild,
  createParent,
  markChildReady,
  openControlDatabase,
  readCodexQuota,
} from '../server/control-db.js';
import { openDatabase } from '../server/db.js';
import { buildTopicGraph, syncTopicState, type Topic, type TopicGraph } from '../server/curriculum.js';
import {
  CodexRunError,
  CodexUnavailableError,
  CODEX_ROLE_ENV,
  type CodexRequest,
} from '../server/codex/client.js';
import { CodexQuotaError, createQuotedRunner } from '../server/codex/quota.js';
import { createValidatingProducer, runWarmupCycle } from '../server/codex/worker.js';
import { reviewDispute } from '../server/codex/dispute.js';
import type { GeneratedTask } from '../server/codex/task-schema.js';

function topic(id = 'math.fractions', patch: Partial<Topic> = {}): Topic {
  return {
    id,
    subject: 'math',
    title: 'Обыкновенные дроби',
    examWeight: 3,
    difficulty: 2,
    prereqs: [],
    answerFormat: 'number',
    promptSeed: 'Спрашивай сложение дробей с разными знаменателями.',
    ...patch,
  };
}

function task(index: number): GeneratedTask {
  return {
    instruction: `Задание №${index}: сколько монет останется?`,
    material: '',
    material_format: 'none',
    choices: [],
    answer: '45',
    accept: ['45', '45 монет'],
    hint: 'Раздели девяносто пополам. Потом проверь обратным действием.',
    explain: '90 : 2 = 45.',
    joke: 'Кошелёк похудел вдвое.',
    difficulty: 2,
  };
}

/** Годный ответ генератора: батч из `count` заданий. */
function batch(count: number): string {
  return JSON.stringify({ items: Array.from({ length: count }, (_, i) => task(i)) });
}

/** Годный ответ проверяющего: все задания приняты. */
function verdicts(count: number): string {
  return JSON.stringify({
    items: Array.from({ length: count }, () => ({
      answer: '45',
      unambiguous: true,
      natural: true,
      on_topic: true,
      age_appropriate: true,
      hint_safe: true,
      note: '',
    })),
  });
}

/** Разбор спора: ответ, которого хватает `parseDisputeReview`. */
const DISPUTE_ANSWER = JSON.stringify({ student_correct: true, note: 'Ученик прав.' });

/** Подставной исполнитель: отдаёт заготовленные ответы по порядку. */
function recorder(answers: (string | Error)[]): {
  requests: CodexRequest[];
  run: (request: CodexRequest) => Promise<string>;
} {
  const requests: CodexRequest[] = [];
  return {
    requests,
    run: (request: CodexRequest): Promise<string> => {
      requests.push(request);
      const next = answers[requests.length - 1];
      if (next === undefined) return Promise.reject(new Error('лишний вызов codex'));
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next);
    },
  };
}

// Модель роли читается из окружения: без обнуления `EDUKATOR_MODEL_*` в
// оболочке разработчика красил бы набор по причине, к коду отношения не имеющей.
beforeEach(() => {
  for (const name of Object.values(CODEX_ROLE_ENV)) vi.stubEnv(name, '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('квота вызовов codex в CodexRunner', () => {
  let tempDir: string;
  let control: Database;
  let childId: string;
  let otherId: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-quota-'));
    control = openControlDatabase(join(tempDir, 'control.db'));
    const parentId = createParent(control, 'родитель@example.com');
    childId = createChild(control, parentId, 'Тимофей');
    markChildReady(control, childId);
    otherId = createChild(control, parentId, 'Вторая');
    markChildReady(control, otherId);
  });

  afterEach(() => {
    control.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('списывает по одному вызову модели: батч из генератора и проверяющего стоит два', async () => {
    // Ради этого квота и вложена в `CodexRunner`: один `budget.run` оборачивает
    // весь конвейер, и счёт по слотам семафора дал бы здесь единицу.
    const { requests, run } = recorder([batch(2), verdicts(2)]);
    const produce = createValidatingProducer({
      log: () => undefined,
      run: createQuotedRunner({ control, childId, run }),
    });

    const accepted = await produce({
      topic: topic(),
      difficulty: 2,
      recent: [],
      profile: { name: 'Тимофей', interests: [], examDate: null, partnerName: 'Кекс' },
    });

    expect(accepted).toHaveLength(2);
    expect(requests).toHaveLength(2);
    expect(readCodexQuota(control, childId).used).toBe(2);
  });

  it('списывает квоту и на неудачном вызове', async () => {
    // Резерв не возвращается намеренно: зацикливание на ошибках модели жжёт ту
    // же квоту, что и удачные вызовы, и возврат обходил бы всю защиту.
    const quoted = createQuotedRunner({
      control,
      childId,
      run: recorder([new CodexRunError('codex завершился с кодом 1')]).run,
    });

    await expect(
      quoted({ prompt: 'p', schemaPath: '/s.json', outPath: '/o.json' }),
    ).rejects.toBeInstanceOf(CodexRunError);
    expect(readCodexQuota(control, childId).used).toBe(1);
  });

  it('исчерпанная квота не пускает вызов и не зовёт модель', async () => {
    const { requests, run } = recorder([]);
    const quoted = createQuotedRunner({ control, childId, run, limit: 2 });

    await quoted({ prompt: 'p', schemaPath: '/s.json', outPath: '/o.json' }).catch(() => undefined);
    await quoted({ prompt: 'p', schemaPath: '/s.json', outPath: '/o.json' }).catch(() => undefined);
    const denied = quoted({ prompt: 'p', schemaPath: '/s.json', outPath: '/o.json' });

    await expect(denied).rejects.toBeInstanceOf(CodexQuotaError);
    // Отказ должен доходить до конвейера как недоступность: иначе генератор
    // потратил бы на него три попытки и увёз бы текст про квоту в промпт.
    await expect(denied).rejects.toBeInstanceOf(CodexUnavailableError);
    expect(requests).toHaveLength(2);
    expect(readCodexQuota(control, childId, new Date(), 2).used).toBe(2);
  });

  it('считает квоту каждому ребёнку свою', async () => {
    const { run } = recorder([batch(1), batch(1)]);
    await createQuotedRunner({ control, childId, run })({
      prompt: 'p', schemaPath: '/s.json', outPath: '/o.json',
    });

    expect(readCodexQuota(control, childId).used).toBe(1);
    expect(readCodexQuota(control, otherId).used).toBe(0);
  });

  it('берёт день из переданных часов, а не из системных', async () => {
    // Часы прокидываются от `buildServer` до диспетчера; сорванная передача
    // молча разводит резерв и чтение по разным московским суткам у полуночи, и
    // суточный предел перестаёт действовать именно там, где он нужнее всего.
    // Дата заведомо не сегодняшняя: на сегодняшней подменённые часы совпали бы
    // с системными и подмену было бы не отличить.
    const evening = new Date('2030-03-10T20:59:00.000Z');
    const { run } = recorder([batch(1), batch(1)]);
    const quoted = createQuotedRunner({ control, childId, run, now: () => evening });

    await quoted({ prompt: 'p', schemaPath: '/s.json', outPath: '/o.json' });

    // 20:59Z — это ещё 10 марта по Москве; 21:00Z было бы уже 11-м.
    expect(readCodexQuota(control, childId, evening).used).toBe(1);
    expect(
      readCodexQuota(control, childId, new Date('2030-03-10T21:00:00.000Z')).used,
    ).toBe(0);
  });

  it('отказывается резервировать внутри транзакции управляющей базы', async () => {
    // Резерв внутри чужой транзакции перестал бы быть своей короткой записью, а
    // вызов модели ушёл бы под запись на все свои минуты.
    const { requests, run } = recorder([batch(1)]);
    const quoted = createQuotedRunner({ control, childId, run });
    control.exec('BEGIN IMMEDIATE');

    try {
      await expect(
        quoted({ prompt: 'p', schemaPath: '/s.json', outPath: '/o.json' }),
      ).rejects.toThrow(/внутри транзакции/u);
    } finally {
      control.exec('ROLLBACK');
    }

    expect(requests).toEqual([]);
  });

  it('держит калибровочную константу спеки', () => {
    expect(CODEX_DAILY_QUOTA).toBe(60);
  });
});

describe('исчерпанная квота и работа по запросу ученика', () => {
  let tempDir: string;
  let control: Database;
  let db: Database;
  let childId: string;
  let graph: TopicGraph;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-quota-worker-'));
    control = openControlDatabase(join(tempDir, 'control.db'));
    const parentId = createParent(control, 'родитель@example.com');
    childId = createChild(control, parentId, 'Тимофей');
    markChildReady(control, childId);
    db = openDatabase(join(tempDir, 'child.db'));
    graph = buildTopicGraph([topic('math.fractions'), topic('math.percent')]);
    syncTopicState(db, graph);
  });

  afterEach(() => {
    db.close();
    control.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('останавливает фон, не потратив ни одного вызова модели', async () => {
    const { requests, run } = recorder([]);
    // Предел в один вызов и один уже потраченный: следующий фоновый вызов
    // упирается в квоту, ещё не дойдя до модели.
    const quoted = createQuotedRunner({ control, childId, run, limit: 1 });
    await quoted({ prompt: 'p', schemaPath: '/s.json', outPath: '/o.json' }).catch(() => undefined);
    requests.length = 0;

    const report = await runWarmupCycle({ db, graph, run: quoted, log: () => undefined });

    expect(report.codexUnavailable).toBe(true);
    expect(requests).toEqual([]);
  });

  it('списывает столько, сколько вызовов сделал цикл прогрева', async () => {
    // Ответ выбирается по схеме запроса, а не по порядку: темы греются
    // одновременно, и очередь вызовов у них перемешана.
    const requests: CodexRequest[] = [];
    const run = (request: CodexRequest): Promise<string> => {
      requests.push(request);
      return Promise.resolve(request.schemaPath.includes('verdicts') ? verdicts(5) : batch(5));
    };
    const quoted = createQuotedRunner({ control, childId, run });

    const report = await runWarmupCycle({
      db,
      graph,
      run: quoted,
      topics: 2,
      target: 5,
      threshold: 5,
      maxBatches: 1,
      log: () => undefined,
    });

    expect(report.codexUnavailable).toBe(false);
    // Тем в цикле меньше, чем вызовов: пополнение одной темы — генератор и
    // проверяющий, и счёт по темам дал бы вдвое меньше.
    expect(requests.length).toBe(report.refilled.length * 2);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(readCodexQuota(control, childId).used).toBe(requests.length);
  });

  it('пропускает спор ученика мимо квоты', async () => {
    const { requests, run } = recorder([DISPUTE_ANSWER]);
    // Разбор спора идёт по нажатию кнопки в занятии: остановить его квотой
    // значит молча сломать ученику урок, а не придержать фоновый расход. Фон
    // при этом уже в отказе — квота выбрана целиком.
    const background = recorder(['{}']);
    const quoted = createQuotedRunner({ control, childId, run: background.run, limit: 1 });
    await quoted({ prompt: 'p', schemaPath: '/s.json', outPath: '/o.json' });
    await expect(
      quoted({ prompt: 'p', schemaPath: '/s.json', outPath: '/o.json' }),
    ).rejects.toBeInstanceOf(CodexQuotaError);
    const before = readCodexQuota(control, childId, new Date(), 1);

    const review = await reviewDispute(
      {
        topic: topic(),
        question: 'Сколько монет останется?',
        expected: '45',
        accept: ['45'],
        given: '45 монет',
      },
      { run },
    );

    expect(review.studentCorrect).toBe(true);
    expect(requests).toHaveLength(1);
    expect(readCodexQuota(control, childId, new Date(), 1).used).toBe(before.used);
  });
});
