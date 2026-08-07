/**
 * Разбор спорного ответа через codex: ученик нажал «я всё-таки прав», а сверка
 * его ответ не засчитала. Разбирающий получает условие, эталон, уже
 * засчитываемые записи и ответ ученика и отвечает одним вердиктом.
 *
 * Повторов здесь нет намеренно. Спор разбирается фоном, ученик ответа не ждёт,
 * а недоступный codex — обычное дело: спор остаётся открытым и разберётся
 * следующей попыткой, тогда как три вызова подряд ради него заняли бы очередь,
 * которой греется банк заданий.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import type { Topic } from '../curriculum.js';
import { describeSchemaErrors, schemaValidator } from '../json-schema.js';
import {
  modelForRole,
  parseCodexAnswer,
  runCodexCli,
  writeCodexSchema,
  type CodexRunner,
} from './client.js';
import { buildDisputePrompt } from './prompt.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Схема вердикта по спору. Она же уходит в codex через `--output-schema`. */
export const DISPUTE_SCHEMA_PATH = resolve(here, '..', '..', 'schemas', 'dispute.json');

/** Предел длины обоснования: оно ложится в `disputes.resolution` и читается человеком. */
export const MAX_RESOLUTION_LENGTH = 300;

/** Спор, каким его видит разбирающий: ответов на другие задания он не получает. */
export interface DisputeContext {
  topic: Topic;
  question: string;
  /** Эталонный ответ задания. */
  expected: string;
  /** Записи, которые сверка уже считает верными. */
  accept: string[];
  /** Ответ ученика, который сверка не засчитала. */
  given: string;
}

export interface DisputeReview {
  /** Ответ ученика означает то же, что эталон. */
  studentCorrect: boolean;
  /** Обоснование одной фразой: сохраняется в `disputes.resolution`. */
  note: string;
}

/**
 * Разбирающий спор. Вынесен за интерфейс по той же причине, что и производитель
 * заданий у воркера: маршруты и пересчёт модели проверяются без запуска codex.
 */
export type DisputeReviewer = (context: DisputeContext) => Promise<DisputeReview>;

/** Вердикт как его отдаёт модель: ровно поля схемы, snake_case. */
interface DisputeReviewJson {
  student_correct: boolean;
  note: string;
}

/** Разбирает ответ модели по спору. */
export function parseDisputeReview(raw: unknown): DisputeReview {
  const validate = schemaValidator<DisputeReviewJson>(DISPUTE_SCHEMA_PATH);
  if (!validate(raw)) {
    throw new Error(`Разбор спора не соответствует схеме: ${describeSchemaErrors(validate.errors)}`);
  }

  return {
    studentCorrect: raw.student_correct,
    note: raw.note.trim().slice(0, MAX_RESOLUTION_LENGTH),
  };
}

export interface ReviewDisputeOptions {
  model?: string;
  /** Подменяемый вызов codex: тесты передают заглушку. */
  run?: CodexRunner;
  timeoutMs?: number;
}

/**
 * Спрашивает codex, прав ли ученик.
 *
 * Бросает `CodexUnavailableError`, если codex не запускается, и обычную ошибку,
 * если ответ не разобрался: и то и другое оставляет спор открытым.
 */
export async function reviewDispute(
  context: DisputeContext,
  options: ReviewDisputeOptions = {},
): Promise<DisputeReview> {
  const run = options.run ?? runCodexCli;
  const workDir = mkdtempSync(join(tmpdir(), 'edukator-dispute-'));

  try {
    const answer = await run({
      prompt: buildDisputePrompt({
        topic: context.topic,
        question: context.question,
        expected: context.expected,
        accept: context.accept,
        given: context.given,
      }),
      schemaPath: writeCodexSchema(workDir, DISPUTE_SCHEMA_PATH),
      outPath: join(workDir, 'dispute.json'),
      model: options.model ?? modelForRole('dispute'),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    return parseDisputeReview(parseCodexAnswer(answer));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/** Разбирающий с зафиксированными настройками: его ждёт `resolveDispute`. */
export function disputeReviewer(options: ReviewDisputeOptions = {}): DisputeReviewer {
  return (context) => reviewDispute(context, options);
}
