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
import type { SourceContext } from '../course-retrieval.js';
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
  /** Структурированная теория для самостоятельного теста lesson-run. */
  lessonContent?: unknown;
  courseTitle?: string;
  grade?: string;
  sourceContext?: SourceContext;
}

export interface GenerateTasksResult {
  tasks: GeneratedTask[];
  /** Сколько попыток понадобилось, включая удачную. */
  attempts: number;
  /** Тексты провалившихся проверок в порядке попыток. */
  failures: string[];
}

/**
 * Модель ответила, но ни один её ответ не прошёл проверку.
 *
 * Отдельный тип, а не текст ошибки, потому что уровнем выше это решает разные
 * вещи. Забракованный ответ — свойство **темы**: генератор запускается, отвечает
 * и раз за разом промахивается по одному и тому же правилу, и правильная
 * реакция — отложить эту тему, дав остальным двадцати дожить до вызова.
 * Сорванный запуск (`CodexRunError`: просроченная авторизация, кончившийся
 * баланс, обрыв сети) — свойство модели, и правильная реакция противоположная:
 * отложить обход целиком с растущей паузой. Сведённые в один тип, они дают либо
 * тему, снятую с прогрева за чужой простой, либо просроченную авторизацию,
 * спрятанную под отступом по темам, — и в журнале при этом тишина.
 */
export class TaskBatchRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskBatchRejectedError';
  }
}

/**
 * Просит у codex батч заданий по теме и возвращает разобранные задания.
 *
 * Бросает `CodexUnavailableError`, если codex не запускается,
 * `TaskBatchRejectedError`, если модель отвечала и её ответы не прошли
 * проверку, и обычную ошибку, если до проверки не дошло ни одного ответа.
 */
export async function generateTaskBatch(
  options: GenerateTasksOptions,
): Promise<GenerateTasksResult> {
  const { topic } = options;
  const sourceContext = options.sourceContext ?? topic.sourceContext;
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
        ...(options.lessonContent === undefined ? {} : { lessonContent: options.lessonContent }),
        ...((options.courseTitle ?? topic.courseTitle) === undefined ? {} : { courseTitle: options.courseTitle ?? topic.courseTitle }),
        ...((options.grade ?? topic.grade) === undefined ? {} : { grade: options.grade ?? topic.grade }),
        ...(sourceContext === undefined ? {} : { sourceContext }),
        ...(previousError === undefined ? {} : { previousError }),
      });

      try {
        const answer = await run({
          prompt,
          schemaPath,
          outPath: join(workDir, `batch-${attempt}.json`),
          model,
          ...(sourceContext === undefined ? {} : { images: sourceContext.images }),
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
  const message =
    `Задания по теме «${topic.id}» не сгенерированы за ${maxAttempts} попыт(ок):\n${report}`;
  // `previousError` заполняется только тем, что модель действительно написала:
  // сорванный запуск в него не попадает. Он и есть признак «ответ был, и он
  // забракован» — ровно то, чем эти два отказа различаются снаружи.
  throw previousError === undefined ? new Error(message) : new TaskBatchRejectedError(message);
}
