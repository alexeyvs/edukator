import type { AnswerFormat, Topic } from './curriculum.js';
import type { Subject } from './db.js';
import type { BankTask } from './codex/bank.js';
import type { DeepHint } from './codex/task-schema.js';
import { taskPromptText } from './codex/task-schema.js';

/**
 * Задание в том виде, в каком его получает ученик. Ни `answer`, ни `accept[]`
 * здесь нет: сверка идёт на сервере. `explain` и `joke` тоже остаются там до
 * ответа, поскольку разбор пересказывает решение целиком.
 */
export interface IssuedTask {
  id: number;
  topicId: string;
  subject: Subject;
  topicTitle: string;
  question: string;
  instruction?: string;
  material?: string;
  materialFormat?: 'none' | 'text' | 'math';
  choices?: string[];
  wordTiles?: string[];
  hint?: string;
  deepHint?: DeepHint;
  difficulty: number;
  answerFormat: AnswerFormat;
}

/** Общее представление банковского задания для занятия и триажа. */
export function projectIssuedTask(
  topic: Topic,
  task: BankTask,
  options: { exposeHint?: boolean } = {},
): IssuedTask {
  return {
    id: task.id,
    topicId: topic.id,
    subject: topic.subject,
    topicTitle: topic.title,
    question: taskPromptText(task),
    ...(task.instruction === undefined ? {} : {
      instruction: task.instruction,
      material: task.material ?? '',
      materialFormat: task.material_format ?? 'none',
      choices: task.choices ?? [],
      wordTiles: task.word_tiles ?? [],
    }),
    ...(options.exposeHint === false ? {} : {
      hint: task.hint,
      ...(task.deep_hint === undefined ? {} : { deepHint: task.deep_hint }),
    }),
    difficulty: task.difficulty,
    answerFormat: topic.answerFormat,
  };
}
