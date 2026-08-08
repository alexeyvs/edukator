/**
 * Разбор батча заданий, пришедшего от codex: проверка по JSON Schema плюс
 * инварианты, которые схемой не выражаются, — согласованность `answer` с
 * `accept[]`, отсутствие ответа в подсказке и пригодность записей `accept[]`
 * для нормализатора выбранного темой формата.
 *
 * Текст ошибки собирается по всем заданиям сразу: он дописывается в промпт
 * повторной попытки, и одна проблема за вызов означала бы три попытки на три
 * дефекта одного батча.
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { AnswerFormat } from '../curriculum.js';
import { checkAnswer, findNumbers, normalizeChoice, normalizeText } from '../normalize.js';
import { describeSchemaErrors, schemaValidator } from '../json-schema.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Схема батча заданий. Она же уходит в codex через `--output-schema`. */
export const TASKS_SCHEMA_PATH = resolve(here, '..', '..', 'schemas', 'tasks.json');

/** Задание, каким его отдаёт генератор: ровно поля схемы, до записи в банк. */
export interface GeneratedTask {
  question: string;
  answer: string;
  /** Равноправные записи ответа, включая сам `answer`: с ними сверяется нормализатор. */
  accept: string[];
  hint: string;
  explain: string;
  joke: string;
  /** 1-3. */
  difficulty: number;
}

interface TaskBatchJson {
  items: GeneratedTask[];
}

/**
 * Ключ для поиска повторов внутри `accept[]`. Берётся нормализация того же
 * формата, которым потом сверяется ответ ученика: две записи, неотличимые для
 * нормализатора, — мусор, а не варианты.
 *
 * Экспортируется ради разбора спора: подтверждённый ответ ученика дописывается
 * в `accept[]`, и решать там, что считать повтором, надо ровно так же.
 */
export function duplicateKey(value: string, format: AnswerFormat): string {
  return format === 'choice' ? normalizeChoice(value) : normalizeText(value);
}

/**
 * Числовой эталон обязан читаться однозначно: на «45 или 46» нормализатор не
 * знает, что считать верным.
 */
function readsAsOneNumber(value: string): boolean {
  return findNumbers(value).length === 1;
}

/**
 * Знак процента в записи числовой темы. Нормализатор читает «40%» как долю 0,4,
 * поэтому запись «40%» рядом с ответом «40» приняла бы 0,4 — ответ, ошибочный
 * ровно в сто раз, — и подняла бы за него `mastery`. Ученику она при этом не
 * нужна: «40%» разворачивается в оба прочтения только для ответа ученика, и он
 * засчитывается уже по самому `answer`.
 *
 * Проверяется отдельно от числа: `findNumbers` знак процента не видит и «40%»
 * для неё такое же одно число, как «40».
 */
function hasPercentSign(value: string): boolean {
  return value.includes('%');
}

/**
 * Запись `accept[]` числовой темы: либо одно число («45», «45 монет»), либо
 * вовсе без чисел — словесная форма вроде «сорок пять». Второе сверяется как
 * текст (`numberExpectations`), и запрещать его нельзя: разбор спора дописывает
 * в `accept[]` подтверждённый ответ ученика как есть, а этот же `parseTaskBatch`
 * потом читает выгруженный посевной файл. Запрет ломал бы задание навсегда
 * после первого же спора. Отсеивается ровно неоднозначное — два числа и больше,
 * знак процента и число, отличное от самого ответа.
 *
 * Последнее — не придирка к форме: `accept[]` перечисляет записи **того же**
 * ответа, и «46» рядом с ответом «45» означает, что сверка засчитает неверный
 * ответ верным и поднимет за него `mastery`. Ловится только здесь: проверяющий
 * сверяет своё решение со всем `accept[]` целиком, и его «46» такую пару как раз
 * подтвердит. Эталон, который сам не читается числом, до сравнения не доходит —
 * про него уже сказано отдельной причиной.
 */
