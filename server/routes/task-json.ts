import type { IssuedTask } from '../issued-task.js';

type PublicTask = Omit<IssuedTask, 'hint'> & Partial<Pick<IssuedTask, 'hint'>>;

export function issuedTaskJson(task: PublicTask, includeHint = true): Record<string, unknown> {
  return {
    id: task.id, topic_id: task.topicId, topic_title: task.topicTitle, subject: task.subject,
    question: task.question,
    ...(task.instruction === undefined ? {} : {
      instruction: task.instruction, material: task.material,
      material_format: task.materialFormat, choices: task.choices,
    }),
    ...(includeHint && task.hint !== undefined ? { hint: task.hint } : {}),
    difficulty: task.difficulty, answer_format: task.answerFormat,
  };
}
