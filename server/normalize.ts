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
 * Смешанное число: целая часть, пробел, правильная дробь — «1 2/3». Отдельная
 * ветвь и обязательно раньше обычной: иначе пробел читается как граница двух
 * чисел, и естественная запись ответа в теме про обыкновенные дроби уходит в
 * `ambiguous-number`, то есть верный ответ считается ошибкой.
 */
const MIXED_BODY = String.raw`\d+\s+\d+\s*/\s*\d+`;

/**
 * Число: целая часть, дробная через точку или запятую и необязательный
 * знаменатель через `/` — «3/4» в теме про обыкновенные дроби такой же
 * законный ответ, как «0,75».
 */
const PLAIN_BODY = String.raw`\d+(?:[.,]\d+)?(?:\s*/\s*\d+(?:[.,]\d+)?)?`;

/**
 * Знак плюс одна из двух записей числа. Отделённым пробелом знак читается
 * только в начале ответа: внутри фразы «Ответ – 5» тире — пунктуация, и приняв
 * его за минус, нормализатор засчитывал бы верный ответ неверным.
 */
const NUMBER = new RegExp(
  `(?:^[${MINUS}]\\s*|[${MINUS}]?)(?:${MIXED_BODY}|${PLAIN_BODY})%?`,
  'g',
);

/**
 * Десятичная дробь без целой части: «,5» — обычное сокращение при вводе.
 * Восстанавливается ноль, потому что иначе `PLAIN_BODY` требует цифру перед
 * разделителем, пропускает его и читает «,5» как 5 — то есть засчитывает
 * неверный ответ верным. Только в начале строки: внутри фразы «Ответ.5» точка
 * заканчивает предложение, а не открывает число.
 */
const LEADING_FRACTION = new RegExp(`^(?<sign>[${MINUS}]?\\s*)(?=[.,]\\d)`);

const MIXED = /^(\d+)\s+(\d+)\s*\/\s*(\d+)$/;

/**
 * Пробел внутри числа как разделитель разрядов: «45 000» — одно число, а не два.
 * За группой не должно идти дробной черты: в «1 200/3» тот же пробел отделяет
 * целую часть смешанного числа, и схлопывание давало 1200/3 = 400 вместо
 * 1 + 200/3 — верный ответ молча превращался в другое число.
 */
const GROUPING_SPACE = /(\d)[ \u00a0\u202f](?=\d{3}(?!\d)(?!\s*\/))/g;

/** Типографские апострофы: «don’t» с телефона и «don't» с клавиатуры — один ответ. */
const APOSTROPHES = /[‘’ʼ`´]/g;

/** Плавающая точка не даёт точного равенства: 0.1+0.2 не равно 0.3 буквально. */
function sameNumber(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

function toNumber(token: string): number {
  const percent = token.trimEnd().endsWith('%');
  const withoutPercent = percent ? token.trimEnd().slice(0, -1) : token;
  const signed = withoutPercent.replace(new RegExp(`^[${MINUS}]\\s*`), '-');
  const sign = signed.startsWith('-') ? -1 : 1;
  const body = signed.replace(/^-/, '').trim();

  const mixed = MIXED.exec(body);
  if (mixed !== null) {
    const [whole = NaN, numerator = NaN, denominator = NaN] = mixed.slice(1).map(Number);
    return sign * (whole + numerator / denominator);
  }

  const [numerator, denominator] = body.replace(/\s+/g, '').split('/');
  const value =
    denominator === undefined
      ? Number(numerator?.replace(',', '.'))
      : Number(numerator?.replace(',', '.')) / Number(denominator.replace(',', '.'));
  return (sign * value) / (percent ? 100 : 1);
}

/**
 * Все числа, найденные в строке. Экспортируется ради разбора споров и тестов:
 * по длине списка видно, ответ ли это без числа или с двумя числами сразу.
 */
export function findNumbers(text: string): number[] {
  // Краевые пробелы снимаются до разбора: иначе знак в «  − 45» уже не в начале
  // строки и перестаёт читаться как знак.
  const prepared = text
    .trim()
    .replace(LEADING_FRACTION, '$<sign>0')
    .replace(GROUPING_SPACE, '$1');

  return [...prepared.matchAll(NUMBER)]
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

/**
 * Разбирает эталоны для числовой сверки. `answer` обязан читаться однозначно,
 * а вот `accept[]` пополняется разбором спора уже на ходу: нечисловая запись в
 * нём — не дефект банка, а подтверждённый живой вариант, и падать на ней
 * значило бы ломать задание навсегда после первого же спора. Такие записи
 * сверяются как текст.
 */
function numberExpectations(expected: ExpectedAnswer): { numbers: number[]; texts: string[] } {
  const numbers = [expectedNumber(expected.answer)];
  const texts: string[] = [];

  for (const raw of expected.accept ?? []) {
    const found = findNumbers(raw);
    const only = found[0];
    if (found.length === 1 && only !== undefined) numbers.push(only);
    else texts.push(normalizeText(raw));
  }

  return { numbers, texts };
}

function checkNumber(given: string, expected: ExpectedAnswer): CheckResult {
  // Пустой ответ разбирается до эталона: ученик ничего не ввёл, и это его
  // случай, а не дефект банка — падать здесь значило бы прятать «empty» за
  // ошибкой задания, до которой ученику дела нет.
  const trimmed = given.trim();
  if (trimmed === '') return reject('', 'empty');

  const { numbers: wanted, texts } = numberExpectations(expected);

  // Словесный вариант сверяется до чисел: «сорок пять» числа не содержит, и
  // числовая ветвь отвергла бы его как no-number, не дойдя до accept.
  const asText = normalizeText(trimmed);
  if (texts.includes(asText)) return { correct: true, normalized: asText };

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
