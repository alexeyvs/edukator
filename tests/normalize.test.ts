import { describe, expect, it } from 'vitest';
import {
  checkAnswer,
  findNumbers,
  normalizeChoice,
  normalizeText,
  type ExpectedAnswer,
} from '../server/normalize.js';

/** Эталон задания; тесты правят ровно то поле, которое проверяют. */
function expected(overrides: Partial<ExpectedAnswer> = {}): ExpectedAnswer {
  return { answer: '-45', ...overrides };
}

describe('нормализатор ответов', () => {
  describe('формат number', () => {
    it('признаёт равными записи −45, -45, «-45 монет», «− 45» и -45.0', () => {
      for (const given of ['−45', '-45', '-45 монет', '− 45', '-45.0', '  -45  ']) {
        const result = checkAnswer(given, expected(), 'number');
        expect(result, `ответ «${given}»`).toMatchObject({ correct: true });
        expect(result.normalized, `ответ «${given}»`).toBe('-45');
      }
    });

    it('принимает запятую как десятичный разделитель', () => {
      expect(checkAnswer('3,5', expected({ answer: '3.5' }), 'number').correct).toBe(true);
      expect(checkAnswer('3.5', expected({ answer: '3,5' }), 'number').correct).toBe(true);
      expect(checkAnswer('−0,25', expected({ answer: '-0.25' }), 'number').correct).toBe(true);
    });

    it('читает десятичную дробь без нуля: «,5» равно 0,5', () => {
      expect(findNumbers('.5')).toEqual([0.5]);
      expect(findNumbers(',5')).toEqual([0.5]);
      expect(findNumbers('-.5')).toEqual([-0.5]);
      expect(findNumbers('− ,25')).toEqual([-0.25]);
      expect(checkAnswer(',5', expected({ answer: '0.5' }), 'number')).toMatchObject({
        correct: true,
        normalized: '0.5',
      });
      // Без нуля впереди «.5» читалось как 5, и неверный ответ засчитывался верным.
      expect(checkAnswer('.5', expected({ answer: '5' }), 'number').correct).toBe(false);
      // Внутри фразы точка — конец предложения, а не запись числа.
      expect(findNumbers('Ответ.5')).toEqual([5]);
    });

    it('считает дробь a/b числом: «3/4» равно 0.75', () => {
      expect(checkAnswer('3/4', expected({ answer: '0.75' }), 'number').correct).toBe(true);
      expect(checkAnswer('0,75', expected({ answer: '3/4' }), 'number').correct).toBe(true);
      expect(checkAnswer('18/24', expected({ answer: '3/4' }), 'number').correct).toBe(true);
      expect(checkAnswer('-1/2', expected({ answer: '−0,5' }), 'number').correct).toBe(true);
    });

    it('читает смешанное число: «1 2/3» — одно число, а не два', () => {
      expect(findNumbers('1 2/3')).toEqual([1 + 2 / 3]);
      expect(checkAnswer('1 1/6', expected({ answer: '7/6' }), 'number').correct).toBe(true);
      expect(checkAnswer('2 1/2', expected({ answer: '2,5' }), 'number').correct).toBe(true);
      expect(checkAnswer('-3 3/4', expected({ answer: '−3,75' }), 'number').correct).toBe(true);
      expect(checkAnswer('1 1/6 часть', expected({ answer: '7/6' }), 'number').correct).toBe(true);
      // Смешанное число как эталон тоже читается однозначно.
      expect(checkAnswer('1,5', expected({ answer: '1 1/2' }), 'number').correct).toBe(true);
    });

    it('не принимает числитель смешанного числа за разряды: «1 200/3»', () => {
      // Пробел перед трёхзначной группой — разделитель разрядов только тогда,
      // когда за группой не идёт дробная черта. Иначе «1 200/3» схлопывалось в
      // «1200/3» = 400, то есть верный ответ молча превращался в другое число.
      expect(findNumbers('1 200/3')).toEqual([1 + 200 / 3]);
      expect(checkAnswer('1 200/3', expected({ answer: '400' }), 'number').correct).toBe(false);
      expect(checkAnswer('1 125/1000', expected({ answer: '1,125' }), 'number').correct).toBe(true);
    });

    it('не принимает пунктуационное тире за знак числа', () => {
      // «Ответ – 5» — тире между словом и числом, а не минус. Прочитав его как
      // знак, нормализатор засчитывал бы верный ответ неверным.
      expect(findNumbers('Ответ – 5')).toEqual([5]);
      expect(findNumbers('Ответ - 5')).toEqual([5]);
      expect(checkAnswer('Ответ – 5', expected({ answer: '5' }), 'number').correct).toBe(true);
      // Знак в начале ответа отделённым пробелом остаётся знаком.
      expect(findNumbers('− 45')).toEqual([-45]);
      expect(findNumbers('  − 45  ')).toEqual([-45]);
    });

    it('не считает пробел внутри числа вторым числом: «45 000» равно 45000', () => {
      expect(checkAnswer('45 000', expected({ answer: '45000' }), 'number').correct).toBe(true);
      expect(checkAnswer('1 000 000 рублей', expected({ answer: '1000000' }), 'number').correct)
        .toBe(true);
      expect(findNumbers('12 3')).toEqual([12, 3]);
    });

    it('сверяется со списком accept', () => {
      const task = expected({ answer: '0.5', accept: ['1/2', '50%'] });
      expect(checkAnswer('1/2', task, 'number').correct).toBe(true);
      expect(checkAnswer('50%', task, 'number').correct).toBe(true);
      expect(checkAnswer('0,5', task, 'number').correct).toBe(true);
      expect(checkAnswer('50', task, 'number').correct).toBe(false);
      expect(findNumbers('50%')).toEqual([0.5]);
      expect(checkAnswer('0.5', expected({ answer: '50%' }), 'number').correct).toBe(true);
    });

    it('отвергает другое число', () => {
      expect(checkAnswer('45', expected(), 'number')).toEqual({
        correct: false,
        normalized: '45',
        reason: 'mismatch',
      });
    });

    it('ошибочные сценарии: пустая строка, текст без числа, два числа в строке', () => {
      expect(checkAnswer('', expected(), 'number')).toEqual({
        correct: false,
        normalized: '',
        reason: 'empty',
      });
      expect(checkAnswer('   ', expected(), 'number').reason).toBe('empty');
      expect(checkAnswer('не знаю', expected(), 'number')).toEqual({
        correct: false,
        normalized: 'не знаю',
        reason: 'no-number',
      });
      expect(checkAnswer('45 или 46', expected(), 'number')).toEqual({
        correct: false,
        normalized: '45 или 46',
        reason: 'ambiguous-number',
      });
      // Ambiguity ловится даже когда одно из чисел — верное.
      expect(checkAnswer('-45 и -45', expected(), 'number').reason).toBe('ambiguous-number');
    });

    it('падает внятной ошибкой, если эталон задания не число', () => {
      expect(() => checkAnswer('45', expected({ answer: 'сорок пять' }), 'number')).toThrow(
        /эталонный ответ.*сорок пять.*не содержит одного числа/i,
      );
    });

    it('сверяет нечисловую запись из accept как текст, а не падает на ней', () => {
      // `accept[]` пополняется разбором спора на ходу, поэтому нечисловая запись
      // в нём — не дефект банка, а живой вариант. Падение на ней ломало бы
      // задание навсегда после первого же подтверждённого спора.
      const task = expected({ answer: '45', accept: ['сорок пять'] });
      expect(checkAnswer('45', task, 'number').correct).toBe(true);
      expect(checkAnswer('Сорок  пять', task, 'number')).toEqual({
        correct: true,
        normalized: 'сорок пять',
      });
      expect(checkAnswer('46', task, 'number')).toEqual({
        correct: false,
        normalized: '46',
        reason: 'mismatch',
      });
      // Двусмысленная запись в accept тоже не мешает сверке с самим answer.
      expect(
        checkAnswer('45', expected({ answer: '45', accept: ['примерно 45 или 46'] }), 'number')
          .correct,
      ).toBe(true);
    });

    it('на пустой ответ отдаёт empty, даже если эталон задания испорчен', () => {
      // Ученик ничего не ввёл — разбирать нечего, и дефект банка тут ни при чём.
      expect(checkAnswer('  ', expected({ answer: 'сорок пять' }), 'number')).toEqual({
        correct: false,
        normalized: '',
        reason: 'empty',
      });
    });
  });

  describe('формат text', () => {
    it('не различает регистр, лишние пробелы и ё/е', () => {
      const task = expected({ answer: 'Ёжик идёт домой' });
      for (const given of [
        'ёжик идёт домой',
        'ЕЖИК ИДЕТ ДОМОЙ',
        '  ежик   идет  домой ',
        'Ежик\tидет\nдомой',
      ]) {
        expect(checkAnswer(given, task, 'text').correct, `ответ «${given}»`).toBe(true);
      }
    });

    it('совпадает с любым элементом accept', () => {
      const task = expected({ answer: 'is going', accept: ['he is going', "he's going"] });
      expect(checkAnswer('  HE IS   going ', task, 'text').correct).toBe(true);
      expect(checkAnswer('he’s going', task, 'text').correct).toBe(true);
      expect(checkAnswer('is going', task, 'text').correct).toBe(true);
    });

    it('отвергает несовпадение и пустой ответ', () => {
      const task = expected({ answer: 'ежик' });
      expect(checkAnswer('заяц', task, 'text')).toEqual({
        correct: false,
        normalized: 'заяц',
        reason: 'mismatch',
      });
      expect(checkAnswer('   ', task, 'text')).toEqual({
        correct: false,
        normalized: '',
        reason: 'empty',
      });
    });

    it('normalizeText схлопывает пробелы, снимает регистр и ё', () => {
      expect(normalizeText('  Ёлка \n  ЗЕЛЁНАЯ  ')).toBe('елка зеленая');
      expect(normalizeText('don’t')).toBe("don't");
    });
  });

  describe('формат choice', () => {
    it('сравнивает напрямую после отсечения краевых пробелов', () => {
      const task = expected({ answer: 'Б', accept: ['b'] });
      expect(checkAnswer('  Б ', task, 'choice').correct).toBe(true);
      expect(checkAnswer('b', task, 'choice').correct).toBe(true);
      expect(checkAnswer('В', task, 'choice')).toEqual({
        correct: false,
        normalized: 'В',
        reason: 'mismatch',
      });
    });

    it('различает регистр: выбор приходит из интерфейса как есть', () => {
      expect(checkAnswer('б', expected({ answer: 'Б' }), 'choice').correct).toBe(false);
      expect(normalizeChoice('  Б ')).toBe('Б');
    });

    it('пустой выбор отвергается с причиной empty', () => {
      expect(checkAnswer(' ', expected({ answer: 'Б' }), 'choice').reason).toBe('empty');
    });
  });

  it('падает внятной ошибкой на неизвестном answer_format', () => {
    expect(() =>
      checkAnswer('45', expected(), 'formula' as unknown as 'number'),
    ).toThrow(/неизвестный формат ответа.*formula/i);
  });
});
