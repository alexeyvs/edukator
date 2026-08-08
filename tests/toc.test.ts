import { describe, expect, it } from 'vitest';
import { findTocPages, formatToc, isTocEntryLine, scoreTocPage } from '../scripts/toc.js';

/** Страница оглавления с классическими отточиями. */
const dottedToc = [
  'Оглавление',
  'Глава 1. Натуральные числа ..................... 5',
  '§ 1. Действия с натуральными числами ........... 6',
  '§ 2. Числовые и буквенные выражения ............ 18',
  '§ 3. Делимость натуральных чисел ............... 24',
  'Глава 2. Геометрические фигуры ................. 32',
  '§ 4. Прямая. Луч. Отрезок. Угол ................ 34',
  '§ 5. Многоугольники ............................ 40',
].join('\n');

/**
 * Та же страница глазами OCR: заголовки и номера страниц уезжают
 * в разные колонки, отточия теряются, «§» читается как «$».
 */
const ocrToc = [
  'Оглавление',
  'Глава 1. Натуральные числа',
  '§ 1. Действия с натуральными числами',
  '$ 2.',
  'Числовые и буквенные выражения',
  '§ 3. Делимость натуральных чисел',
  'Глава 2. Геометрические фигуры',
  '§ 4. Прямая. Луч. Отрезок. Угол',
  '5',
  '6',
  '18',
  '24',
  '32',
  '34',
].join('\n');

const prose = [
  'Чтобы к сумме двух чисел прибавить третье число, можно к первому',
  'числу прибавить сумму второго и третьего чисел.',
  'Если одно из двух слагаемых равно нулю, то сумма равна другому',
  'слагаемому, и это свойство называют свойством нуля при сложении.',
  'Равенство a - b = c верно, если верно равенство b + c = a.',
  'В равенстве a - b = c число a называют уменьшаемым.',
].join('\n');

/** Страница ответов к упражнениям: цифр много, но названий тем нет. */
const answers = [
  'Ответы и указания к упражнениям',
  '1.1. 42',
  '1.2. 17',
  '1.3. 8',
  '1.4. 125',
  '2.1. 36',
  '2.2. 4',
  '2.3. 91',
  '2.4. 60',
].join('\n');

/**
 * Предметный указатель: те же «название … номер», что и в оглавлении, и той же
 * плотности — отличает его только отсутствие заголовка. Лежит в самом конце
 * книги, куда и смотрит просмотр краёв, и обычно длиннее оглавления.
 */
const subjectIndex = [
  'Абсцисса ....................................... 45',
  'Биссектриса .................................... 112',
  'Вектор ......................................... 8',
  'Гипотенуза ..................................... 203',
  'Дискриминант ................................... 91',
  'Знаменатель .................................... 17',
  'Катет .......................................... 203',
  'Медиана ........................................ 118',
].join('\n');

describe('isTocEntryLine', () => {
  it('признаёт строку с отточием и номером страницы', () => {
    expect(isTocEntryLine('§ 1. Действия с натуральными числами ........... 6')).toBe(true);
  });

  it('признаёт строку с номером страницы через пробелы', () => {
    expect(isTocEntryLine('Многоугольники        40')).toBe(true);
  });

  it('признаёт строку, начатую маркером раздела, без номера страницы', () => {
    expect(isTocEntryLine('Глава 2. Геометрические фигуры')).toBe(true);
    expect(isTocEntryLine('§ 4. Прямая. Луч. Отрезок. Угол')).toBe(true);
    expect(isTocEntryLine('Unit 3 Family album')).toBe(true);
  });

  it('признаёт «$» вместо «§» — типовая ошибка OCR', () => {
    expect(isTocEntryLine('$ 25.')).toBe(true);
  });

  it('отвергает прозу, пустую строку и строку из одних цифр', () => {
    expect(isTocEntryLine('Чтобы к сумме двух чисел прибавить третье число, можно')).toBe(false);
    expect(isTocEntryLine('   ')).toBe(false);
    expect(isTocEntryLine('42')).toBe(false);
  });

  it('отвергает нумерацию упражнений: в названии нет букв', () => {
    expect(isTocEntryLine('1.1. 42')).toBe(false);
  });
});

