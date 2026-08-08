import type { AnswerFormat, Topic } from './curriculum.js';
import type { Subject } from './db.js';
import type { BankTask } from './codex/bank.js';
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
  hint: string;
  difficulty: number;
  answerFormat: AnswerFormat;
}

/** Общее представление банковского задания для занятия и триажа. */
export function projectIssuedTask(topic: Topic, task: BankTask): IssuedTask {
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
    }),
    hint: task.hint,
    difficulty: task.difficulty,
    answerFormat: topic.answerFormat,
  };
}
