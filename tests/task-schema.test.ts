import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { codexOutputSchema } from '../server/codex/client.js';
import { checkAnswer } from '../server/normalize.js';
import {
  fitsAccept,
  deepHintWordCount,
  MIN_REVEAL_LENGTH,
  parseTaskBatch,
  taskPromptText,
  TASKS_SCHEMA_PATH,
  type GeneratedTask,
  type DeepHint,
} from '../server/codex/task-schema.js';
import { TEST_DEEP_HINT } from './generated-task-fixture.js';

/** Задание по числовой теме: от него отталкиваются все проверки инвариантов. */
function task(patch: Partial<GeneratedTask> = {}): unknown {
  return {
    instruction: 'Сколько осталось?',
    material: 'В инвентаре 90 монет, половину потратили.',
    material_format: 'text',
    choices: [],
    word_tiles: [],
    answer: '45',
    accept: ['45', '45 монет'],
    hint: 'Найди половину исходного количества. Проверь, что две равные части дают целое.',
    deep_hint: TEST_DEEP_HINT,
    explain: '90 : 2 = 45',
    joke: 'Кошелёк похудел вдвое — как и шансы на новый скин',
    difficulty: 2,
    ...patch,
  };
}

function batch(...items: unknown[]): unknown {
  return { items };
}

function deepHintAtWords(total: number): DeepHint {
  const result: DeepHint = {
    ...TEST_DEEP_HINT,
    explanation: '',
    examples: TEST_DEEP_HINT.examples.map((example) => ({ ...example })) as DeepHint['examples'],
    checklist: [...TEST_DEEP_HINT.checklist],
  };
  const remaining = total - deepHintWordCount(result);
  if (remaining < 1) throw new Error(`Нельзя собрать deep_hint из ${total} слов`);
  result.explanation = Array.from({ length: remaining }, () => 'пояснение').join(' ');
  expect(deepHintWordCount(result)).toBe(total);
  return result;
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
      'instruction',
      'material',
      'material_format',
      'choices',
      'word_tiles',
      'answer',
      'accept',
      'hint',
      'deep_hint',
      'explain',
      'joke',
      'difficulty',
    ]);
  });
});

