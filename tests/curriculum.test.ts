import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../server/db.js';
import {
  CURRICULUM_DIR,
  loadCurriculum,
  parseCurriculumFile,
  syncTopicState,
} from '../server/curriculum.js';

/** Минимальная валидная тема; тесты правят ровно то поле, которое проверяют. */
function topic(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'math.fractions-basic',
    subject: 'math',
    title: 'Обыкновенные дроби',
    exam_weight: 2,
    difficulty: 1,
    prereqs: [],
    answer_format: 'number',
    prompt_seed: 'Сокращение и сравнение дробей, формулировки вида «Сократи дробь 18/24».',
    ...overrides,
  };
}

function file(topics: Record<string, unknown>[], subject = 'math'): Record<string, unknown> {
  return { subject, topics };
}

describe('карта тем', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-curriculum-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeSubject(subject: string, content: unknown): void {
    writeFileSync(join(tempDir, `${subject}.json`), JSON.stringify(content), 'utf8');
  }

  describe('загрузка и граф', () => {
    it('загружает валидную карту и строит граф', () => {
      const graph = parseCurriculumFile(
        file([
          topic(),
          topic({ id: 'math.percent', prereqs: ['math.fractions-basic'], exam_weight: 3 }),
        ]),
        'math.json',
      );

      expect([...graph.byId.keys()]).toEqual(['math.fractions-basic', 'math.percent']);
      expect(graph.byId.get('math.percent')?.examWeight).toBe(3);
      expect(graph.byId.get('math.percent')?.prereqs).toEqual(['math.fractions-basic']);
      expect(graph.dependents.get('math.fractions-basic')).toEqual(['math.percent']);
      expect(graph.bySubject.get('math')).toHaveLength(2);
    });

    it('переводит поля темы в camelCase', () => {
      const graph = parseCurriculumFile(file([topic()]), 'math.json');

      expect(graph.byId.get('math.fractions-basic')).toEqual({
        id: 'math.fractions-basic',
        subject: 'math',
        title: 'Обыкновенные дроби',
        examWeight: 2,
        difficulty: 1,
        prereqs: [],
        answerFormat: 'number',
        promptSeed: 'Сокращение и сравнение дробей, формулировки вида «Сократи дробь 18/24».',
      });
    });

    it('упорядочивает темы так, что предпосылки идут раньше зависимых', () => {
      const graph = parseCurriculumFile(
        file([
          topic({ id: 'math.percent', prereqs: ['math.ratio'] }),
          topic({ id: 'math.ratio', prereqs: ['math.fractions-basic'] }),
          topic(),
        ]),
        'math.json',
      );

      expect(graph.order.map((item) => item.id)).toEqual([
        'math.fractions-basic',
        'math.ratio',
        'math.percent',
      ]);
    });

    it('читает каталог с несколькими предметами', () => {
      writeSubject('math', file([topic()]));
      writeSubject(
        'russian',
        file([topic({ id: 'russian.spelling', subject: 'russian', answer_format: 'text' })], 'russian'),
      );

      const graph = loadCurriculum(tempDir);

      expect(graph.byId.size).toBe(2);
      expect(graph.bySubject.get('russian')?.[0]?.id).toBe('russian.spelling');
      expect(graph.subjects).toEqual(['math', 'russian']);
    });

    it('загружает настоящую карту тем из content/curriculum', () => {
      const graph = loadCurriculum(CURRICULUM_DIR);

      expect(graph.byId.size).toBeGreaterThan(0);
      expect(graph.subjects).toContain('math');
    });

    /**
     * Приёмка этапа: карты всех трёх предметов лежат в репозитории и проходят
     * валидатор целиком, а не по одной. Содержание проверяет человек — здесь
     * только структура и объём, которого хватит планировщику.
     */
    it('проводит карты трёх предметов через валидатор', () => {
      const graph = loadCurriculum(CURRICULUM_DIR);

      expect(graph.subjects).toEqual(['math', 'russian', 'english']);
      for (const subject of graph.subjects) {
        const topics = graph.bySubject.get(subject) ?? [];
        expect(topics.length).toBeGreaterThanOrEqual(15);
        expect(topics.length).toBeLessThanOrEqual(30);
        // Есть на чём считать прогноз и что предлагать планировщику.
        expect(topics.some((item) => item.examWeight >= 2)).toBe(true);
      }
      // Топологический порядок построен, значит циклов и висячих prereqs нет.
      expect(graph.order).toHaveLength(graph.byId.size);
    });
  });

  describe('ошибочные сценарии', () => {
    it('отвергает дубль id внятной ошибкой', () => {
      expect(() => parseCurriculumFile(file([topic(), topic()]), 'math.json')).toThrow(
        /math\.fractions-basic.*(дубл|повтор)/i,
      );
    });

    it('отвергает exam_weight вне 0-3', () => {
      expect(() => parseCurriculumFile(file([topic({ exam_weight: 4 })]), 'math.json')).toThrow(
        /exam_weight/,
      );
      expect(() => parseCurriculumFile(file([topic({ exam_weight: -1 })]), 'math.json')).toThrow(
        /exam_weight/,
      );
    });

    it('отвергает difficulty вне 1-3', () => {
      expect(() => parseCurriculumFile(file([topic({ difficulty: 0 })]), 'math.json')).toThrow(
        /difficulty/,
      );
      expect(() => parseCurriculumFile(file([topic({ difficulty: 5 })]), 'math.json')).toThrow(
        /difficulty/,
      );
    });

    it('отвергает неизвестный answer_format и предмет', () => {
      expect(() => parseCurriculumFile(file([topic({ answer_format: 'essay' })]), 'math.json')).toThrow(
        /answer_format/,
      );
      expect(() => parseCurriculumFile(file([topic()], 'химия'), 'химия.json')).toThrow(/subject/);
    });

    it('отвергает тему, предмет которой не совпадает с предметом файла', () => {
      expect(() =>
        parseCurriculumFile(file([topic({ id: 'russian.spelling', subject: 'russian' })]), 'math.json'),
      ).toThrow(/russian\.spelling/);
    });

    it('отвергает лишние и отсутствующие поля темы', () => {
      expect(() => parseCurriculumFile(file([topic({ note: 'лишнее' })]), 'math.json')).toThrow(
        /note/,
      );
      const withoutTitle = topic();
      delete withoutTitle.title;
      expect(() => parseCurriculumFile(file([withoutTitle]), 'math.json')).toThrow(/title/);
    });

    it('отвергает ссылку в prereqs на несуществующую тему', () => {
      expect(() =>
        parseCurriculumFile(file([topic({ prereqs: ['math.нет-такой'] })]), 'math.json'),
      ).toThrow(/math\.нет-такой|prereq/i);
    });

    it('обнаруживает цикл в prereqs', () => {
      expect(() =>
        parseCurriculumFile(
          file([
            topic({ id: 'math.a', prereqs: ['math.c'] }),
            topic({ id: 'math.b', prereqs: ['math.a'] }),
            topic({ id: 'math.c', prereqs: ['math.b'] }),
          ]),
          'math.json',
        ),
      ).toThrow(/цикл/i);
    });

    it('обнаруживает тему, объявленную собственной предпосылкой', () => {
      expect(() =>
        parseCurriculumFile(file([topic({ prereqs: ['math.fractions-basic'] })]), 'math.json'),
      ).toThrow(/цикл/i);
    });

    it('отвергает пустой список тем и не-объект в корне файла', () => {
      expect(() => parseCurriculumFile(file([]), 'math.json')).toThrow(/topics/);
      expect(() => parseCurriculumFile([topic()], 'math.json')).toThrow(/math\.json/);
    });

    it('сообщает имя файла в ошибке разбора', () => {
      writeFileSync(join(tempDir, 'math.json'), '{ не json', 'utf8');

      expect(() => loadCurriculum(tempDir)).toThrow(/math\.json/);
    });

    it('падает, если в каталоге нет ни одной карты тем', () => {
      expect(() => loadCurriculum(tempDir)).toThrow(/карт/i);
      expect(() => loadCurriculum(join(tempDir, 'нет-каталога'))).toThrow(/нет-каталога/);
    });
  });

  describe('синхронизация с topic_state', () => {
    let db: Database;

    beforeEach(() => {
      db = openDatabase(join(tempDir, 'test.db'));
    });

    afterEach(() => {
      db.close();
    });

    function states(): { topic_id: string; mastery: number; attempts: number }[] {
      return db
        .prepare<[], { topic_id: string; mastery: number; attempts: number }>(
          'SELECT topic_id, mastery, attempts FROM topic_state ORDER BY topic_id',
        )
        .all();
    }

    it('заводит отсутствующие темы с нулевыми значениями', () => {
      const graph = parseCurriculumFile(
        file([topic(), topic({ id: 'math.percent', prereqs: ['math.fractions-basic'] })]),
        'math.json',
      );

      const result = syncTopicState(db, graph);

      expect(result.added).toEqual(['math.fractions-basic', 'math.percent']);
      expect(states()).toEqual([
        { topic_id: 'math.fractions-basic', mastery: 0, attempts: 0 },
        { topic_id: 'math.percent', mastery: 0, attempts: 0 },
      ]);
    });

    it('не трогает состояние уже известных тем', () => {
      const graph = parseCurriculumFile(file([topic()]), 'math.json');
      syncTopicState(db, graph);
      db.prepare('UPDATE topic_state SET mastery = 0.7, attempts = 5 WHERE topic_id = ?').run(
        'math.fractions-basic',
      );

      const result = syncTopicState(db, graph);

      expect(result.added).toEqual([]);
      expect(states()).toEqual([{ topic_id: 'math.fractions-basic', mastery: 0.7, attempts: 5 }]);
    });

    it('игнорирует записи по исчезнувшим темам, не удаляя их', () => {
      db.prepare('INSERT INTO topic_state (topic_id, mastery) VALUES (?, ?)').run('math.старая', 0.9);
      const graph = parseCurriculumFile(file([topic()]), 'math.json');

      const result = syncTopicState(db, graph);

      expect(result.stale).toEqual(['math.старая']);
      expect(states().map((row) => row.topic_id)).toContain('math.старая');
    });

    it('идемпотентна: повторный вызов ничего не меняет', () => {
      const graph = parseCurriculumFile(file([topic()]), 'math.json');
      syncTopicState(db, graph);
      const before = states();

      syncTopicState(db, graph);

      expect(states()).toEqual(before);
    });
  });
});
