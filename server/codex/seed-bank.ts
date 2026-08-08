/**
 * Посевной банк: задания, сгенерированные и проверенные заранее, лежащие в
 * репозитории файлами `content/seed-bank/<предмет>.json`. Он решает две задачи.
 *
 * Первая — первый запуск: банк в базе пуст, а генерация батча занимает у модели
 * полминуты, и без посева ученик увидел бы спиннер ровно в тот единственный
 * раз, когда приложение показывают впервые.
 *
 * Вторая — откат: codex бывает недоступен (нет сети, кончился доступ, упал
 * сервис), и тогда воркеру нечем пополнить очередь. Задание всё равно обязано
 * найтись, поэтому `takeTaskOrSeed` перед тем, как признать очередь пустой,
 * дозаливает посев по теме.
 *
 * Повторной загрузки при перезапуске не происходит: задания идут в банк тем же
 * `storeTasks`, а он отсекает уже лежащее по отпечатку формулировки. Отдельной
 * отметки «посев загружен» нет намеренно — она разошлась бы с содержимым базы,
 * стоит кому-то дописать в посевной файл новую тему.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import type { Database } from 'better-sqlite3';
import type { AnswerFormat, Topic, TopicGraph } from '../curriculum.js';
import { SUBJECTS, type Subject } from '../db.js';
import { storeTasks, takeTask, type BankTask, type TakeTaskOptions } from './bank.js';
import { parseTaskBatch, type GeneratedTask, type MaterialFormat } from './task-schema.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Каталог посевных файлов: по одному на предмет, лежат в репозитории. */
export const SEED_BANK_DIR = resolve(here, '..', '..', 'content', 'seed-bank');

/** Задания одной темы в посевном файле. */
export interface SeedTopic {
  topicId: string;
  tasks: GeneratedTask[];
}

export interface SeedBank {
  subject: Subject;
  topics: SeedTopic[];
  /**
   * Записи, которые разбор не пережил, — по одной причине на запись. Файл при
   * этом отдаётся: испорчена запись, а не файл.
   */
  problems: string[];
}

/** Тема посевного файла как она лежит в JSON: snake_case, как и в картах тем. */
interface SeedTopicJson {
  topic_id: string;
  tasks: GeneratedTask[];
}

function parseSeedTasks(tasks: GeneratedTask[], format: AnswerFormat): GeneratedTask[] {
  return parseTaskBatch({ items: tasks }, format);
}

export interface LoadSeedBankResult {
  /** Сколько заданий доехало до банка этим вызовом. */
  loaded: number;
  /** Сколько отсеяно как уже лежащее в теме: при перезапуске это весь посев. */
  skipped: number;
  /** Предметы, посевного файла у которых нет: не ошибка, но их полезно видеть. */
  missing: Subject[];
}

