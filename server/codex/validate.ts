/**
 * Проверка сгенерированного батча вторым вызовом codex. Валидатор получает
 * условия и подсказки — без ответов и разборов, — решает каждое задание сам и
 * отдельно оценивает пять вещей: условие однозначно, ситуация не натянута, тема
 * заявленная, содержание уместно подростку, подсказка не раскрывает ответ.
 *
 * Ответ валидатора сверяется с эталоном генератора нормализатором, а не
 * строкой: «−45» и «-45 монет» — один и тот же ответ, и считать их разными
 * значило бы выбрасывать годные задания пачками. Расхождение ответов или любая
 * проваленная оценка отправляют задание в отбраковку с записанной причиной —
 * по ней потом видно, что именно портит генерацию.
 *
 * Батч не проходит целиком, если вердиктов пришло не столько же, сколько
 * заданий: соответствие тут позиционное, и при другой длине неизвестно, к чему
 * относится каждый вердикт.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import type { AnswerFormat, Topic } from '../curriculum.js';
import { checkAnswer } from '../normalize.js';
import { describeSchemaErrors, schemaValidator } from '../json-schema.js';
import {
  modelForRole,
  parseCodexAnswer,
  runCodexCli,
  writeCodexSchema,
  type CodexRunner,
} from './client.js';
import { buildValidationPrompt } from './prompt.js';
import type { GeneratedTask } from './task-schema.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Схема вердиктов. Она же уходит в codex через `--output-schema`. */
export const VERDICTS_SCHEMA_PATH = resolve(here, '..', '..', 'schemas', 'verdicts.json');

/** Предел длины замечания валидатора: причина отбраковки читается человеком. */
export const MAX_NOTE_LENGTH = 300;

/** Вердикт по одному заданию: собственный ответ проверяющего и пять оценок. */
export interface Verdict {
  answer: string;
  unambiguous: boolean;
  natural: boolean;
  onTopic: boolean;
  ageAppropriate: boolean;
  hintSafe: boolean;
  hintUseful?: boolean;
  deepHintSafe?: boolean;
  deepHintUseful?: boolean;
  wordOrderValid?: boolean;
  note: string;
}

/** Вердикт как его отдаёт модель: ровно поля схемы, snake_case. */
interface VerdictJson {
  answer: string;
  unambiguous: boolean;
  natural: boolean;
  on_topic: boolean;
  age_appropriate: boolean;
  hint_safe: boolean;
  hint_useful: boolean;
  deep_hint_safe: boolean;
  deep_hint_useful: boolean;
  word_order_valid: boolean;
  note: string;
}

interface VerdictBatchJson {
  items: VerdictJson[];
}

export interface RejectedTask {
  task: GeneratedTask;
  /** Все проваленные проверки одной строкой: сохраняется для диагностики. */
  reason: string;
}

export interface ValidateTasksResult {
  accepted: GeneratedTask[];
  rejected: RejectedTask[];
}

export interface ValidateTasksOptions {
  topic: Topic;
  tasks: readonly GeneratedTask[];
  model?: string;
  /** Подменяемый вызов codex: тесты передают заглушку. */
  run?: CodexRunner;
  timeoutMs?: number;
}

/** Пять оценок: всё, кроме собственного ответа проверяющего и замечания. */
type VerdictCheck =
  | 'unambiguous' | 'natural' | 'onTopic' | 'ageAppropriate'
  | 'hintSafe' | 'hintUseful' | 'deepHintSafe' | 'deepHintUseful' | 'wordOrderValid';

/** Оценки вердикта и текст отбраковки, когда оценка провалена. */
const CHECKS: { key: VerdictCheck; problem: string }[] = [
  { key: 'unambiguous', problem: 'условие читается неоднозначно или данных не хватает' },
  { key: 'natural', problem: 'ситуация натянута' },
  { key: 'onTopic', problem: 'задание не о заявленной теме' },
  { key: 'ageAppropriate', problem: 'содержание не годится подростку' },
  { key: 'hintSafe', problem: 'подсказка раскрывает ответ прямо или однозначно' },
  { key: 'hintUseful', problem: 'краткая подсказка не даёт полезного направления' },
  { key: 'deepHintSafe', problem: 'расширенная подсказка раскрывает ответ или повторяет данные задания' },
  { key: 'deepHintUseful', problem: 'расширенная подсказка не даёт полезной теории и двух разборов' },
  { key: 'wordOrderValid', problem: 'карточки нельзя однозначно собрать или они уже стоят правильно' },
];

