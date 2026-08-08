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
 * минус из скопированного условия, короткое и длинное тире из автозамены.
 * Длинное тире обязательно: автозамена macOS и iOS ставит именно его, и без
 * него «—45» читалось как 45 — то есть верный отрицательный ответ считался
 * неверным, а неверный положительный засчитывался.
 */
const MINUS = '-−–—';

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
 *
 * Знак процента берётся и через пробел — «50 %» пишут ровно так же часто, как
 * «50%». Без этого `answerForms` не разворачивал бы второе прочтение, и ученик
 * получал бы незачёт на верном ответе из-за одного пробела. Пробел разрешён
 * только вместе с самим знаком (`(?:\s*%)?`, а не `\s*%?`): иначе совпадение
 * захватывало бы хвостовые пробелы и там, где процента нет вовсе.
 */
const NUMBER = new RegExp(
  `(?:^[${MINUS}]\\s*|[${MINUS}]?)(?:${MIXED_BODY}|${PLAIN_BODY})(?:\\s*%)?`,
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

  // Деление на сто общее для обеих ветвей: смешанное число со знаком процента
  // («12 1/2%») — такая же доля, как «12,5%», и ранний возврат из ветви
  // смешанного числа отдавал бы 12,5 вместо 0,125.
  const mixed = MIXED.exec(body);
  if (mixed !== null) {
    const [whole = NaN, numerator = NaN, denominator = NaN] = mixed.slice(1).map(Number);
    return (sign * (whole + numerator / denominator)) / (percent ? 100 : 1);
  }

  const [numerator, denominator] = body.replace(/\s+/g, '').split('/');
  const value =
    denominator === undefined
      ? Number(numerator?.replace(',', '.'))
      : Number(numerator?.replace(',', '.')) / Number(denominator.replace(',', '.'));
  return (sign * value) / (percent ? 100 : 1);
}

/** Разобранное число вместе с признаком, что оно записано со знаком процента. */
interface ParsedNumber {
  value: number;
  percent: boolean;
}

function parseNumbers(text: string): ParsedNumber[] {
  // Краевые пробелы снимаются до разбора: иначе знак в «  − 45» уже не в начале
  // строки и перестаёт читаться как знак.
  const prepared = text
    .trim()
    .replace(LEADING_FRACTION, '$<sign>0')
    .replace(GROUPING_SPACE, '$1');

  return [...prepared.matchAll(NUMBER)]
    .map((match) => ({
      value: toNumber(match[0]),
      percent: match[0].trimEnd().endsWith('%'),
    }))
    .filter((parsed) => Number.isFinite(parsed.value));
}

/**
 * Все числа, найденные в строке. Экспортируется ради разбора споров и тестов:
 * по длине списка видно, ответ ли это без числа или с двумя числами сразу.
 */
export function findNumbers(text: string): number[] {
  return parseNumbers(text).map((parsed) => parsed.value);
}

/**
 * Два законных прочтения ответа со знаком процента. «40%» — это и доля 0,4, и
 * сами сорок процентов: в теме про проценты эталон записан числом («Сколько
 * процентов класса составляют девочки?» — «40»), и деление на сто засчитывало
 * бы верный ответ неверным, а в теме про доли эталон как раз «0,4». Что имел в
 * виду ученик, из записи не видно, поэтому годятся оба прочтения.
 *
 * Только для ответа ученика: эталон «0,5» с вариантом «50%» — это доля, и
 * голое «50» рядом с ней остаётся другим числом, а не второй записью того же.
 */
function answerForms(parsed: ParsedNumber): number[] {
  return parsed.percent ? [parsed.value, parsed.value * 100] : [parsed.value];
}

/**
 * Текстовая нормализация: регистр, схлопывание пробелов, `ё` = `е` и
 * типографские апострофы. Сравниваются только нормализованные строки.
 *
 * U+0085 выписан отдельно, как и в `inlineField`: `\s` в JS его не покрывает ни
 * с флагом `u`, ни без него, и `trim` тоже не снимает. Ответ, где вместо
 * пробела приехал этот знак, иначе не сходился бы с эталоном — и ученик получал
 * бы «неверно» за верный ответ.
 */
