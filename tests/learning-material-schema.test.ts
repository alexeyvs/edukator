import { describe, expect, it } from 'vitest';
import {
  LEARNING_BLOCK_TYPES,
  parseLearningMaterial,
  type LearningMaterialContent,
} from '../server/codex/learning-material-schema.js';

function material(): LearningMaterialContent {
  return {
    introduction: 'Разберём правило без спешки.',
    objectives: ['Узнать правило', 'Применить его в примере'],
    sections: [
      { title: 'Идея', blocks: [{ type: 'paragraph', content: 'Сначала найдём главное.' }] },
      { title: 'Формула', blocks: [{ type: 'formula', content: '\\frac{a}{b}' }] },
      { title: 'Практика', blocks: [
        { type: 'example', content: 'Разберём один пример.' },
        { type: 'warning', content: 'Не меняй знак без причины.' },
      ] },
    ],
    summary: ['Найди правило.', 'Проверь ответ.'],
  };
}

describe('схема учебного материала', () => {
  it('принимает только четыре безопасных типа блоков и возвращает копию', () => {
    expect(LEARNING_BLOCK_TYPES).toEqual(['paragraph', 'formula', 'example', 'warning']);
    const source = material();
    const parsed = parseLearningMaterial(source);
    expect(parsed).toEqual(source);
    expect(parsed).not.toBe(source);
    expect(parsed.sections[0]).not.toBe(source.sections[0]);
  });

  it('запрещает HTML во всех текстовых полях', () => {
    const source = material();
    source.sections[1]?.blocks.push({ type: 'paragraph', content: '<script>alert(1)</script>' });
    expect(() => parseLearningMaterial(source)).toThrow(/HTML.*запрещён/u);
  });

  it('проверяет число целей, разделов, памяток и блоков после облегчения codex-схемы', () => {
    expect(() => parseLearningMaterial({ ...material(), objectives: [] })).toThrow(/схеме/u);
    expect(() => parseLearningMaterial({ ...material(), sections: material().sections.slice(0, 2) }))
      .toThrow(/схеме/u);
    expect(() => parseLearningMaterial({ ...material(), summary: ['Один пункт'] }))
      .toThrow(/схеме/u);
    const source = material();
    source.sections[0] = { title: 'Пусто', blocks: [] };
    expect(() => parseLearningMaterial(source)).toThrow(/схеме/u);
  });

  it('отбраковывает лишние поля, пустой и чрезмерно длинный текст', () => {
    expect(() => parseLearningMaterial({ ...material(), html: '<p>x</p>' })).toThrow(/схеме/u);
    expect(() => parseLearningMaterial({ ...material(), introduction: '   ' })).toThrow(/пустой/u);
    expect(() => parseLearningMaterial({ ...material(), introduction: 'я'.repeat(4_001) }))
      .toThrow(/длиннее 4000/u);
  });
});
