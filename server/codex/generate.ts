/**
 * Генерация батча заданий по одной теме: тема и целевая сложность на входе,
 * разобранные задания на выходе. Один вызов codex даёт весь батч — замер спеки
 * 23.6 секунды на пять заданий, и это единственная причина, по которой воркер
 * успевает держать очередь тёплой.
 *
 * Ответ модели не считается годным, пока не прошёл разбор из `task-schema.ts`.
 * Провал не роняет генерацию сразу: текст замечаний уходит в промпт следующей
 * попытки, попыток не больше `DEFAULT_ATTEMPTS`. Недоступность codex —
 * исключение: она пробрасывается наверх сразу, потому что воркеру нужно узнать
 * о ней, а не получить три пустых попытки подряд.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Topic } from '../curriculum.js';
import type { Profile } from '../db.js';
import {
  modelForRole,
  CodexRunError,
  CodexUnavailableError,
  DEFAULT_ATTEMPTS,
  parseCodexAnswer,
  runCodexCli,
  writeCodexSchema,
  type CodexRunner,
} from './client.js';
import { buildGenerationPrompt, readPersona, TASK_BATCH_SIZE } from './prompt.js';
import { parseTaskBatch, TASKS_SCHEMA_PATH, type GeneratedTask } from './task-schema.js';

export interface GenerateTasksOptions {
  topic: Topic;
  /** Целевая сложность 1-3; выходящее за диапазон значение поджимает промпт. */
  difficulty: number;
  /** Профиль ученика; без него промпт берёт нейтральные умолчания. */
  profile?: Profile;
  /** Формулировки уже выданных по теме заданий: их повторять нельзя. */
  recent?: string[];
  /** Сколько заданий просить одним вызовом; по умолчанию размер батча из спеки. */
  count?: number;
  attempts?: number;
  model?: string;
  /** Подменяемый вызов codex: тесты передают заглушку. */
  run?: CodexRunner;
  /** Максимальное время одного вызова codex. */
  timeoutMs?: number;
  /** Текст персоны; по умолчанию читается из `content/persona.md`. */
  persona?: string;
}

export interface GenerateTasksResult {
  tasks: GeneratedTask[];
  /** Сколько попыток понадобилось, включая удачную. */
  attempts: number;
  /** Тексты провалившихся проверок в порядке попыток. */
  failures: string[];
}

/**
 * Просит у codex батч заданий по теме и возвращает разобранные задания.
 *
 * Бросает `CodexUnavailableError`, если codex не запускается, и обычную ошибку
 * с отчётом по всем попыткам, если ни один батч не прошёл проверку.
 */
export async function generateTaskBatch(
  options: GenerateTasksOptions,
): Promise<GenerateTasksResult> {
  const { topic } = options;
  const maxAttempts = options.attempts ?? DEFAULT_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`Число попыток должно быть положительным целым, получено ${maxAttempts}`);
  }

  const run = options.run ?? runCodexCli;
  const model = options.model ?? modelForRole('generate');
  const count = options.count ?? TASK_BATCH_SIZE;
  // Персона читается до первого вызова: её отсутствие — ошибка настройки, и
  // узнать о ней дешевле сразу, чем через полминуты работы модели.
  const persona = options.persona ?? readPersona();

  const workDir = mkdtempSync(join(tmpdir(), 'edukator-tasks-'));
  const failures: string[] = [];
  // Отдельно от `failures`: в промпт следующей попытки уходит только то, что
  // модель действительно написала. Сорванный запуск (`CodexRunError`) в отчёт
  // попадает, а в промпт — нет.
  let previousError: string | undefined;

  try {
    const schemaPath = writeCodexSchema(workDir, TASKS_SCHEMA_PATH);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const prompt = buildGenerationPrompt({
        topic,
        difficulty: options.difficulty,
        count,
        persona,
        ...(options.profile === undefined ? {} : { profile: options.profile }),
        ...(options.recent === undefined ? {} : { recent: options.recent }),
        ...(previousError === undefined ? {} : { previousError }),
      });

      try {
        const answer = await run({
          prompt,
          schemaPath,
          outPath: join(workDir, `batch-${attempt}.json`),
          model,
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        });
        const tasks = parseTaskBatch(parseCodexAnswer(answer), topic.answerFormat);
        return { tasks, attempts: attempt, failures };
      } catch (error) {
        // codex, которого нет в PATH, к третьей попытке не появится.
        if (error instanceof CodexUnavailableError) throw error;
        failures.push((error as Error).message);
        if (!(error instanceof CodexRunError)) previousError = (error as Error).message;
      }
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  const report = failures.map((message, index) => `  попытка ${index + 1}: ${message}`).join('\n');
  throw new Error(
    `Задания по теме «${topic.id}» не сгенерированы за ${maxAttempts} попыт(ок):\n${report}`,
  );
}
