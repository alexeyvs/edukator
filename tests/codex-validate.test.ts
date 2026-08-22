import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Topic } from '../server/curriculum.js';
import {
  CODEX_FALLBACK_MODEL,
  CODEX_MODEL,
  CODEX_ROLE_ENV,
  CodexUnavailableError,
  type CodexRequest,
} from '../server/codex/client.js';
import type { GeneratedTask } from '../server/codex/task-schema.js';
import {
  MAX_NOTE_LENGTH,
  parseVerdictBatch,
  validateTaskBatch,
  type Verdict,
} from '../server/codex/validate.js';
import { TEST_DEEP_HINT } from './generated-task-fixture.js';

function topic(patch: Partial<Topic> = {}): Topic {
  return {
    id: 'math.fractions',
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

function task(patch: Partial<GeneratedTask> = {}): GeneratedTask {
  return {
    instruction: 'Реши задачу.', material: 'В инвентаре 90 монет, половину потратил. Сколько осталось?', material_format: 'text', choices: [],
    word_tiles: [],
    answer: '45',
    accept: ['45', '45 монет'],
    hint: 'Половина от девяноста',
    deep_hint: TEST_DEEP_HINT,
    explain: '90 : 2 = 45',
    joke: 'Кошелёк похудел вдвое — как и шансы на новый скин',
    difficulty: 2,
    ...patch,
  };
}

/** Вердикт «всё в порядке»: от него отталкиваются проверки отбраковки. */
function verdict(patch: Partial<Verdict> = {}): unknown {
  const full: Verdict = {
    answer: '45',
    unambiguous: true,
    natural: true,
    onTopic: true,
    ageAppropriate: true,
    hintSafe: true,
    hintUseful: true,
    deepHintSafe: true,
    deepHintUseful: true,
    wordOrderValid: true,
    note: '',
    ...patch,
  };

  return {
    answer: full.answer,
    unambiguous: full.unambiguous,
    natural: full.natural,
    on_topic: full.onTopic,
    age_appropriate: full.ageAppropriate,
    hint_safe: full.hintSafe,
    hint_useful: full.hintUseful,
    deep_hint_safe: full.deepHintSafe,
    deep_hint_useful: full.deepHintUseful,
    word_order_valid: full.wordOrderValid,
    note: full.note,
  };
}

function verdicts(...items: unknown[]): string {
  return JSON.stringify({ items });
}

/** Подставной исполнитель: настоящий codex в тестах не зовётся ни разу. */
function recorder(answer: string | Error): {
  requests: CodexRequest[];
  run: (request: CodexRequest) => Promise<string>;
} {
  const requests: CodexRequest[] = [];
  return {
    requests,
    run: (request: CodexRequest): Promise<string> => {
      requests.push(request);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
}

// Модель роли читается из окружения, поэтому умолчание проверяется только на
// пустой переменной: иначе `EDUKATOR_MODEL_VALIDATE` в оболочке разработчика
// красил бы набор по причине, к коду отношения не имеющей.
beforeEach(() => {
  for (const name of Object.values(CODEX_ROLE_ENV)) vi.stubEnv(name, '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('validateTaskBatch: совпадающие ответы', () => {
  it('берёт модель роли validate, а не роли генератора', async () => {
    // Разведение ролей и заведено ради этого: слабый проверяющий бракует
    // верные задания, считая расхождение ответов ошибкой генератора.
    vi.stubEnv(CODEX_ROLE_ENV.validate, 'модель-проверяющего');
    vi.stubEnv(CODEX_ROLE_ENV.generate, 'модель-генератора');
    const { requests, run } = recorder(verdicts(verdict()));

    await validateTaskBatch({ topic: topic(), tasks: [task()], run });

    expect(requests[0]?.model).toBe('модель-проверяющего');
  });

  it('пропускает задание, на которое проверяющий ответил так же', async () => {
    const { requests, run } = recorder(verdicts(verdict(), verdict({ answer: '30' })));

    const result = await validateTaskBatch({
      topic: topic(),
      tasks: [task(), task({ answer: '30', accept: ['30'] })],
      run,
    });

    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.model).toBe(CODEX_MODEL);
  });

  it('отдаёт проверяющему условие и подсказку, но не ответ и разбор', async () => {
    const { requests, run } = recorder(verdicts(verdict()));

    await validateTaskBatch({ topic: topic(), tasks: [task()], run });

    const prompt = requests[0]?.prompt ?? '';
    expect(prompt).toContain('В инвентаре 90 монет');
    expect(prompt).toContain('Половина от девяноста');
    expect(prompt).toContain('hint_safe');
    expect(prompt).toContain(TEST_DEEP_HINT.rule);
    expect(prompt).toContain('deep_hint_safe');
    expect(prompt).toContain('deep_hint_useful');
    expect(prompt).toContain('word_order_valid');
    expect(prompt).not.toContain('90 : 2 = 45');
    expect(prompt).not.toContain('новый скин');
    // «45» встречается в условии как часть числа 90 не может, поэтому проверка
    // на отсутствие эталона осмысленна.
    expect(prompt).not.toContain('45');
  });

  it('уходит на запасную модель и учитывает срок, когда их указали', async () => {
    const { requests, run } = recorder(verdicts(verdict()));

    await validateTaskBatch({
      topic: topic(),
      tasks: [task()],
      model: CODEX_FALLBACK_MODEL,
      timeoutMs: 1000,
      run,
    });

    expect(requests[0]?.model).toBe(CODEX_FALLBACK_MODEL);
    expect(requests[0]?.timeoutMs).toBe(1000);
  });

  it('кладёт рядом схему вердиктов без запрещённых структурированным выводом слов', async () => {
    let schema = '';
    await validateTaskBatch({
      topic: topic(),
      tasks: [task()],
      run: (request) => {
        schema = readFileSync(request.schemaPath, 'utf8');
        expect(basename(request.schemaPath)).toBe('verdicts.codex.json');
        expect(dirname(request.outPath)).toBe(dirname(request.schemaPath));
        return Promise.resolve(verdicts(verdict()));
      },
    });

    for (const keyword of ['minItems', 'minLength']) {
      expect(schema).not.toContain(`"${keyword}"`);
    }
    expect(schema).toContain('"age_appropriate"');
  });

  it('убирает рабочий каталог после работы', async () => {
    let workDir = '';
    await validateTaskBatch({
      topic: topic(),
      tasks: [task()],
      run: (request) => {
        workDir = dirname(request.outPath);
        return Promise.resolve(verdicts(verdict()));
      },
    });

    expect(workDir).not.toBe('');
    expect(existsSync(workDir)).toBe(false);
  });

  it('не зовёт codex на пустом батче', async () => {
    const { requests, run } = recorder(verdicts(verdict()));

    const result = await validateTaskBatch({ topic: topic(), tasks: [], run });

    expect(result).toEqual({ accepted: [], rejected: [] });
    expect(requests).toEqual([]);
  });
});

describe('validateTaskBatch: сверка идёт нормализатором', () => {
  it('признаёт совпадением «−45» и «-45 монет»', async () => {
    const { run } = recorder(verdicts(verdict({ answer: '-45 монет' })));

    const result = await validateTaskBatch({
      topic: topic(),
      tasks: [task({ answer: '−45', accept: ['−45'] })],
      run,
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toEqual([]);
  });

  it('засчитывает ответ, совпавший не с answer, а с записью accept', async () => {
    const { run } = recorder(verdicts(verdict({ answer: '45 монет' })));

    const result = await validateTaskBatch({ topic: topic(), tasks: [task()], run });

    expect(result.accepted).toHaveLength(1);
  });

  it('сверяет текстовую тему по правилам её формата: «Ёж» и «еж» — один ответ', async () => {
    const { run } = recorder(verdicts(verdict({ answer: 'еж' })));

    const result = await validateTaskBatch({
      topic: topic({ answerFormat: 'text' }),
      tasks: [task({ instruction: 'Кто съел жука?', answer: 'Ёж', accept: ['Ёж'] })],
      run,
    });

    expect(result.accepted).toHaveLength(1);
  });

  it('отбраковывает задание, эталон которого не сверяется нормализатором', async () => {
    const { run } = recorder(verdicts(verdict()));

    const result = await validateTaskBatch({
      topic: topic(),
      tasks: [task({ answer: 'сорок пять', accept: ['сорок пять'] })],
      run,
    });

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]?.reason).toMatch(/эталон.*не сверяется/su);
  });
});

  describe('validateTaskBatch: отбраковка', () => {
    it('отбраковывает весь небезопасный по смыслу элемент батча', async () => {
      const { run } = recorder(verdicts(verdict({ hintSafe: false, note: 'названа позиция варианта' })));
      const result = await validateTaskBatch({ topic: topic(), tasks: [task()], run });
      expect(result.accepted).toEqual([]);
      expect(result.rejected[0]?.reason).toMatch(/подсказка раскрывает.*позиция варианта/s);
    });

  it('отбраковывает задание при расхождении ответов и называет оба', async () => {
    const { run } = recorder(verdicts(verdict({ answer: '46' }), verdict()));

    const result = await validateTaskBatch({
      topic: topic(),
      tasks: [task({ instruction: 'Первое' }), task({ instruction: 'Второе' })],
      run,
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]?.instruction).toBe('Второе');
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.task.instruction).toBe('Первое');
    expect(result.rejected[0]?.reason).toContain('«46»');
    expect(result.rejected[0]?.reason).toContain('«45»');
  });

  it('отбраковывает задание при провале любой оценки обоих уровней и карточек', async () => {
    const checks = [
      { patch: { unambiguous: false }, reason: /неоднозначно/u },
      { patch: { natural: false }, reason: /натянут/u },
      { patch: { onTopic: false }, reason: /не о заявленной теме/u },
      { patch: { ageAppropriate: false }, reason: /не соответствует уровню курса/u },
      { patch: { hintSafe: false }, reason: /подсказка раскрывает/u },
      { patch: { hintUseful: false }, reason: /не даёт полезного направления/u },
      { patch: { deepHintSafe: false }, reason: /расширенная подсказка раскрывает/u },
      { patch: { deepHintUseful: false }, reason: /не даёт полезной теории/u },
      { patch: { wordOrderValid: false }, reason: /карточки нельзя однозначно собрать/u },
    ];

    for (const { patch, reason } of checks) {
      const { run } = recorder(verdicts(verdict(patch)));

      const result = await validateTaskBatch({ topic: topic(), tasks: [task()], run });

      expect(result.accepted).toEqual([]);
      expect(result.rejected[0]?.reason).toMatch(reason);
    }
  });

  it('перечисляет в причине все проваленные проверки сразу', async () => {
    const { run } = recorder(
      verdicts(verdict({ answer: '46', natural: false, onTopic: false, note: 'бред какой-то' })),
    );

    const result = await validateTaskBatch({ topic: topic(), tasks: [task()], run });

    const reason = result.rejected[0]?.reason ?? '';
    expect(reason).toContain('«46»');
    expect(reason).toMatch(/натянут/u);
    expect(reason).toMatch(/не о заявленной теме/u);
    expect(reason).toContain('бред какой-то');
  });

  // Тест обрезки строит и вход, и ожидание из самой константы, так что её
  // подмену не ловит: предел уходит в промпт следующей попытки, поэтому число
  // прибито буквально.
  it('держит предел замечания', () => {
    expect(MAX_NOTE_LENGTH).toBe(300);
  });

  it('обрезает замечание проверяющего и не пишет его, когда оно пустое', async () => {
    const long = recorder(
      verdicts(verdict({ answer: '46', note: 'ы'.repeat(MAX_NOTE_LENGTH + 50) })),
    );
    const silent = recorder(verdicts(verdict({ answer: '46', note: '   ' })));

    const verbose = await validateTaskBatch({ topic: topic(), tasks: [task()], run: long.run });
    const terse = await validateTaskBatch({ topic: topic(), tasks: [task()], run: silent.run });

    expect(verbose.rejected[0]?.reason).not.toContain('ы'.repeat(MAX_NOTE_LENGTH + 1));
    expect(verbose.rejected[0]?.reason).toContain('ы'.repeat(MAX_NOTE_LENGTH));
    expect(terse.rejected[0]?.reason).not.toContain('проверяющий:');
  });
});

describe('validateTaskBatch: ошибочные сценарии', () => {
  it('отвергает батч, когда вердиктов пришло меньше, чем заданий', async () => {
    const { run } = recorder(verdicts(verdict()));

    await expect(
      validateTaskBatch({ topic: topic(), tasks: [task(), task({ instruction: 'Второе' })], run }),
    ).rejects.toThrow(/1 вердикт.*на 2 задани/su);
  });

  it('отвергает батч, когда вердиктов пришло больше, чем заданий', async () => {
    const { run } = recorder(verdicts(verdict(), verdict()));

    await expect(validateTaskBatch({ topic: topic(), tasks: [task()], run })).rejects.toThrow(
      /2 вердикт.*на 1 задани/su,
    );
  });

  it('отвергает ответ, который не разбирается как JSON', async () => {
    const { run } = recorder('Конечно! Задания я проверил, всё отлично.');

    await expect(validateTaskBatch({ topic: topic(), tasks: [task()], run })).rejects.toThrow(
      /не разбирается как JSON/u,
    );
  });

  it('отвергает вердикт, не соответствующий схеме', async () => {
    const broken = verdict() as Record<string, unknown>;
    delete broken['on_topic'];
    const { run } = recorder(verdicts(broken));

    await expect(validateTaskBatch({ topic: topic(), tasks: [task()], run })).rejects.toThrow(
      /схеме.*on_topic/su,
    );
  });

  it('пробрасывает недоступность codex наверх', async () => {
    const { run } = recorder(new CodexUnavailableError('codex не найден'));

    await expect(validateTaskBatch({ topic: topic(), tasks: [task()], run })).rejects.toThrow(
      CodexUnavailableError,
    );
  });

  it('убирает рабочий каталог и когда проверка провалилась', async () => {
    let workDir = '';

    await expect(
      validateTaskBatch({
        topic: topic(),
        tasks: [task()],
        run: (request) => {
          workDir = dirname(request.outPath);
          return Promise.reject(new CodexUnavailableError('codex не найден'));
        },
      }),
    ).rejects.toThrow(CodexUnavailableError);
    expect(existsSync(workDir)).toBe(false);
  });
});

describe('parseVerdictBatch', () => {
  it('переводит вердикты в camelCase', () => {
    const parsed = parseVerdictBatch(
      JSON.parse(verdicts(verdict({ onTopic: false, note: 'это про проценты' }))),
      1,
    );

    expect(parsed[0]).toEqual({
      answer: '45',
      unambiguous: true,
      natural: true,
      onTopic: false,
      ageAppropriate: true,
      hintSafe: true,
      hintUseful: true,
      deepHintSafe: true,
      deepHintUseful: true,
      wordOrderValid: true,
      note: 'это про проценты',
    });
  });

  it('отвергает пустой список вердиктов и лишние поля', () => {
    expect(() => parseVerdictBatch({ items: [] }, 0)).toThrow(/схеме.*items/su);
    expect(() =>
      parseVerdictBatch({ items: [{ ...(verdict() as object), task_id: 7 }] }, 1),
    ).toThrow(/схеме.*task_id/su);
  });

  it('отвергает вердикт с оценкой не булевого типа', () => {
    expect(() => parseVerdictBatch({ items: [verdict({ natural: 'да' as never })] }, 1)).toThrow(
      /схеме.*natural/su,
    );
  });
});
