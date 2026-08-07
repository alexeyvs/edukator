import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { codexOutputSchema } from '../server/codex/client.js';
import { parseTaskBatch, TASKS_SCHEMA_PATH, type GeneratedTask } from '../server/codex/task-schema.js';

/** Задание по числовой теме: от него отталкиваются все проверки инвариантов. */
function task(patch: Partial<GeneratedTask> = {}): unknown {
  return {
    question: 'В инвентаре 90 монет, половину потратил. Сколько осталось?',
    answer: '45',
    accept: ['45', '45 монет'],
    hint: 'Половина от девяноста',
    explain: '90 : 2 = 45',
    joke: 'Кошелёк похудел вдвое — как и шансы на новый скин',
    difficulty: 2,
    ...patch,
  };
}

function batch(...items: unknown[]): unknown {
  return { items };
}

describe('схема батча', () => {
  it('переживает вырезание запрещённых структурированным выводом ключевых слов', () => {
    const source = JSON.parse(readFileSync(TASKS_SCHEMA_PATH, 'utf8')) as unknown;
    const stripped = codexOutputSchema(source) as {
      required: string[];
      $defs: { task: { required: string[] } };
    };

    for (const keyword of ['minItems', 'uniqueItems', 'minLength', 'minimum', 'maximum']) {
      expect(JSON.stringify(stripped)).not.toContain(`"${keyword}"`);
    }
    expect(stripped.required).toEqual(['items']);
    expect(stripped.$defs.task.required).toEqual([
      'question',
      'answer',
      'accept',
      'hint',
      'explain',
      'joke',
      'difficulty',
    ]);
  });
});

describe('parseTaskBatch: успешный разбор', () => {
  it('разбирает корректный батч', () => {
    const parsed = parseTaskBatch(batch(task(), task({ answer: '30', accept: ['30'] })), 'number');

    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({
      question: 'В инвентаре 90 монет, половину потратил. Сколько осталось?',
      answer: '45',
      accept: ['45', '45 монет'],
      hint: 'Половина от девяноста',
      explain: '90 : 2 = 45',
      joke: 'Кошелёк похудел вдвое — как и шансы на новый скин',
      difficulty: 2,
    });
    expect(parsed[1]?.answer).toBe('30');
  });

  it('считает вхождение answer в accept по нормализатору, а не по строке', () => {
    const parsed = parseTaskBatch(
      batch(
        task({
          question: 'Кто съел жука?',
          answer: 'Ёж',
          accept: ['еж'],
          hint: 'Колючий',
          explain: 'Ёж',
          difficulty: 1,
        }),
      ),
      'text',
    );

    expect(parsed[0]?.answer).toBe('Ёж');
  });

  it('пропускает нечисловой accept, когда формат темы не числовой', () => {
    const parsed = parseTaskBatch(
      batch(
        task({
          answer: 'сорок пять',
          accept: ['сорок пять', 'сорок пять монет'],
          explain: 'Половина от девяноста',
        }),
      ),
      'text',
    );

    expect(parsed[0]?.accept).toEqual(['сорок пять', 'сорок пять монет']);
  });
});

describe('parseTaskBatch: нарушения схемы', () => {
  it('отвергает корень, который не объект с items', () => {
    expect(() => parseTaskBatch([task()], 'number')).toThrow(/схеме/);
  });

  it('отвергает пустой батч', () => {
    expect(() => parseTaskBatch(batch(), 'number')).toThrow(/схеме.*items/s);
  });

  it('отвергает задание без обязательного поля', () => {
    const broken = task() as Record<string, unknown>;
    delete broken['joke'];

    expect(() => parseTaskBatch(batch(broken), 'number')).toThrow(/схеме.*joke/s);
  });

  it('отвергает лишнее поле: модель не должна дописывать свои', () => {
    expect(() => parseTaskBatch(batch(task({ ...{} }) as object), 'number')).not.toThrow();
    expect(() =>
      parseTaskBatch(batch({ ...(task() as object), topic_id: 'math.fractions' }), 'number'),
    ).toThrow(/схеме.*topic_id/s);
  });

  it('отвергает пустой accept', () => {
    expect(() => parseTaskBatch(batch(task({ accept: [] })), 'number')).toThrow(/схеме.*accept/s);
  });

  it('отвергает difficulty вне 1..3', () => {
    expect(() => parseTaskBatch(batch(task({ difficulty: 0 })), 'number')).toThrow(
      /схеме.*difficulty/s,
    );
    expect(() => parseTaskBatch(batch(task({ difficulty: 4 })), 'number')).toThrow(
      /схеме.*difficulty/s,
    );
  });
});

describe('parseTaskBatch: нарушения инвариантов', () => {
  it('отвергает задание, у которого answer не входит в accept', () => {
    expect(() => parseTaskBatch(batch(task({ accept: ['46'] })), 'number')).toThrow(
      /задание 1.*accept/s,
    );
  });

  it('отвергает дубли в accept с точностью до нормализатора', () => {
    expect(() => parseTaskBatch(batch(task({ accept: ['45', ' 45 '] })), 'number')).toThrow(
      /задание 1.*дубл/s,
    );
    expect(() =>
      parseTaskBatch(
        batch(task({ answer: 'Ёж', accept: ['Ёж', 'еж'], hint: 'Колючий', explain: 'Ёж' })),
        'text',
      ),
    ).toThrow(/задание 1.*дубл/s);
  });

  it('отвергает подсказку, в которой уже есть ответ', () => {
    expect(() =>
      parseTaskBatch(batch(task({ hint: 'Тут всё просто: останется 45 монет' })), 'number'),
    ).toThrow(/задание 1.*подсказк/s);
  });

  it('не считает ответ раскрытым, когда он лишь часть другого числа', () => {
    expect(() =>
      parseTaskBatch(batch(task({ hint: 'Начни с 450 монет и подумай' })), 'number'),
    ).not.toThrow();
  });

  it('отвергает нечисловой accept при answer_format: number', () => {
    expect(() =>
      parseTaskBatch(batch(task({ accept: ['45', 'сорок пять'] })), 'number'),
    ).toThrow(/задание 1.*сорок пять/s);
  });

  it('отвергает неоднозначный числовой accept: два числа в одной записи', () => {
    expect(() => parseTaskBatch(batch(task({ accept: ['45', '45 или 46'] })), 'number')).toThrow(
      /задание 1.*45 или 46/s,
    );
  });

  it('перечисляет все кривые задания сразу, а не первое попавшееся', () => {
    const message = (() => {
      try {
        parseTaskBatch(batch(task({ accept: ['46'] }), task(), task({ accept: ['47'] })), 'number');
        return '';
      } catch (error) {
        return (error as Error).message;
      }
    })();

    expect(message).toMatch(/задание 1/);
    expect(message).toMatch(/задание 3/);
    expect(message).not.toMatch(/задание 2/);
  });
});
