import { describe, expect, it } from 'vitest';
import { issuedTaskJson } from '../server/routes/task-json.js';
import type { IssuedTask } from '../server/session.js';

const legacy: IssuedTask = {
  id: 1, topicId: 'math.a', topicTitle: 'Счёт', subject: 'math',
  question: 'Сколько будет два плюс два?', hint: 'Сложи числа.',
  difficulty: 1, answerFormat: 'number',
};

describe('issuedTaskJson', () => {
  it('сохраняет plain-text fallback и умеет скрыть подсказку для триажа', () => {
    expect(issuedTaskJson(legacy, false)).toEqual({
      id: 1, topic_id: 'math.a', topic_title: 'Счёт', subject: 'math',
      question: 'Сколько будет два плюс два?', difficulty: 1, answer_format: 'number',
    });
    expect(issuedTaskJson(legacy)).toMatchObject({ hint: 'Сложи числа.' });
  });
});