export function seedBankPath(subject: Subject, dir: string = SEED_BANK_DIR): string {
  return join(dir, `${subject}.json`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Разбирает посевной файл. Задания проверяются тем же `parseTaskBatch`, что и
 * ответ модели: посев — такой же непроверенный текст, только сгенерированный
 * раньше, и пропускать его мимо инвариантов значило бы завести в базе задания,
 * которые генератор бы не пропустил.
 *
 * Негодная запись выбрасывается поштучно, а не роняет разбор: причина уходит в
 * `problems`, а здоровые темы файла доезжают до банка. Бросить на первой значило
 * бы ровно то, от чего защищается перехват на каждую тему в `loadSeedBank`, —
 * переименованная в карте тем одна тема оставляла бы без посева весь предмет, то
 * есть все его темы отвечали бы 503, пока codex недоступен.
 *
 * Роняют разбор только поломки самого файла — не объект, чужой или неизвестный
 * предмет, `topics` не массивом: годных записей в таком файле не бывает по
 * определению.
 *
 * `source` попадает в текст причины: иначе непонятно, какой из трёх файлов чинить.
 */
export function parseSeedBank(
  raw: unknown,
  graph: TopicGraph,
  source: string,
  expected?: Subject,
): SeedBank {
  if (!isObject(raw)) {
    throw new Error(`Посевной банк ${source}: ожидался объект`);
  }

  const subject = raw['subject'];
  if (typeof subject !== 'string' || !SUBJECTS.includes(subject as Subject)) {
    throw new Error(
      `Посевной банк ${source}: поле subject должно быть одним из ${SUBJECTS.join(', ')}, получено «${String(subject)}»`,
    );
  }
  if (expected !== undefined && subject !== expected) {
    throw new Error(
      `Посевной банк ${source}: объявлен предмет «${subject}», а файл называется «${expected}.json»`,
    );
  }

  const rawTopics = raw['topics'];
  if (!Array.isArray(rawTopics)) {
    throw new Error(`Посевной банк ${source}: поле topics должно быть массивом`);
  }

  const seen = new Set<string>();
  const topics: SeedTopic[] = [];
  const problems: string[] = [];

  rawTopics.forEach((entry, index) => {
    const where = `${source}, запись ${index + 1}`;
    if (!isObject(entry)) {
      problems.push(`Посевной банк ${where}: ожидался объект`);
      return;
    }

    const topicId = entry['topic_id'];
    if (typeof topicId !== 'string') {
      problems.push(`Посевной банк ${where}: поле topic_id должно быть строкой`);
      return;
    }
    if (seen.has(topicId)) {
      problems.push(`Посевной банк ${where}: тема «${topicId}» встречается дважды`);
      return;
    }
    seen.add(topicId);

    // Формат ответа задаёт карта тем, а от него зависит проверка `accept[]`:
    // без темы в карте посев проверить нечем, а положить его в базу — значит
    // нарушить внешний ключ `task_bank.topic_id`.
    const topic: Topic | undefined = graph.byId.get(topicId);
    if (topic === undefined) {
      problems.push(`Посевной банк ${where}: темы «${topicId}» нет в карте`);
      return;
    }
    if (topic.subject !== subject) {
      problems.push(
        `Посевной банк ${where}: тема «${topicId}» принадлежит предмету «${topic.subject}», а файл объявлен как «${subject}»`,
      );
      return;
    }

    const { tasks } = entry as unknown as SeedTopicJson;
    let parsed: GeneratedTask[];
    try {
      parsed = parseSeedTasks(tasks, topic.answerFormat);
    } catch (error) {
      problems.push(`Посевной банк ${where}, тема «${topicId}»: ${(error as Error).message}`);
      return;
    }

    topics.push({ topicId, tasks: parsed });
  });

  return { subject: subject as Subject, topics, problems };
}

/**
 * Читает посевной файл предмета. Отсутствие файла — не ошибка, а `null`:
 * приложение обязано работать и на пустом посеве, иначе его нечем было бы
 * собрать в первый раз.
 */
export function readSeedBank(
  graph: TopicGraph,
  subject: Subject,
  dir: string = SEED_BANK_DIR,
): SeedBank | null {
  const path = seedBankPath(subject, dir);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Посевной банк ${path} не читается: ${(error as Error).message}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`Посевной банк ${path} не разбирается как JSON: ${(error as Error).message}`);
  }

  return parseSeedBank(raw, graph, path, subject);
}

export interface LoadSeedBankOptions {
  dir?: string;
  /** Предметы, которые загружать; по умолчанию все из карты. */
  subjects?: readonly Subject[];
}

/**
 * Порча посева с перечнем предметов, которые её не пережили.
 *
 * Список нужен выгрузке `prefetch --export`: предмет, посев которого не
 * загрузился, лежит в базе огрызком — тем, что успела нагенерировать пара
 * циклов, — и переписать им снимок значит потерять сам снимок. Отличить это от
 * «предмет ещё не грели» по содержимому базы нельзя, поэтому причина
 * передаётся ошибкой, а не угадывается по числу заданий.
 *
 * Вместе со списком уходит и частичный итог: здоровые предметы до банка
 * доехали, а `missing` той же выгрузке говорит, у каких предметов исходного
 * файла не было вовсе. Потеряв итог вместе с исключением, вызывающий считал бы
 * такой предмет загруженным.
 */
export class SeedBankError extends Error {
  readonly subjects: readonly Subject[];
  readonly result: LoadSeedBankResult;

  constructor(message: string, subjects: readonly Subject[], result: LoadSeedBankResult) {
    super(message);
    this.name = 'SeedBankError';
    this.subjects = subjects;
    this.result = result;
  }
}

/**
 * Заливает посев в банк. Идемпотентна: повторный вызов не добавляет ничего, всё
 * уходит в `skipped` — на этом же и держится «не загружается повторно при
 * перезапуске».
 *
 * Испорченный файл одного предмета не отменяет посев остальных: предметы
 * обходятся до конца, здоровые доезжают до банка, а причины собираются и
 * бросаются одной ошибкой уже после. Иначе дефект в `math.json` оставлял бы без
 * заданий и русский с английским — то есть занятие целиком, — а вызывающие
 * ошибку и так только пишут в stderr.
 *
 * Ровно так же и внутри файла: негодную запись отбрасывает разбор
 * (`parseSeedBank`), остальные темы предмета грузятся, а причина попадает в ту же
 * ошибку. Предмет при этом всё равно считается испорченным — выгрузка
 * `prefetch --export` не имеет права переписать снимок, часть которого не
 * загрузилась.
 */
