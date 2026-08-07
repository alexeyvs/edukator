import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import type { Database } from 'better-sqlite3';
import { SUBJECTS, type Subject } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

/** Каталог с картами тем: истина в последней инстанции, `topic_state` — только рантайм. */
export const CURRICULUM_DIR = resolve(projectRoot, 'content', 'curriculum');

/** Схема одной карты тем. Она же уходит в codex через `--output-schema`. */
export const CURRICULUM_SCHEMA_PATH = resolve(projectRoot, 'schemas', 'curriculum.json');

export const ANSWER_FORMATS = ['number', 'text', 'choice'] as const;
export type AnswerFormat = (typeof ANSWER_FORMATS)[number];

export interface Topic {
  id: string;
  subject: Subject;
  title: string;
  /** 0-3, вероятность встретиться на вступительном. */
  examWeight: number;
  /** 1-3, базовая сложность. */
  difficulty: number;
  /** Темы, которые должны быть освоены раньше. */
  prereqs: string[];
  answerFormat: AnswerFormat;
  promptSeed: string;
}

export interface TopicGraph {
  /** Темы по `id`, в порядке объявления в файлах. */
  byId: Map<string, Topic>;
  /** Топологический порядок: предпосылки идут раньше зависимых от них тем. */
  order: Topic[];
  /** Обратные рёбра: тема → темы, для которых она предпосылка. */
  dependents: Map<string, string[]>;
  bySubject: Map<Subject, Topic[]>;
  /** Предметы, карты которых удалось загрузить, в порядке `SUBJECTS`. */
  subjects: Subject[];
}

/** Тема как она лежит в JSON: snake_case, ровно поля из схемы. */
interface TopicJson {
  id: string;
  subject: Subject;
  title: string;
  exam_weight: number;
  difficulty: number;
  prereqs: string[];
  answer_format: AnswerFormat;
  prompt_seed: string;
}

interface CurriculumJson {
  subject: Subject;
  topics: TopicJson[];
}

/**
 * Ajv поставляется как CommonJS: под ESM `default` оказывается либо самим
 * классом, либо вложенным в `.default` — зависит от того, кто грузит модуль.
 */
const Ajv = (Ajv2020 as unknown as { default?: typeof Ajv2020 }).default ?? Ajv2020;

let cachedValidator: ValidateFunction<CurriculumJson> | undefined;

