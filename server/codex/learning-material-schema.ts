import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describeSchemaErrors, schemaValidator } from '../json-schema.js';

const here = dirname(fileURLToPath(import.meta.url));

export const LEARNING_MATERIAL_SCHEMA_PATH = resolve(
  here,
  '..',
  '..',
  'schemas',
  'learning-material.json',
);

export const LEARNING_BLOCK_TYPES = ['paragraph', 'formula', 'example', 'warning'] as const;
export type LearningBlockType = (typeof LEARNING_BLOCK_TYPES)[number];

export interface LearningBlock {
  type: LearningBlockType;
  content: string;
}

export interface LearningSection {
  title: string;
  blocks: LearningBlock[];
}

export interface LearningMaterialContent {
  introduction: string;
  objectives: string[];
  sections: LearningSection[];
  summary: string[];
}

const HTML_TAG = /<\s*\/?\s*[a-z][^>]*>/iu;
const LATEX_DELIMITER = /\$/u;
const MAX_TEXT_LENGTH = 4_000;
const MAX_BLOCKS_PER_SECTION = 8;

function stringsOf(content: LearningMaterialContent): string[] {
  return [
    content.introduction,
    ...content.objectives,
    ...content.sections.flatMap((section) => [
      section.title,
      ...section.blocks.map((block) => block.content),
    ]),
    ...content.summary,
  ];
}

/** Проверяет ограничения, снятые из схемы для structured output Codex. */
export function parseLearningMaterial(raw: unknown): LearningMaterialContent {
  const validate = schemaValidator<LearningMaterialContent>(LEARNING_MATERIAL_SCHEMA_PATH);
  if (!validate(raw)) {
    throw new Error(
      `Учебный материал не соответствует схеме: ${describeSchemaErrors(validate.errors)}`,
    );
  }
  for (const [index, section] of raw.sections.entries()) {
    if (section.blocks.length < 1 || section.blocks.length > MAX_BLOCKS_PER_SECTION) {
      throw new Error(
        `Раздел ${index + 1} должен содержать от одного до ${MAX_BLOCKS_PER_SECTION} блоков`,
      );
    }
  }
  for (const text of stringsOf(raw)) {
    if (text.trim() === '') throw new Error('Учебный материал содержит пустой текстовый блок');
    if (text.length > MAX_TEXT_LENGTH) {
      throw new Error(`Текстовый блок учебного материала длиннее ${MAX_TEXT_LENGTH} знаков`);
    }
    if (HTML_TAG.test(text)) throw new Error('HTML в учебном материале запрещён');
  }
  if (raw.sections.some((section) =>
    section.blocks.some((block) => block.type === 'formula' && LATEX_DELIMITER.test(block.content)))) {
    throw new Error('Формула учебного материала должна быть display-LaTeX без разделителей $');
  }
  return {
    introduction: raw.introduction,
    objectives: [...raw.objectives],
    sections: raw.sections.map((section) => ({
      title: section.title,
      blocks: section.blocks.map((block) => ({ ...block })),
    })),
    summary: [...raw.summary],
  };
}
