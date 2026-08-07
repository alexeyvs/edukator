/**
 * Общий клиент codex CLI: запуск, аргументы, подготовка схемы для
 * `--output-schema`, разбор ответа. Ничего предметного здесь нет — ни карты
 * тем, ни заданий: и сборка карты, и генератор заданий зовут одно и то же.
 *
 * Данные, попадающие в промпт, считаются недоверенными (распознанное
 * оглавление, интересы ученика), поэтому вызов идёт без пользовательской
 * конфигурации, в read-only песочнице и с отключёнными инструментами.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { runChild } from '../run-child.js';

/** Рабочая модель из спеки: она уложилась в бюджет времени на генерацию. */
export const CODEX_MODEL = 'gpt-5.6-terra';

/** Запасная модель: берётся вручную, когда рабочая недоступна или деградировала. */
export const CODEX_FALLBACK_MODEL = 'gpt-5.6-luna';

/** Сколько раз ответ модели прогоняется через проверку, прежде чем вызывающий сдаётся. */
export const DEFAULT_ATTEMPTS = 3;
export const CODEX_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Ключевые слова, которые структурированный вывод не принимает: запрос падает
 * с `invalid_json_schema` ещё до обращения к модели. Ограничения от этого не
 * теряются — их проверяет валидатор на стороне вызывающего, а нарушение уходит
 * в промпт следующей попытки. Диапазоны дублируются словами в `description` и
 * в промпте, чтобы модель о них всё-таки знала.
 */
const UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  'uniqueItems',
  'minItems',
  'maxItems',
  'contains',
  'minContains',
  'maxContains',
  'unevaluatedItems',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minProperties',
  'maxProperties',
  'patternProperties',
  'propertyNames',
  'unevaluatedProperties',
]);

/** Копия схемы без запрещённых структурированным выводом ключевых слов. */
export function codexOutputSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(codexOutputSchema);
  if (schema === null || typeof schema !== 'object') return schema;

  return Object.fromEntries(
    Object.entries(schema as Record<string, unknown>)
      .filter(([key]) => !UNSUPPORTED_SCHEMA_KEYWORDS.has(key))
      .map(([key, value]) => [key, codexOutputSchema(value)]),
  );
}

/**
 * Кладёт схему для `--output-schema` рядом с ответом и возвращает путь к ней.
 * Имя берётся от исходной схемы: `schemas/tasks.json` → `tasks.codex.json`,
 * так в рабочем каталоге видно, чья это копия.
 */
export function writeCodexSchema(dir: string, sourcePath: string): string {
  const source = JSON.parse(readFileSync(sourcePath, 'utf8')) as unknown;
  const path = join(dir, `${basename(sourcePath).replace(/\.json$/, '')}.codex.json`);
  writeFileSync(path, `${JSON.stringify(codexOutputSchema(source), null, 2)}\n`);
  return path;
}

export interface CodexRequest {
  prompt: string;
  /** JSON Schema для `--output-schema`: модель обязана ответить строго по ней. */
  schemaPath: string;
  /** Файл для `-o`: туда codex кладёт последнее сообщение агента. */
  outPath: string;
  /** Модель; по умолчанию рабочая, запасная указывается явно. */
  model?: string;
  /** Имя исполняемого файла: тесты подсовывают сюда заглушку. */
  bin?: string;
  /** Максимальное время одного вызова; тесты уменьшают его для зависшей заглушки. */
  timeoutMs?: number;
  /** Общий предел stdout + stderr внешнего процесса. */
  maxOutputBytes?: number;
}

/** Вызов codex, вынесенный за интерфейс: тесты подменяют его, не запуская модель. */
export type CodexRunner = (request: CodexRequest) => Promise<string>;

/** codex не установлен или не запускается: повторять попытки бессмысленно. */
export class CodexUnavailableError extends Error {}

/**
 * Аргументы командной строки codex. Вынесены отдельно, чтобы состав флагов
 * проверялся тестом, а не глазами: `--ephemeral` бережёт диск от сессий,
 * `--skip-git-repo-check` нужен для запуска вне репозитория.
 */
export function codexArgs(request: CodexRequest): string[] {
  return [
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    // Всё, что уходит в промпт, — недоверенные данные. Агенту здесь не нужны
    // инструменты: отключение shell не даёт инъекции читать локальные файлы,
    // тогда как один read-only sandbox запрещает лишь запись.
    '--disable',
    'shell_tool',
    '--disable',
    'unified_exec',
    '--sandbox',
    'read-only',
    '--cd',
    dirname(request.outPath),
    '-m',
    request.model ?? CODEX_MODEL,
    '--output-schema',
    request.schemaPath,
    '-o',
    request.outPath,
    request.prompt,
  ];
}

/**
 * Запускает codex и возвращает последнее сообщение агента.
 *
 * stdin закрыт (`stdio[0] = 'ignore'` — то же самое, что `< /dev/null` в
 * командной строке). Без этого codex считает, что промпт придёт из потока, и
 * висит бесконечно, ничего не сообщая.
 */
export async function runCodexCli(request: CodexRequest): Promise<string> {
  let result;
  try {
    result = await runChild({
      bin: request.bin ?? 'codex',
      args: codexArgs(request),
      label: 'codex',
      timeoutMs: request.timeoutMs ?? CODEX_TIMEOUT_MS,
      ...(request.maxOutputBytes === undefined ? {} : { maxOutputBytes: request.maxOutputBytes }),
    });
  } catch (error) {
    const system = error as NodeJS.ErrnoException;
    if (system.code === 'ENOENT') {
      throw new CodexUnavailableError(
        `codex не найден: ожидался исполняемый файл «${request.bin ?? 'codex'}» в PATH`,
      );
    }
    throw error;
  }
  if (result.code !== 0) {
    throw new Error(
      `codex завершился с кодом ${result.code}: ${(result.stderr + result.stdout).trim()}`,
    );
  }
  const stderr = result.stderr;

  let answer: string;
  try {
    answer = readFileSync(request.outPath, 'utf8');
  } catch (error) {
    throw new Error(
      `codex не записал ответ в ${request.outPath}: ${(error as Error).message}` +
        (stderr.trim() === '' ? '' : `; stderr: ${stderr.trim()}`),
    );
  }

  if (answer.trim() === '') {
    throw new Error(`codex вернул пустой ответ в ${request.outPath}`);
  }

  return answer;
}

/**
 * Достаёт JSON из ответа модели. `--output-schema` обязывает codex вернуть
 * чистый JSON, но обрамление ```json встречается достаточно часто, чтобы не
 * ронять из-за него целую попытку.
 */
export function parseCodexAnswer(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') throw new Error('ответ codex пуст');

  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  const text = fenced === null ? trimmed : (fenced[1] ?? '');

  try {
    return JSON.parse(text);
  } catch (error) {
    const head = text.slice(0, 200);
    throw new Error(
      `ответ codex не разбирается как JSON: ${(error as Error).message}; начало ответа: ${head}`,
    );
  }
}
