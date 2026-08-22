import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { SUBJECT_TITLES, requireCourseId, type CourseId } from './db.js';
import { describeSchemaErrors, schemaValidator } from './json-schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

/** Каталог с картами тем: истина в последней инстанции, `topic_state` — только рантайм. */
export const CURRICULUM_DIR = resolve(projectRoot, 'content', 'curriculum');

/** Схема одной карты тем. Она же уходит в codex через `--output-schema`. */
export const CURRICULUM_SCHEMA_PATH = resolve(projectRoot, 'schemas', 'curriculum.json');

/**
 * Минимальный `exam_weight` темы, которую разрешено ставить в `prereqs`:
 * тема вне экзамена в план не попадает, а значит и открыть собой ничего не может.
 */
export const MIN_PREREQ_WEIGHT = 1;

export const ANSWER_FORMATS = ['number', 'text', 'choice'] as const;
export type AnswerFormat = (typeof ANSWER_FORMATS)[number];

export interface Topic {
  id: string;
  subject: CourseId;
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

export interface CourseMetadata {
  courseId: CourseId;
  title: string;
  grade: string;
  revisionId: number | null;
}

export interface TopicGraph {
  /** Темы по `id`, в порядке объявления в файлах. */
  byId: Map<string, Topic>;
  /** Топологический порядок: предпосылки идут раньше зависимых от них тем. */
  order: Topic[];
  /** Обратные рёбра: тема → темы, для которых она предпосылка. */
  dependents: Map<string, string[]>;
  bySubject: Map<CourseId, Topic[]>;
  courses: Map<CourseId, CourseMetadata>;
  /** Совместимое имя: курсы в порядке объявления. */
  subjects: CourseId[];
}

/** Тема как она лежит в JSON: snake_case, ровно поля из схемы. */
interface TopicJson {
  id: string;
  subject: CourseId;
  title: string;
  exam_weight: number;
  difficulty: number;
  prereqs: string[];
  answer_format: AnswerFormat;
  prompt_seed: string;
}

interface CurriculumJson {
  subject: CourseId;
  title?: string;
  grade?: string;
  revision?: number;
  topics: TopicJson[];
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
export function buildTopicGraph(
  topics: Topic[],
  courseMetadata: Iterable<CourseMetadata> = [],
): TopicGraph {
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
      const required = byId.get(prereq);
      if (required === undefined) {
        throw new Error(
          `Карта тем: тема «${topic.id}» ссылается в prereqs на несуществующую тему «${prereq}»`,
        );
      }
      // Приоритет умножается на `exam_weight`, поэтому тему с нулевым весом
      // планировщик не предложит никогда — её `mastery` навсегда остаётся нулём,
      // а всё, что стоит за ней, навсегда закрыто. Проявляется это не ошибкой, а
      // молча выпавшим из плана куском карты, так что ловим при загрузке.
      if (required.examWeight < MIN_PREREQ_WEIGHT) {
        throw new Error(
          `Карта тем: тема «${topic.id}» требует «${prereq}» с exam_weight ${required.examWeight}: ` +
            'такая предпосылка не попадает в план и закрывает зависимые темы навсегда',
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

  const bySubject = new Map<CourseId, Topic[]>();
  for (const topic of topics) {
    bySubject.set(topic.subject, [...(bySubject.get(topic.subject) ?? []), topic]);
  }

  const courses = new Map<CourseId, CourseMetadata>();
  for (const metadata of courseMetadata) {
    if (courses.has(metadata.courseId)) {
      throw new Error(`Карта тем: курс «${metadata.courseId}» объявлен дважды`);
    }
    courses.set(metadata.courseId, { ...metadata });
  }
  for (const courseId of bySubject.keys()) {
    if (!courses.has(courseId)) {
      courses.set(courseId, {
        courseId,
        title: SUBJECT_TITLES[courseId] ?? courseId,
        grade: '',
        revisionId: null,
      });
    }
  }

  return {
    byId,
    order,
    dependents,
    bySubject,
    courses,
    subjects: [...bySubject.keys()],
  };
}

/**
 * Заменяет предложенные моделью локальные идентификаторы на ID, выданные
 * сервером. Старые значения используются только для разрешения prereqs внутри
 * одного ответа и никогда не становятся постоянной идентичностью темы.
 */
export function assignServerTopicIds(
  graph: TopicGraph,
  createToken: () => string = randomUUID,
): TopicGraph {
  const assigned = new Map<string, string>();
  for (const topic of graph.byId.values()) {
    const token = createToken();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(token)) {
      throw new Error(`Сервер выдал некорректный токен темы «${token}»`);
    }
    assigned.set(topic.id, `${topic.subject}.${token}`);
  }

  const topics = [...graph.byId.values()].map((topic): Topic => ({
    ...topic,
    id: assigned.get(topic.id) as string,
    prereqs: topic.prereqs.map((id) => assigned.get(id) as string),
  }));
  return buildTopicGraph(topics, graph.courses.values());
}

/**
 * Проверяет содержимое одной карты тем по JSON Schema и строит граф.
 * `source` — имя файла или иной источник: попадает в текст ошибки, иначе
 * непонятно, какую карту чинить. `expected` — course ID, который карта обязана
 * объявлять (используется для ответа модели; имя legacy-файла не проверяется).
 *
 * Схема требует и совпадения предмета с именем файла, и префикса `<subject>.`
 * в `id`, но выразить это в JSON Schema нельзя, поэтому проверки здесь.
 */
export function parseCurriculumFile(
  raw: unknown,
  source: string,
  expected?: CourseId,
): TopicGraph {
  const validate = schemaValidator<CurriculumJson>(CURRICULUM_SCHEMA_PATH);
  if (!validate(raw)) {
    throw new Error(
      `Карта тем ${source} не соответствует схеме: ${describeSchemaErrors(validate.errors)}`,
    );
  }
  requireCourseId(raw.subject, `Карта тем ${source}: subject`);

  // Иначе `math.json` с предметом «russian» проходит молча, и математика просто
  // исчезает из планирования: в графе её нет, а старт лишь пишет предупреждение.
  if (expected !== undefined && raw.subject !== expected) {
    throw new Error(
      `Карта тем ${source}: объявлен предмет «${raw.subject}», а файл называется «${expected}.json»`,
    );
  }

  for (const topic of raw.topics) {
    if (topic.subject !== raw.subject) {
      throw new Error(
        `Карта тем ${source}: у темы «${topic.id}» предмет «${topic.subject}», а файл объявлен как «${raw.subject}»`,
      );
    }
    // Пространство имён `id` — единственное, что отличает темы разных карт при
    // сшивании их в один граф: чужой префикс роняет тему в чужой неймспейс.
    if (!topic.id.startsWith(`${raw.subject}.`)) {
      throw new Error(
        `Карта тем ${source}: id темы «${topic.id}» должен начинаться с «${raw.subject}.»`,
      );
    }
  }

  return buildTopicGraph(raw.topics.map(toTopic), [{
    courseId: raw.subject,
    title: raw.title ?? SUBJECT_TITLES[raw.subject] ?? raw.subject,
    grade: raw.grade ?? '7 класс',
    revisionId: raw.revision ?? 1,
  }]);
}

function readCurriculumFile(path: string): TopicGraph {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Карта тем ${path} не найдена`);
    }
    throw new Error(`Карта тем ${path} не читается: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Карта тем ${path} не разбирается как JSON: ${(error as Error).message}`);
  }

  return parseCurriculumFile(parsed, path);
}

/**
 * Обнаруживает все JSON-карты в каталоге и сшивает их в один граф. Legacy-курсы
 * сохраняют привычный порядок, произвольные новые ID идут после них по алфавиту.
 */
export function loadCurriculum(dir: string = CURRICULUM_DIR): TopicGraph {
  const topics: Topic[] = [];
  const courses: CourseMetadata[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch (error) {
    throw new Error(`Каталог карт ${dir} не читается: ${(error as Error).message}`);
  }
  if (entries.length === 0) {
    throw new Error(`Каталог карт ${dir} не содержит JSON-карт`);
  }
  const graphs = entries.map((entry) => readCurriculumFile(join(dir, entry)));
  const legacyOrder = new Map(
    Object.keys(SUBJECT_TITLES).map((courseId, index) => [courseId, index]),
  );
  graphs.sort((left, right) => {
    const leftId = left.subjects[0] as string;
    const rightId = right.subjects[0] as string;
    const leftRank = legacyOrder.get(leftId) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = legacyOrder.get(rightId) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || leftId.localeCompare(rightId);
  });
  for (const graph of graphs) {
    topics.push(...graph.byId.values());
    courses.push(...graph.courses.values());
  }

  return buildTopicGraph(topics, courses);
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
  const insert = db.prepare('INSERT INTO topic_state (topic_id) VALUES (?)');
  const readState = db.prepare<[], { topic_id: string }>('SELECT topic_id FROM topic_state');

  // Чтение без транзакции перед транзакцией: заводить обычно нечего, а
  // `syncTopicState` зовётся на каждом /api/health. `immediate` берёт запись на
  // всю базу и под WAL ждёт занятия и воркера до истечения busy timeout —
  // синхронно, всем событийным циклом, — а по истечении опрос здоровья ответил
  // бы «database: error» об исправной базе. Гонку двух стартов это не открывает:
  // состав перечитывается заново уже под записью, и решение о вставке принимает
  // именно оно.
  const before = new Set(readState.all().map((row) => row.topic_id));
  if ([...graph.byId.keys()].every((id) => before.has(id))) {
    return { added: [], stale: [...before].filter((id) => !graph.byId.has(id)) };
  }

  // Чтение состава внутри той же транзакции, что и вставка, и `immediate`, а не
  // отложенная: иначе два старта сервера подряд оба увидят пустой `topic_state`,
  // оба соберут один и тот же `added` — и второй упадёт на первичном ключе.
  const { known, added } = db.transaction((): { known: Set<string>; added: string[] } => {
    const seen = new Set(readState.all().map((row) => row.topic_id));
    const fresh = [...graph.byId.keys()].filter((id) => !seen.has(id));
    for (const id of fresh) insert.run(id);
    return { known: seen, added: fresh };
  }).immediate();

  return {
    added,
    stale: [...known].filter((id) => !graph.byId.has(id)),
  };
}