export function loadSeedBank(
  db: Database,
  graph: TopicGraph,
  options: LoadSeedBankOptions = {},
): LoadSeedBankResult {
  const dir = options.dir ?? SEED_BANK_DIR;
  const subjects = options.subjects ?? graph.subjects;

  const result: LoadSeedBankResult = { loaded: 0, skipped: 0, missing: [] };
  const broken: string[] = [];
  // Предмет попадает сюда и когда не разобрался файл, и когда упала запись
  // одной темы: в обоих случаях в банке лежит не весь посев предмета.
  const brokenSubjects = new Set<Subject>();

  for (const subject of subjects) {
    let bank: SeedBank | null;
    try {
      bank = readSeedBank(graph, subject, dir);
    } catch (error) {
      broken.push((error as Error).message);
      brokenSubjects.add(subject);
      continue;
    }
    if (bank === null) {
      result.missing.push(subject);
      continue;
    }
    if (bank.problems.length > 0) {
      broken.push(...bank.problems);
      brokenSubjects.add(subject);
    }

    // Запись каждой темы — под своим перехватом. Тема, которой нет в
    // `topic_state`, роняет `storeTasks`, и общий на файл перехват оставлял бы
    // без посева весь остаток этого файла: отказ на пятой теме `math.json`
    // молча хоронил бы восемнадцать следующих.
    for (const { topicId, tasks } of bank.topics) {
      try {
        const { stored, duplicates } = storeTasks(db, topicId, tasks);
        result.loaded += stored.length;
        result.skipped += duplicates.length;
      } catch (error) {
        broken.push(`посев темы «${topicId}»: ${(error as Error).message}`);
        brokenSubjects.add(subject);
      }
    }
  }

  if (broken.length > 0) throw new SeedBankError(broken.join('; '), [...brokenSubjects], result);

  return result;
}

export interface TakeTaskOrSeedOptions extends TakeTaskOptions {
  dir?: string;
  /**
   * Предметы, посев которых в этом запросе уже дозаливали. Вызывающий перебирает
   * несколько тем подряд, а дозаливка предмета — разбор всего его файла плюс
   * транзакция на каждую тему; повторять это на второй пустой теме того же
   * предмета бессмысленно, залито уже всё.
   */
  seeded?: Set<Subject>;
}

/**
 * Задание по теме с откатом на посев. Обычный путь — очередь банка; когда она
 * пуста (codex недоступен и воркеру нечем было её пополнить), посев по этой
 * теме дозаливается и выдача повторяется.
 *
 * Дозаливка идёт по одному предмету, а не по всему посеву: тема известна, а
 * разбор двух лишних файлов на каждом промахе очереди ничего не даёт.
 *
 * `null` остаётся возможным ответом: посев по теме мог кончиться или его могло
 * не быть вовсе, и придумывать задание вместо него здесь нечем.
 */
export function takeTaskOrSeed(
  db: Database,
  graph: TopicGraph,
  topicId: string,
  options: TakeTaskOrSeedOptions = {},
): BankTask | null {
  const { dir, seeded, ...take } = options;
  const first = takeTask(db, topicId, take);
  if (first !== null) return first;

  const topic = graph.byId.get(topicId);
  if (topic === undefined) {
    throw new Error(`Посевной банк: темы «${topicId}» нет в карте`);
  }
  if (seeded !== undefined && seeded.has(topic.subject)) return null;
  seeded?.add(topic.subject);

  // Порча посевного файла — не повод отказать в занятии: сервер и при старте
  // терпит её, а здесь она пришла бы ученику пятисоткой посреди занятия. Причина
  // уходит в stderr, а тема выглядит просто пустой — что и есть правда.
  try {
    loadSeedBank(db, graph, {
      subjects: [topic.subject],
      ...(dir === undefined ? {} : { dir }),
    });
  } catch (error) {
    // Выдача повторяется и после ошибки: `loadSeedBank` бросает уже после обхода
    // всех тем, и здоровые из них — в том числе запрошенная — до банка доехали.
    // Возврат `null` прямо отсюда прятал бы залитое задание, а вместе с ним (из-за
    // отметки в `seeded`) и весь остаток предмета в этом запросе.
    process.stderr.write(`посевной банк не дозалит: ${(error as Error).message}\n`);
  }

  return takeTask(db, topicId, take);
}

interface SeedRow {
  topic_id: string;
  question: string;
  instruction: string | null;
  material: string | null;
  material_format: MaterialFormat | null;
  choices: string | null;
  answer: string;
  accept: string;
  hint: string | null;
  explain: string | null;
  joke: string | null;
  difficulty: number;
}

/**
 * Поле, без которого выгруженный посев не загрузится обратно: схема батча
 * требует непустых `hint`, `explain` и `joke`, а колонки банка допускают NULL —
 * строки, записанные до появления генератора, или правка базы руками. Выгрузив
 * их пустой строкой, экспорт переписал бы снимок файлом, который `parseTaskBatch`
 * отвергнет, а `loadSeedBank` ловит такую порчу по предмету целиком: снимок
 * пропал бы, и предмет остался бы вовсе без посева.
 */