function validator(): ValidateFunction<CurriculumJson> {
  if (cachedValidator === undefined) {
    const schema = JSON.parse(readFileSync(CURRICULUM_SCHEMA_PATH, 'utf8')) as object;
    const ajv = new Ajv({ allErrors: true, strict: true });
    cachedValidator = ajv.compile<CurriculumJson>(schema);
  }
  return cachedValidator;
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

function toTopic(raw: TopicJson): Topic {
  return {
    id: raw.id,
    subject: raw.subject,
    title: raw.title,
    examWeight: raw.exam_weight,
    difficulty: raw.difficulty,
    prereqs: [...raw.prereqs],
    answerFormat: raw.answer_format,
    promptSeed: raw.prompt_seed,
  };
}

/** Обратное преобразование: пригодится скрипту сборки карты (задача 5) и экспорту. */
export function toTopicJson(topic: Topic): TopicJson {
  return {
    id: topic.id,
    subject: topic.subject,
    title: topic.title,
    exam_weight: topic.examWeight,
    difficulty: topic.difficulty,
    prereqs: [...topic.prereqs],
    answer_format: topic.answerFormat,
    prompt_seed: topic.promptSeed,
  };
}

/**
 * Строит граф тем и проверяет связи: дубли `id`, ссылки на несуществующие темы
 * и циклы в `prereqs`. Цикл ловится обходом в глубину — он не проявляется ни в
 * схеме, ни в тестах на отдельную тему, а планировщик на нём зациклится.
 */
export function buildTopicGraph(topics: Topic[]): TopicGraph {
  const byId = new Map<string, Topic>();
  for (const topic of topics) {
    if (byId.has(topic.id)) {
      throw new Error(`Карта тем: тема «${topic.id}» дублируется`);
    }
    byId.set(topic.id, topic);
  }

  const dependents = new Map<string, string[]>();
  for (const topic of topics) {
    for (const prereq of topic.prereqs) {
      if (!byId.has(prereq)) {
        throw new Error(
          `Карта тем: тема «${topic.id}» ссылается в prereqs на несуществующую тему «${prereq}»`,
        );
      }
      dependents.set(prereq, [...(dependents.get(prereq) ?? []), topic.id]);
    }
  }

  const order: Topic[] = [];
  const done = new Set<string>();
  const path: string[] = [];
  const inPath = new Set<string>();

  const visit = (id: string): void => {
    if (done.has(id)) return;
    if (inPath.has(id)) {
      const cycle = [...path.slice(path.indexOf(id)), id].join(' → ');
      throw new Error(`Карта тем: цикл в prereqs: ${cycle}`);
    }
    inPath.add(id);
    path.push(id);
    // Тема попадает в порядок после всех своих предпосылок.
    for (const prereq of byId.get(id)?.prereqs ?? []) visit(prereq);
    path.pop();
    inPath.delete(id);
    done.add(id);
    const topic = byId.get(id);
    if (topic !== undefined) order.push(topic);
  };

  for (const topic of topics) visit(topic.id);

  const bySubject = new Map<Subject, Topic[]>();
  for (const topic of topics) {
    bySubject.set(topic.subject, [...(bySubject.get(topic.subject) ?? []), topic]);
  }

  return {
    byId,
    order,
    dependents,
    bySubject,
    subjects: SUBJECTS.filter((subject) => bySubject.has(subject)),
  };
}

/**
 * Проверяет содержимое одной карты тем по JSON Schema и строит граф.
 * `source` — имя файла или иной источник: попадает в текст ошибки, иначе
 * непонятно, какую из трёх карт чинить.
 */
export function parseCurriculumFile(raw: unknown, source: string): TopicGraph {
  const validate = validator();
  if (!validate(raw)) {
    const details = (validate.errors ?? []).map(describeError).join('; ');
    throw new Error(`Карта тем ${source} не соответствует схеме: ${details}`);
  }

  for (const topic of raw.topics) {
    if (topic.subject !== raw.subject) {
      throw new Error(
        `Карта тем ${source}: у темы «${topic.id}» предмет «${topic.subject}», а файл объявлен как «${raw.subject}»`,
      );
    }
  }

  return buildTopicGraph(raw.topics.map(toTopic));
}

function readCurriculumFile(dir: string, subject: Subject): Topic[] | undefined {
  const path = join(dir, `${subject}.json`);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`Карта тем ${path} не читается: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Карта тем ${path} не разбирается как JSON: ${(error as Error).message}`);
  }

  return [...parseCurriculumFile(parsed, path).byId.values()];
}

/**
 * Загружает карты всех предметов из каталога и сшивает их в один граф.
 * Отсутствующий файл предмета пропускается — на этапе сборки карт (задача 5)
 * их появление растянуто во времени; пустой каталог считается ошибкой.
 */
export function loadCurriculum(dir: string = CURRICULUM_DIR): TopicGraph {
  const topics: Topic[] = [];
  for (const subject of SUBJECTS) {
    topics.push(...(readCurriculumFile(dir, subject) ?? []));
  }

  if (topics.length === 0) {
    throw new Error(`Не найдено ни одной карты тем в ${dir}`);
  }

  return buildTopicGraph(topics);
}

export interface SyncResult {
  /** Темы, заведённые в `topic_state` этим вызовом. */
  added: string[];
  /** Строки `topic_state` без темы в карте: игнорируются, но их полезно видеть. */
  stale: string[];
}

/**
 * Приводит `topic_state` к карте тем: отсутствующие темы заводятся с нулевыми
 * значениями, состояние известных не трогается. Записи по исчезнувшим темам
 * не удаляются — тема может вернуться в карту вместе со своей историей, а
 * удаление увело бы за собой задания и попытки по каскаду.
 */
export function syncTopicState(db: Database, graph: TopicGraph): SyncResult {
  const known = new Set(
    db
      .prepare<[], { topic_id: string }>('SELECT topic_id FROM topic_state')
      .all()
      .map((row) => row.topic_id),
  );

  const added = [...graph.byId.keys()].filter((id) => !known.has(id));
  const insert = db.prepare('INSERT INTO topic_state (topic_id) VALUES (?)');
  db.transaction(() => {
    for (const id of added) insert.run(id);
  })();

  return {
    added,
    stale: [...known].filter((id) => !graph.byId.has(id)),
  };
}
