/**
 * Общий клиент codex CLI: запуск, аргументы, подготовка схемы для
 * `--output-schema`, разбор ответа. Ничего предметного здесь нет — ни карты
 * тем, ни заданий: и сборка карты, и генератор заданий зовут одно и то же.
 *
 * Данные, попадающие в промпт, считаются недоверенными (распознанное
 * оглавление, интересы ученика), поэтому вызов идёт без пользовательской
 * конфигурации, в read-only песочнице и с отключёнными инструментами.
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  ChildOutputLimitError,
  ChildTimeoutError,
  MAX_CHILD_OUTPUT_BYTES,
  runChild,
} from '../run-child.js';

/**
 * Модель по умолчанию для всех ролей.
 *
 * Замер 2026-08-07 на батче из 5 заданий (тема «Глагол: спряжение и вид»):
 * sol 29.1 с против terra 32.1 с — на реальной нагрузке sol не медленнее.
 * Ранний замер (15.5 с против 9.7 с) снят на тривиальном промпте и на батчи
 * не переносится. Полнота `accept[]` сопоставима, но sol сам перечисляет
 * сокращения («несов. вид», «несов.»), из-за отсутствия которых валидатор
 * браковал половину батча на открытых формулировках.
 */
export const CODEX_MODEL = 'gpt-5.6-sol';

/** Запасная модель: берётся вручную, когда рабочая недоступна или деградировала. */
export const CODEX_FALLBACK_MODEL = 'gpt-5.6-terra';

/**
 * Роли вызовов codex. Модель задаётся на роль, а не одна на всё: валидатор
 * решает задания независимо от генератора, и если он слабее, то начинает
 * браковать верные задания — расхождение ответов он трактует как ошибку
 * генератора, а не свою.
 */
export const CODEX_ROLES = ['generate', 'validate', 'dispute', 'curriculum'] as const;

export type CodexRole = (typeof CODEX_ROLES)[number];

/** Переменная окружения на роль: смена модели не требует правки кода. */
export const CODEX_ROLE_ENV: Record<CodexRole, string> = {
  generate: 'EDUKATOR_MODEL_GENERATE',
  validate: 'EDUKATOR_MODEL_VALIDATE',
  dispute: 'EDUKATOR_MODEL_DISPUTE',
  curriculum: 'EDUKATOR_MODEL_CURRICULUM',
};

/**
 * Модель для роли: переменная окружения, иначе `CODEX_MODEL`. Пустая или
 * состоящая из пробелов переменная считается незаданной — иначе `VAR=` в
 * окружении молча запускал бы codex без `-m` с чужим умолчанием.
 */
export function modelForRole(role: CodexRole, env: NodeJS.ProcessEnv = process.env): string {
  if (!CODEX_ROLES.includes(role)) {
    throw new Error(`Клиент codex: неизвестная роль «${role}», ожидается одна из ${CODEX_ROLES.join(', ')}`);
  }

  return env[CODEX_ROLE_ENV[role]]?.trim() || CODEX_MODEL;
}

/** Сколько раз ответ модели прогоняется через проверку, прежде чем вызывающий сдаётся. */
export const DEFAULT_ATTEMPTS = 3;
export const CODEX_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Ошибки запуска, которые следующая попытка не исправит: исполняемого файла нет,
 * прав нет, на его месте каталог. Всё остальное с `errno` — беда одного вызова
 * (см. разбор в `runCodexCli`).
 */
const PERMANENT_SPAWN_ERRORS = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'ENOEXEC']);

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

/**
 * Ключевые слова, значение которых — карта «имя поля → схема». Их ключи это
 * имена полей данных, а не ключевые слова: поле, названное `pattern` или
 * `minimum`, вырезать нельзя — оно осталось бы в `required`, и схема стала бы
 * невыполнимой.
 *
 * `patternProperties` сюда не входит намеренно: оно вырезано целиком фильтром
 * выше, и запись в обоих наборах была бы недостижимой ветвью.
 */
const SCHEMA_MAP_KEYWORDS = new Set([
  'properties',
  'dependentSchemas',
  '$defs',
  'definitions',
]);

/** Ключевые слова, значение которых — данные, а не схема: внутрь лезть нечего. */
const LITERAL_KEYWORDS = new Set(['enum', 'const', 'default', 'examples']);

function stripSchemaMap(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([name, nested]) => [
      name,
      codexOutputSchema(nested),
    ]),
  );
}

