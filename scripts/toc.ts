/**
 * Поиск страниц оглавления в тексте PDF. Модуль чистый: на вход — уже
 * извлечённый постранично текст, на выход — выбранные страницы. Извлечение
 * (текстовый слой или OCR) живёт в `extract-toc.ts`, чтобы эвристику можно было
 * проверять на синтетике, не таская за собой ни одного PDF.
 */

/** Страница книги с уже извлечённым текстом. */
export interface PdfPage {
  /** Номер страницы в PDF, с единицы. */
  num: number;
  text: string;
}

export interface TocPageScore {
  num: number;
  /** Строк, похожих на пункт оглавления. */
  entries: number;
  /** Непустых строк всего. */
  lines: number;
  /** Доля пунктов среди непустых строк, 0..1. */
  density: number;
  /** На странице есть заголовок «Оглавление» / «Contents». */
  heading: boolean;
  /** Плотность плюс единица за заголовок. */
  score: number;
}

export interface TocSelection {
  pages: PdfPage[];
  from: number;
  to: number;
}

const DEFAULT_MIN_ENTRIES = 6;
const DEFAULT_MIN_DENSITY = 0.5;

/** Заголовок оглавления на трёх языках учебников плюс украинский «Зміст» (Мерзляк). */
const HEADING = /(оглавление|содержание|зміст|table of contents|contents)/i;

/**
 * Маркер раздела в начале строки. «$» — типовое прочтение «§» распознавалкой.
 * Границу слова здесь пришлось выразить через `(?!\p{L})`: `\b` в JS считает
 * словом только ASCII, поэтому после «глава» никакой границы не находит.
 */
const SECTION_MARKER =
  /^\s*(?:[§$]\s*\d+|(?:глава|раздел|тема|часть|урок|приложение|unit|lesson|part|chapter|module|appendix)(?!\p{L}))/iu;

/** Название, отточие (или просто пробелы) и номер страницы в конце строки. */
const LEADER_AND_PAGE = /^(.*\S)[.·…\s]{2,}(\d{1,4})$/u;

/** Голый номер страницы: OCR читает колонку номеров отдельно от названий. */
const BARE_PAGE_NUMBER = /^\d{1,4}$/;

const MAX_ENTRY_LENGTH = 120;

function hasLetters(text: string): boolean {
  return (text.match(/\p{L}/gu) ?? []).length >= 3;
}

/**
 * Строка похожа на пункт оглавления. Голый номер страницы сюда не входит:
 * в отрыве от страницы он ничего не значит и разбирается в `scoreTocPage`.
 */
export function isTocEntryLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 2 || trimmed.length > MAX_ENTRY_LENGTH) return false;

  const leader = LEADER_AND_PAGE.exec(trimmed);
  // Требование букв в названии отсекает нумерацию ответов вида «1.1. 42».
  if (leader !== null && hasLetters(leader[1] ?? '')) return true;

  return SECTION_MARKER.test(trimmed) && /\d|\p{L}/u.test(trimmed);
}

export function scoreTocPage(page: PdfPage): TocPageScore {
  const lines = page.text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

  const titled = lines.filter(isTocEntryLine).length;
  // Колонка номеров засчитывается только рядом с названиями тем — иначе
  // страница ответов к упражнениям выглядит как идеальное оглавление.
  const bare = titled >= 3 ? lines.filter((line) => BARE_PAGE_NUMBER.test(line)).length : 0;
  const entries = titled + bare;
  const density = lines.length === 0 ? 0 : entries / lines.length;
  const heading = lines.some((line) => line.length <= 40 && HEADING.test(line));

  return {
    num: page.num,
    entries,
    lines: lines.length,
    density,
    heading,
    score: density + (heading ? 1 : 0),
  };
}

function qualifies(score: TocPageScore): boolean {
  if (score.heading && score.entries >= 3) return true;
  return score.entries >= DEFAULT_MIN_ENTRIES && score.density >= DEFAULT_MIN_DENSITY;
}

/**
 * Выбирает лучший подряд идущий кусок страниц оглавления. «Подряд» считается по
 * номерам страниц, а не по позициям в массиве: при OCR просматриваются только
 * начало и конец книги, и между ними в списке зияет дыра.
 */
export function findTocPages(pages: PdfPage[]): TocSelection {
  if (pages.length === 0) {
    throw new Error('Оглавление не найдено: не разобрано ни одной страницы PDF');
  }

  const sorted = [...pages].sort((left, right) => left.num - right.num);
  const runs: PdfPage[][] = [];
  let previous: PdfPage | undefined;
  for (const page of sorted) {
    if (!qualifies(scoreTocPage(page))) {
      previous = undefined;
      continue;
    }
    if (previous !== undefined && page.num === previous.num + 1) {
      runs[runs.length - 1]?.push(page);
    } else {
      runs.push([page]);
    }
    previous = page;
  }

  if (runs.length === 0) {
    throw new Error(
      'Оглавление не найдено: ни одна из просмотренных страниц не похожа на оглавление. ' +
        'Задайте страницы вручную флагом --pages <от>-<до>',
    );
  }

  // Заголовок решает, а не прибавляет. Плотность у страницы предметного
  // указателя и у оглавления одинаковая — обе сплошь «название … номер», — так
  // что суммой правит длина куска, а указатели и ответы к упражнениям как раз
  // длиннее оглавления и лежат ровно в конце книги, куда и смотрит просмотр
  // краёв. Единица за заголовок этого не перебивала: четыре страницы указателя
  // (4.0) обходили три страницы оглавления с заголовком (3.86), и подменённые
  // страницы уезжали в `raw-toc` молча — сообщать о подмене нечему, а карта тем
  // потом собирается по ним. «Оглавление» же на указателе не написано.
  const weights = new Map<PdfPage[], [number, number]>(
    runs.map((run) => {
      const scores = run.map(scoreTocPage);
      return [
        run,
        [
          scores.some((score) => score.heading) ? 1 : 0,
          scores.reduce((sum, score) => sum + score.density, 0),
        ],
      ];
    }),
  );
  const best = runs.reduce((champion, run) => {
    const [headed, density] = weights.get(run) ?? [0, 0];
    const [bestHeaded, bestDensity] = weights.get(champion) ?? [0, 0];
    if (headed !== bestHeaded) return headed > bestHeaded ? run : champion;
    return density > bestDensity ? run : champion;
  });

  return {
    pages: best,
    from: best[0]?.num ?? 0,
    to: best[best.length - 1]?.num ?? 0,
  };
}

export interface FormatTocOptions {
  /** Имя исходного PDF: попадает в шапку файла. */
  source: string;
  /** Откуда взят текст — из слоя PDF или из распознавания. */
  extraction: 'text' | 'ocr';
}

/**
 * Собирает выбранные страницы в текст для `content/raw-toc/<subject>.txt`.
 * Шапка нужна на этапе 5: по ней видно, откуда взялась карта тем и стоит ли
 * доверять формулировкам (после OCR они бывают битыми).
 */
export function formatToc(selection: TocSelection, options: FormatTocOptions): string {
  const range = selection.from === selection.to ? `${selection.from}` : `${selection.from}-${selection.to}`;
  const header = [
    `# источник: ${options.source}`,
    `# страницы: ${range}`,
    `# извлечение: ${options.extraction}`,
  ].join('\n');

  const body = selection.pages
    .map((page) => `----- страница ${page.num} -----\n${page.text.trim()}`)
    .join('\n\n');

  return `${header}\n\n${body}\n`;
}
