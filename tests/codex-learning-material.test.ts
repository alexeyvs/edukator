import { describe, expect, it } from 'vitest';
import type { Topic } from '../server/curriculum.js';
import { DEFAULT_PROFILE } from '../server/db.js';
import {
  CodexUnavailableError,
  type CodexRequest,
} from '../server/codex/client.js';
import {
  generateLearningMaterial,
  validateLearningMaterial,
} from '../server/codex/learning-material.js';
import type { LearningMaterialContent } from '../server/codex/learning-material-schema.js';

const topic: Topic = {
  id: 'math.fractions', subject: 'math', title: 'Дроби', examWeight: 3,
  difficulty: 2, prereqs: [], answerFormat: 'number', promptSeed: 'Сложение дробей.',
};

const content: LearningMaterialContent = {
  introduction: 'Дроби похожи на части шкалы.',
  objectives: ['Складывать дроби'],
  sections: [
    { title: 'Части', blocks: [{ type: 'paragraph', content: 'Знаменатель задаёт размер части.' }] },
    { title: 'Правило', blocks: [{ type: 'formula', content: '\\frac{a}{c}+\\frac{b}{c}=\\frac{a+b}{c}' }] },
    { title: 'Пример', blocks: [{ type: 'example', content: 'Одна треть плюс одна треть.' }] },
  ],
  summary: ['Проверь знаменатель.', 'Сложи числители.'],
};

function options(run: (request: CodexRequest) => Promise<string>) {
  return {
    topic,
    prerequisites: [],
    profile: { ...DEFAULT_PROFILE, name: 'Тимофей', interests: ['Minecraft'] },
    recentErrors: [{ question: 'Сколько?', answer: '5' }],
    previousApproaches: ['Старая подача'],
    persona: 'Ты спокойный напарник.',
    run,
  };
}

describe('генерация и проверка учебного материала', () => {
  it('повторяет структурно негодный ответ и передаёт персональный контекст безопасными данными', async () => {
    const calls: CodexRequest[] = [];
    const result = await generateLearningMaterial(options((request) => {
      calls.push(request);
      return Promise.resolve(calls.length === 1
        ? JSON.stringify({ introduction: '<b>опасно</b>' })
        : JSON.stringify(content));
    }));
    expect(result).toEqual(content);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.model).toBe('gpt-5.6-sol');
    expect(calls[0]?.prompt).toContain('Minecraft');
    expect(calls[0]?.prompt).toContain('Старая подача');
    expect(calls[1]?.prompt).toContain('Ошибка прошлой попытки');
  });

  it('не повторяет недоступный codex и проверяет число попыток', async () => {
    let calls = 0;
    await expect(generateLearningMaterial(options(() => {
      calls += 1;
      return Promise.reject(new CodexUnavailableError('нет codex'));
    }))).rejects.toThrow(CodexUnavailableError);
    expect(calls).toBe(1);
    await expect(generateLearningMaterial({ ...options(() => Promise.resolve('{}')), attempts: 0 }))
      .rejects.toThrow(/число попыток/u);
  });

  it('после исчерпания попыток сообщает последнюю структурную ошибку', async () => {
    await expect(generateLearningMaterial({
      ...options(() => Promise.resolve('{}')),
      attempts: 2,
    })).rejects.toThrow(/не прошёл структурную проверку/u);
  });

  it('принимает только согласованный положительный вердикт независимой роли validate', async () => {
    const requests: CodexRequest[] = [];
    const accepted = await validateLearningMaterial({
      topic, material: content,
      run: (request) => {
        requests.push(request);
        return Promise.resolve(JSON.stringify({
          accepted: true, accurate: true, complete: true,
          age_appropriate: true, grounded: true, note: '',
        }));
      },
    });
    expect(accepted).toEqual({ accepted: true, reason: '' });
    expect(requests[0]?.prompt).toContain('независимый методист');

    const rejected = await validateLearningMaterial({
      topic, material: content,
      run: () => Promise.resolve(JSON.stringify({
        accepted: true, accurate: false, complete: true,
        age_appropriate: true, grounded: true, note: 'Ошибка в правиле',
      })),
    });
    expect(rejected).toEqual({ accepted: false, reason: 'Ошибка в правиле' });
  });

  it('отбраковывает повреждённый вердикт и подставляет причину при пустой заметке', async () => {
    await expect(validateLearningMaterial({
      topic, material: content, run: () => Promise.resolve('{}'),
    })).rejects.toThrow(/не соответствует схеме/u);
    await expect(validateLearningMaterial({
      topic, material: content,
      run: () => Promise.reject(new Error('проверяющий упал')),
    })).rejects.toThrow('проверяющий упал');
    expect(await validateLearningMaterial({
      topic, material: content,
      run: () => Promise.resolve(JSON.stringify({
        accepted: false, accurate: true, complete: true,
        age_appropriate: true, grounded: true, note: ' ',
      })),
    })).toEqual({ accepted: false, reason: 'независимая проверка материала не пройдена' });
  });
});
