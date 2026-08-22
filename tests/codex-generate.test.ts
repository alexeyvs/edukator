import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Topic } from '../server/curriculum.js';
import {
  CODEX_FALLBACK_MODEL,
  CODEX_MODEL,
  CODEX_ROLE_ENV,
  CodexRunError,
  CodexUnavailableError,
  type CodexRequest,
} from '../server/codex/client.js';
import { readPersona, TASK_BATCH_SIZE } from '../server/codex/prompt.js';
import type { GeneratedTask } from '../server/codex/task-schema.js';
import { generateTaskBatch } from '../server/codex/generate.js';
import { TEST_DEEP_HINT } from './generated-task-fixture.js';

const PERSONA = 'Ты напарник, а не учитель.';

// Модель роли читается из окружения, поэтому умолчание проверяется только на
// пустой переменной: иначе `EDUKATOR_MODEL_GENERATE` в оболочке разработчика
// красил бы набор по причине, к коду отношения не имеющей.
beforeEach(() => {
  for (const name of Object.values(CODEX_ROLE_ENV)) vi.stubEnv(name, '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

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

function task(index: number, patch: Partial<GeneratedTask> = {}): GeneratedTask {
  return {
    instruction: `Задание №${index}: сколько монет останется?`,
    material: '',
    material_format: 'none',
    choices: [],
    word_tiles: [],
    answer: '45',
    accept: ['45', '45 монет'],
    hint: 'Приведи дроби к общему знаменателю. Затем вычти и проверь обратным действием.',
    deep_hint: TEST_DEEP_HINT,
    explain: 'Общий знаменатель 6, дальше обычное вычитание.',
    joke: 'Дроби целы, монеты тоже.',
    difficulty: 2,
    ...patch,
  };
}

/** Годный ответ модели: батч из `count` заданий по числовой теме. */
function batch(count = TASK_BATCH_SIZE, patch: Partial<GeneratedTask> = {}): string {
  return JSON.stringify({ items: Array.from({ length: count }, (_, i) => task(i, patch)) });
}

/**
 * Подставной исполнитель: отдаёт заготовленные ответы по порядку и запоминает
 * запросы. Настоящий codex в тестах не зовётся ни разу.
 */
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

describe('generateTaskBatch: успешная генерация', () => {
  it('возвращает разобранный батч с первой попытки', async () => {
    const { requests, run } = recorder([batch()]);

    const result = await generateTaskBatch({ topic: topic(), difficulty: 2, persona: PERSONA, run });

    expect(result.tasks).toHaveLength(TASK_BATCH_SIZE);
    expect(result.tasks[0]?.answer).toBe('45');
    expect(result.attempts).toBe(1);
    expect(result.failures).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it('просит батч одним вызовом и передаёт тему, сложность и рабочую модель', async () => {
    const { requests, run } = recorder([batch()]);

    await generateTaskBatch({
      topic: topic(),
      difficulty: 3,
      recent: ['Сколько будет 1/2 + 1/3?'],
      profile: { name: 'Тимофей', interests: ['Minecraft'], examDate: null, partnerName: 'Кекс' },
      timeoutMs: 1000,
      persona: PERSONA,
      run,
    });

    const request = requests[0];
    expect(request?.model).toBe(CODEX_MODEL);
    expect(request?.timeoutMs).toBe(1000);
    expect(request?.prompt).toContain('Minecraft');
    expect(request?.prompt).toContain('Спрашивай сложение дробей с разными знаменателями.');
    expect(request?.prompt).toContain('3 из 3');
    expect(request?.prompt).toContain(`ровно ${TASK_BATCH_SIZE}`);
    expect(request?.prompt).toContain('Сколько будет 1/2 + 1/3?');
    expect(request?.prompt).toContain(PERSONA);
  });

  it('берёт модель роли generate, а не роли соседнего вызова', async () => {
    // Иначе перепутанная роль здесь неотличима: без переменных все четыре роли
    // дают одну и ту же модель.
    vi.stubEnv(CODEX_ROLE_ENV.generate, 'модель-генератора');
    vi.stubEnv(CODEX_ROLE_ENV.validate, 'модель-проверяющего');
    const { requests, run } = recorder([batch()]);

    await generateTaskBatch({ topic: topic(), difficulty: 1, persona: PERSONA, run });

    expect(requests[0]?.model).toBe('модель-генератора');
  });

  it('уходит на запасную модель и на другой размер батча, когда их указали', async () => {
    const { requests, run } = recorder([batch(2)]);

    const result = await generateTaskBatch({
      topic: topic(),
      difficulty: 1,
      count: 2,
      model: CODEX_FALLBACK_MODEL,
      persona: PERSONA,
      run,
    });

    expect(result.tasks).toHaveLength(2);
    expect(requests[0]?.model).toBe(CODEX_FALLBACK_MODEL);
    expect(requests[0]?.prompt).toContain('ровно 2');
  });

  it('кладёт рядом схему для codex без запрещённых структурированным выводом слов', async () => {
    let schema = '';
    const result = await generateTaskBatch({
      topic: topic(),
      difficulty: 2,
      persona: PERSONA,
      run: (request) => {
        schema = readFileSync(request.schemaPath, 'utf8');
        expect(basename(request.schemaPath)).toBe('tasks.codex.json');
        expect(dirname(request.outPath)).toBe(dirname(request.schemaPath));
        return Promise.resolve(batch());
      },
    });

    expect(result.attempts).toBe(1);
    for (const keyword of ['uniqueItems', 'minItems', 'minLength', 'minimum', 'maximum']) {
      expect(schema).not.toContain(`"${keyword}"`);
    }
    expect(schema).toContain('"difficulty"');
  });

  it('берёт персону из content/persona.md, когда её не передали', async () => {
    const { requests, run } = recorder([batch()]);

    await generateTaskBatch({ topic: topic(), difficulty: 2, run });

    expect(requests[0]?.prompt).toContain(readPersona());
  });

  it('убирает рабочий каталог после работы', async () => {
    let workDir = '';
    await generateTaskBatch({
      topic: topic(),
      difficulty: 2,
      persona: PERSONA,
      run: (request) => {
        workDir = dirname(request.outPath);
        return Promise.resolve(batch());
      },
    });

    expect(workDir).not.toBe('');
    expect(existsSync(workDir)).toBe(false);
  });
});

describe('generateTaskBatch: повторные попытки', () => {
  it('повторяет вызов, когда ответ не разбирается как JSON', async () => {
    const { requests, run } = recorder(['Конечно! Вот задания:', batch()]);

    const result = await generateTaskBatch({ topic: topic(), difficulty: 2, persona: PERSONA, run });

    expect(result.attempts).toBe(2);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatch(/не разбирается как JSON/u);
    expect(requests).toHaveLength(2);
  });

  it('повторяет вызов, когда батч не прошёл инварианты разбора', async () => {
    const { run } = recorder([batch(1, { accept: ['сорок шесть'] }), batch()]);

    const result = await generateTaskBatch({ topic: topic(), difficulty: 2, persona: PERSONA, run });

    expect(result.attempts).toBe(2);
    expect(result.failures[0]).toMatch(/отсутствует в accept/u);
  });

  it('повторяет вызов, когда сам codex завершился с ошибкой', async () => {
    const { run } = recorder([new Error('codex завершился с кодом 3: лимит исчерпан'), batch()]);

    const result = await generateTaskBatch({ topic: topic(), difficulty: 2, persona: PERSONA, run });

    expect(result.attempts).toBe(2);
    expect(result.failures[0]).toMatch(/лимит исчерпан/u);
  });

  // Замечанием к ответу это не является: модель ничего не писала, а в тексте
  // диагностика CLI с локальными путями. Ещё и второй десятиминутный вызов ушёл
  // бы на «исправь ровно это».
  it('не отправляет модели текст сорванного запуска, но оставляет его в отчёте', async () => {
    const { requests, run } = recorder([
      new CodexRunError('codex завершился с кодом 3: /Users/kid/edukator сломан'),
      batch(),
    ]);

    const result = await generateTaskBatch({ topic: topic(), difficulty: 2, persona: PERSONA, run });

    expect(result.failures[0]).toMatch(/сломан/u);
    expect(requests[1]?.prompt).not.toContain('# Прошлая попытка');
    expect(requests[1]?.prompt).not.toContain('/Users/kid');
  });

  it('дописывает текст ошибки в промпт повторной попытки', async () => {
    const { requests, run } = recorder([
      batch(1, { hint: 'Ответ 45, осталось записать.' }),
      batch(),
    ]);

    await generateTaskBatch({ topic: topic(), difficulty: 2, persona: PERSONA, run });

    expect(requests[0]?.prompt).not.toContain('# Прошлая попытка');
    expect(requests[1]?.prompt).toContain('# Прошлая попытка');
    expect(requests[1]?.prompt).toContain('подсказка содержит ответ');
    // Замечание цитирует ответ модели, поэтому уходит блоком JSON, а не текстом:
    // иначе цитата смогла бы открыть собственный раздел промпта.
    expect(requests[1]?.prompt).toContain('"Батч заданий:');
    expect(requests[1]?.prompt.split('\n').filter((line) => line.startsWith('# '))).toEqual([
      '# Персона',
      '# Тема',
      '# Профиль ученика',
      '# Сложность',
      '# Последние формулировки',
      '# Что вернуть',
      '# Прошлая попытка',
    ]);
  });
});

describe('generateTaskBatch: ошибочные сценарии', () => {
  it('сдаётся после трёх попыток и показывает причину каждой', async () => {
    const bad = batch(1, { difficulty: 7 });
    const { requests, run } = recorder([bad, bad, bad]);

    await expect(
      generateTaskBatch({ topic: topic(), difficulty: 2, persona: PERSONA, run }),
    ).rejects.toThrow(/math\.fractions.*не сгенерированы за 3 попыт/su);
    expect(requests).toHaveLength(3);
  });

  it('уважает заданное число попыток', async () => {
    const { requests, run } = recorder(['не json']);

    await expect(
      generateTaskBatch({ topic: topic(), difficulty: 2, attempts: 1, persona: PERSONA, run }),
    ).rejects.toThrow(/не сгенерированы за 1 попыт/u);
    expect(requests).toHaveLength(1);
  });

  it('отвергает неположительное число попыток, не запуская codex', async () => {
    const { requests, run } = recorder([batch()]);

    await expect(
      generateTaskBatch({ topic: topic(), difficulty: 2, attempts: 0, persona: PERSONA, run }),
    ).rejects.toThrow(/положительным целым/u);
    expect(requests).toEqual([]);
  });

  it('пробрасывает недоступность codex наверх, не тратя попытки', async () => {
    const { requests, run } = recorder([
      new CodexUnavailableError('codex не найден'),
      batch(),
      batch(),
    ]);

    await expect(
      generateTaskBatch({ topic: topic(), difficulty: 2, persona: PERSONA, run }),
    ).rejects.toThrow(CodexUnavailableError);
    expect(requests).toHaveLength(1);
  });

  it('отвергает нечисловой accept на числовой теме и принимает его на текстовой', async () => {
    const wordy = batch(1, { answer: 'сорок пять', accept: ['сорок пять'] });

    await expect(
      generateTaskBatch({
        topic: topic(),
        difficulty: 2,
        attempts: 1,
        persona: PERSONA,
        run: recorder([wordy]).run,
      }),
    ).rejects.toThrow(/не читается как одно число/u);

    const textual = await generateTaskBatch({
      topic: topic({ answerFormat: 'text' }),
      difficulty: 2,
      persona: PERSONA,
      run: recorder([wordy]).run,
    });
    expect(textual.tasks).toHaveLength(1);
  });

});
