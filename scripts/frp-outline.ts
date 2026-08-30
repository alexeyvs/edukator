/**
 * Разбор структуры федеральной рабочей программы. Модуль чистый: на вход — уже
 * извлечённый постранично текст, на выход — отрезки «учебный курс + класс».
 * Извлечение живёт в `frp-pdf.ts`, чтобы эвристику можно было проверять на
 * синтетике, не таская за собой ни одного PDF, — как у `toc.ts`.
 *
 * Программа издана на уровень образования: 5–9 одним документом. Внутри она
 * делится на учебные курсы («Алгебра», «Геометрия», «Вероятность и статистика»),
 * у каждого свои «Содержание обучения» и «Тематическое планирование», и оба
 * разбиты подзаголовками «N КЛАСС». Состав тем несут только эти два раздела:
 * «Планируемые результаты» говорят о личностных и метапредметных достижениях и
 * для карты тем бесполезны.
 */

export interface FrpPage {
  /** Номер страницы в PDF, с единицы. */
  num: number;
  text: string;
}

export interface PageRange { from: number; to: number }

export interface FrpSlice {
  /** Название учебного курса как оно стоит в заголовке, без кавычек. */
  courseTitle: string;
  grade: number;
  ranges: PageRange[];
}

const COURSE_HEADING = /ФЕДЕРАЛЬНАЯ\s+РАБОЧАЯ\s+ПРОГРАММА\s+УЧЕБНОГО\s+КУРСА\s*«([^»]+)»/gu;
const CONTENT_SECTION = /(СОДЕРЖАНИЕ\s+ОБУЧЕНИЯ|ТЕМАТИЧЕСКОЕ\s+ПЛАНИРОВАНИЕ)(?!\p{L})/gu;
const OTHER_SECTION = /(ПЛАНИРУЕМЫЕ\s+РЕЗУЛЬТАТЫ|ПРЕДМЕТНЫЕ\s+РЕЗУЛЬТАТЫ|ПОЯСНИТЕЛЬНАЯ\s+ЗАПИСКА)(?!\p{L})/gu;
// Граница слова здесь обязана быть `(?!\p{L})`: `\b` в JS считает словом только
// ASCII, поэтому «7 КЛАССИФИКАЦИЯ» прошло бы за заголовок седьмого класса.
const GRADE_HEADING = /(\d{1,2})\s*КЛАСС(?!\p{L})/gu;

interface Marker {
  at: number;
  kind: 'course' | 'content' | 'other' | 'grade';
  value: string;
}

function markers(text: string): Marker[] {
  const found: Marker[] = [];
  for (const [regexp, kind] of [
    [COURSE_HEADING, 'course'],
    [CONTENT_SECTION, 'content'],
    [OTHER_SECTION, 'other'],
    [GRADE_HEADING, 'grade'],
  ] as const) {
    for (const match of text.matchAll(regexp)) {
      found.push({ at: match.index, kind, value: match[1] ?? '' });
    }
  }
  return found.sort((left, right) => left.at - right.at);
}

/**
 * Страница приписывается **каждому** состоянию, действовавшему на ней хоть
 * где-то. Заголовки в программе стоят вверху страницы, но граница классов
 * иногда приходится на середину: приписав такую страницу одному состоянию, мы
 * теряли бы начало следующего класса. Лишняя страница в срезе безвредна,
 * потерянная — нет.
 */
export function sliceFrp(pages: readonly FrpPage[]): FrpSlice[] {
  const collected = new Map<string, { courseTitle: string; grade: number; pages: number[] }>();
  let courseTitle: string | undefined;
  let inContent = false;
  let grade: number | undefined;

  for (const page of pages) {
    const onPage = new Map<string, { courseTitle: string; grade: number }>();
    const remember = (): void => {
      if (courseTitle === undefined || !inContent || grade === undefined) return;
      onPage.set(`${courseTitle} ${String(grade)}`, { courseTitle, grade });
    };
    remember();
    const pageMarkers = markers(page.text);
    for (const marker of pageMarkers) {
      if (marker.kind === 'course') {
        courseTitle = marker.value;
        inContent = false;
        grade = undefined;
      } else if (marker.kind === 'content') {
        inContent = true;
        grade = undefined;
      } else if (marker.kind === 'other') {
        inContent = false;
        grade = undefined;
      } else {
        grade = Number(marker.value);
      }
      remember();
    }
    // Если на странице есть маркеры и мы закончили вне содержания обучения,
    // страница переходит в другой раздел. Не включаем её.
    if (pageMarkers.length > 0 && !inContent) {
      onPage.clear();
    }
    for (const [key, state] of onPage) {
      const entry = collected.get(key) ?? { ...state, pages: [] };
      entry.pages.push(page.num);
      collected.set(key, entry);
    }
  }

  return [...collected.values()].map((entry) => ({
    courseTitle: entry.courseTitle,
    grade: entry.grade,
    ranges: toRanges(entry.pages),
  }));
}

function toRanges(numbers: readonly number[]): PageRange[] {
  const ranges: PageRange[] = [];
  for (const num of [...numbers].sort((left, right) => left - right)) {
    const last = ranges.at(-1);
    if (last === undefined) ranges.push({ from: num, to: num });
    else if (num === last.to + 1) last.to = num;
    else if (num !== last.to) ranges.push({ from: num, to: num });
  }
  return ranges;
}

/** Диапазоны всех учебных курсов одного класса, в порядке появления в документе. */
export function rangesForGrade(slices: readonly FrpSlice[], grade: number): PageRange[] {
  return slices.filter((slice) => slice.grade === grade).flatMap((slice) => slice.ranges);
}