function fitsNumberTopic(value: string, answer: string): boolean {
  if (findNumbers(value).length > 1 || hasPercentSign(value)) return false;
  if (!readsAsOneNumber(value) || !readsAsOneNumber(answer) || hasPercentSign(answer)) return true;
  return checkAnswer(value, { answer }, 'number').correct;
}

/**
 * Годится ли строка в `accept[]` вообще. Тот же вопрос, что `parseTaskBatch`
 * задаёт записям батча, но нужен и разбору спора: подтверждённый ответ ученика
 * дописывается в `accept[]` как есть, а выгруженный посевной файл читается
 * обратно этим же разбором. Пустая строка (её отвергает `minLength` схемы) и
 * «45 и 46» на числовой теме сделали бы посев предмета неразбираемым навсегда,
 * а «40%» — засчитывало бы 0,4 за ответ 40 (см. `hasPercentSign`).
 *
 * `answer` нужен ровно затем же: подтверждённое спором «46» при эталоне «45» —
 * другое число, и дописать его значило бы завести задание, которое `taskProblems`
 * потом забракует, а до тех пор засчитывало бы обе взаимоисключающие записи.
 * Сам спор при этом остаётся подтверждённым — не принимается только запись в
 * `accept[]`.
 */
export function fitsAccept(value: string, format: AnswerFormat, answer: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '') return false;
  return format !== 'number' || fitsNumberTopic(trimmed, answer);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Ниже этой длины буквенный ответ на раскрытие не проверяется. Ответ в один-два
 * знака — это буква фонетики («о», «б»), метка варианта («A») или служебное
 * слово английского («a», «an»), и они же стоят предлогом, союзом и артиклем в
 * любой осмысленной подсказке: «подумай **о** проверочном слове» считалось бы
 * раскрытием ответа «о». Ложное срабатывание тут дороже пропуска — оно роняет
 * весь батч, и темы с односимвольным ответом (фонетика, морфемика) остались бы
 * без заданий совсем.
 *
 * На цифры послабление не распространяется: короткий числовой ответ «45» в
 * подсказке — настоящее раскрытие, служебных чисел не бывает.
 */
export const MIN_REVEAL_LENGTH = 3;

/**
 * Знаки, которые связывают цифры в одно число: разделитель десятичной дроби и
 * черта обыкновенной. Цифра ответа, стоящая к такому знаку вплотную, — часть
 * чужого числа, а не раскрытие: «45» в подсказке «выросло с 45,5 до 60» и в
 * «приведи к 45/2» — это 45,5 и 22,5. Граница «не буква и не цифра» их не
 * отсекает (запятая под неё как раз подходит), а цена промаха здесь не одно
 * задание: `parseTaskBatch` роняет весь батч, а в посевном файле — весь предмет.
 */
const NUMBER_GLUE = '[.,/]';

/**
 * Подсказка не должна содержать ответ. Совпадение ищется по границе слова, но
 * не через `\b`: она в JS только ASCII, а ответы бывают и русскими словами.
 * Иначе подсказка «начни с 450 монет» считалась бы раскрывающей ответ 45.
 */
function revealsAnswer(hint: string, answer: string): boolean {
  const needle = normalizeText(answer);
  if (needle.length < MIN_REVEAL_LENGTH && !/\p{N}/u.test(needle)) return false;

  // Склейка проверяется только с той стороны, где у самого ответа стоит цифра:
  // у словесного ответа соседняя запятая — обычная пунктуация, и запрет на неё
  // пропускал бы настоящее раскрытие в «вспомни про did, дальше сам».
  const glueBefore = /^\p{N}/u.test(needle) ? `(?<!\\p{N}${NUMBER_GLUE})` : '';
  const glueAfter = /\p{N}$/u.test(needle) ? `(?!${NUMBER_GLUE}\\p{N})` : '';
  const boundary = new RegExp(
    `(?<![\\p{L}\\p{N}])${glueBefore}${escapeRegExp(needle)}(?![\\p{L}\\p{N}])${glueAfter}`,
    'u',
  );
  return boundary.test(normalizeText(hint));
}

