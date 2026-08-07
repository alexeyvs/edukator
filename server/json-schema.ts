/**
 * Общая обвязка над Ajv: компиляция схемы из файла и человекочитаемый текст
 * ошибок. Схем в проекте несколько (карта тем, батч заданий), и повторять
 * настройку Ajv в каждом модуле незачем.
 */
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';

/**
 * Ajv поставляется как CommonJS: под ESM `default` оказывается либо самим
 * классом, либо вложенным в `.default` — зависит от того, кто грузит модуль.
 * Под `moduleResolution: nodenext` тип импорта из CJS — пространство имён, а не
 * конструктор, поэтому нужный тип назван здесь руками. Проверяет его сам вызов
 * `compile`: ошибись в форме — упадёт компиляция схем в тестах.
 */
type Ajv2020Constructor = new (options: {
  allErrors: boolean;
  strict: boolean;
}) => { compile: <T>(schema: object) => ValidateFunction<T> };

const Ajv = ((Ajv2020 as unknown as { default?: unknown }).default ??
  Ajv2020) as unknown as Ajv2020Constructor;

const compiled = new Map<string, ValidateFunction>();

/** Компилирует схему из файла и запоминает результат: компиляция дороже проверки. */
export function schemaValidator<T>(path: string): ValidateFunction<T> {
  const cached = compiled.get(path);
  if (cached !== undefined) return cached as ValidateFunction<T>;

  const schema = JSON.parse(readFileSync(path, 'utf8')) as object;
  const validate = new Ajv({ allErrors: true, strict: true }).compile<T>(schema);
  compiled.set(path, validate as ValidateFunction);
  return validate;
}

/** Ajv не кладёт в `message` виновника (лишнее поле, допустимые значения) — добираем из `params`. */
function describeError(error: ErrorObject): string {
  const where = error.instancePath === '' ? '/' : error.instancePath;
  const params = Object.values(error.params)
    .flat()
    .filter((value) => value !== undefined && value !== null)
    .join(', ');
  return params === '' ? `${where}: ${error.message}` : `${where}: ${error.message} (${params})`;
}

/** Все ошибки проверки одной строкой: текст уходит и в лог, и в промпт повторной попытки. */
export function describeSchemaErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map(describeError).join('; ');
}
