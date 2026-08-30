/**
 * Обвязка над `pdftotext` и `qpdf` — единственное место, где эвристика разбора
 * ФРП (`frp-outline.ts`) встречается с настоящим PDF. `readPdfPages` кормит её
 * постраничным текстом, `cutPdf` вырезает найденные отрезки в отдельный файл,
 * который потом загружается как источник курса.
 */

import { MAX_CHILD_OUTPUT_BYTES, runChild } from '../server/run-child.js';
import type { FrpPage, PageRange } from './frp-outline.js';

export interface PdfTools { pdftotext: string; qpdf: string }

export const DEFAULT_PDF_TOOLS: PdfTools = { pdftotext: 'pdftotext', qpdf: 'qpdf' };

// Импорт учебника — операция редкая и ручная, но документ федерального объёма
// разбирается не мгновенно; предел щедрый, а не подогнанный под конкретный файл.
export const PDF_TOOL_TIMEOUT_MS = 120_000;

// Федеральная программа на весь уровень образования (5–9 классы, несколько
// учебных курсов) даёт заметно больше текста, чем обычный вывод инструмента:
// умолчание `runChild` рассчитано на короткий ответ модели, а не на постранично
// извлечённый учебник целиком.
const MAX_PDFTOTEXT_OUTPUT_BYTES = 16 * MAX_CHILD_OUTPUT_BYTES;

/** `pdftotext` разделяет страницы этим байтом (form feed). */
const PAGE_BREAK = '\f';

/**
 * Извлекает постраничный текст PDF через `pdftotext -layout <path> -`.
 * `-layout` сохраняет визуальный порядок колонок таблиц тематического
 * планирования — без него строки перемешались бы поперёк граф.
 */
export async function readPdfPages(path: string, tools: PdfTools = DEFAULT_PDF_TOOLS): Promise<FrpPage[]> {
  const result = await runChild({
    bin: tools.pdftotext,
    args: ['-layout', path, '-'],
    label: 'pdftotext',
    timeoutMs: PDF_TOOL_TIMEOUT_MS,
    maxOutputBytes: MAX_PDFTOTEXT_OUTPUT_BYTES,
  });
  if (result.code !== 0) {
    throw new Error(`pdftotext не удался (код ${result.code}): ${result.stderr.trim()}`);
  }
  // Пустой документ даёт пустую строку, а не один пустой кусок: `''.split` уже
  // вернул бы `['']`, то есть одну несуществующую страницу.
  if (result.stdout === '') return [];
  // Настоящий pdftotext дописывает перевод страницы и после последней
  // страницы, а не только между страницами: документ из N страниц даёт N
  // символов `\f`, а не N−1. Наивное разбиение оставило бы фантомную (N+1)-ю
  // страницу с пустым текстом — а её номер уехал бы дальше, в `cutPdf`, как
  // диапазон, которого в файле нет. Срезается ровно один завершающий разделитель:
  // подлинно пустая последняя страница документа даёт `\f\f` в конце и после
  // среза одного `\f` остаётся ровно её собственный пустой кусок.
  const text = result.stdout.endsWith(PAGE_BREAK)
    ? result.stdout.slice(0, -PAGE_BREAK.length)
    : result.stdout;
  return text.split(PAGE_BREAK).map((pageText, index) => ({ num: index + 1, text: pageText }));
}

/**
 * Вырезает диапазоны страниц из `input` в один `output` через
 * `qpdf --empty --pages <input> <from>-<to> ... -- <output>`.
 */
export async function cutPdf(
  input: string,
  output: string,
  ranges: readonly PageRange[],
  tools: PdfTools = DEFAULT_PDF_TOOLS,
): Promise<void> {
  // `qpdf --empty` без страниц молча выдаёт пустой, но валидный PDF. Тот
  // прошёл бы дальше по конвейеру и отказал бы позже, на OCR, с формулировкой
  // «источник без распознанных страниц» — с другого конца и по другой причине.
  if (ranges.length === 0) {
    throw new Error('cutPdf: список диапазонов страниц пуст');
  }
  const args = ['--empty', '--pages'];
  for (const range of ranges) {
    args.push(input, `${range.from}-${range.to}`);
  }
  args.push('--', output);
  const result = await runChild({
    bin: tools.qpdf,
    args,
    label: 'qpdf',
    timeoutMs: PDF_TOOL_TIMEOUT_MS,
    // `qpdf` пишет результат в файл, а не в stdout — умолчания хватает с
    // избытком, но предел выписан явно, как и у `pdftotext`: молчаливое
    // умолчание в одном из двух вызовов легко потерять при следующей правке.
    maxOutputBytes: MAX_CHILD_OUTPUT_BYTES,
  });
  if (result.code !== 0) {
    throw new Error(`qpdf не удался (код ${result.code}): ${result.stderr.trim()}`);
  }
}
