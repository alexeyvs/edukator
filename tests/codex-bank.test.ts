import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../server/db.js';
import {
  bossTaskAtPosition,
  countAvailable,
  issuedTask,
  learningTaskAtPosition,
  readBankTask,
  recentQuestions,
  reserveBossTasks,
  reserveLearningTasks,
  storeTasks,
  takeTask,
} from '../server/codex/bank.js';
import type { GeneratedTask } from '../server/codex/task-schema.js';

const TOPIC = 'math.fractions';

const LEARNING_CONTENT = {
  introduction: 'Разберём сложение по шагам.',
  objectives: ['Складывать небольшие числа'],
  sections: [
    { title: 'Идея', blocks: [{ type: 'paragraph', content: 'Слагаемые объединяются в сумму.' }] },
    { title: 'Правило', blocks: [{ type: 'formula', content: 'a+b=c' }] },
    { title: 'Пример', blocks: [{ type: 'example', content: 'Два плюс два равно четырём.' }] },
  ],
  summary: ['Сложи слагаемые.', 'Проверь сумму обратным действием.'],
};

function task(patch: Partial<GeneratedTask> = {}): GeneratedTask {
  return {
    instruction: 'Сколько будет 2 + 2?', material: '', material_format: 'none', choices: [],
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
    task({ instruction: `Задание номер ${index + 1}: сколько будет ${index + 1} + 2?`, difficulty }),
  );
}

function preparingBatch(db: Database): number {
  return db.prepare<[string], { id: number }>(
    "INSERT INTO boss_batches (topic_id, status) VALUES (?, 'preparing') RETURNING id",
  ).get(TOPIC)?.id ?? 0;
}

