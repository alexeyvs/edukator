import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeSchemaErrors, schemaValidator } from '../server/json-schema.js';

const SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['name', 'count'],
  properties: {
    name: { type: 'string', minLength: 1 },
    count: { type: 'integer', minimum: 1 },
  },
};

interface Payload {
  name: string;
  count: number;
}

let dir: string;
let path: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'edukator-json-schema-'));
  path = join(dir, 'проба.json');
  writeFileSync(path, JSON.stringify(SCHEMA));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('schemaValidator', () => {
  it('компилирует схему из файла и пропускает годные данные', () => {
    const validate = schemaValidator<Payload>(path);

    expect(validate({ name: 'дроби', count: 3 })).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it('отдаёт из кеша ту же функцию, а не компилирует заново', () => {
    expect(schemaValidator<Payload>(path)).toBe(schemaValidator<Payload>(path));
  });

  // Через этот вызов проходят все четыре схемы проекта, а голый `ENOENT` или
  // `Unexpected token` не называет ни файл, ни то, что сломалась именно схема:
  // разбираться пришлось бы по стеку.
  it('падает внятно на несуществующем файле схемы, называя путь', () => {
    const missing = join(dir, 'нет-такой.json');

    expect(() => schemaValidator(missing)).toThrow(/Схема .*нет-такой\.json не читается/u);
  });

  it('падает внятно на неразбираемом файле схемы, называя путь', () => {
    const broken = join(dir, 'битая.json');
    writeFileSync(broken, '{ это не json');

    expect(() => schemaValidator(broken)).toThrow(/Схема .*битая\.json не читается/u);
  });
});

describe('describeSchemaErrors', () => {
  // Ajv не кладёт виновника в `message`: без разбора `params` текст «must NOT
  // have additional properties» не называет лишнее поле, а именно он уходит в
  // промпт повторной попытки.
  it('называет лишнее поле, а не только сам факт нарушения', () => {
    const validate = schemaValidator<Payload>(path);
    validate({ name: 'дроби', count: 3, лишнее: 1 });

    const text = describeSchemaErrors(validate.errors);

    expect(text).toContain('лишнее');
    expect(text).toMatch(/additional properties/i);
  });

  it('называет недостающее обязательное поле и место нарушения', () => {
    const validate = schemaValidator<Payload>(path);
    validate({ name: 'дроби' });

    expect(describeSchemaErrors(validate.errors)).toContain('count');
  });

  it('перечисляет все нарушения сразу, а не первое', () => {
    const validate = schemaValidator<Payload>(path);
    validate({ name: '', count: 0 });

    const text = describeSchemaErrors(validate.errors);

    expect(text).toContain('/name');
    expect(text).toContain('/count');
    expect(text.split('; ')).toHaveLength(2);
  });

  it('на отсутствующем списке ошибок отдаёт пустую строку, а не падает', () => {
    expect(describeSchemaErrors(null)).toBe('');
    expect(describeSchemaErrors(undefined)).toBe('');
    expect(describeSchemaErrors([])).toBe('');
  });
});
