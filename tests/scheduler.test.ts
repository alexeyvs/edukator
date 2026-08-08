import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase, writeProfile, type Subject } from '../server/db.js';
import { buildTopicGraph, type Topic, type TopicGraph } from '../server/curriculum.js';
import { newTopicState, readTopicStates, type TopicState } from '../server/mastery.js';
import { forecastFor } from '../server/forecast.js';
import {
  activeRunTopics,
  activeTopics,
  EXAM_HORIZON_DAYS,
  EXAM_URGENCY_GAIN,
  OVERDUE_CAP,
  PREREQ_MASTERY,
  PREREQ_SOFT_FLOOR,
  SUBJECT_FLOOR,
  examUrgency,
  planFromDatabase,
  planRuns,
  prereqsReady,
  prereqsReadiness,
  rankTopics,
  reviewUrgency,
  runsAssignedToday,
  topicsUsedToday,
  selectSubject,
  selectTopic,
  subjectDeficit,
  topicPriority,
} from '../server/scheduler.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function at(day: number): Date {
  return new Date(Date.UTC(2026, 7, 7, 12) + day * DAY_MS);
}

function topic(id: string, patch: Partial<Topic> = {}): Topic {
  return {
    id,
    subject: 'math',
    title: id,
    examWeight: 2,
    difficulty: 2,
    prereqs: [],
    answerFormat: 'number',
    promptSeed: 'seed',
    ...patch,
  };
}

function state(id: string, patch: Partial<TopicState> = {}): TopicState {
  return { ...newTopicState(id), ...patch };
}

function stateMap(...states: TopicState[]): Map<string, TopicState> {
  return new Map(states.map((item) => [item.topicId, item]));
}

/** Ровные темы одного предмета: фикстура для выбора предмета дня. */
function subjectTopics(subject: Subject, count: number): Topic[] {
  return Array.from({ length: count }, (_, index) => topic(`${subject}.t${index}`, { subject }));
}

function graphOf(topics: Topic[]): TopicGraph {
  return buildTopicGraph(topics);
}

