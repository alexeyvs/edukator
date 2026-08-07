import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../server/db.js';
import {
  countAvailable,
  recentQuestions,
  storeTasks,
  takeTask,
} from '../server/codex/bank.js';
import type { GeneratedTask } from '../server/codex/task-schema.js';

const TOPIC = 'math.fractions';

function task(patch: Partial<GeneratedTask> = {}): GeneratedTask {
  return {
    question: 'Сколько будет 2 + 2?',
    answer: '4',
    accept: ['4', 'четыре'],
    hint: 'Сложи столбиком',
    explain: 'Два плюс два — четыре.',
    joke: 'Не Нобелевка, но зачёт',
    difficulty: 2,
    ...patch,
  };
}

/** Пять формулировок, различимых отпечатком: только они и годятся банку. */
function batch(count: number, difficulty = 2): GeneratedTask[] {
  return Array.from({ length: count }, (_, index) =>
    task({ question: `Задание номер ${index + 1}: сколько будет ${index + 1} + 2?`, difficulty }),
  );
}

describe('банк заданий', () => {
  let tempDir: string;
  let db: Database;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-bank-'));
    db = openDatabase(join(tempDir, 'test.db'));
    db.prepare('INSERT INTO topic_state (topic_id) VALUES (?)').run(TOPIC);
    db.prepare('INSERT INTO topic_state (topic_id) VALUES (?)').run('math.percent');
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('запись и выдача', () => {
    it('записывает задание, выдаёт его целиком и второй раз не предлагает', () => {
      const { stored, duplicates } = storeTasks(db, TOPIC, [task()]);

      expect(duplicates).toEqual([]);
      expect(stored).toHaveLength(1);
      expect(stored[0]?.topicId).toBe(TOPIC);
      expect(stored[0]?.id).toBeGreaterThan(0);

      const given = takeTask(db, TOPIC);

      expect(given).toMatchObject({
        id: stored[0]?.id,
        topicId: TOPIC,
        question: 'Сколько будет 2 + 2?',
        answer: '4',
        accept: ['4', 'четыре'],
        hint: 'Сложи столбиком',
        difficulty: 2,
      });
      expect(takeTask(db, TOPIC)).toBeNull();
      expect(countAvailable(db, TOPIC)).toBe(0);
    });

    it('считает остатком только невыданные задания темы', () => {
      storeTasks(db, TOPIC, batch(3));
      storeTasks(db, 'math.percent', batch(2));

      expect(countAvailable(db, TOPIC)).toBe(3);

      takeTask(db, TOPIC);

      expect(countAvailable(db, TOPIC)).toBe(2);
      expect(countAvailable(db, 'math.percent')).toBe(2);
    });

    it('выдаёт задания в порядке записи', () => {
      storeTasks(db, TOPIC, batch(3));

      const questions = [takeTask(db, TOPIC), takeTask(db, TOPIC), takeTask(db, TOPIC)].map(
        (given) => given?.question,
      );

      expect(questions).toEqual(batch(3).map((item) => item.question));
    });

    it('при заданной сложности берёт ближайшую по ней, а не первую попавшуюся', () => {
      storeTasks(db, TOPIC, [
        task({ question: 'Лёгкое: 1 + 1?', difficulty: 1 }),
        task({ question: 'Трудное: 17 * 24 - 8?', difficulty: 3 }),
      ]);

      expect(takeTask(db, TOPIC, { difficulty: 3 })?.difficulty).toBe(3);
      // Точного совпадения больше нет — остаётся ближайшее, а не пустая выдача.
      expect(takeTask(db, TOPIC, { difficulty: 3 })?.difficulty).toBe(1);
    });
  });

  describe('защита от повторов', () => {
    it('не пускает в банк формулировку, отличающуюся только регистром и пунктуацией', () => {
      storeTasks(db, TOPIC, [task()]);

      const repeat = task({ question: '  сколько будет 2+2 ' });
      const { stored, duplicates } = storeTasks(db, TOPIC, [repeat]);

      expect(stored).toEqual([]);
      expect(duplicates).toEqual([repeat]);
      expect(countAvailable(db, TOPIC)).toBe(1);
    });

    it('отсеивает дубль внутри одного батча, сохраняя остальные задания', () => {
      const { stored, duplicates } = storeTasks(db, TOPIC, [
        task({ question: 'Сколько будет 2 + 2?' }),
        task({ question: 'Сколько будет 2+2?' }),
        task({ question: 'Сколько будет 3 + 5?' }),
      ]);

      expect(stored.map((item) => item.question)).toEqual([
        'Сколько будет 2 + 2?',
        'Сколько будет 3 + 5?',
      ]);
      expect(duplicates).toHaveLength(1);
    });

    it('различает задания, отличающиеся только числами', () => {
      const { duplicates } = storeTasks(db, TOPIC, [
        task({ question: 'Сколько будет 2 + 2?' }),
        task({ question: 'Сколько будет 7 + 2?' }),
      ]);

      expect(duplicates).toEqual([]);
      expect(countAvailable(db, TOPIC)).toBe(2);
    });

    it('считает формулировку повтором только внутри своей темы', () => {
      storeTasks(db, TOPIC, [task()]);
      const { stored } = storeTasks(db, 'math.percent', [task()]);

      expect(stored).toHaveLength(1);
    });

    it('не записывает батч частично, если задание в нём непригодно', () => {
      expect(() => storeTasks(db, TOPIC, [task(), task({ question: '???' })])).toThrow(
        /формулировка.*пуста/i,
      );
      expect(countAvailable(db, TOPIC)).toBe(0);
    });
  });

  describe('последние формулировки', () => {
    it('отдаёт последние N в хронологическом порядке, включая уже выданные', () => {
      storeTasks(db, TOPIC, batch(3));
      takeTask(db, TOPIC);

      expect(recentQuestions(db, TOPIC, 2)).toEqual([
        'Задание номер 2: сколько будет 2 + 2?',
        'Задание номер 3: сколько будет 3 + 2?',
      ]);
      expect(recentQuestions(db, TOPIC)).toHaveLength(3);
    });

    it('на теме без заданий отдаёт пустой список', () => {
      expect(recentQuestions(db, TOPIC)).toEqual([]);
    });

    it('падает на неположительном пределе выборки', () => {
      expect(() => recentQuestions(db, TOPIC, 0)).toThrow(/положительным целым/i);
    });
  });

  describe('ошибочные сценарии', () => {
    it('на пустом банке темы отдаёт null, а не выдумывает задание', () => {
      expect(takeTask(db, TOPIC)).toBeNull();
      expect(countAvailable(db, TOPIC)).toBe(0);
    });

    it('падает внятной ошибкой на теме вне карты', () => {
      const missing = /темы «math.unknown» нет в карте/;

      expect(() => storeTasks(db, 'math.unknown', [task()])).toThrow(missing);
      expect(() => takeTask(db, 'math.unknown')).toThrow(missing);
      expect(() => recentQuestions(db, 'math.unknown')).toThrow(missing);
      expect(() => countAvailable(db, 'math.unknown')).toThrow(missing);
    });

    it('падает на задании с повреждённым accept[]', () => {
      const { stored } = storeTasks(db, TOPIC, [task()]);
      db.prepare('UPDATE task_bank SET accept = ? WHERE id = ?').run('{не json', stored[0]?.id);

      expect(() => takeTask(db, TOPIC)).toThrow(/accept\[\] не как JSON/i);
    });

    it('падает на accept[] не из строк', () => {
      const { stored } = storeTasks(db, TOPIC, [task()]);
      db.prepare('UPDATE task_bank SET accept = ? WHERE id = ?').run('[4]', stored[0]?.id);

      expect(() => takeTask(db, TOPIC)).toThrow(/должен быть массивом строк/i);
    });
  });
});
