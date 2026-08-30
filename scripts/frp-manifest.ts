/**
 * Манифест федеральных рабочих программ: список источников для импорта курсов,
 * данные, а не код. Ведётся руками, потому что имена файлов на edsoo.ru
 * нерегулярны — у математики `2025_ooo_frp_matematika-5-9_baza.pdf`, у русского
 * языка `01_frp_russkij-yazyk_5-9-klassy_itog-na-sajt_1-2.pdf`. Правила сборки
 * URL не существует, и выведенное правило ломалось бы молча.
 *
 * `sha256` делает прогон детерминированным и превращает выход новой редакции
 * программы в явный отказ «файл на URL изменился» вместо тихой подмены
 * содержания курса.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

/** Манифест источников ФРП: путь считается от `import.meta.url`, как `CURRICULUM_DIR`. */
export const FRP_MANIFEST_PATH = resolve(projectRoot, 'content', 'frp', 'sources.json');

const MIN_GRADE = 5;
const MAX_GRADE = 11;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export type FrpLevel = 'ooo' | 'soo';

export interface FrpSource {
  subject: string;
  title: string;
  level: FrpLevel;
  url: string;
  sha256: string;
  grades: number[];
  courseId?: Record<string, string>;
}

function fail(message: string): never {
  throw new Error(message);
}

function asRecord(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${description}: ожидался объект`);
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown, field: string, description: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${description}: поле "${field}" обязано быть непустой строкой`);
  }
  return value;
}

function asLevel(value: unknown, description: string): FrpLevel {
  if (typeof value !== 'string' || (value !== 'ooo' && value !== 'soo')) {
    fail(`${description}: поле "level" обязано быть "ooo" или "soo"`);
  }
  return value;
}

function asGrades(value: unknown, description: string): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${description}: поле "grades" обязано быть непустым списком классов`);
  }
  return value.map((grade, gradeIndex) => {
    if (
      typeof grade !== 'number' ||
      !Number.isInteger(grade) ||
      grade < MIN_GRADE ||
      grade > MAX_GRADE
    ) {
      fail(
        `${description}: grades[${gradeIndex}] обязан быть целым числом ` +
          `${MIN_GRADE}..${MAX_GRADE}`,
      );
    }
    return grade;
  });
}

function asCourseId(
  value: unknown,
  grades: number[],
  description: string,
): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = asRecord(value, `${description}: поле "courseId"`);
  for (const [gradeKey, courseIdValue] of Object.entries(record)) {
    if (!grades.includes(Number(gradeKey))) {
      fail(
        `${description}: courseId называет класс ${gradeKey}, которого нет в grades`,
      );
    }
    if (typeof courseIdValue !== 'string' || courseIdValue.trim() === '') {
      fail(`${description}: courseId["${gradeKey}"] обязан быть непустой строкой`);
    }
  }
  return record as Record<string, string>;
}

/** Разбирает и проверяет манифест; отказ на первой некорректной записи. */
export function parseFrpManifest(raw: unknown): FrpSource[] {
  if (!Array.isArray(raw)) {
    fail('манифест ФРП обязан быть массивом записей');
  }

  const seenSubjectLevel = new Set<string>();
  const sources: FrpSource[] = [];

  raw.forEach((item, index) => {
    const description = `запись манифеста #${index}`;
    const record = asRecord(item, description);
    const subject = asNonEmptyString(record.subject, 'subject', description);
    const withSubject = `${description} (${subject})`;
    const title = asNonEmptyString(record.title, 'title', withSubject);
    const level = asLevel(record.level, withSubject);
    const url = asNonEmptyString(record.url, 'url', withSubject);
    if (!url.startsWith('https://')) {
      fail(`${withSubject}: адрес "${url}" обязан начинаться с https://`);
    }
    const sha256 = asNonEmptyString(record.sha256, 'sha256', withSubject);
    if (!SHA256_PATTERN.test(sha256)) {
      fail(`${withSubject}: sha256 обязан быть 64 знаками [0-9a-f]`);
    }
    const grades = asGrades(record.grades, withSubject);

    // Предмет и уровень вместе — ключ манифеста: одна и та же программа не
    // может встретиться дважды и молча перекрыть первую запись.
    const subjectLevelKey = `${subject}::${level}`;
    if (seenSubjectLevel.has(subjectLevelKey)) {
      fail(`манифест ФРП: предмет "${subject}" повторён на уровне "${level}"`);
    }
    seenSubjectLevel.add(subjectLevelKey);

    const courseId = asCourseId(record.courseId, grades, withSubject);

    sources.push({
      subject,
      title,
      level,
      url,
      sha256,
      grades,
      ...(courseId === undefined ? {} : { courseId }),
    });
  });

  return sources;
}

/** Читает и разбирает манифест из файла репозитория (или указанного пути). */
export function readFrpManifest(path: string = FRP_MANIFEST_PATH): FrpSource[] {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return parseFrpManifest(raw);
}