export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(APOSTROPHES, "'")
    .replace(/[\s\u0085]+/g, ' ')
    .trim();
}

/**
 * Выбор сверяется той же нормализацией, что и текст: метка «A» и вариант
 * «A) Work in pairs» остаются разными записями, но регистр, «ё», апострофы и
 * разница в пробелах снимаются. Ученик вводит ответ руками, и «a» вместо «A» —
 * это тот же вариант, а не другой; промпт требует перечислять в `accept[]` и
 * метку, и текст варианта, но набрать метку строчной он предусмотреть не может.
 *
 * Следствие, о котором обязан знать промпт: варианты, отличающиеся **только**
 * буквой `ё` («все» и «всё»), сверке неразличимы, и задание с такой парой
 * засчитывает неверный выбор. `FORMAT_RULES` их прямо запрещает.
 *
 * Кириллические двойники латинских букв (`В` и `B`) при этом **не** сводятся:
 * в списке «А, Б, В» третий вариант выглядит ровно как второй вариант списка
 * «A, B, C», и такая замена засчитывала бы соседний вариант как верный.
 */
export function normalizeChoice(value: string): string {
  return normalizeText(value);
}

/**
 * Знаки действия и их синонимы: «·», «×» и «*» — одно и то же умножение, «:» и
 * «÷» — одно деление. Приводятся к одной записи и отбиваются пробелами, поэтому
 * «2+2» и «2 + 2» дают один отпечаток, а «2 + 2» и «2 · 2» — разные.
 */
const OPERATOR_FORMS: Record<string, string> = {
  '+': '+',
  '-': '-',
  '−': '-',
  '–': '-',
  '—': '-',
  '*': '*',
  '×': '*',
  '·': '*',
  '/': '/',
  '÷': '/',
  ':': '/',
  '=': '=',
  '%': '%',
};

/**
 * Знаки действия обязаны дожить до отпечатка: «4800 : 16 + 37 · 25» и
 * «4800 · 16 - 37 : 25» отличаются только ими. Снятые вместе с пунктуацией, они
 * делали такие задания неразличимыми — банк отвергал второе как повтор, а тема,
 * весь батч которой лёг на такие совпадения, переставала доливаться совсем.
 */
const OPERATORS = /[+*×·/÷:=%−–—-]/gu;

/**
 * Разделитель, стоящий не между цифрами: точка в конце предложения, запятая
 * после вводного слова. Внутри числа те же знаки значимы — «2,5» и «25» разные
 * условия, — поэтому вырезаются только краевые. Дефис и косая черта сюда не
 * входят: их раньше разбирает `OPERATORS`.
 */
const OUTER_SEPARATOR = /(?<!\p{N})[.,]|[.,](?!\p{N})/gu;

/** Всё остальное, что не буква, не цифра, не разделитель числа и не знак действия. */
const PUNCTUATION = /[^\p{L}\p{N}.,+*/=%-]+/gu;

/**
 * Отпечаток формулировки задания: по нему банк отсекает повторы внутри темы.
 * Снимает регистр, «ё», пунктуацию и разницу в пробелах, но **сохраняет числа и
 * знаки действия**: «сколько будет 2+2» и «сколько будет 3+5» — разные задания,
 * и склеив их, банк отверг бы всю тему после первого же задания.
 */
export function questionFingerprint(text: string): string {
  return normalizeText(text)
    .replace(OPERATORS, (sign) => ` ${OPERATOR_FORMS[sign] ?? sign} `)
    .replace(OUTER_SEPARATOR, ' ')
    .replace(PUNCTUATION, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

  const numbers = parseNumbers(trimmed);
  const only = numbers[0];
  if (only === undefined) return reject(trimmed, 'no-number');
  if (numbers.length > 1) return reject(trimmed, 'ambiguous-number');

  // Показывается та запись, которая совпала: ученику, ответившему «40%» на
  // эталон «40», нормализованное «0.4» читалось бы как «мне засчитали другое».
  const matched = answerForms(only).find((form) => wanted.some((value) => sameNumber(value, form)));
  return matched === undefined
    ? reject(String(only.value), 'mismatch')
    : { correct: true, normalized: String(matched) };
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
