import type { AnswerFormat } from './curriculum.js';

/** Эталон задания из `task_bank`: основной ответ и допустимые варианты. */
export interface ExpectedAnswer {
  answer: string;
  /** Пополняется разбором споров, поэтому равноправен с `answer`. */
  accept?: string[];
}

/**
 * Почему ответ не засчитан. Уходит в разбор спора: «два числа в строке» и
 * «не то число» — разные случаи, LLM разбирает их по-разному.
 */
export type RejectReason = 'mismatch' | 'empty' | 'no-number' | 'ambiguous-number';

export interface CheckResult {
  correct: boolean;
  /** Нормализованный ответ ученика: пишется в `attempts` и показывается в разборе. */
  normalized: string;
  reason?: RejectReason;
}

/**
 * Знаки минуса, которые встречаются в ответах: дефис с клавиатуры, юникодный
 * минус из скопированного условия и короткое тире из автозамены.
 */
const MINUS = '-−–';

/**
 * Число: знак (возможно отделённый пробелом), целая часть, дробная через точку
 * или запятую и необязательный знаменатель через `/` — «3/4» в теме про
 * обыкновенные дроби такой же законный ответ, как «0,75».
 */
const NUMBER = new RegExp(
  `[${MINUS}]?\\s*\\d+(?:[.,]\\d+)?(?:\\s*/\\s*\\d+(?:[.,]\\d+)?)?`,
  'g',
);

/** Пробел внутри числа как разделитель разрядов: «45 000» — одно число, а не два. */
const GROUPING_SPACE = /(\d)[ \u00a0\u202f](?=\d{3}(?!\d))/g;

/** Типографские апострофы: «don’t» с телефона и «don't» с клавиатуры — один ответ. */
const APOSTROPHES = /[‘’ʼ`´]/g;

/** Плавающая точка не даёт точного равенства: 0.1+0.2 не равно 0.3 буквально. */
function sameNumber(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

function toNumber(token: string): number {
  const cleaned = token.replace(/\s+/g, '').replace(new RegExp(`^[${MINUS}]`), '-');
  const [numerator, denominator] = cleaned.split('/');
  const value =
    denominator === undefined
      ? Number(numerator?.replace(',', '.'))
      : Number(numerator?.replace(',', '.')) / Number(denominator.replace(',', '.'));
  return value;
}

/**
 * Все числа, найденные в строке. Экспортируется ради разбора споров и тестов:
 * по длине списка видно, ответ ли это без числа или с двумя числами сразу.
 */
export function findNumbers(text: string): number[] {
  return [...text.replace(GROUPING_SPACE, '$1').matchAll(NUMBER)]
    .map((match) => toNumber(match[0]))
    .filter((value) => Number.isFinite(value));
}

/**
 * Текстовая нормализация: регистр, схлопывание пробелов, `ё` = `е` и
 * типографские апострофы. Сравниваются только нормализованные строки.
 */
export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(APOSTROPHES, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Выбор приходит из интерфейса как есть — снимаются только краевые пробелы. */
export function normalizeChoice(value: string): string {
  return value.trim();
}

function candidates(expected: ExpectedAnswer): string[] {
  return [expected.answer, ...(expected.accept ?? [])];
}

function reject(normalized: string, reason: RejectReason): CheckResult {
  return { correct: false, normalized, reason };
}

/**
 * Эталон обязан читаться однозначно: «сорок пять» или «45 или 46» в задании —
 * дефект банка заданий, а не ошибка ученика, и молча считать такой ответ
 * неверным нельзя.
 */
function expectedNumber(raw: string): number {
  const numbers = findNumbers(raw);
  const only = numbers[0];
  if (numbers.length !== 1 || only === undefined) {
    throw new Error(`Нормализатор: эталонный ответ «${raw}» не содержит одного числа`);
  }
  return only;
}

function checkNumber(given: string, expected: ExpectedAnswer): CheckResult {
  const trimmed = given.trim();
  const wanted = candidates(expected).map(expectedNumber);

  if (trimmed === '') return reject('', 'empty');

  const numbers = findNumbers(trimmed);
  const only = numbers[0];
  if (only === undefined) return reject(trimmed, 'no-number');
  if (numbers.length > 1) return reject(trimmed, 'ambiguous-number');

  const normalized = String(only);
  return wanted.some((value) => sameNumber(value, only))
    ? { correct: true, normalized }
    : reject(normalized, 'mismatch');
}

function checkText(given: string, expected: ExpectedAnswer): CheckResult {
  const normalized = normalizeText(given);
  if (normalized === '') return reject('', 'empty');

  return candidates(expected).some((value) => normalizeText(value) === normalized)
    ? { correct: true, normalized }
    : reject(normalized, 'mismatch');
}

function checkChoice(given: string, expected: ExpectedAnswer): CheckResult {
  const normalized = normalizeChoice(given);
  if (normalized === '') return reject('', 'empty');

  return candidates(expected).some((value) => normalizeChoice(value) === normalized)
    ? { correct: true, normalized }
    : reject(normalized, 'mismatch');
}

/**
 * Сверяет ответ ученика с эталоном задания. Ветвь выбирается по `answer_format`
 * темы; обращений к LLM нет — ответ обязан приходить мгновенно, спорные случаи
 * разбирает кнопка «я всё-таки прав».
 */
export function checkAnswer(
  given: string,
  expected: ExpectedAnswer,
  format: AnswerFormat,
): CheckResult {
  switch (format) {
    case 'number':
      return checkNumber(given, expected);
    case 'text':
      return checkText(given, expected);
    case 'choice':
      return checkChoice(given, expected);
    default:
      throw new Error(`Нормализатор: неизвестный формат ответа «${String(format)}»`);
  }
}