function requireSeedText(value: string | null, field: string, question: string): string {
  const text = value ?? '';
  if (text.trim() === '') {
    throw new Error(
      `Посевной банк: у задания «${question}» пустое поле ${field}: такой посев не загрузится обратно`,
    );
  }
  return text;
}

/**
 * Собирает задания предмета из банка в вид посевного файла. Берутся все
 * задания, включая выданные: посев — снимок содержимого банка для репозитория,
 * а не остаток очереди. Кроме отбракованных: занятие пометило их `rejected`
 * именно потому, что задание негодное, — вернув их в посев, следующая загрузка
 * либо повторно выдала бы битое задание, либо уронила бы разбор файла и
 * оставила бы без посева весь предмет.
 */
export function collectSeedTasks(db: Database, graph: TopicGraph, subject: Subject): SeedTopic[] {
  const topics = graph.bySubject.get(subject) ?? [];
  const ids = topics.map((topic) => topic.id);
  if (ids.length === 0) return [];

  const rows = db
    .prepare<string[], SeedRow>(
      `SELECT topic_id, question, instruction, material, material_format, choices,
              answer, accept, hint, explain, joke, difficulty
         FROM task_bank
        WHERE topic_id IN (${ids.map(() => '?').join(', ')})
          AND status <> 'rejected'
        ORDER BY topic_id, id`,
    )
    .all(...ids);

  const byTopic = new Map<string, GeneratedTask[]>();
  for (const row of rows) {
    let accept: unknown;
    let choices: unknown;
    try {
      accept = JSON.parse(row.accept);
    } catch (error) {
      throw new Error(
        `Посевной банк: accept[] задания «${row.question}» не разбирается как JSON: ${(error as Error).message}`,
      );
    }
    if (!Array.isArray(accept) || accept.some((item) => typeof item !== 'string')) {
      throw new Error(`Посевной банк: accept[] задания «${row.question}» не массив строк`);
    }
    try {
      choices = JSON.parse(row.choices ?? '[]');
    } catch (error) {
      throw new Error(
        `Посевной банк: choices задания «${row.question}» не разбирается как JSON: ${(error as Error).message}`,
      );
    }
    if (!Array.isArray(choices) || choices.some((item) => typeof item !== 'string')) {
      throw new Error(`Посевной банк: choices задания «${row.question}» не массив строк`);
    }
    // Старые строки остаются доступны для истории попыток, но обратно в строго
    // структурированный посевной банк не выгружаются.
    if (row.instruction === null) continue;
    const task: GeneratedTask = {
      instruction: row.instruction,
      material: row.material ?? '',
      material_format: row.material_format ?? 'none',
      choices: choices as string[],
      answer: row.answer,
      accept: accept as string[],
      hint: requireSeedText(row.hint, 'hint', row.question),
      explain: requireSeedText(row.explain, 'explain', row.question),
      joke: requireSeedText(row.joke, 'joke', row.question),
      difficulty: row.difficulty,
    };
    const list = byTopic.get(row.topic_id);
    if (list === undefined) byTopic.set(row.topic_id, [task]);
    else list.push(task);
  }

  // Порядок тем — как в карте: у файла в репозитории должен быть устойчивый
  // вид, иначе каждый экспорт даёт бессмысленный диф.
  const seeds: SeedTopic[] = [];
  for (const topic of topics) {
    const tasks = byTopic.get(topic.id);
    if (tasks === undefined) continue;
    // Снимок проверяется ровно тем разбором, которым его будут читать обратно
    // (`parseSeedBank`), а не одними непустыми `hint`/`explain`/`joke`. Банк
    // держит инварианты формата на момент вставки, а `answer_format` темы мог с
    // тех пор смениться — пересборкой карты тем при том же `id`. Строки тогда
    // лежат в базе законно, но выгруженный из них файл `parseTaskBatch`
    // отвергнет, а `loadSeedBank` ловит такую порчу по предмету целиком: снимок
    // оказался бы переписан нечитаемым, и предмет остался бы без посева.
    try {
      parseSeedTasks(tasks, topic.answerFormat);
    } catch (error) {
      throw new Error(
        `Посевной банк: тема «${topic.id}» не пройдёт обратный разбор: ${(error as Error).message}`,
      );
    }
    seeds.push({ topicId: topic.id, tasks });
  }
  return seeds;
}

/** Сериализует посев в тот же вид, в котором он лежит в репозитории. */
export function formatSeedBank(subject: Subject, topics: readonly SeedTopic[]): string {
  const payload = {
    subject,
    topics: topics.map((entry): SeedTopicJson => ({ topic_id: entry.topicId, tasks: entry.tasks })),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}
