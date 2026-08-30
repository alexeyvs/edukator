import { describe, expect, it } from 'vitest';
import { rangesForGrade, sliceFrp, type FrpPage } from '../scripts/frp-outline.js';

function pages(...texts: string[]): FrpPage[] {
  return texts.map((text, index) => ({ num: index + 1, text }));
}

describe('sliceFrp', () => {
  it('разбирает два учебных курса с общими классами', () => {
    const slices = sliceFrp(pages(
      'ФЕДЕРАЛЬНАЯ РАБОЧАЯ ПРОГРАММА УЧЕБНОГО КУРСА «АЛГЕБРА»',
      'СОДЕРЖАНИЕ ОБУЧЕНИЯ\n7 КЛАСС\nЧисла и вычисления',
      'ПРЕДМЕТНЫЕ РЕЗУЛЬТАТЫ\nвыпускник научится',
      'ТЕМАТИЧЕСКОЕ ПЛАНИРОВАНИЕ\n7 КЛАСС\nЧисла и вычисления, 25 часов',
      'ФЕДЕРАЛЬНАЯ РАБОЧАЯ ПРОГРАММА УЧЕБНОГО КУРСА «ГЕОМЕТРИЯ»',
      'СОДЕРЖАНИЕ ОБУЧЕНИЯ\n7 КЛАСС\nТреугольники',
    ));

    expect(slices).toEqual([
      { courseTitle: 'АЛГЕБРА', grade: 7, ranges: [{ from: 2, to: 2 }, { from: 4, to: 4 }] },
      { courseTitle: 'ГЕОМЕТРИЯ', grade: 7, ranges: [{ from: 6, to: 6 }] },
    ]);
  });

  it('не берёт страницы вне содержания обучения и тематического планирования', () => {
    const slices = sliceFrp(pages(
      'ФЕДЕРАЛЬНАЯ РАБОЧАЯ ПРОГРАММА УЧЕБНОГО КУРСА «АЛГЕБРА»',
      'ПЛАНИРУЕМЫЕ РЕЗУЛЬТАТЫ\n7 КЛАСС\nличностные результаты',
    ));
    expect(slices).toEqual([]);
  });

  it('склеивает смежные страницы одного класса в один диапазон', () => {
    const slices = sliceFrp(pages(
      'ФЕДЕРАЛЬНАЯ РАБОЧАЯ ПРОГРАММА УЧЕБНОГО КУРСА «АЛГЕБРА»',
      'СОДЕРЖАНИЕ ОБУЧЕНИЯ\n7 КЛАСС\nЧисла',
      'продолжение без заголовков',
      'продолжение без заголовков',
    ));
    expect(slices).toEqual([
      { courseTitle: 'АЛГЕБРА', grade: 7, ranges: [{ from: 2, to: 4 }] },
    ]);
  });

  it('страница со сменой класса попадает в оба класса', () => {
    const slices = sliceFrp(pages(
      'ФЕДЕРАЛЬНАЯ РАБОЧАЯ ПРОГРАММА УЧЕБНОГО КУРСА «АЛГЕБРА»',
      'СОДЕРЖАНИЕ ОБУЧЕНИЯ\n7 КЛАСС\nЧисла\n8 КЛАСС\nСтепень',
    ));
    expect(slices).toEqual([
      { courseTitle: 'АЛГЕБРА', grade: 7, ranges: [{ from: 2, to: 2 }] },
      { courseTitle: 'АЛГЕБРА', grade: 8, ranges: [{ from: 2, to: 2 }] },
    ]);
  });

  it('находит заголовок класса после кириллической границы слова', () => {
    // `\b` здесь не работает: в JS он ASCII-only и после «КЛАСС» границы не видит,
    // поэтому «7 КЛАССИФИКАЦИЯ» прошла бы за заголовок седьмого класса.
    const slices = sliceFrp(pages(
      'ФЕДЕРАЛЬНАЯ РАБОЧАЯ ПРОГРАММА УЧЕБНОГО КУРСА «АЛГЕБРА»',
      'СОДЕРЖАНИЕ ОБУЧЕНИЯ\n7 КЛАСС\nтекст',
      'СОДЕРЖАНИЕ ОБУЧЕНИЯ\n7 КЛАССИФИКАЦИЯ\nтекст',
    ));
    expect(slices).toEqual([
      { courseTitle: 'АЛГЕБРА', grade: 7, ranges: [{ from: 2, to: 3 }] },
    ]);
  });

  it('игнорирует класс до первого заголовка учебного курса', () => {
    expect(sliceFrp(pages('СОДЕРЖАНИЕ ОБУЧЕНИЯ\n7 КЛАСС\nтекст'))).toEqual([]);
  });
});

describe('rangesForGrade', () => {
  it('собирает диапазоны всех учебных курсов одного класса по порядку', () => {
    const slices = [
      { courseTitle: 'АЛГЕБРА', grade: 7, ranges: [{ from: 2, to: 3 }] },
      { courseTitle: 'ГЕОМЕТРИЯ', grade: 7, ranges: [{ from: 9, to: 9 }] },
      { courseTitle: 'АЛГЕБРА', grade: 8, ranges: [{ from: 4, to: 5 }] },
    ];
    expect(rangesForGrade(slices, 7)).toEqual([{ from: 2, to: 3 }, { from: 9, to: 9 }]);
  });

  it('на классе без отрезков возвращает пустой список', () => {
    expect(rangesForGrade([], 9)).toEqual([]);
  });
});
