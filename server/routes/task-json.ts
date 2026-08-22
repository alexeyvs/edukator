import type { IssuedTask } from '../issued-task.js';

type PublicTask = Omit<IssuedTask, 'hint' | 'deepHint'> &
  Partial<Pick<IssuedTask, 'hint' | 'deepHint'>>;

export function issuedTaskJson(task: PublicTask, includeHint = true): Record<string, unknown> {
  return {
    id: task.id, topic_id: task.topicId, topic_title: task.topicTitle, subject: task.subject,
    question: task.question,
    ...(task.instruction === undefined ? {} : {
      instruction: task.instruction, material: task.material,
      material_format: task.materialFormat, choices: task.choices,
      word_tiles: task.wordTiles,
    }),
    ...(includeHint && task.hint !== undefined ? { hint: task.hint } : {}),
    ...(includeHint && task.deepHint !== undefined ? { deep_hint: task.deepHint } : {}),
    difficulty: task.difficulty, answer_format: task.answerFormat,
  };
}