/** Копия схемы без запрещённых структурированным выводом ключевых слов. */
export function codexOutputSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(codexOutputSchema);
  if (schema === null || typeof schema !== 'object') return schema;

  return Object.fromEntries(
    Object.entries(schema as Record<string, unknown>)
      .filter(([key]) => !UNSUPPORTED_SCHEMA_KEYWORDS.has(key))
      .map(([key, value]) => {
        if (LITERAL_KEYWORDS.has(key)) return [key, value];
        return [key, SCHEMA_MAP_KEYWORDS.has(key) ? stripSchemaMap(value) : codexOutputSchema(value)];
      }),
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

/**
 * codex не запускается или молчит: повторять попытки бессмысленно, и решение
 * принимает не тема, а цикл. Сюда попадает и несостоявшийся запуск (нет файла,
 * нет прав), и превышенный срок: десять минут молчания три раза подряд — это
 * полчаса на одну тему, после которых воркер ещё и сбросил бы отступ, решив,
 * что просто не повезло с темой.
 */
export class CodexUnavailableError extends Error {}

/**
 * Сорвался сам запуск: ненулевой код возврата или не записанный файл ответа.
 * Отличать от негодного ответа модели нужно ради промпта повторной попытки —
 * туда уходит текст прошлого провала под заголовком «исправь эти замечания».
 * Диагностика CLI (с локальными путями внутри) замечанием к модели не является,
 * и отправлять её обратно значит сжечь ещё один вызов на минуты.
 */
export class CodexRunError extends Error {}

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
    const bin = request.bin ?? 'codex';
    if (error instanceof ChildTimeoutError) {
      throw new CodexUnavailableError(`codex не ответил: ${error.message}`);
    }
    // Разговорившийся процесс — беда одного вызова, а не всего codex: следующий
    // придёт с другим промптом. Но и замечанием к модели это не является.
    if (error instanceof ChildOutputLimitError) throw new CodexRunError(error.message);
    const system = error as NodeJS.ErrnoException;
    if (system.code === 'ENOENT') {
      throw new CodexUnavailableError(
        `codex не найден: ожидался исполняемый файл «${bin}» в PATH`,
      );
    }
    // Прочие постоянные ошибки запуска (нет прав, каталог вместо файла)
    // отличаются от отсутствия только текстом: процесс не стартовал, и три
    // попытки этого не исправят.
    //
    // Список именно перечислен, а не «всё, у чего есть errno»: сорванный запуск
    // бывает и бедой одного вызова. Слишком длинный промпт даёт `E2BIG`, нехватка
    // процессов под нагрузкой — `EAGAIN`, и записав их в «codex недоступен»,
    // воркер уходил бы в получасовой отступ на исправной модели, бросив все
    // остальные темы.
    if (system.code !== undefined && PERMANENT_SPAWN_ERRORS.has(system.code)) {
      throw new CodexUnavailableError(`codex не запускается («${bin}»): ${system.code}`);
    }
    if (system.code !== undefined) {
      throw new CodexRunError(`codex не запустился («${bin}»): ${system.code}`);
    }
    throw error;
  }
  if (result.code !== 0) {
    throw new CodexRunError(
      `codex завершился с кодом ${result.code}: ${(result.stderr + result.stdout).trim()}`,
    );
  }
  const stderr = result.stderr;

  // Предел вывода `runChild` этот файл не покрывает: ответ идёт не через stdout,
  // а через `--output-last-message`. Без проверки размера зациклившаяся на
  // токенах генерация даёт файл в сотни мегабайт, и чтение его одной строкой
  // валит процесс на `ERR_STRING_TOO_LONG` — в сервере это уносит и занятие.
  const limit = request.maxOutputBytes ?? MAX_CHILD_OUTPUT_BYTES;
  try {
    const { size } = statSync(request.outPath);
    if (size > limit) {
      throw new CodexRunError(
        `codex записал в ${request.outPath} ${size} байт при пределе ${limit}`,
      );
    }
  } catch (error) {
    if (error instanceof CodexRunError) throw error;
    throw new CodexRunError(
      `codex не записал ответ в ${request.outPath}: ${(error as Error).message}` +
        (stderr.trim() === '' ? '' : `; stderr: ${stderr.trim()}`),
    );
  }

  let answer: string;
  try {
    answer = readFileSync(request.outPath, 'utf8');
  } catch (error) {
    throw new CodexRunError(
      `codex не записал ответ в ${request.outPath}: ${(error as Error).message}` +
        (stderr.trim() === '' ? '' : `; stderr: ${stderr.trim()}`),
    );
  }

  if (answer.trim() === '') {
    throw new CodexRunError(`codex вернул пустой ответ в ${request.outPath}`);
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