describe('parseTaskBatch: успешный разбор', () => {
  it('собирает стабильное полное представление инструкции, материала и вариантов', () => {
    expect(taskPromptText({
      instruction: 'Выбери дробь', material: String.raw`\frac{1}{2}`,
      material_format: 'math', choices: ['1/2', '2'],
    })).toBe('Выбери дробь\n\n\\frac{1}{2}\n\nA. 1/2\nB. 2');
  });

  it('разбирает корректный батч', () => {
    const parsed = parseTaskBatch(batch(task(), task({ answer: '30', accept: ['30'] })), 'number');

    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({
      instruction: 'Сколько осталось?',
      material: 'В инвентаре 90 монет, половину потратили.',
      material_format: 'text',
      choices: [],
      word_tiles: [],
      answer: '45',
      accept: ['45', '45 монет'],
      hint: 'Найди половину исходного количества. Проверь, что две равные части дают целое.',
      deep_hint: TEST_DEEP_HINT,
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
          instruction: 'Кто съел жука?',
          answer: 'Ёж',
          accept: ['еж'],
          hint: 'Вспомни признаки животного. Сопоставь их с условием.',
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
  describe('карточки порядка слов', () => {
    it('принимает повторяющиеся слова, когда их мультимножество буквально собирает ответ', () => {
      const [parsed] = parseTaskBatch(batch(task({
        instruction: 'Собери английскую фразу.',
        answer: 'to be or not to be',
        accept: ['to be or not to be'],
        word_tiles: ['be', 'to', 'or', 'not', 'to', 'be'],
        hint: 'Найди устойчивое начало фразы. Затем проверь порядок служебных слов.',
        explain: 'Фраза собрана.',
      })), 'text');

      expect(parsed?.word_tiles).toEqual(['be', 'to', 'or', 'not', 'to', 'be']);
    });

    it('разрешает карточки только текстовой теме и без choices', () => {
      const wordOrder = {
        answer: 'Moscow is cold.', accept: ['Moscow is cold.'],
        word_tiles: ['cold.', 'Moscow', 'is'],
      };
      expect(() => parseTaskBatch(batch(task(wordOrder)), 'number')).toThrow(/только.*текстового/su);
      expect(() => parseTaskBatch(batch(task({ ...wordOrder, choices: ['yes', 'no'] })), 'text'))
        .toThrow(/word_tiles.*choices.*пустым/su);
    });

    it('отвергает слишком короткий набор, правильный начальный порядок и несовпадающее мультимножество', () => {
      expect(() => parseTaskBatch(batch(task({
        answer: 'Hello', accept: ['Hello'], word_tiles: ['Hello'],
      })), 'text')).toThrow(/от 2 до 12/su);
      expect(() => parseTaskBatch(batch(task({
        answer: 'Moscow is cold.', accept: ['Moscow is cold.'],
        word_tiles: ['Moscow', 'is', 'cold.'],
      })), 'text')).toThrow(/правильном порядке/su);
      expect(() => parseTaskBatch(batch(task({
        answer: 'Moscow is cold.', accept: ['Moscow is cold.'],
        word_tiles: ['Moscow', 'is', 'Cold.'],
      })), 'text')).toThrow(/мультимножество/su);
    });

    it('требует прикреплять пунктуацию к слову-карточке', () => {
      expect(() => parseTaskBatch(batch(task({
        answer: 'Hello , world', accept: ['Hello , world'],
        word_tiles: ['world', ',', 'Hello'],
      })), 'text')).toThrow(/пунктуация.*прикреплена/su);
    });
  });

  describe('расширенная подсказка', () => {
    it('принимает обе границы объёма 200–350 слов', () => {
      expect(() => parseTaskBatch(batch(task({ deep_hint: deepHintAtWords(200) })), 'number'))
        .not.toThrow();
      expect(() => parseTaskBatch(batch(task({ deep_hint: deepHintAtWords(350) })), 'number'))
        .not.toThrow();
    });

    it('отвергает 199 и 351 слово', () => {
      expect(() => parseTaskBatch(batch(task({ deep_hint: deepHintAtWords(199) })), 'number'))
        .toThrow(/200–350.*199/su);
      expect(() => parseTaskBatch(batch(task({ deep_hint: deepHintAtWords(351) })), 'number'))
        .toThrow(/200–350.*351/su);
    });

    it('требует все секции и ровно два разобранных примера', () => {
      const missing = task({ deep_hint: { ...TEST_DEEP_HINT } }) as Record<string, unknown>;
      delete (missing['deep_hint'] as Record<string, unknown>)['rule'];
      expect(() => parseTaskBatch(batch(missing), 'number')).toThrow(/схеме.*rule/su);
      expect(() => parseTaskBatch(batch(task({
        deep_hint: { ...TEST_DEEP_HINT, examples: [TEST_DEEP_HINT.examples[0]] } as never,
      })), 'number')).toThrow(/схеме.*examples/su);
    });

    // Второй уровень — это теория, а не вторая короткая подсказка. Тема-
    // классификация («каким членом предложения является слово?») выражается
    // ответом-термином, и запрет называть его закрывал бы генерацию наглухо:
    // правило обязано перечислить разряды вместе с нужным. Прод это и показал —
    // 199 из 236 отбраковок за трое суток пришлись на этот запрет, а суточная
    // квота ребёнка сгорала за час, ничего не положив в банк.
    it('разрешает теории второго уровня назвать термин, который и есть ответ', () => {
      expect(() => parseTaskBatch(batch(task({
        deep_hint: { ...TEST_DEEP_HINT, explanation: `${TEST_DEEP_HINT.explanation} Разряд 45 тоже разбирают отдельно.` },
      })), 'number')).not.toThrow();
      expect(() => parseTaskBatch(batch(task({
        deep_hint: { ...TEST_DEEP_HINT, rule: 'Правило разбирает случаи 45 и соседние с ним.' },
      })), 'number')).not.toThrow();
    });

    // Разбор на другом материале, пришедший к тому же термину, ответа текущего
    // задания не выдаёт: ученик всё равно обязан применить правило к своему
    // условию. А при закрытом наборе разрядов совпадение неизбежно.
    it('разрешает разобранному примеру прийти к тому же ответу на другом материале', () => {
      expect(() => parseTaskBatch(batch(task({
        deep_hint: {
          ...TEST_DEEP_HINT,
          examples: [
            { ...TEST_DEEP_HINT.examples[0], answer: '45', walkthrough: 'Разбор приводит к 45 на других данных.' },
            TEST_DEEP_HINT.examples[1],
          ] as DeepHint['examples'],
        },
      })), 'number')).not.toThrow();
    });

    // Единственная секция второго уровня, которая говорит о **текущем** задании
    // во втором лице: «убедись, что у тебя получилось 45» — это и есть ответ,
    // выданный прямо. Механическая проверка остаётся ровно здесь.
    it('не позволяет чек-листу назвать ответ текущего задания', () => {
      expect(() => parseTaskBatch(batch(task({
        deep_hint: { ...TEST_DEEP_HINT, checklist: [...TEST_DEEP_HINT.checklist, 'Убедись, что вышло 45.'] },
      })), 'number')).toThrow(/чек-лист расширенной подсказки содержит ответ/su);
    });

    it('не позволяет примеру повторять текущее задание', () => {
      expect(() => parseTaskBatch(batch(task({
        deep_hint: {
          ...TEST_DEEP_HINT,
          examples: [
            { ...TEST_DEEP_HINT.examples[0], prompt: 'Сколько осталось?' },
            TEST_DEEP_HINT.examples[1],
          ] as DeepHint['examples'],
        },
      })), 'number')).toThrow(/повторяет текущее задание/su);
    });
  });

  it('проверяет согласованность формата и материала', () => {
    expect(() => parseTaskBatch(batch(task({ material: 'лишнее', material_format: 'none' })), 'number'))
      .toThrow(/material_format=none/s);
    expect(() => parseTaskBatch(batch(task({ material: '', material_format: 'text' })), 'number'))
      .toThrow(/material_format=text/s);
    expect(() => parseTaskBatch(batch(task({ material: '$x+1$', material_format: 'math' })), 'number'))
      .toThrow(/LaTeX.*без разделителей/s);
  });

  // Формулу посреди фразы display-материал не выражает: он занимает материал
  // целиком. Инлайн-разделители рендерит SafeRichText, поэтому они разрешены
  // везде, где текст доезжает до экрана через неё.
  it('пропускает инлайн-формулу в прозе', () => {
    expect(() =>
      parseTaskBatch(
        batch(task({
          material: String.raw`Использовали \(\frac{13}{40}\) деталей.`,
          instruction: String.raw`Найди \(x\)`,
          explain: String.raw`Получается \(\frac{13}{40}=0{,}325\).`,
        })),
        'number',
      ),
    ).not.toThrow();
  });

  // Всё, что мимо разделителей, экран показывает исходником: «\frac{13}{40}»
  // вместо дроби. Пара `$…$` и `\[…\]` в прозе не рендерится вовсе.
  it('не пускает LaTeX мимо инлайн-разделителей', () => {
    expect(() =>
      parseTaskBatch(batch(task({ material: String.raw`Получилось \frac{13}{40} деталей.` })), 'number'),
    ).toThrow(/LaTeX.*\\\(…\\\)/su);

    expect(() => parseTaskBatch(batch(task({ instruction: 'Найди $x$.' })), 'number'))
      .toThrow(/LaTeX/su);

    expect(() => parseTaskBatch(batch(task({ explain: String.raw`Ответ \[x=4\].` })), 'number'))
      .toThrow(/LaTeX/su);

    // Незакрытый разделитель не должен считаться инлайном: до экрана он доедет
    // исходником ровно так же.
    expect(() => parseTaskBatch(batch(task({ material: String.raw`Осталось \(\frac12 деталей.` })), 'number'))
      .toThrow(/LaTeX/su);

    // Обычная косая черта — не разметка, и запрещать её нечего.
    expect(() => parseTaskBatch(batch(task({ material: 'Использовали 13/40 деталей.' })), 'number'))
      .not.toThrow();

    // Одиночный доллар — цена, а не формула: из-за него терялся бы весь батч.
    expect(() => parseTaskBatch(batch(task({ material: 'Скин стоит $5 в магазине.' })), 'number'))
      .not.toThrow();
  });

  it('требует варианты только для choice и буквальное совпадение answer', () => {
    expect(() => parseTaskBatch(batch(task({ choices: ['4', '5'] })), 'number')).toThrow(/пустым массивом/s);
    expect(() => parseTaskBatch(batch(task({ answer: '4', accept: ['4'], choices: ['четыре', '5'] })), 'choice'))
      .toThrow(/буквально совпадать/s);
    expect(() => parseTaskBatch(batch(task({ answer: '4', accept: ['4'], choices: ['4', ' 4 '] })), 'choice'))
      .toThrow(/уникальными после нормализации/s);
  });

  it('не позволяет accept[] засчитать неправильную choice-карточку', () => {
    expect(() =>
      parseTaskBatch(
        batch(task({ answer: '4', accept: ['4', '5'], choices: ['4', '5'] })),
        'choice',
      ),
    ).toThrow(/для choice.*accept «5».*совпадать с ответом «4»/s);
  });

  it('требует содержательную подсказку из 2–4 предложений', () => {
    expect(() => parseTaskBatch(batch(task({ hint: 'Только одно предложение.' })), 'number'))
      .toThrow(/2–4 предложений/s);
    expect(() => parseTaskBatch(batch(task({ hint: 'Раз. Два. Три. Четыре. Пять.' })), 'number'))
      .toThrow(/2–4 предложений/s);
  });

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

  // `minLength` схемы считает знаки, а не смысл, и пробел проходит. Дальше по
  // пути такое задание никто не смотрит — до выгрузки посева, где оно роняет
  // предмет целиком, и снимок перестаёт обновляться навсегда.
  it('отвергает пробельные hint, explain и joke', () => {
    expect(() => parseTaskBatch(batch(task({ hint: '   ' })), 'number')).toThrow(
      /задание 1.*поле hint состоит из одних пробелов/s,
    );
    expect(() => parseTaskBatch(batch(task({ explain: '\n\t' })), 'number')).toThrow(
      /задание 1.*поле explain состоит из одних пробелов/s,
    );
    expect(() => parseTaskBatch(batch(task({ joke: ' ' })), 'number')).toThrow(
      /задание 1.*поле joke состоит из одних пробелов/s,
    );
  });

  it('отвергает подсказку, в которой уже есть ответ', () => {
    expect(() =>
      parseTaskBatch(batch(task({ hint: 'Тут всё просто: останется 45 монет' })), 'number'),
    ).toThrow(/задание 1.*подсказк/s);
  });

  it('не считает ответ раскрытым, когда он лишь часть другого числа', () => {
    expect(() =>
      parseTaskBatch(batch(task({ hint: 'Начни с 450 монет и подумай. Проверь вычисление.' })), 'number'),
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
          task({ answer: 'о', accept: ['о'], hint: 'Подумай о проверочном слове. Проверь ударение.', explain: 'о' }),
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
            hint: 'Перед гласным звуком ставится an, а не a. Проверь первый звук.',
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
            hint: 'Вспомогательный глагол прошедшего — did. Проверь время предложения.',
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
        batch(task({ answer: '45', hint: 'Цена выросла с 45,5 до 60 рублей. Сравни величины.' })),
        'number',
      ),
    ).not.toThrow();
    expect(() =>
      parseTaskBatch(batch(task({ answer: '45', hint: 'Начни с 1,45 метра. Проверь единицы.' })), 'number'),
    ).not.toThrow();
    expect(() =>
      parseTaskBatch(batch(task({ answer: '45', hint: 'Приведи дробь к 45/2. Проверь знаменатель.' })), 'number'),
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
            hint: 'Вспомни про did, дальше сам. Проверь время.',
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
        batch(task({ answer: '2.5', accept: ['2.5'], hint: 'Начни с 275 граммов. Проверь единицы.', explain: '2.5' })),
        'number',
      ),
    ).not.toThrow();
  });

  it('разбирает метку варианта со скобкой, а не падает на построении регулярки', () => {
    // Метка «2)» — обычный ответ на теме с выбором, а незакрытая скобка в
    // регулярке — `SyntaxError` наружу из разбора, то есть весь батч в мусор.
    expect(() =>
      parseTaskBatch(
        batch(task({ answer: '2)', accept: ['2)'], choices: ['1)', '2)'], hint: 'Сравни знаменатели. Проверь каждый вариант.', explain: 'второй' })),
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

  it('для choice разрешает спору сохранить только буквальный answer', () => {
    expect(fitsAccept('четыре', 'choice', 'четыре')).toBe(true);
    expect(fitsAccept('пять', 'choice', 'четыре')).toBe(false);
    expect(fitsAccept(' четыре ', 'choice', 'четыре')).toBe(false);
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
