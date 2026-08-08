import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { codexOutputSchema } from '../server/codex/client.js';
import { checkAnswer } from '../server/normalize.js';
import {
  fitsAccept,
  MIN_REVEAL_LENGTH,
  parseTaskBatch,
  TASKS_SCHEMA_PATH,
  type GeneratedTask,
} from '../server/codex/task-schema.js';

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
    // Словесная запись: числовое расхождение ловится раньше и своей причиной,
    // а здесь проверяется именно отсутствие эталона среди записей.
    expect(() => parseTaskBatch(batch(task({ accept: ['сорок шесть'] })), 'number')).toThrow(
      /задание 1.*отсутствует в accept/s,
    );
    expect(() =>
      parseTaskBatch(batch(task({ answer: 'кот', accept: ['пёс'] })), 'text'),
    ).toThrow(/задание 1.*отсутствует в accept/s);
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

  // Ответ в один-два знака — буква фонетики или артикль, и он же предлог в
  // осмысленной подсказке. Раньше это роняло весь батч, то есть темы русского с
  // односимвольным ответом оставались без заданий вовсе.
  it('не проверяет на раскрытие ответы короче трёх знаков', () => {
    expect(MIN_REVEAL_LENGTH).toBe(3);

    expect(() =>
      parseTaskBatch(
        batch(
          task({ answer: 'о', accept: ['о'], hint: 'Подумай о проверочном слове', explain: 'о' }),
        ),
        'text',
      ),
    ).not.toThrow();
    expect(() =>
      parseTaskBatch(
        batch(
          task({
            answer: 'an',
            accept: ['an'],
            hint: 'Перед гласным звуком ставится an, а не a',
            explain: 'an',
          }),
        ),
        'text',
      ),
    ).not.toThrow();
  });

  it('проверяет на раскрытие ответы от трёх знаков', () => {
    expect(() =>
      parseTaskBatch(
        batch(
          task({
            answer: 'did',
            accept: ['did'],
            hint: 'Вспомогательный глагол прошедшего — did',
            explain: 'did',
          }),
        ),
        'text',
      ),
    ).toThrow(/задание 1.*подсказк/s);
  });

  // Послабление для коротких ответов — про служебные слова, а не про числа:
  // «45» в подсказке раскрывает ответ по-настоящему.
  it('проверяет на раскрытие короткий числовой ответ', () => {
    expect(() =>
      parseTaskBatch(batch(task({ answer: '45', hint: 'Останется 45 монет' })), 'number'),
    ).toThrow(/задание 1.*подсказк/s);
    expect(() =>
      parseTaskBatch(
        batch(task({ answer: '5', accept: ['5'], hint: 'Ответ 5', explain: '5' })),
        'number',
      ),
    ).toThrow(/задание 1.*подсказк/s);
  });

  // Запятая и точка под границу «не буква и не цифра» подходят, поэтому ответ
  // «45» совпадал бы с началом числа 45,5 — и ронял весь батч на подсказке, где
  // никакого раскрытия нет. То же с чертой обыкновенной дроби.
  it('не считает раскрытием ответ, склеенный в подсказке в другое число', () => {
    expect(() =>
      parseTaskBatch(
        batch(task({ answer: '45', hint: 'Цена выросла с 45,5 до 60 рублей' })),
        'number',
      ),
    ).not.toThrow();
    expect(() =>
      parseTaskBatch(batch(task({ answer: '45', hint: 'Начни с 1,45 метра' })), 'number'),
    ).not.toThrow();
    expect(() =>
      parseTaskBatch(batch(task({ answer: '45', hint: 'Приведи дробь к 45/2' })), 'number'),
    ).not.toThrow();
  });

  // Послабление ровно на цифру рядом с разделителем: точка в конце предложения
  // ответ по-прежнему раскрывает.
  it('видит раскрытие числового ответа в конце предложения', () => {
    expect(() =>
      parseTaskBatch(batch(task({ answer: '45', hint: 'Останется ровно 45.' })), 'number'),
    ).toThrow(/задание 1.*подсказк/s);
  });

  // Послабление про числа, а не про слова: у буквенного ответа соседняя запятая
  // — обычная пунктуация, и раскрытие через неё обязано ловиться.
  it('видит раскрытие словесного ответа перед запятой', () => {
    expect(() =>
      parseTaskBatch(
        batch(
          task({
            answer: 'did',
            accept: ['did'],
            hint: 'Вспомни про did, дальше сам',
            explain: 'did',
          }),
        ),
        'text',
      ),
    ).toThrow(/задание 1.*подсказк/s);
  });

  // Ответ уходит в регулярку, и метасимволы в нём экранируются. Без этого
  // «2.5» совпадало бы с «275» в подсказке (точка — любой знак), а «(3;4)»
  // роняло бы весь разбор `SyntaxError` из `new RegExp`.
  it('не считает раскрытием совпадение по метасимволам ответа', () => {
    expect(() =>
      parseTaskBatch(
        batch(task({ answer: '2.5', accept: ['2.5'], hint: 'Начни с 275 граммов', explain: '2.5' })),
        'number',
      ),
    ).not.toThrow();
  });

  it('разбирает метку варианта со скобкой, а не падает на построении регулярки', () => {
    // Метка «2)» — обычный ответ на теме с выбором, а незакрытая скобка в
    // регулярке — `SyntaxError` наружу из разбора, то есть весь батч в мусор.
    expect(() =>
      parseTaskBatch(
        batch(task({ answer: '2)', accept: ['2)'], hint: 'Сравни знаменатели', explain: 'второй' })),
        'choice',
      ),
    ).not.toThrow();
    // И настоящее раскрытие такой метки по-прежнему ловится.
    expect(() =>
      parseTaskBatch(
        batch(task({ answer: '2)', accept: ['2)'], hint: 'Верный — 2)', explain: 'второй' })),
        'choice',
      ),
    ).toThrow(/задание 1.*подсказк/s);
  });

  // Разбор спора дописывает подтверждённый ответ ученика в `accept[]` как есть,
  // а выгруженный посевной файл читается этим же разбором: запрет на словесную
  // запись ломал бы задание навсегда после первого же спора.
  it('пропускает словесную запись accept при answer_format: number', () => {
    expect(() =>
      parseTaskBatch(batch(task({ accept: ['45', 'сорок пять'] })), 'number'),
    ).not.toThrow();
  });

  it('отвергает нечисловой ответ при answer_format: number', () => {
    expect(() =>
      parseTaskBatch(batch(task({ answer: 'сорок пять', accept: ['сорок пять'] })), 'number'),
    ).toThrow(/задание 1.*сорок пять.*не читается как одно число/s);
  });

  // Эталон «40%» нормализатор читает как долю 0,4, и ученик, написавший
  // требуемое формой ответа «40», получил бы незачёт на верном ответе.
  it('отвергает эталон со знаком процента при answer_format: number', () => {
    expect(() =>
      parseTaskBatch(batch(task({ answer: '40%', accept: ['40%', '40'] })), 'number'),
    ).toThrow(/задание 1.*40%.*знаком процента/s);
  });

  // Дыра, которую запрет на `%` в самом `answer` не закрывает: «40%» просится в
  // `accept[]` как «равноправная запись» ответа «40», но нормализатор читает её
  // как долю 0,4 — и ответ, ошибочный ровно в сто раз, шёл бы в зачёт.
  it('отвергает знак процента в accept при answer_format: number', () => {
    expect(() =>
      parseTaskBatch(batch(task({ answer: '40', accept: ['40', '40%'] })), 'number'),
    ).toThrow(/задание 1.*40%.*знак процента/s);
  });

  it('ученику знак процента при этом не нужен: «40%» засчитывается по самому answer', () => {
    expect(checkAnswer('40%', { answer: '40', accept: ['40'] }, 'number').correct).toBe(true);
    expect(checkAnswer('0,4', { answer: '40', accept: ['40'] }, 'number').correct).toBe(false);
  });

  it('не пускает «40%» в accept и через разбор спора', () => {
    expect(fitsAccept('40%', 'number', '40')).toBe(false);
    expect(fitsAccept('40', 'number', '40')).toBe(true);
    // Текстовой темы запрет не касается: там процент — часть формулировки.
    expect(fitsAccept('40%', 'text', '40')).toBe(true);
  });

  it('не пускает в accept число, отличное от эталона: сверка засчитала бы неверный ответ', () => {
    expect(() => parseTaskBatch(batch(task({ answer: '45', accept: ['45', '46'] })), 'number')).toThrow(
      /задание 1.*«46» — другое число, чем ответ «45»/s,
    );
    // Та же запись не должна попадать в accept и через подтверждённый спор:
    // иначе задание принимало бы обе взаимоисключающие записи до первой выгрузки.
    expect(fitsAccept('46', 'number', '45')).toBe(false);
    // Другая запись того же числа и запись с единицами измерения — законны.
    expect(fitsAccept('45,0', 'number', '45')).toBe(true);
    expect(fitsAccept('45 монет', 'number', '45')).toBe(true);
    // Словесная форма в сравнение не идёт: чисел в ней нет.
    expect(fitsAccept('сорок пять', 'number', '45')).toBe(true);
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
