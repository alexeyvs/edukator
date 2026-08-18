import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describeSchemaErrors, schemaValidator } from '../json-schema.js';
import {
  modelForRole,
  parseCodexAnswer,
  runCodexCli,
  writeCodexSchema,
  type CodexRunner,
} from './client.js';
import { buildIntegrityPrompt, type IntegrityPromptItem } from './prompt.js';

const here = dirname(fileURLToPath(import.meta.url));

export const INTEGRITY_SCHEMA_PATH = resolve(here, '..', '..', 'schemas', 'integrity-review.json');
export const MAX_INTEGRITY_REASON_LENGTH = 300;

export type IntegrityDecision = 'meaningful' | 'doubtful' | 'junk';

export interface IntegrityVerdict {
  id: number;
  decision: IntegrityDecision;
  confidence: number;
  reason: string;
}

interface IntegrityReviewJson {
  items: Array<{
    id: number;
    decision: IntegrityDecision;
    confidence: number;
    reason: string;
  }>;
}

export type IntegrityReviewer = (
  items: readonly IntegrityPromptItem[],
) => Promise<IntegrityVerdict[]>;

export function parseIntegrityReview(raw: unknown, expectedIds: readonly number[]): IntegrityVerdict[] {
  const validate = schemaValidator<IntegrityReviewJson>(INTEGRITY_SCHEMA_PATH);
  if (!validate(raw)) {
    throw new Error(`Проверка осмысленности не соответствует схеме: ${describeSchemaErrors(validate.errors)}`);
  }
  const expected = new Set(expectedIds);
  const found = new Set<number>();
  for (const item of raw.items) {
    if (!expected.has(item.id) || found.has(item.id)) {
      throw new Error(`Проверка осмысленности вернула неожиданный или повторный id ${item.id}`);
    }
    if (!Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
      throw new Error(`Проверка осмысленности вернула confidence вне диапазона для id ${item.id}`);
    }
    found.add(item.id);
  }
  if (found.size !== expected.size) {
    throw new Error('Проверка осмысленности вернула вердикты не для всех ответов');
  }
  return raw.items.map((item) => ({
    ...item,
    reason: item.reason.trim().slice(0, MAX_INTEGRITY_REASON_LENGTH),
  }));
}

export interface ReviewIntegrityOptions {
  model?: string;
  run?: CodexRunner;
  timeoutMs?: number;
}

export async function reviewIntegrity(
  items: readonly IntegrityPromptItem[],
  options: ReviewIntegrityOptions = {},
): Promise<IntegrityVerdict[]> {
  const run = options.run ?? runCodexCli;
  const workDir = mkdtempSync(join(tmpdir(), 'edukator-integrity-'));
  try {
    const answer = await run({
      prompt: buildIntegrityPrompt(items),
      schemaPath: writeCodexSchema(workDir, INTEGRITY_SCHEMA_PATH),
      outPath: join(workDir, 'integrity-review.json'),
      model: options.model ?? modelForRole('integrity'),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    return parseIntegrityReview(parseCodexAnswer(answer), items.map((item) => item.id));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export function integrityReviewer(options: ReviewIntegrityOptions = {}): IntegrityReviewer {
  return (items) => reviewIntegrity(items, options);
}