function taskProblems(task: GeneratedTask, format: AnswerFormat): string[] {
  const problems: string[] = [];

  // Числовая пригодность проверяется первой: сверка `answer` с `accept[]` идёт
  // нормализатором, а он на нечисловом эталоне числовой темы бросает.
  let numbersFit = true;
  if (format === 'number') {
    if (!readsAsOneNumber(task.answer)) {
      numbersFit = false;
      problems.push(`ответ «${task.answer}» не читается как одно число, а тема числовая`);
    } else if (hasPercentSign(task.answer)) {
      // Эталон «40%» нормализатор читает как долю 0,4, а два прочтения («40%» —
      // это и 0,4, и сорок) он разворачивает только для ответа ученика. Ученик,
      // написавший требуемое формой «40», получил бы незачёт на верном ответе,
      // и починить это можно было бы только спором. Знак процента — часть
      // условия, а не ответа.
      numbersFit = false;
      problems.push(`ответ «${task.answer}» записан со знаком процента, а тема числовая: нужно голое число`);
    }
    for (const value of task.accept) {
      // Причины разводятся: «40%» — одно число для `findNumbers`, и сообщение
      // про «больше одного числа» отправило бы генератор чинить не то.
      if (findNumbers(value).length > 1) {
        numbersFit = false;
        problems.push(`запись «${value}» содержит больше одного числа, а тема числовая`);
      } else if (hasPercentSign(value)) {
        numbersFit = false;
        problems.push(
          `запись «${value}» содержит знак процента, а тема числовая: она приняла бы долю вместо числа`,
        );
      } else if (!fitsNumberTopic(value, task.answer)) {
        // Сюда доходит ровно одно: одно число, не равное эталону. Словесная
        // запись («сорок пять») законна и в сравнение не идёт, а негодный
        // эталон уже назван своей причиной выше.
        numbersFit = false;
        problems.push(`запись «${value}» — другое число, чем ответ «${task.answer}»`);
      }
    }
  }

  const seen = new Set<string>();
  for (const value of task.accept) {
    const key = duplicateKey(value, format);
    if (seen.has(key)) problems.push(`запись «${value}» дублирует другую в accept[]`);
    seen.add(key);
  }

  // Словесные записи `accept[]` числовой темы в сверку не идут: эталоном их
  // подставлять нельзя (нормализатор требует от эталона число), да и совпасть с
  // числовым `answer` они не могут.
  const acceptsAnswer = task.accept.some((value) =>
    format === 'number' && !readsAsOneNumber(value)
      ? false
      : checkAnswer(task.answer, { answer: value }, format).correct,
  );
  if (numbersFit && !acceptsAnswer) {
    problems.push(`ответ «${task.answer}» отсутствует в accept[]`);
  }

  if (revealsAnswer(task.hint, task.answer)) {
    problems.push(`подсказка содержит ответ «${task.answer}»`);
  }

  return problems;
}

/**
 * Разбирает ответ codex в задания. `format` — `answer_format` темы, под которую
 * шла генерация: от него зависит, чем сверяется `accept[]`.
 */
export function parseTaskBatch(raw: unknown, format: AnswerFormat): GeneratedTask[] {
  const validate = schemaValidator<TaskBatchJson>(TASKS_SCHEMA_PATH);
  if (!validate(raw)) {
    throw new Error(`Батч заданий не соответствует схеме: ${describeSchemaErrors(validate.errors)}`);
  }

  const problems = raw.items.flatMap((task, index) =>
    taskProblems(task, format).map((problem) => `задание ${index + 1}: ${problem}`),
  );
  if (problems.length > 0) {
    throw new Error(`Батч заданий: ${problems.join('; ')}`);
  }

  return raw.items.map((task) => ({ ...task, accept: [...task.accept] }));
}