function preparingMaterial(db: Database): number {
  return Number(db.prepare(
    `INSERT INTO learning_materials
       (subject, topic_id, recommendation_reason, mastery_before)
     VALUES ('math', ?, 'Слабая тема', 0.2)`,
  ).run(TOPIC).lastInsertRowid);
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
    it('изолирует одинаковую тему и формулировку по редакции курса', () => {
      const oldStored = storeTasks(db, TOPIC, [task()], { courseRevisionId: 10 }).stored[0];
      const newStored = storeTasks(db, TOPIC, [task()], { courseRevisionId: 11 }).stored[0];
      expect(countAvailable(db, TOPIC, 10)).toBe(1);
      expect(countAvailable(db, TOPIC, 11)).toBe(1);
      expect(recentQuestions(db, TOPIC, 10, 11)).toHaveLength(1);
      expect(takeTask(db, TOPIC, { courseRevisionId: 11 })?.id).toBe(newStored?.id);
      expect(takeTask(db, TOPIC, { courseRevisionId: 11 })).toBeNull();
      expect(takeTask(db, TOPIC, { courseRevisionId: 10 })?.id).toBe(oldStored?.id);
    });
    it('балансирует позиции правильных choice-ответов внутри записываемого батча', () => {
      const choices = ['Правильный', 'Первый дистрактор', 'Второй дистрактор', 'Третий дистрактор'];
      const generated = Array.from({ length: 12 }, (_, index) => task({
        instruction: `Выбор ${index + 1}: найди правильную карточку.`,
        choices,
        answer: 'Правильный',
        accept: ['Правильный'],
      }));

      const { stored } = storeTasks(db, TOPIC, generated);
      const counts = [0, 0, 0, 0];
      for (const item of stored) {
        if (!('choices' in item)) throw new Error('choice сохранился в старом формате');
        const position = item.choices.indexOf(item.answer);
        counts[position] = (counts[position] ?? 0) + 1;
        expect(new Set(item.choices)).toEqual(new Set(choices));
      }

      expect(counts).toEqual([3, 3, 3, 3]);
    });

    it('один раз перемешивает word_tiles и сохраняет полученный порядок', () => {
      const { stored } = storeTasks(db, TOPIC, [task({
        instruction: 'Собери предложение о погоде.',
        answer: 'Moscow is colder in winter.',
        accept: ['Moscow is colder in winter.'],
        word_tiles: ['winter.', 'colder', 'Moscow', 'in', 'is'],
      })]);
      const id = stored[0]?.id;
      expect(id).toBeDefined();

      const first = readBankTask(db, id as number);
      const second = readBankTask(db, id as number);
      const firstTiles = first !== null && 'word_tiles' in first ? first.word_tiles : undefined;
      const secondTiles = second !== null && 'word_tiles' in second ? second.word_tiles : undefined;
      expect(firstTiles?.join(' ')).not.toBe('Moscow is colder in winter.');
      expect(firstTiles).toEqual(secondTiles);
      expect(firstTiles?.toSorted()).toEqual(
        ['Moscow', 'is', 'colder', 'in', 'winter.'].toSorted(),
      );
      expect(first?.deep_hint).toBeDefined();
    });

    it('считает fingerprint и историю по полному структурированному тексту', () => {
      const structured = (material: string): GeneratedTask => ({
        instruction: 'Вычисли значение.', material, material_format: 'math', choices: [],
        answer: '4', accept: ['4'],
        hint: 'Сначала выполни действие. Затем проверь обратным действием.',
        explain: 'Получается четыре.', joke: 'Сошлось.', difficulty: 2,
      });

      expect(storeTasks(db, TOPIC, [structured('2+2'), structured('3+1')]).stored).toHaveLength(2);
      expect(recentQuestions(db, TOPIC)).toEqual([
        'Вычисли значение.\n\n2+2',
        'Вычисли значение.\n\n3+1',
      ]);
      expect(takeTask(db, TOPIC)).toMatchObject({
        instruction: 'Вычисли значение.',
        material: '2+2',
        material_format: 'math',
        choices: [],
      });
    });

    it('хранит варианты как JSON и отвергает повреждённую строку', () => {
      const { stored } = storeTasks(db, TOPIC, [{
        instruction: 'Выбери ответ.', material: '', material_format: 'none', choices: ['3', '4'],
        answer: '4', accept: ['4'],
        hint: 'Сравни варианты по очереди. Проверь выбранное сложением.',
        explain: 'Верный вариант — четыре.', joke: 'Карточка сошлась.', difficulty: 1,
      }]);
      db.prepare('UPDATE task_bank SET choices = ? WHERE id = ?').run('{', stored[0]?.id);

      expect(() => takeTask(db, TOPIC)).toThrow(/choices.*не как JSON/u);
      expect(takeTask(db, TOPIC)).toBeNull();
    });

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

      expect(questions).toEqual(batch(3).map((item) => item.instruction));
    });

    it('при заданной сложности берёт ближайшую по ней, а не первую попавшуюся', () => {
      storeTasks(db, TOPIC, [
        task({ instruction: 'Лёгкое: 1 + 1?', difficulty: 1 }),
        task({ instruction: 'Трудное: 17 * 24 - 8?', difficulty: 3 }),
      ]);

      expect(takeTask(db, TOPIC, { difficulty: 3 })?.difficulty).toBe(3);
      // Точного совпадения больше нет — остаётся ближайшее, а не пустая выдача.
      expect(takeTask(db, TOPIC, { difficulty: 3 })?.difficulty).toBe(1);
    });
  });

  describe('уже выданное задание', () => {
    it('находит выданное, на которое ещё не ответили', () => {
      storeTasks(db, TOPIC, batch(3));
      const given = takeTask(db, TOPIC);

      expect(issuedTask(db, TOPIC)).toMatchObject({ id: given?.id, question: given?.question });
      // Очередь при этом не тронута: повторная выдача её не расходует.
      expect(countAvailable(db, TOPIC)).toBe(2);
    });

    it('перестаёт находить задание, на которое ответили', () => {
      storeTasks(db, TOPIC, batch(2));
      const given = takeTask(db, TOPIC);
      db.prepare(
        `INSERT INTO attempts (task_id, topic_id, answer, is_correct)
         VALUES (?, ?, '4', 1)`,
      ).run(given?.id, TOPIC);

      expect(issuedTask(db, TOPIC)).toBeNull();
    });

    it('отдаёт null, когда выданного нет, и падает на теме вне карты', () => {
      storeTasks(db, TOPIC, batch(2));

      expect(issuedTask(db, TOPIC)).toBeNull();
      expect(() => issuedTask(db, 'math.unknown')).toThrow(/нет в карте/u);
    });

    it('отдаёт раньше выданное первым, когда неотвеченных несколько', () => {
      storeTasks(db, TOPIC, batch(3));
      const first = takeTask(db, TOPIC);
      takeTask(db, TOPIC);

      expect(issuedTask(db, TOPIC)?.id).toBe(first?.id);
    });
  });

  describe('защита от повторов', () => {
    it('не пускает в банк формулировку, отличающуюся только регистром и пунктуацией', () => {
      storeTasks(db, TOPIC, [task()]);

      const repeat = task({ instruction: '  сколько будет 2+2 ' });
      const { stored, duplicates } = storeTasks(db, TOPIC, [repeat]);

      expect(stored).toEqual([]);
      expect(duplicates).toEqual([repeat]);
      expect(countAvailable(db, TOPIC)).toBe(1);
    });

    it('отсеивает дубль внутри одного батча, сохраняя остальные задания', () => {
      const { stored, duplicates } = storeTasks(db, TOPIC, [
        task({ instruction: 'Сколько будет 2 + 2?' }),
        task({ instruction: 'Сколько будет 2+2?' }),
        task({ instruction: 'Сколько будет 3 + 5?' }),
      ]);

      expect(stored.map((item) => item.question)).toEqual([
        'Сколько будет 2 + 2?',
        'Сколько будет 3 + 5?',
      ]);
      expect(duplicates).toHaveLength(1);
    });

    it('различает задания, отличающиеся только числами', () => {
      const { duplicates } = storeTasks(db, TOPIC, [
        task({ instruction: 'Сколько будет 2 + 2?' }),
        task({ instruction: 'Сколько будет 7 + 2?' }),
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
      expect(() => storeTasks(db, TOPIC, [task(), task({ instruction: '???' })])).toThrow(
        /формулировка.*пуста/i,
      );
      expect(countAvailable(db, TOPIC)).toBe(0);
    });
  });

  describe('резерв босса', () => {
    it('пишет задания в редакцию boss-батча', () => {
      const batchId = preparingBatch(db);
      db.prepare('UPDATE boss_batches SET course_revision_id = 17 WHERE id = ?').run(batchId);
      expect(reserveBossTasks(db, batchId, batch(5)).ready).toBe(true);
      expect(db.prepare<[string], { revisions: number }>(
        'SELECT COUNT(DISTINCT course_revision_id) AS revisions FROM task_bank WHERE status = ?',
      ).get('boss_reserved')).toEqual({ revisions: 1 });
      expect(db.prepare("SELECT MIN(course_revision_id) AS revision FROM task_bank WHERE status = 'boss_reserved'").get())
        .toEqual({ revision: 17 });
    });
    it('сохраняет контракт обычной вставки и атомарной выдачи', () => {
      const ordinary = task({ instruction: 'Обычный контракт: сколько будет 6 + 7?' });

      expect(storeTasks(db, TOPIC, [ordinary])).toMatchObject({
        duplicates: [],
        stored: [{ question: 'Обычный контракт: сколько будет 6 + 7?', topicId: TOPIC }],
      });
      expect(takeTask(db, TOPIC)).toMatchObject({
        question: 'Обычный контракт: сколько будет 6 + 7?',
        answer: '4',
        accept: ['4', 'четыре'],
      });
      expect(takeTask(db, TOPIC)).toBeNull();
    });

    it('атомарно связывает пять позиций и не смешивает их с обычной очередью', () => {
      storeTasks(db, TOPIC, [task({ instruction: 'Обычная очередь: сколько будет 10 + 1?' })]);
      const batchId = preparingBatch(db);

      const result = reserveBossTasks(db, batchId, batch(5));

      expect(result.ready).toBe(true);
      expect(result.stored).toHaveLength(5);
      expect(db.prepare('SELECT status FROM boss_batches WHERE id = ?').get(batchId))
        .toEqual({ status: 'ready' });
      expect(db.prepare(
        `SELECT boss_tasks.position, task_bank.status
           FROM boss_tasks JOIN task_bank ON task_bank.id = boss_tasks.task_id
          WHERE boss_tasks.batch_id = ? ORDER BY boss_tasks.position`,
      ).all(batchId)).toEqual([1, 2, 3, 4, 5].map((position) => ({
        position, status: 'boss_reserved',
      })));
      expect(countAvailable(db, TOPIC)).toBe(1);
      expect(takeTask(db, TOPIC)?.question).toBe('Обычная очередь: сколько будет 10 + 1?');
      expect(takeTask(db, TOPIC)).toBeNull();
    });

    it('читает только указанную позицию и не повторяет уже отвеченную', () => {
      const batchId = preparingBatch(db);
      reserveBossTasks(db, batchId, batch(5));

      expect(bossTaskAtPosition(db, batchId, 2)?.question).toBe(
        'Задание номер 2: сколько будет 2 + 2?',
      );
      expect(bossTaskAtPosition(db, batchId, 3)?.question).toBe(
        'Задание номер 3: сколько будет 3 + 2?',
      );
      const answered = bossTaskAtPosition(db, batchId, 2);
      db.prepare(
        `INSERT INTO attempts (task_id, topic_id, answer, is_correct)
         VALUES (?, ?, '4', 1)`,
      ).run(answered?.id, TOPIC);

      expect(bossTaskAtPosition(db, batchId, 2)).toBeNull();
      expect(() => bossTaskAtPosition(db, batchId, 6)).toThrow(/от 1 до 5/u);
    });

    it('при дубле внутри набора проваливает батч и выводит новые строки из резерва', () => {
      const batchId = preparingBatch(db);
      const tasks = batch(5);
      tasks[1] = task({ instruction: tasks[0]?.instruction ?? '' });

      expect(reserveBossTasks(db, batchId, tasks)).toMatchObject({ ready: false, stored: [] });
      expect(db.prepare('SELECT status FROM boss_batches WHERE id = ?').get(batchId))
        .toEqual({ status: 'failed' });
      expect(db.prepare(
        "SELECT COUNT(*) AS n FROM task_bank WHERE status = 'boss_reserved'",
      ).get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM boss_tasks WHERE batch_id = ?').get(batchId))
        .toEqual({ n: 0 });
    });

    it('при дубле между попытками не оставляет частично готовый второй бой', () => {
      const firstId = preparingBatch(db);
      expect(reserveBossTasks(db, firstId, batch(4)).ready).toBe(false);
      const secondId = preparingBatch(db);

      expect(reserveBossTasks(db, secondId, batch(5)).ready).toBe(false);
      expect(db.prepare('SELECT status FROM boss_batches WHERE id = ?').get(secondId))
        .toEqual({ status: 'failed' });
      expect(db.prepare('SELECT COUNT(*) AS n FROM boss_tasks WHERE batch_id = ?').get(secondId))
        .toEqual({ n: 0 });
      expect(db.prepare(
        "SELECT COUNT(*) AS n FROM task_bank WHERE status = 'boss_reserved'",
      ).get()).toEqual({ n: 0 });
    });

    it('повреждённый JSON проваливает весь готовый бой', () => {
      const batchId = preparingBatch(db);
      const { stored } = reserveBossTasks(db, batchId, batch(5));
      db.prepare('UPDATE task_bank SET accept = ? WHERE id = ?').run('{', stored[1]?.id);

      expect(() => bossTaskAtPosition(db, batchId, 2)).toThrow(/accept\[\].*не как JSON/u);
      expect(db.prepare('SELECT status FROM boss_batches WHERE id = ?').get(batchId))
        .toEqual({ status: 'failed' });
      expect(db.prepare(
        "SELECT COUNT(*) AS n FROM task_bank WHERE status = 'boss_reserved'",
      ).get()).toEqual({ n: 0 });
    });

    it('ошибка посреди связывания откатывает все строки и не объявляет бой готовым', () => {
      const batchId = preparingBatch(db);
      db.exec(`CREATE TRIGGER stop_boss_link BEFORE INSERT ON boss_tasks
        WHEN NEW.position = 3 BEGIN SELECT RAISE(ABORT, 'оборванная вставка'); END`);

      expect(() => reserveBossTasks(db, batchId, batch(5))).toThrow(/оборванная вставка/u);
      expect(db.prepare('SELECT status FROM boss_batches WHERE id = ?').get(batchId))
        .toEqual({ status: 'preparing' });
      expect(db.prepare('SELECT COUNT(*) AS n FROM boss_tasks WHERE batch_id = ?').get(batchId))
        .toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM task_bank').get()).toEqual({ n: 0 });
    });
  });

  describe('резерв материала', () => {
    it('пишет задания в редакцию learning material', () => {
      const materialId = preparingMaterial(db);
      db.prepare('UPDATE learning_materials SET course_revision_id = 23 WHERE id = ?').run(materialId);
      expect(reserveLearningTasks(db, materialId, LEARNING_CONTENT, batch(5)).ready).toBe(true);
      expect(db.prepare("SELECT MIN(course_revision_id) AS revision FROM task_bank WHERE status = 'lesson_reserved'").get())
        .toEqual({ revision: 23 });
    });
    it('читает тест строго по позиции и не повторяет отвеченное', () => {
      const materialId = preparingMaterial(db);
      const { stored, ready } = reserveLearningTasks(
        db,
        materialId,
        LEARNING_CONTENT,
        batch(5),
      );
      expect(ready).toBe(true);
      const runId = Number(db.prepare(
        `INSERT INTO runs (subject, kind, topic_id, started_at, lives_remaining)
         VALUES ('math', 'lesson', ?, '2026-08-08T08:00:00.000Z', NULL)`,
      ).run(TOPIC).lastInsertRowid);
      expect(learningTaskAtPosition(db, materialId, 2, runId)?.id).toBe(stored[1]?.id);

      db.prepare(
        `INSERT INTO attempts (task_id, topic_id, run_id, answer, is_correct)
         VALUES (?, ?, ?, '4', 1)`,
      ).run(stored[1]?.id, TOPIC, runId);
      expect(learningTaskAtPosition(db, materialId, 2, runId)).toBeNull();
      expect(() => learningTaskAtPosition(db, materialId, 0, runId)).toThrow(/от 1 до 5/u);
      expect(() => learningTaskAtPosition(db, materialId, 6, runId)).toThrow(/от 1 до 5/u);
    });

    it('отклоняет claim до публикации, если содержимое не прошло схему', () => {
      const materialId = preparingMaterial(db);

      expect(() => reserveLearningTasks(
        db,
        materialId,
        { introduction: '<script>не теория</script>' },
        batch(5),
      )).toThrow(/содержимое материала не прошло проверку/u);

      expect(db.prepare(
        'SELECT status, content, finished_at FROM learning_materials WHERE id = ?',
      ).get(materialId)).toMatchObject({
        status: 'rejected', content: null, finished_at: expect.any(String),
      });
      expect(db.prepare('SELECT COUNT(*) AS n FROM learning_tasks WHERE material_id = ?').get(materialId))
        .toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM task_bank').get()).toEqual({ n: 0 });
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

    // Иначе строка остаётся `used` без попытки, `issuedTask` находит её снова, а
    // занятие обходит стороной всю тему — тема с одним битым заданием умирает.
    it('выводит задание с повреждённым accept[] из очереди, а не оставляет выданным', () => {
      const { stored } = storeTasks(db, TOPIC, batch(2));
      const broken = stored[0]?.id;
      db.prepare('UPDATE task_bank SET accept = ? WHERE id = ?').run('{не json', broken);

      expect(() => takeTask(db, TOPIC)).toThrow(/accept\[\] не как JSON/i);
      expect(
        db.prepare('SELECT status FROM task_bank WHERE id = ?').get(broken),
      ).toEqual({ status: 'rejected' });
      expect(issuedTask(db, TOPIC)).toBeNull();
      // Соседнее задание темы по-прежнему выдаётся.
      expect(takeTask(db, TOPIC)?.id).toBe(stored[1]?.id);
    });

    it('отбраковывает повреждённое задание и при повторной выдаче выданного', () => {
      const { stored } = storeTasks(db, TOPIC, [task()]);
      const issued = takeTask(db, TOPIC);
      db.prepare('UPDATE task_bank SET accept = ? WHERE id = ?').run('[4]', issued?.id);

      expect(() => issuedTask(db, TOPIC)).toThrow(/должен быть массивом строк/i);
      expect(issuedTask(db, TOPIC)).toBeNull();
      expect(
        db.prepare('SELECT status FROM task_bank WHERE id = ?').get(stored[0]?.id),
      ).toEqual({ status: 'rejected' });
    });
  });
});