describe('scoreTocPage', () => {
  it('видит заголовок оглавления и высокую плотность пунктов', () => {
    const score = scoreTocPage({ num: 333, text: dottedToc });
    expect(score.heading).toBe(true);
    expect(score.entries).toBeGreaterThanOrEqual(7);
    expect(score.density).toBeGreaterThan(0.8);
  });

  it('засчитывает колонку голых номеров страниц рядом с названиями', () => {
    const score = scoreTocPage({ num: 333, text: ocrToc });
    expect(score.entries).toBeGreaterThan(scoreTocPage({ num: 333, text: prose }).entries);
    expect(score.density).toBeGreaterThan(0.8);
  });

  it('не засчитывает голые номера там, где названий тем нет', () => {
    expect(scoreTocPage({ num: 300, text: answers }).entries).toBeLessThanOrEqual(1);
  });

  it('даёт прозе нулевую плотность', () => {
    expect(scoreTocPage({ num: 10, text: prose }).density).toBe(0);
  });

  it('на пустой странице не делит на ноль', () => {
    const score = scoreTocPage({ num: 1, text: '   \n\n  ' });
    expect(score.lines).toBe(0);
    expect(score.density).toBe(0);
    expect(score.score).toBe(0);
  });
});

describe('findTocPages', () => {
  it('находит страницу оглавления среди страниц с текстом', () => {
    const selection = findTocPages([
      { num: 1, text: prose },
      { num: 2, text: prose },
      { num: 333, text: dottedToc },
      { num: 334, text: prose },
    ]);
    expect(selection.from).toBe(333);
    expect(selection.to).toBe(333);
    expect(selection.pages).toHaveLength(1);
  });

  it('склеивает подряд идущие страницы оглавления', () => {
    const selection = findTocPages([
      { num: 333, text: dottedToc },
      { num: 334, text: ocrToc },
      { num: 335, text: prose },
    ]);
    expect(selection.from).toBe(333);
    expect(selection.to).toBe(334);
    expect(selection.pages.map((page) => page.num)).toEqual([333, 334]);
  });

  it('не склеивает страницы из разных концов книги', () => {
    const selection = findTocPages([
      { num: 3, text: dottedToc },
      { num: 333, text: ocrToc },
    ]);
    expect(selection.pages).toHaveLength(1);
  });

  it('предпочитает оглавление странице ответов с той же плотностью', () => {
    const selection = findTocPages([
      { num: 300, text: answers },
      { num: 301, text: answers },
      { num: 302, text: answers },
      { num: 333, text: dottedToc },
    ]);
    expect(selection.from).toBe(333);
  });

  it('предпочитает оглавление с заголовком более длинному предметному указателю', () => {
    // Сумма плотностей длиной куска и правится: указатель на страницу плотнее не
    // бывает, зато страниц у него больше. Единица за заголовок этого не
    // перебивала, и в `raw-toc` молча уезжал указатель — а карта тем потом
    // собирается по нему, и заметить подмену уже нечем.
    const selection = findTocPages([
      { num: 333, text: dottedToc },
      { num: 334, text: ocrToc },
      { num: 400, text: subjectIndex },
      { num: 401, text: subjectIndex },
      { num: 402, text: subjectIndex },
      { num: 403, text: subjectIndex },
    ]);

    expect(selection.from).toBe(333);
    expect(selection.to).toBe(334);
  });

  it('берёт самый плотный кусок, когда заголовка нет ни у кого', () => {
    const selection = findTocPages([
      { num: 400, text: subjectIndex },
      { num: 500, text: subjectIndex },
      { num: 501, text: subjectIndex },
    ]);

    expect(selection.pages.map((page) => page.num)).toEqual([500, 501]);
  });

  it('падает с внятной ошибкой, если оглавления нет', () => {
    expect(() => findTocPages([{ num: 1, text: prose }])).toThrow(/Оглавление не найдено/);
  });

  it('падает с внятной ошибкой на пустом списке страниц', () => {
    expect(() => findTocPages([])).toThrow(/ни одной страницы/i);
  });
});

describe('formatToc', () => {
  it('складывает страницы в текст с шапкой источника', () => {
    const selection = findTocPages([{ num: 333, text: dottedToc }]);
    const text = formatToc(selection, { source: 'merzljak.pdf', extraction: 'ocr' });
    expect(text).toContain('merzljak.pdf');
    expect(text).toContain('333');
    expect(text).toContain('ocr');
    expect(text).toContain('Глава 1. Натуральные числа');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('разделяет несколько страниц отбивкой с номером', () => {
    const selection = findTocPages([
      { num: 333, text: dottedToc },
      { num: 334, text: ocrToc },
    ]);
    const text = formatToc(selection, { source: 'merzljak.pdf', extraction: 'text' });
    expect(text).toMatch(/страница 334/);
  });
});
