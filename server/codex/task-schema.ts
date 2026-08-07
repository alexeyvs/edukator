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
 * Числовой эталон обязан читаться однозначно: «сорок пять» или «45 или 46» в
 * `accept[]` числовой темы уронят нормализатор на первом же ответе ученика.
 */
function readsAsOneNumber(value: string): boolean {
  return findNumbers(value).length === 1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Подсказка не должна содержать ответ. Совпадение ищется по границе слова, но
 * не через `\b`: она в JS только ASCII, а ответы бывают и русскими словами.
 * Иначе подсказка «начни с 450 монет» считалась бы раскрывающей ответ 45.
 */
function revealsAnswer(hint: string, answer: string): boolean {
  const needle = normalizeText(answer);
  if (needle === '') return false;

  const boundary = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`, 'u');
  return boundary.test(normalizeText(hint));
}

function taskProblems(task: GeneratedTask, format: AnswerFormat): string[] {
  const problems: string[] = [];

  // Числовая пригодность проверяется первой: сверка `answer` с `accept[]` идёт
  // нормализатором, а он на нечисловом эталоне числовой темы бросает.
  let numbersFit = true;
  if (format === 'number') {
    for (const value of [task.answer, ...task.accept]) {
      if (!readsAsOneNumber(value)) {
        numbersFit = false;
        problems.push(`запись «${value}» не читается как одно число, а тема числовая`);
      }
    }
  }

  const seen = new Set<string>();
  for (const value of task.accept) {
    const key = duplicateKey(value, format);
    if (seen.has(key)) problems.push(`запись «${value}» дублирует другую в accept[]`);
    seen.add(key);
  }

  if (numbersFit && !task.accept.some((value) => checkAnswer(task.answer, { answer: value }, format).correct)) {
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
