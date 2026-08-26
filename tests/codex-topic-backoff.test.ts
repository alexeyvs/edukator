import { describe, expect, it } from 'vitest';
import {
  TOPIC_BACKOFF_BASE_MS,
  TOPIC_BACKOFF_MAX_MS,
  TopicBackoff,
  topicBackoffDelay,
} from '../server/codex/topic-backoff.js';

function at(minutes: number): Date {
  return new Date(Date.UTC(2026, 7, 26, 0, 0, 0) + minutes * 60 * 1000);
}

describe('topicBackoffDelay', () => {
  // Постоянная задержка неотличима от растущей на одном шаге, поэтому формула
  // вынесена отдельно и проверяется на нескольких: тема, безнадёжная третий час
  // подряд, обязана отходить дальше, чем оступившаяся впервые.
  it('удваивает паузу и упирается в потолок', () => {
    expect(topicBackoffDelay(1)).toBe(TOPIC_BACKOFF_BASE_MS);
    expect(topicBackoffDelay(2)).toBe(TOPIC_BACKOFF_BASE_MS * 2);
    expect(topicBackoffDelay(3)).toBe(TOPIC_BACKOFF_BASE_MS * 4);
    expect(topicBackoffDelay(99)).toBe(TOPIC_BACKOFF_MAX_MS);
  });

  it('без провалов паузы нет', () => {
    expect(topicBackoffDelay(0)).toBe(0);
    expect(topicBackoffDelay(-1)).toBe(0);
  });

  // Числа вписаны руками: ожидание, собранное из той же константы, её подмену
  // не ловит. Цена ошибки здесь — сгоревшая за час суточная квота ребёнка.
  it('держит калибровочные константы', () => {
    expect(TOPIC_BACKOFF_BASE_MS).toBe(15 * 60 * 1000);
    expect(TOPIC_BACKOFF_MAX_MS).toBe(6 * 60 * 60 * 1000);
  });
});

describe('TopicBackoff', () => {
  it('нетронутую тему не держит', () => {
    expect(new TopicBackoff().blocked('russian.mestoimenie', at(0))).toBe(false);
  });

  it('после провала держит тему до конца паузы и отпускает после', () => {
    const backoff = new TopicBackoff();
    expect(backoff.noteFailure('russian.mestoimenie', at(0))).toBe(TOPIC_BACKOFF_BASE_MS);

    expect(backoff.blocked('russian.mestoimenie', at(14))).toBe(true);
    expect(backoff.blocked('russian.mestoimenie', at(15))).toBe(false);
  });

  it('держит только провалившуюся тему', () => {
    const backoff = new TopicBackoff();
    backoff.noteFailure('russian.mestoimenie', at(0));

    expect(backoff.blocked('math.common-fractions', at(1))).toBe(false);
  });

  it('второй провал подряд отодвигает тему вдвое дальше', () => {
    const backoff = new TopicBackoff();
    backoff.noteFailure('english.question-words', at(0));
    expect(backoff.noteFailure('english.question-words', at(15))).toBe(TOPIC_BACKOFF_BASE_MS * 2);

    expect(backoff.blocked('english.question-words', at(44))).toBe(true);
    expect(backoff.blocked('english.question-words', at(45))).toBe(false);
  });

  // Удачный долив обязан сбрасывать счётчик, а не только снимать текущую паузу:
  // иначе тема, споткнувшаяся раз в сутки, к концу недели уходила бы в
  // шестичасовой отступ с первого же провала — то есть переставала бы греться
  // из-за того, что когда-то грелась плохо.
  it('удачный долив сбрасывает и паузу, и счётчик провалов', () => {
    const backoff = new TopicBackoff();
    backoff.noteFailure('math.linear-equations', at(0));
    backoff.noteSuccess('math.linear-equations');

    expect(backoff.blocked('math.linear-equations', at(1))).toBe(false);
    expect(backoff.noteFailure('math.linear-equations', at(1))).toBe(TOPIC_BACKOFF_BASE_MS);
  });

  it('успех незнакомой темы ничего не ломает', () => {
    const backoff = new TopicBackoff();
    expect(() => { backoff.noteSuccess('english.present-simple'); }).not.toThrow();
  });
});
