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
import type { Topic, TopicGraph } from '../curriculum.js';
import { SUBJECTS, type Subject } from '../db.js';
import { storeTasks, takeTask, type BankTask, type TakeTaskOptions } from './bank.js';
import { parseTaskBatch, type GeneratedTask } from './task-schema.js';

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
}

/** Тема посевного файла как она лежит в JSON: snake_case, как и в картах тем. */
interface SeedTopicJson {
  topic_id: string;
  tasks: GeneratedTask[];
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
 * `source` попадает в текст ошибки: иначе непонятно, какой из трёх файлов чинить.
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
  const topics = rawTopics.map((entry, index): SeedTopic => {
    const where = `${source}, запись ${index + 1}`;
    if (!isObject(entry)) throw new Error(`Посевной банк ${where}: ожидался объект`);

    const topicId = entry['topic_id'];
    if (typeof topicId !== 'string') {
      throw new Error(`Посевной банк ${where}: поле topic_id должно быть строкой`);
    }
    if (seen.has(topicId)) {
      throw new Error(`Посевной банк ${where}: тема «${topicId}» встречается дважды`);
    }
    seen.add(topicId);

    // Формат ответа задаёт карта тем, а от него зависит проверка `accept[]`:
    // без темы в карте посев проверить нечем, а положить его в базу — значит
    // нарушить внешний ключ `task_bank.topic_id`.
    const topic: Topic | undefined = graph.byId.get(topicId);
    if (topic === undefined) {
      throw new Error(`Посевной банк ${where}: темы «${topicId}» нет в карте`);
    }
    if (topic.subject !== subject) {
      throw new Error(
        `Посевной банк ${where}: тема «${topicId}» принадлежит предмету «${topic.subject}», а файл объявлен как «${subject}»`,
      );
    }

    const { tasks } = entry as unknown as SeedTopicJson;
    let parsed: GeneratedTask[];
    try {
      parsed = parseTaskBatch({ items: tasks }, topic.answerFormat);
    } catch (error) {
      throw new Error(`Посевной банк ${where}, тема «${topicId}»: ${(error as Error).message}`);
    }

    return { topicId, tasks: parsed };
  });

  return { subject: subject as Subject, topics };
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
 * Заливает посев в банк. Идемпотентна: повторный вызов не добавляет ничего, всё
 * уходит в `skipped` — на этом же и держится «не загружается повторно при
 * перезапуске».
 */
export function loadSeedBank(
  db: Database,
  graph: TopicGraph,
  options: LoadSeedBankOptions = {},
): LoadSeedBankResult {
  const dir = options.dir ?? SEED_BANK_DIR;
  const subjects = options.subjects ?? graph.subjects;

  const result: LoadSeedBankResult = { loaded: 0, skipped: 0, missing: [] };

  for (const subject of subjects) {
    const bank = readSeedBank(graph, subject, dir);
    if (bank === null) {
      result.missing.push(subject);
      continue;
    }

    for (const { topicId, tasks } of bank.topics) {
      const { stored, duplicates } = storeTasks(db, topicId, tasks);
      result.loaded += stored.length;
      result.skipped += duplicates.length;
    }
  }

  return result;
}

export interface TakeTaskOrSeedOptions extends TakeTaskOptions {
  dir?: string;
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
  const { dir, ...take } = options;
  const first = takeTask(db, topicId, take);
  if (first !== null) return first;

  const topic = graph.byId.get(topicId);
  if (topic === undefined) {
    throw new Error(`Посевной банк: темы «${topicId}» нет в карте`);
  }

  loadSeedBank(db, graph, {
    subjects: [topic.subject],
    ...(dir === undefined ? {} : { dir }),
  });

  return takeTask(db, topicId, take);
}

interface SeedRow {
  topic_id: string;
  question: string;
  answer: string;
  accept: string;
  hint: string | null;
  explain: string | null;
  joke: string | null;
  difficulty: number;
}

/**
 * Собирает задания предмета из банка в вид посевного файла. Берутся все
 * задания, включая выданные: посев — снимок содержимого банка для репозитория,
 * а не остаток очереди.
 */
export function collectSeedTasks(db: Database, graph: TopicGraph, subject: Subject): SeedTopic[] {
  const ids = (graph.bySubject.get(subject) ?? []).map((topic) => topic.id);
  if (ids.length === 0) return [];

  const rows = db
    .prepare<string[], SeedRow>(
      `SELECT topic_id, question, answer, accept, hint, explain, joke, difficulty
         FROM task_bank
        WHERE topic_id IN (${ids.map(() => '?').join(', ')})
        ORDER BY topic_id, id`,
    )
    .all(...ids);

  const byTopic = new Map<string, GeneratedTask[]>();
  for (const row of rows) {
    let accept: unknown;
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
    byTopic.set(row.topic_id, [
      ...(byTopic.get(row.topic_id) ?? []),
      {
        question: row.question,
        answer: row.answer,
        accept: accept as string[],
        hint: row.hint ?? '',
        explain: row.explain ?? '',
        joke: row.joke ?? '',
        difficulty: row.difficulty,
      },
    ]);
  }

  // Порядок тем — как в карте: у файла в репозитории должен быть устойчивый
  // вид, иначе каждый экспорт даёт бессмысленный диф.
  return ids
    .filter((id) => byTopic.has(id))
    .map((id) => ({ topicId: id, tasks: byTopic.get(id) ?? [] }));
}

/** Сериализует посев в тот же вид, в котором он лежит в репозитории. */
export function formatSeedBank(subject: Subject, topics: readonly SeedTopic[]): string {
  const payload = {
    subject,
    topics: topics.map((entry): SeedTopicJson => ({ topic_id: entry.topicId, tasks: entry.tasks })),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}