describe('планировщик', () => {
  // Прочие тесты строят ожидание из этих же констант и переживают их подмену.
  // Числа заданы спекой и планом, поэтому прибиты буквально.
  it('держит калибровочные константы спеки', () => {
    expect(PREREQ_MASTERY).toBe(0.6);
    expect(PREREQ_SOFT_FLOOR).toBe(0.2);
    expect(OVERDUE_CAP).toBe(2);
    expect(EXAM_HORIZON_DAYS).toBe(30);
    expect(EXAM_URGENCY_GAIN).toBe(2);
    expect(SUBJECT_FLOOR).toBe(0.5);
    // За горизонтом экзамен на план не влияет, в день X тема веса 3 идёт ×3.
    expect(examUrgency({ examWeight: 3 }, at(0), '2026-10-07')).toBe(1);
    expect(examUrgency({ examWeight: 3 }, at(0), '2026-08-07')).toBeCloseTo(3, 12);
    expect(examUrgency({ examWeight: 1 }, at(0), '2026-08-07')).toBeCloseTo(1 + 2 / 3, 12);
  });

  describe('предпосылки', () => {
    const topics = [topic('math.base'), topic('math.next', { prereqs: ['math.base'] })];
    const graph = graphOf(topics);

    it('просаживает тему с неосвоенной предпосылкой, но не обнуляет её', () => {
      // Обе темы не тронуты, различие только в готовности предпосылок.
      const states = stateMap(state('math.base'), state('math.next'));

      expect(prereqsReady(topics[1] as Topic, states)).toBe(false);

      const blocked = topicPriority(topics[1] as Topic, states, { now: at(0) });
      const open = topicPriority(topics[0] as Topic, states, { now: at(0) });

      expect(blocked).toBeGreaterThan(0);
      expect(blocked).toBeCloseTo(open * PREREQ_SOFT_FLOOR, 10);
      expect(selectTopic(graph, states, 'math', { now: at(0) })?.topic.id).toBe('math.base');
    });

    it('почти освоенная предпосылка почти не мешает: приоритет решает mastery темы', () => {
      const states = stateMap(
        state('math.base', { mastery: PREREQ_MASTERY - 0.01 }),
        state('math.next'),
      );

      // Фундамент закрыт на 98%, а тема сверху не тронута — берём её, а не
      // дошлифовываем базу. При жёстком затворе она была бы недостижима.
      expect(prereqsReady(topics[1] as Topic, states)).toBe(false);
      expect(prereqsReadiness(topics[1] as Topic, states)).toBeGreaterThan(0.98);
      expect(selectTopic(graph, states, 'math', { now: at(0) })?.topic.id).toBe('math.next');
    });

    it('нетронутая предпосылка даёт ровно нижний пол, освоенная наполовину — больше', () => {
      const untouched = stateMap(state('math.base'), state('math.next'));
      expect(prereqsReadiness(topics[1] as Topic, untouched)).toBe(PREREQ_SOFT_FLOOR);

      const half = stateMap(
        state('math.base', { mastery: PREREQ_MASTERY / 2 }),
        state('math.next'),
      );
      expect(prereqsReadiness(topics[1] as Topic, half)).toBeCloseTo(0.5, 10);

      expect(prereqsReadiness(topics[0] as Topic, untouched)).toBe(1);
    });

    it('усредняет готовность нескольких предпосылок и ограничивает вклад единицей', () => {
      const many = topic('math.next-many', { prereqs: ['math.a', 'math.b'] });
      const states = stateMap(
        state('math.a', { mastery: PREREQ_MASTERY / 2 }),
        state('math.b', { mastery: PREREQ_MASTERY * 2 }),
      );

      expect(prereqsReady(many, states)).toBe(false);
      expect(prereqsReadiness(many, states)).toBeCloseTo(0.75, 10);
    });

    it('срочность к экзамену выводит тяжёлую тему из-под неосвоенной предпосылки', () => {
      const heavy = [
        topic('math.base', { examWeight: 1 }),
        topic('math.next', { examWeight: 3, prereqs: ['math.base'] }),
      ];
      const heavyGraph = graphOf(heavy);
      const states = stateMap(state('math.base'), state('math.next'));
      const examDate = '2026-09-06';

      // За месяц до экзамена фундамент идёт первым.
      expect(selectTopic(heavyGraph, states, 'math', { now: at(0), examDate })?.topic.id).toBe(
        'math.base',
      );
      // На финишной прямой тяжёлая тема пробивается, несмотря на пробел в фундаменте.
      expect(selectTopic(heavyGraph, states, 'math', { now: at(29), examDate })?.topic.id).toBe(
        'math.next',
      );
    });

    it('открывает тему, когда предпосылка перевалила порог', () => {
      const states = stateMap(state('math.base', { mastery: PREREQ_MASTERY }), state('math.next'));

      expect(prereqsReady(topics[1] as Topic, states)).toBe(true);
      expect(topicPriority(topics[1] as Topic, states, { now: at(0) })).toBeGreaterThan(0);
      // Предпосылка освоена наполовину, зависимая тема не тронута — берём вторую.
      expect(selectTopic(graph, states, 'math', { now: at(0) })?.topic.id).toBe('math.next');
    });

    it('считает недостающую строку состояния нулевой темой, а не ошибкой', () => {
      expect(prereqsReady(topics[1] as Topic, new Map())).toBe(false);
      expect(prereqsReadiness(topics[1] as Topic, new Map())).toBe(PREREQ_SOFT_FLOOR);
      expect(topicPriority(topics[0] as Topic, new Map(), { now: at(0) })).toBeGreaterThan(0);
    });
  });

  describe('приоритет темы', () => {
    it('при прочих равных выбирает тему с большим exam_weight', () => {
      const topics = [
        topic('math.light', { examWeight: 1 }),
        topic('math.heavy', { examWeight: 3 }),
      ];
      const graph = graphOf(topics);
      const states = stateMap(state('math.light'), state('math.heavy'));

      const ranked = rankTopics(graph, states, { now: at(0) });
      expect(ranked.map((item) => item.topic.id)).toEqual(['math.heavy', 'math.light']);
      expect(selectTopic(graph, states, 'math', { now: at(0) })?.topic.id).toBe('math.heavy');
    });

    it('при прочих равных выбирает менее освоенную тему', () => {
      const topics = [topic('math.weak'), topic('math.strong')];
      const graph = graphOf(topics);
      const states = stateMap(
        state('math.weak', { mastery: 0.2 }),
        state('math.strong', { mastery: 0.8 }),
      );

      expect(selectTopic(graph, states, 'math', { now: at(0) })?.topic.id).toBe('math.weak');
    });

    it('не предлагает тему вне экзамена и тему, освоенную полностью', () => {
      const topics = [topic('math.offexam', { examWeight: 0 }), topic('math.done')];
      const graph = graphOf(topics);
      const states = stateMap(state('math.offexam'), state('math.done', { mastery: 1 }));

      expect(topicPriority(topics[0] as Topic, states, { now: at(0) })).toBe(0);
      expect(topicPriority(topics[1] as Topic, states, { now: at(0) })).toBe(0);
      expect(selectTopic(graph, states, 'math', { now: at(0) })).toBeNull();
    });

    it('отсеивает занятые сегодня темы, названные полем `used`', () => {
      // Отсев работал только через позиционный аргумент, который заполняет один
      // `planRuns`. Всякий другой вызывающий, прочитав описание поля, получал бы
      // сегодняшнюю тему обратно молча — без ошибки и без признака.
      const graph = graphOf([topic('math.weak'), topic('math.strong')]);
      const states = stateMap(state('math.weak'), state('math.strong', { mastery: 0.9 }));
      const used = new Set(['math.weak']);

      expect(selectTopic(graph, states, 'math', { now: at(0), used })?.topic.id).toBe('math.strong');
      expect(selectSubject(graph, states, { now: at(0), used: new Set(['math.weak', 'math.strong']) })).toBeNull();
    });
  });

  describe('срочность повторения', () => {
    const seen = state('math.fractions', {
      mastery: 0.5,
      confidence: 0.5,
      attempts: 3,
      lastSeen: at(-5).toISOString(),
      nextReview: at(5).toISOString(),
    });

    it('растёт по мере приближения к next_review', () => {
      expect(reviewUrgency(seen, at(-5))).toBeCloseTo(1, 12);
      expect(reviewUrgency(seen, at(0))).toBeCloseTo(1.5, 12);
      expect(reviewUrgency(seen, at(5))).toBeCloseTo(2, 12);
    });

    it('продолжает расти на просрочке, но упирается в потолок', () => {
      expect(reviewUrgency(seen, at(15))).toBeCloseTo(1 + OVERDUE_CAP, 12);
      expect(reviewUrgency(seen, at(500))).toBeCloseTo(1 + OVERDUE_CAP, 12);
    });

    it('считает непроверенную тему подошедшей к повторению', () => {
      expect(reviewUrgency(state('math.fractions'), at(0))).toBeCloseTo(2, 12);
    });

    it('поднимает подошедшую к повторению тему над только что пройденной', () => {
      const topics = [topic('math.due'), topic('math.fresh')];
      const graph = graphOf(topics);
      const states = stateMap(
        { ...seen, topicId: 'math.due' },
        { ...seen, topicId: 'math.fresh', lastSeen: at(0).toISOString(), nextReview: at(10).toISOString() },
      );

      expect(selectTopic(graph, states, 'math', { now: at(5) })?.topic.id).toBe('math.due');
    });
  });

  describe('срочность к дате экзамена', () => {
    const heavy = topic('math.heavy', { examWeight: 3 });
    const light = topic('math.light', { examWeight: 1 });

    it('без даты экзамена срочность не растёт', () => {
      expect(examUrgency(heavy, at(0), null)).toBe(1);
      expect(examUrgency(heavy, at(0), undefined)).toBe(1);
    });

    it('за горизонтом планирования срочность ещё не растёт', () => {
      const examDate = new Date(at(0).getTime() + (EXAM_HORIZON_DAYS + 5) * DAY_MS)
        .toISOString()
        .slice(0, 10);
      expect(examUrgency(heavy, at(0), examDate)).toBeCloseTo(1, 12);
    });

    it('растёт по квадрату давления, а не линейно', () => {
      // Точка внутри горизонта: на его краях x² = x, и обе граничные проверки
      // калибровки одинаковы при любой степени. Спека требует именно квадрат —
      // «последняя неделя перевешивает», — и без внутренней точки его подмена
      // на линейный рост ничем не ловится. Числа вписаны руками, а не собраны
      // из тех же констант: на линейном росте вышло бы 2 и 2.6.
      const midnight = at(-0.5);

      // 15 дней из 30: давление 0.5, в квадрате 0.25.
      expect(examUrgency(heavy, midnight, '2026-08-22')).toBeCloseTo(1.5, 12);
      expect(examUrgency(light, midnight, '2026-08-22')).toBeCloseTo(1.1666666666666667, 12);
      // 6 дней из 30: давление 0.8, в квадрате 0.64.
      expect(examUrgency(heavy, midnight, '2026-08-13')).toBeCloseTo(2.28, 12);
      expect(examUrgency(light, midnight, '2026-08-13')).toBeCloseTo(1.4266666666666667, 12);
    });

    it('поднимает тяжёлые темы сильнее лёгких по мере приближения экзамена', () => {
      const examDate = new Date(at(0).getTime() + EXAM_HORIZON_DAYS * DAY_MS)
        .toISOString()
        .slice(0, 10);
      const states = stateMap(state('math.heavy'), state('math.light'));
      const far = { now: at(0), examDate };
      const near = { now: at(EXAM_HORIZON_DAYS - 3), examDate };

      const ratioFar =
        topicPriority(heavy, states, far) / topicPriority(light, states, far);
      const ratioNear =
        topicPriority(heavy, states, near) / topicPriority(light, states, near);

      expect(examUrgency(heavy, near.now, examDate)).toBeGreaterThan(
        examUrgency(heavy, far.now, examDate),
      );
      expect(ratioNear).toBeGreaterThan(ratioFar);
    });

    it('на прошедшей дате экзамена срочность остаётся максимальной', () => {
      const examDate = at(-10).toISOString().slice(0, 10);
      expect(examUrgency(heavy, at(0), examDate)).toBeCloseTo(3, 12);
      expect(examUrgency(light, at(0), examDate)).toBeCloseTo(1 + 2 / 3, 12);
    });

    it('отвергает некорректную дату экзамена внятной ошибкой', () => {
      expect(() => examUrgency(heavy, at(0), 'когда-нибудь')).toThrow(/дата экзамена/i);
    });
  });

  describe('план дня', () => {
    const topics = [
      ...subjectTopics('math', 4),
      ...subjectTopics('russian', 4),
      ...subjectTopics('english', 4),
    ];
    const graph = graphOf(topics);
    const states = stateMap(
      ...topics.map((item) =>
        state(item.id, { mastery: { math: 0, russian: 0.5, english: 0.8 }[item.subject] }),
      ),
    );

    it('считает отставание предмета по взвешенной освоенности', () => {
      expect(subjectDeficit(graph, states, 'math')).toBeCloseTo(1, 12);
      expect(subjectDeficit(graph, states, 'russian')).toBeCloseTo(0.5, 12);
      expect(subjectDeficit(graph, states, 'english')).toBeCloseTo(0.2, 12);
    });

    it('не считает отставанием темы вне экзамена', () => {
      const withJunk = graphOf([
        topic('math.core', { subject: 'math', examWeight: 2 }),
        topic('math.junk', { subject: 'math', examWeight: 0 }),
      ]);
      // Освоена только внеэкзаменационная тема: отставание остаётся полным.
      const only = stateMap(state('math.core', { mastery: 0 }), state('math.junk', { mastery: 1 }));

      expect(subjectDeficit(withJunk, only, 'math')).toBeCloseTo(1, 12);
    });

    it('начинает с самого отстающего предмета', () => {
      expect(selectSubject(graph, states, { now: at(0) })).toBe('math');
    });

    it('учитывает assigned из options при прямом выборе предмета', () => {
      const assigned = new Map<Subject, number>([['math', 10]]);
      expect(selectSubject(graph, states, { now: at(0), assigned })).not.toBe('math');
    });

    it('не ставит два забега подряд по одному предмету', () => {
      const plan = planRuns(graph, states, 6, { now: at(0) });

      expect(plan).toHaveLength(6);
      for (let index = 1; index < plan.length; index += 1) {
        expect(plan[index]?.subject).not.toBe(plan[index - 1]?.subject);
      }
      // Предмет предыдущего забега известен снаружи — первый забег его не повторяет.
      expect(planRuns(graph, states, 1, { now: at(0), lastSubject: 'math' })[0]?.subject).toBe(
        'russian',
      );
      expect(selectSubject(graph, states, { now: at(0), lastSubject: 'math' })).toBe('russian');
    });

    it('даёт отстающему предмету больше забегов, не выбрасывая остальные', () => {
      const plan = planRuns(graph, states, 6, { now: at(0) });
      const count = (subject: Subject): number =>
        plan.filter((run) => run.subject === subject).length;

      expect(count('math')).toBeGreaterThan(count('russian'));
      expect(count('russian')).toBeGreaterThan(count('english'));
      expect(count('english')).toBeGreaterThanOrEqual(1);
    });

    it('не повторяет тему внутри одного плана', () => {
      const plan = planRuns(graph, states, 9, { now: at(0) });
      const ids = plan.map((run) => run.topic.id);

      expect(new Set(ids).size).toBe(ids.length);
      expect(plan.every((run) => run.priority > 0)).toBe(true);
    });

    it('повторяет предмет, если кандидаты остались только в нём', () => {
      const single = graphOf(subjectTopics('math', 3));
      const plan = planRuns(single, stateMap(), 3, { now: at(0) });

      expect(plan.map((run) => run.subject)).toEqual(['math', 'math', 'math']);
    });

    it('укорачивает план, когда кандидаты кончились', () => {
      const single = graphOf(subjectTopics('math', 2));
      expect(planRuns(single, stateMap(), 5, { now: at(0) })).toHaveLength(2);
      expect(planRuns(single, stateMap(), 0, { now: at(0) })).toEqual([]);
    });

    it('отвергает некорректное число забегов', () => {
      expect(() => planRuns(graph, states, -1, { now: at(0) })).toThrow(/забег/i);
      expect(() => planRuns(graph, states, 1.5, { now: at(0) })).toThrow(/забег/i);
    });
  });

  describe('ошибочные сценарии', () => {
    it('пустая карта тем не даёт ни предмета, ни плана', () => {
      const empty = graphOf([]);

      expect(rankTopics(empty, stateMap(), { now: at(0) })).toEqual([]);
      expect(selectSubject(empty, stateMap(), { now: at(0) })).toBeNull();
      expect(selectTopic(empty, stateMap(), 'math', { now: at(0) })).toBeNull();
      expect(planRuns(empty, stateMap(), 3, { now: at(0) })).toEqual([]);
    });

    it('все темы освоены — предлагать нечего', () => {
      const topics = subjectTopics('math', 3);
      const graph = graphOf(topics);
      const states = stateMap(...topics.map((item) => state(item.id, { mastery: 1 })));

      expect(selectTopic(graph, states, 'math', { now: at(0) })).toBeNull();
      expect(selectSubject(graph, states, { now: at(0) })).toBeNull();
      expect(planRuns(graph, states, 3, { now: at(0) })).toEqual([]);
    });

    it('неосвоенный корень идёт первым, но цепочка за ним остаётся достижимой', () => {
      const topics = [
        topic('math.root'),
        topic('math.a', { prereqs: ['math.root'] }),
        topic('math.b', { prereqs: ['math.a'] }),
      ];
      const graph = graphOf(topics);
      const states = stateMap(...topics.map((item) => state(item.id)));

      const ranked = rankTopics(graph, states, { now: at(0) });
      // Освоенных предпосылок нет ни у кого, кроме корня.
      expect(ranked.filter((item) => item.ready).map((item) => item.topic.id)).toEqual([
        'math.root',
      ]);
      // Но мягкий пол оставляет ненулевой приоритет всей цепочке — иначе тема
      // за неосвоенным корнем не всплыла бы никогда.
      expect(ranked.every((item) => item.priority > 0)).toBe(true);
      expect(ranked[0]?.topic.id).toBe('math.root');
      expect(selectTopic(graph, states, 'math', { now: at(0) })?.topic.id).toBe('math.root');
      // План дня ставит корень первым, а зависимые темы — после него: состояние
      // между забегами одного плана ещё не пересчитывается.
      expect(planRuns(graph, states, 3, { now: at(0) }).map((run) => run.topic.id)).toEqual([
        'math.root',
        'math.a',
        'math.b',
      ]);
    });

    it('предмет без единой темы в карте не выбирается', () => {
      const graph = graphOf(subjectTopics('math', 2));
      expect(selectTopic(graph, stateMap(), 'russian', { now: at(0) })).toBeNull();
      expect(subjectDeficit(graph, stateMap(), 'russian')).toBe(0);
    });
  });

  describe('план из базы', () => {
    let tempDir: string;
    let db: Database;
    const topics = [...subjectTopics('math', 3), ...subjectTopics('russian', 3)];
    const graph = graphOf(topics);

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'edukator-scheduler-'));
      db = openDatabase(join(tempDir, 'test.db'));
      const insert = db.prepare('INSERT INTO topic_state (topic_id) VALUES (?)');
      for (const item of topics) insert.run(item.id);
    });

    afterEach(() => {
      db.close();
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('строит план по состояниям и профилю из базы', () => {
      const plan = planFromDatabase(db, graph, 4, at(0));

      expect(plan).toHaveLength(4);
      expect(new Set(plan.map((run) => run.topic.id)).size).toBe(4);
      for (let index = 1; index < plan.length; index += 1) {
        expect(plan[index]?.subject).not.toBe(plan[index - 1]?.subject);
      }
    });

    it('не начинает с предмета последнего забега', () => {
      db.prepare('INSERT INTO runs (subject, topic_id, started_at) VALUES (?, ?, ?)').run(
        'math',
        'math.t0',
        at(-1).toISOString(),
      );

      expect(planFromDatabase(db, graph, 1, at(0))[0]?.subject).toBe('russian');
    });

    it('держит баланс предметов между вызовами по одному забегу', () => {
      // Живой сервер запрашивает следующий забег по одному, а не днём целиком.
      // Счётчик назначенных забегов живёт внутри `planRuns`, поэтому без чтения
      // уже начатых забегов дня метод делителей рассыпался бы, и третий предмет
      // выпадал бы из плана — ровно то, ради чего делители и вводились.
      const daily = [...subjectTopics('math', 2), ...subjectTopics('russian', 2),
        ...subjectTopics('english', 2)];
      const dailyGraph = graphOf(daily);
      const insert = db.prepare('INSERT OR IGNORE INTO topic_state (topic_id) VALUES (?)');
      for (const item of daily) insert.run(item.id);

      const startRun = db.prepare(
        'INSERT INTO runs (subject, topic_id, started_at) VALUES (?, ?, ?)',
      );
      const oneByOne: Subject[] = [];
      for (let index = 0; index < 3; index += 1) {
        const next = planFromDatabase(db, dailyGraph, 1, at(0))[0];
        if (next === undefined) break;
        oneByOne.push(next.subject);
        startRun.run(next.subject, next.topic.id, at(0).toISOString());
      }

      expect(new Set(oneByOne).size).toBe(3);
      expect(new Set(topicsUsedToday(db, at(0))).size).toBe(3);
      expect(oneByOne).toEqual(planFromDatabase(db, dailyGraph, 3, at(0)).map((run) => run.subject));
    });

    it('не повторяет уже использованную сегодня тему между вызовами', () => {
      const first = planFromDatabase(db, graph, 1, at(0))[0];
      expect(first).toBeDefined();
      db.prepare('INSERT INTO runs (subject, topic_id, started_at) VALUES (?, ?, ?)').run(
        first?.subject,
        first?.topic.id,
        at(0).toISOString(),
      );
      expect(planFromDatabase(db, graph, 1, at(0))[0]?.topic.id).not.toBe(first?.topic.id);
    });

    it('ставит тему идущего забега первой, хотя план её сегодня больше не предложит', () => {
      // Ровно то, ради чего `activeTopics` и заведён: занятие выдаёт задания из
      // темы начатого забега, а план её уже считает использованной. Без этого и
      // выдача, и долив перескочили бы на чужую тему посреди забега.
      const first = planFromDatabase(db, graph, 1, at(0))[0];
      expect(first).toBeDefined();
      db.prepare('INSERT INTO runs (subject, topic_id, started_at) VALUES (?, ?, ?)').run(
        first?.subject,
        first?.topic.id,
        at(0).toISOString(),
      );

      const active = activeTopics(db, graph, 2, at(0));

      expect(active[0]?.id).toBe(first?.topic.id);
      // Второй раз та же тема в выборку не попадает: план её не предложит, а
      // дубль означал бы двойной долив одной темы за цикл.
      expect(new Set(active.map((item) => item.id)).size).toBe(active.length);
      expect(active).toHaveLength(3);
    });

    it('не ставит впереди тему законченного забега', () => {
      // Закрытый забег занятие уже не ведёт, а первую тему `nextTask` и берёт:
      // задания уходили бы из пройденной темы, а воркер грел бы её вместо той,
      // по которой ученик занимается сейчас. Для `planRuns` она по-прежнему
      // использована сегодня — отсев из плана этой правкой не трогается.
      const [done, current] = planFromDatabase(db, graph, 2, at(0));
      expect(done).toBeDefined();
      expect(current).toBeDefined();
      const startRun = db.prepare(
        'INSERT INTO runs (subject, topic_id, started_at, finished_at) VALUES (?, ?, ?, ?)',
      );
      startRun.run(done?.subject, done?.topic.id, at(0).toISOString(), at(0).toISOString());
      startRun.run(current?.subject, current?.topic.id, at(0).toISOString(), null);

      const active = activeTopics(db, graph, 2, at(0));

      expect(active[0]?.id).toBe(current?.topic.id);
      expect(active.map((item) => item.id)).not.toContain(done?.topic.id);
      expect(topicsUsedToday(db, at(0)).has(done?.topic.id ?? '')).toBe(true);
    });

    it('ставит впереди тему самого свежего незакрытого забега', () => {
      // Забег, брошенный утром без отметки конца, висит незакрытым до полуночи.
      // Без порядка по `started_at` он обходил бы начатый только что: `DISTINCT`
      // отдаёт строки как придётся.
      // Отметки строятся от местной полуночи: сутки у планировщика местные, и
      // вычитание часов из UTC-полудня в поясе за океаном уехало бы во вчера.
      const hour = (offset: number): Date => {
        const moment = new Date(at(0));
        moment.setHours(offset, 0, 0, 0);
        return moment;
      };
      const [older, newer] = planFromDatabase(db, graph, 2, hour(3));
      const startRun = db.prepare(
        'INSERT INTO runs (subject, topic_id, started_at) VALUES (?, ?, ?)',
      );
      startRun.run(older?.subject, older?.topic.id, hour(1).toISOString());
      startRun.run(newer?.subject, newer?.topic.id, hour(2).toISOString());

      expect(activeTopics(db, graph, 1, hour(3))[0]?.id).toBe(newer?.topic.id);
    });

    it('без начатых забегов повторяет план', () => {
      const plan = planFromDatabase(db, graph, 3, at(0)).map((run) => run.topic.id);

      expect(activeTopics(db, graph, 3, at(0)).map((item) => item.id)).toEqual(plan);
    });

    it('не считает вчерашние забеги за назначенные сегодня', () => {
      // Иначе вчерашний перекос по предмету переносился бы на сегодняшний план.
      db.prepare('INSERT INTO runs (subject, topic_id, started_at) VALUES (?, ?, ?)').run(
        'math',
        'math.t0',
        at(-1).toISOString(),
      );

      const plan = planFromDatabase(db, graph, 2, at(0));
      expect(plan.map((run) => run.subject)).toEqual(['russian', 'math']);
    });

    it('не считает вчерашние темы за использованные сегодня', () => {
      // Нижняя граница суток нужна не меньше верхней: без неё каждая когда-либо
      // пройденная тема исключалась бы из плана навсегда, и через неделю
      // `planRuns` возвращал бы пустой план.
      db.prepare('INSERT INTO runs (subject, topic_id, started_at) VALUES (?, ?, ?)').run(
        'math',
        'math.t0',
        at(-1).toISOString(),
      );

      expect(topicsUsedToday(db, at(0))).toEqual(new Set());
      expect(topicsUsedToday(db, at(-1))).toEqual(new Set(['math.t0']));
    });

    it('считает сутки по Москве независимо от пояса процесса', () => {
      const insert = db.prepare('INSERT INTO runs (subject, topic_id, started_at) VALUES (?, ?, ?)');
      insert.run('math', 'math.t0', '2026-08-07T10:00:00.000Z'); // 7 августа 13:00 — вчера
      insert.run('russian', 'russian.t0', '2026-08-07T21:10:00.000Z'); // 8 августа 00:10 — сегодня

      const now = new Date('2026-08-07T21:30:00.000Z'); // 8 августа 00:30 по Москве
      expect([...runsAssignedToday(db, now)]).toEqual([['russian', 1]]);
      expect(topicsUsedToday(db, now)).toEqual(new Set(['russian.t0']));
    });

    it('учитывает дату экзамена из профиля', () => {
      const examDate = new Date(at(0).getTime() + 2 * DAY_MS).toISOString().slice(0, 10);
      writeProfile(db, { examDate });
      db.prepare('UPDATE topic_state SET mastery = 0.5 WHERE topic_id = ?').run('math.t0');

      const withExam = planFromDatabase(db, graph, 1, at(0))[0]?.priority as number;
      writeProfile(db, { examDate: null });
      const withoutExam = planFromDatabase(db, graph, 1, at(0))[0]?.priority as number;

      expect(withExam).toBeGreaterThan(withoutExam);
    });

    it('навсегда исключает закрытую тему из плана и старого обычного забега', () => {
      const closedAt = '2020-01-01T00:00:00.000Z';
      db.prepare('UPDATE topic_state SET closed_at = ? WHERE topic_id = ?').run(
        closedAt,
        'math.t0',
      );
      db.prepare('INSERT INTO runs (subject, topic_id, started_at) VALUES (?, ?, ?)').run(
        'math',
        'math.t0',
        at(0).toISOString(),
      );

      const farFuture = at(3650);
      expect(planFromDatabase(db, graph, graph.byId.size, farFuture).map((run) => run.topic.id))
        .not.toContain('math.t0');
      expect(activeTopics(db, graph, graph.byId.size, at(0)).map((item) => item.id))
        .not.toContain('math.t0');
      expect(
        db.prepare<[string], { closed_at: string | null }>(
          'SELECT closed_at FROM topic_state WHERE topic_id = ?',
        ).get('math.t0')?.closed_at,
      ).toBe(closedAt);
    });

    it('не смешивает открытый boss-забег с обычными активными темами', () => {
      db.prepare(
        "INSERT INTO runs (subject, kind, topic_id, started_at) VALUES (?, 'boss', ?, ?)",
      ).run('math', 'math.t0', at(0).toISOString());

      expect(activeRunTopics(db, at(0))).not.toContain('math.t0');
    });

    it('ранжирует остальные темы предмета и возвращает пустой полностью закрытый план', () => {
      db.prepare("UPDATE topic_state SET closed_at = '2026-08-07T12:00:00.000Z' WHERE topic_id = ?")
        .run('math.t0');

      const partlyOpen = planFromDatabase(db, graph, graph.byId.size, at(0));
      expect(partlyOpen.some((run) => run.topic.id === 'math.t1')).toBe(true);
      expect(partlyOpen.some((run) => run.topic.id === 'math.t2')).toBe(true);
      expect(partlyOpen.some((run) => run.topic.id === 'math.t0')).toBe(false);

      db.prepare("UPDATE topic_state SET closed_at = '2026-08-07T12:00:00.000Z'").run();
      expect(planFromDatabase(db, graph, graph.byId.size, at(0))).toEqual([]);
      expect(activeTopics(db, graph, graph.byId.size, at(0))).toEqual([]);
    });

    it('сохраняет закрытую тему и её экзаменационный вес в прогнозе', () => {
      db.prepare(
        `UPDATE topic_state
            SET mastery = 0.8, confidence = 0.9, attempts = 5,
                last_seen = ?, closed_at = ?
          WHERE topic_id = ?`,
      ).run(at(0).toISOString(), at(0).toISOString(), 'math.t0');

      const forecast = forecastFor(graph, readTopicStates(db), 'math', at(0));

      expect(forecast?.weight).toBe(6);
      expect(forecast?.ratio).toBeCloseTo(0.8 / 3, 10);
      expect(readTopicStates(db).get('math.t0')).toMatchObject({ mastery: 0.8, attempts: 5 });
    });
  });
});
