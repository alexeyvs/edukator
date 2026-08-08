import { describe, expect, it } from 'vitest';
import {
  checkAnswer,
  findNumbers,
  normalizeChoice,
  normalizeText,
  questionFingerprint,
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

    it('делит на сто и смешанное число со знаком процента', () => {
      // Ветвь смешанного числа возвращалась раньше деления на сто, и «12 1/2%»
      // читалось как 12,5 вместо 0,125: верный ответ на теме про проценты
      // засчитывался неверным, а «12 1/2%» рядом с эталоном 12,5 — верным.
      expect(findNumbers('12 1/2%')).toEqual([0.125]);
      expect(findNumbers('1 1/2%')).toEqual([0.015]);
      expect(checkAnswer('12 1/2%', expected({ answer: '0,125' }), 'number').correct).toBe(true);
      // Оба прочтения записи со знаком процента доступны и здесь.
      expect(checkAnswer('12 1/2%', expected({ answer: '12,5' }), 'number').correct).toBe(true);
      expect(checkAnswer('12 1/2%', expected({ answer: '12' }), 'number').correct).toBe(false);
    });

    it('читает длинное тире как знак минуса', () => {
      // Автозамена macOS и iOS ставит именно его. Без этого «—45» читалось как
      // 45: верный отрицательный ответ шёл в незачёт, а неверный положительный
      // засчитывался.
      expect(findNumbers('—45')).toEqual([-45]);
      expect(checkAnswer('—45', expected(), 'number')).toMatchObject({ correct: true });
      expect(checkAnswer('—45', expected({ answer: '45' }), 'number').correct).toBe(false);
      // Пунктуационное длинное тире внутри фразы знаком не становится.
      expect(findNumbers('Ответ — 5')).toEqual([5]);
    });

    it('сверяет числа с допуском плавающей точки, а не побитово', () => {
      // Буквальное равенство ломалось бы на разной записи одного числа: 0.1+0.2
      // не равно 0.3, и «0,3» на эталон «0,1+0,2» уходило бы в mismatch.
      expect(checkAnswer('0,3', expected({ answer: String(0.1 + 0.2) }), 'number').correct)
        .toBe(true);
      expect(checkAnswer('4,35', expected({ answer: String(4.35 + 1e-15) }), 'number').correct)
        .toBe(true);
      // Допуск относительный и узкий: соседнее число им не покрывается.
      expect(checkAnswer('0,3000001', expected({ answer: '0,3' }), 'number').correct).toBe(false);
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

    it('читает ответ со знаком процента двояко: «45%» подходит и к 0.45, и к 45', () => {
      // Эталон темы про проценты — само число («Сколько процентов класса
      // составляют девочки?» — «40»), и деление на сто засчитывало бы верный
      // ответ неверным.
      expect(checkAnswer('45%', expected({ answer: '45' }), 'number')).toEqual({
        correct: true,
        normalized: '45',
      });
      expect(checkAnswer('45%', expected({ answer: '0.45' }), 'number')).toEqual({
        correct: true,
        normalized: '0.45',
      });
      expect(checkAnswer('45%', expected({ answer: '46' }), 'number').correct).toBe(false);
    });

    it('читает знак процента и через пробел: «45 %» — та же запись, что «45%»', () => {
      // Пробел перед знаком ставят ровно так же часто, и без него второе
      // прочтение не разворачивалось — верный ответ на теме про доли считался
      // неверным из-за одного нажатия.
      expect(findNumbers('45 %')).toEqual([0.45]);
      expect(checkAnswer('45 %', expected({ answer: '0.45' }), 'number')).toEqual({
        correct: true,
        normalized: '0.45',
      });
      expect(checkAnswer('45 %', expected({ answer: '45' }), 'number').correct).toBe(true);
      // Пробел без знака процента в совпадение не уходит: «45 » — это 45.
      expect(findNumbers('45 ')).toEqual([45]);
      expect(findNumbers('45 и 46')).toEqual([45, 46]);
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

    it('normalizeText схлопывает U+0085, который не покрыт `\\s` и не снимается `trim`', () => {
      // Тот же знак, ради которого заведены оговорки в `dataBlock` и
      // `inlineField`: он приезжает вместе с текстом из чужих источников, а на
      // вид это перевод строки. Ответ с ним не сходился бы с эталоном, и ученик
      // получал бы «неверно» за верное.
      expect(normalizeText('\u0085Ёлка\u0085зелёная\u0085')).toBe('елка зеленая');
      expect(checkAnswer('два\u0085слова', expected({ answer: 'два слова' }), 'text').correct).toBe(
        true,
      );
    });
  });

  describe('формат choice', () => {
    it('сравнивает напрямую после отсечения краевых пробелов', () => {
      const task = expected({ answer: 'Б', accept: ['b'] });
      expect(checkAnswer('  Б ', task, 'choice').correct).toBe(true);
      expect(checkAnswer('b', task, 'choice').correct).toBe(true);
      expect(checkAnswer('В', task, 'choice')).toEqual({
        correct: false,
        normalized: 'в',
        reason: 'mismatch',
      });
    });

    it('не различает регистр: строчная метка — тот же вариант, а не другой', () => {
      expect(checkAnswer('б', expected({ answer: 'Б' }), 'choice').correct).toBe(true);
      expect(checkAnswer('work in pairs', expected({ answer: 'Work in pairs' }), 'choice').correct)
        .toBe(true);
      expect(normalizeChoice('  Б ')).toBe('б');
    });

    it('не сводит кириллические двойники: «В» списка А-Б-В — не «B» списка A-B-C', () => {
      expect(checkAnswer('В', expected({ answer: 'B' }), 'choice').correct).toBe(false);
      expect(checkAnswer('С', expected({ answer: 'C' }), 'choice').correct).toBe(false);
    });

    it('пустой выбор отвергается с причиной empty', () => {
      expect(checkAnswer(' ', expected({ answer: 'Б' }), 'choice').reason).toBe('empty');
    });
  });

  describe('отпечаток формулировки', () => {
    it('снимает регистр, ё, пунктуацию и разницу в пробелах', () => {
      const same = [
        'Сколько будет 2 + 2?',
        '  сколько   будет 2+2 ',
        'Сколько будет 2 + 2!',
        'Сколько будет 2+2',
      ].map(questionFingerprint);

      expect(new Set(same).size).toBe(1);
      expect(questionFingerprint('Что подберёшь?')).toBe(questionFingerprint('что подберешь'));
    });

    it('сохраняет числа: задания, отличающиеся только ими, — разные', () => {
      expect(questionFingerprint('Сколько будет 2 + 2?')).not.toBe(
        questionFingerprint('Сколько будет 3 + 5?'),
      );
    });

    it('сохраняет знак действия: задания, отличающиеся только им, — разные', () => {
      const fingerprints = [
        'Вычислите: 4800 : 16 + 37 · 25',
        'Вычислите: 4800 · 16 - 37 : 25',
        'Вычислите: 4800 : 16 - 37 · 25',
      ].map(questionFingerprint);

      expect(new Set(fingerprints).size).toBe(3);
      expect(questionFingerprint('Вычислите: 18,75 - 6,408')).not.toBe(
        questionFingerprint('Вычислите: 18,75 + 6,408'),
      );
    });

    it('сводит синонимы одного знака к одной записи', () => {
      expect(questionFingerprint('2 · 3')).toBe(questionFingerprint('2 × 3'));
      expect(questionFingerprint('8 : 4')).toBe(questionFingerprint('8 ÷ 4'));
      expect(questionFingerprint('7 − 3')).toBe(questionFingerprint('7 - 3'));
    });

    it('сохраняет разделитель внутри числа и снимает его на границе слова', () => {
      expect(questionFingerprint('Итого 2,5 кг.')).toBe('итого 2,5 кг');
      expect(questionFingerprint('Итого 25 кг')).not.toBe(questionFingerprint('Итого 2,5 кг'));
    });

    it('на строке без букв и цифр даёт пустой отпечаток', () => {
      expect(questionFingerprint('  ???  ')).toBe('');
    });
  });

  it('падает внятной ошибкой на неизвестном answer_format', () => {
    expect(() =>
      checkAnswer('45', expected(), 'formula' as unknown as 'number'),
    ).toThrow(/неизвестный формат ответа.*formula/i);
  });
});