/** Разбирает ответ валидатора. `expected` — сколько заданий ушло на проверку. */
export function parseVerdictBatch(raw: unknown, expected: number): Verdict[] {
  const validate = schemaValidator<VerdictBatchJson>(VERDICTS_SCHEMA_PATH);
  if (!validate(raw)) {
    throw new Error(`Вердикты не соответствуют схеме: ${describeSchemaErrors(validate.errors)}`);
  }

  if (raw.items.length !== expected) {
    throw new Error(
      `Проверяющий вернул ${raw.items.length} вердикт(ов) на ${expected} задани(й): ` +
        'соответствие позиционное, при другой длине неизвестно, к чему относится каждый',
    );
  }

  return raw.items.map((item) => ({
    answer: item.answer,
    unambiguous: item.unambiguous,
    natural: item.natural,
    onTopic: item.on_topic,
    ageAppropriate: item.age_appropriate,
    hintSafe: item.hint_safe,
    hintUseful: item.hint_useful,
    deepHintSafe: item.deep_hint_safe,
    deepHintUseful: item.deep_hint_useful,
    wordOrderValid: item.word_order_valid,
    note: item.note,
  }));
}

/**
 * Сверяет ответ проверяющего с эталоном задания. Эталон приходит из разбора
 * батча и обязан быть пригоден нормализатору, но задание могло прийти и из
 * банка: непригодный эталон — повод отбраковать задание, а не уронить весь
 * батч, потому что вручную такое всё равно чинить по одному.
 */
function answerMatches(task: GeneratedTask, verdict: Verdict, format: AnswerFormat): string | null {
  let correct: boolean;
  try {
    correct = checkAnswer(verdict.answer, { answer: task.answer, accept: task.accept }, format)
      .correct;
  } catch (error) {
    return `эталон задания не сверяется нормализатором: ${(error as Error).message}`;
  }

  return correct
    ? null
    : `проверяющий ответил «${verdict.answer}», а эталон — «${task.answer}»`;
}

function taskProblems(task: GeneratedTask, verdict: Verdict, format: AnswerFormat): string[] {
  const mismatch = answerMatches(task, verdict, format);

  return [
    ...(mismatch === null ? [] : [mismatch]),
    ...CHECKS.filter(({ key }) => verdict[key] === false).map(({ problem }) => problem),
  ];
}

/** Пары «задание — вердикт». Длины сверены разбором, проверка нужна строгому индексу. */
function pairs(
  tasks: readonly GeneratedTask[],
  verdicts: readonly Verdict[],
): { task: GeneratedTask; verdict: Verdict }[] {
  return tasks.map((task, index) => {
    const verdict = verdicts[index];
    if (verdict === undefined) throw new Error(`Вердикт по заданию ${index + 1} потерян`);
    return { task, verdict };
  });
}

/**
 * Проверяет батч и делит его на принятые и отбракованные задания.
 *
 * Бросает `CodexUnavailableError`, если codex не запускается, и обычную ошибку,
 * если ответ валидатора не разобрался: повторов здесь нет — воркеру дешевле
 * сгенерировать новый батч, чем уговаривать проверяющего.
 */
export async function validateTaskBatch(
  options: ValidateTasksOptions,
): Promise<ValidateTasksResult> {
  const { topic } = options;
  const tasks = [...options.tasks];
  // Пустой батч — не ошибка, а обычный итог генерации, из которой всё отсеяли
  // раньше. Звать ради него codex незачем.
  if (tasks.length === 0) return { accepted: [], rejected: [] };

  const run = options.run ?? runCodexCli;
  const workDir = mkdtempSync(join(tmpdir(), 'edukator-verdicts-'));

  let verdicts: Verdict[];
  try {
    const answer = await run({
      prompt: buildValidationPrompt({ topic, tasks }),
      schemaPath: writeCodexSchema(workDir, VERDICTS_SCHEMA_PATH),
      outPath: join(workDir, 'verdicts.json'),
      model: options.model ?? modelForRole('validate'),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    verdicts = parseVerdictBatch(parseCodexAnswer(answer), tasks.length);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  const accepted: GeneratedTask[] = [];
  const rejected: RejectedTask[] = [];

  for (const { task, verdict } of pairs(tasks, verdicts)) {
    const problems = taskProblems(task, verdict, topic.answerFormat);
    if (problems.length === 0) {
      accepted.push(task);
      continue;
    }

    const note = verdict.note.trim().slice(0, MAX_NOTE_LENGTH);
    rejected.push({
      task,
      reason: problems.join('; ') + (note === '' ? '' : ` (проверяющий: «${note}»)`),
    });
  }

  return { accepted, rejected };
}
