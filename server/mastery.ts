import type { Database } from 'better-sqlite3';

/**
 * Рантайм-состояние темы: строка `topic_state`, приведённая к camelCase.
 * Истина по составу тем — карта в `content/curriculum`, здесь только прогресс.
 */
export interface TopicState {
  topicId: string;
  /** 0..1, оценка освоенности темы. */
  mastery: number;
  /** 0..1 на момент `lastSeen`; текущее значение считает `confidenceAt`. */
  confidence: number;
  attempts: number;
  /** ISO-время последней попытки либо `null`, если тема не проверялась. */
  lastSeen: string | null;
  /** ISO-время, когда тему стоит повторить. */
  nextReview: string | null;
}

/** Результат одной попытки: всё, от чего зависит сдвиг `mastery`. */
export interface Attempt {
  correct: boolean;
  /** 1-3, сложность задания из `task_bank`. */
  difficulty: number;
  /** Сохранённый исторический штраф; новые попытки всегда передают false. */
  hintPenaltyApplied?: boolean;
  /** Совместимость прямых вызовов: до v18 этот флаг одновременно означал штраф. */
  hintUsed?: boolean;
  /** Время попытки; по умолчанию — сейчас. Задаётся явно в тестах и при импорте истории. */
  at?: Date;
}

/** База роста при верном ответе. Подлежит калибровке по пробным экзаменам. */
export const ALPHA = 0.35;

/** База спада при неверном ответе. */
export const BETA = 0.3;

/** Множители α по сложности 1/2/3: лёгкое задание доказывает меньше. */
export const ALPHA_BY_DIFFICULTY = [0.7, 1.0, 1.3] as const;

/** Множители β по сложности 1/2/3: ошибка в лёгком задании информативнее. */
export const BETA_BY_DIFFICULTY = [1.3, 1.0, 0.7] as const;

/** Подсказка ослабляет рост вдвое, но не смягчает спад: подсказали и всё равно неверно. */
export const HINT_FACTOR = 0.5;

/** Уверенность копится как `1 − CONFIDENCE_BASE^n` по числу попыток. */
const CONFIDENCE_BASE = 0.75;

/** И затухает как `CONFIDENCE_DECAY^d` по дням простоя. */
const CONFIDENCE_DECAY = 0.98;

/** Ниже этого `mastery` тема считается пробелом — порог из спеки. */
export const GAP_MASTERY = 0.6;

/**
 * «Достаточная уверенность» для вывода о пробеле: 0.5 достигается на третьей
 * попытке (`1 − 0.75³ ≈ 0.58`). По одному-двум ответам тему в пробелы не пишем —
 * иначе случайная ошибка на старте отправит планировщик долбить освоенное.
 */
export const CONFIDENCE_FLOOR = 0.5;

/** Интервал повторения при нулевом `mastery`: назавтра. */
export const MIN_REVIEW_DAYS = 1;

/** И при полном `mastery`: три недели. */
export const MAX_REVIEW_DAYS = 21;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Пустое состояние темы: такой же нулевой строкой её заводит `syncTopicState`. */
export function newTopicState(topicId: string): TopicState {
  return {
    topicId,
    mastery: 0,
    confidence: 0,
    attempts: 0,
    lastSeen: null,
    nextReview: null,
  };
}

/**
 * Состояние темы из карты. Недостающая строка — это ещё не выполненная
 * синхронизация, а не опечатка: состав тем задаёт карта, поэтому здесь
 * (в отличие от `readTopicState`) отсутствие строки равно нулевому состоянию.
 */
export function stateOf(states: Map<string, TopicState>, topicId: string): TopicState {
  return states.get(topicId) ?? newTopicState(topicId);
}

/** Прижимает значение к 0..1. Общий для модели, планировщика и прогноза. */
export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function checkDifficulty(difficulty: number): number {
  if (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > 3) {
    throw new Error(`Модель знаний: сложность задания вне 1..3 (${difficulty})`);
  }
  return difficulty;
}

function checkMastery(mastery: number): number {
  if (!Number.isFinite(mastery) || mastery < 0 || mastery > 1) {
    throw new Error(`Модель знаний: mastery вне 0..1 (${mastery})`);
  }
  return mastery;
}

/**
 * Новое значение `mastery` по результату попытки.
 * Верный ответ подтягивает к единице, неверный — к нулю, поэтому значение
 * остаётся в 0..1 само по себе; `clamp01` страхует от накопленной погрешности.
 */
export function nextMastery(mastery: number, attempt: Attempt): number {
  checkMastery(mastery);
  const index = checkDifficulty(attempt.difficulty) - 1;

  if (attempt.correct) {
    const penalized = attempt.hintPenaltyApplied ?? attempt.hintUsed ?? false;
    const alpha = ALPHA * (ALPHA_BY_DIFFICULTY[index] as number) * (penalized ? HINT_FACTOR : 1);
    return clamp01(mastery + alpha * (1 - mastery));
  }

  const beta = BETA * (BETA_BY_DIFFICULTY[index] as number);
  return clamp01(mastery - beta * mastery);
}

/**
 * `confidence = (1 − 0.75^n) · 0.98^d`. Дни считаются дробно; отрицательный
 * простой (часы «в будущее» из-за перевода времени) считается нулевым.
 */
export function computeConfidence(attempts: number, days: number): number {
  if (!Number.isInteger(attempts) || attempts < 0) {
    throw new Error(`Модель знаний: число попыток должно быть неотрицательным целым (${attempts})`);
  }
  if (!Number.isFinite(days)) {
    throw new Error(`Модель знаний: число дней должно быть конечным (${days})`);
  }
  const idle = Math.max(0, days);
  return clamp01((1 - CONFIDENCE_BASE ** attempts) * CONFIDENCE_DECAY ** idle);
}

/** Дней между отметками времени. Прошлое в будущем — ноль, а не отрицательное время. */
export function daysBetween(from: Date | string, to: Date | string): number {
  const start = typeof from === 'string' ? Date.parse(from) : from.getTime();
  const end = typeof to === 'string' ? Date.parse(to) : to.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new Error(`Модель знаний: некорректная отметка времени (${String(from)} → ${String(to)})`);
  }
  return Math.max(0, (end - start) / DAY_MS);
}

/**
 * Уверенность на момент `now`: хранимое значение свежо только на `lastSeen`,
 * а затухание идёт непрерывно, поэтому считается при чтении, а не по расписанию.
 */
export function confidenceAt(state: TopicState, now: Date = new Date()): number {
  if (state.attempts === 0 || state.lastSeen === null) return 0;
  return computeConfidence(state.attempts, daysBetween(state.lastSeen, now));
}

/**
 * Интервал до повторения: экспоненциальный рост от суток при нуле до трёх
 * недель при единице. Экспонента, а не линия, — чтобы освоенная тема уходила
 * из плана заметно, а полузнакомая возвращалась через считанные дни.
 */
export function reviewIntervalDays(mastery: number): number {
  checkMastery(mastery);
  return MIN_REVIEW_DAYS * (MAX_REVIEW_DAYS / MIN_REVIEW_DAYS) ** mastery;
}

/**
 * Применяет попытку к состоянию темы. Исходное состояние не меняется: его же
 * читает планировщик текущего забега, и мутация уводила бы приоритеты на лету.
 */
export function applyAttempt(state: TopicState, attempt: Attempt): TopicState {
  const at = attempt.at ?? new Date();
  if (!Number.isFinite(at.getTime())) {
    throw new Error(`Модель знаний: некорректное время попытки (${String(at)})`);
  }
  if (state.lastSeen !== null) {
    const lastSeen = Date.parse(state.lastSeen);
    if (!Number.isFinite(lastSeen)) {
      throw new Error(`Модель знаний: некорректное время последней попытки (${state.lastSeen})`);
    }
    if (at.getTime() < lastSeen) {
      throw new Error(
        `Модель знаний: попытка ${at.toISOString()} старше последней ${state.lastSeen}; импортируйте историю по порядку`,
      );
    }
  }
  const mastery = nextMastery(state.mastery, attempt);
  const attempts = state.attempts + 1;

  return {
    topicId: state.topicId,
    mastery,
    // Попытка только что состоялась, простоя нет — затухание начнётся после неё.
    confidence: computeConfidence(attempts, 0),
    attempts,
    lastSeen: at.toISOString(),
    nextReview: new Date(at.getTime() + reviewIntervalDays(mastery) * DAY_MS).toISOString(),
  };
}

/**
 * Пробел: либо слабая тема с накопленной уверенностью, либо тяжёлая тема без
 * единой попытки. Второй случай приоритетнее — непроверенная тема опаснее
 * известной слабой, про неё вообще ничего не известно.
 */
export function isGap(
  topic: { examWeight: number },
  state: TopicState,
  now: Date = new Date(),
): boolean {
  if (state.attempts === 0) return topic.examWeight >= 2;
  return state.mastery < GAP_MASTERY && confidenceAt(state, now) >= CONFIDENCE_FLOOR;
}

interface TopicStateRow {
  topic_id: string;
  mastery: number;
  confidence: number;
  attempts: number;
  last_seen: string | null;
  next_review: string | null;
}

function toState(row: TopicStateRow): TopicState {
  return {
    topicId: row.topic_id,
    mastery: row.mastery,
    confidence: row.confidence,
    attempts: row.attempts,
    lastSeen: row.last_seen,
    nextReview: row.next_review,
  };
}

const SELECT_STATE =
  'SELECT topic_id, mastery, confidence, attempts, last_seen, next_review FROM topic_state';

/** Состояния всех тем по `topic_id`: планировщик считает приоритеты разом по всем. */
export function readTopicStates(db: Database): Map<string, TopicState> {
  const rows = db.prepare<[], TopicStateRow>(`${SELECT_STATE} ORDER BY topic_id`).all();
  return new Map(rows.map((row) => [row.topic_id, toState(row)]));
}

/**
 * Состояние одной темы. Отсутствие строки — не «нулевая тема», а рассинхрон с
 * картой: строки заводит `syncTopicState`, и молчаливый ноль скрыл бы опечатку в `id`.
 */
export function readTopicState(db: Database, topicId: string): TopicState {
  const row = db.prepare<[string], TopicStateRow>(`${SELECT_STATE} WHERE topic_id = ?`).get(topicId);
  if (row === undefined) {
    throw new Error(`Модель знаний: тема «${topicId}» не заведена в topic_state`);
  }
  return toState(row);
}

/** Сохраняет состояние существующей темы. Новые темы заводит только синхронизация с картой. */
export function writeTopicState(db: Database, state: TopicState): void {
  const info = db
    .prepare(
      `UPDATE topic_state
          SET mastery = @mastery,
              confidence = @confidence,
              attempts = @attempts,
              last_seen = @lastSeen,
              next_review = @nextReview
        WHERE topic_id = @topicId`,
    )
    .run(state);

  if (info.changes === 0) {
    throw new Error(`Модель знаний: тема «${state.topicId}» не заведена в topic_state`);
  }
}

/**
 * Читает состояние темы, применяет попытку и сохраняет результат одной
 * транзакцией: чтение и запись обязаны видеть один и тот же снимок, иначе два
 * ответа подряд посчитались бы от одного и того же `mastery`.
 *
 * Транзакция именно `immediate`: под WAL отложенная берёт снимок на чтении и
 * запрашивает запись только в конце, так что чужая фиксация между ними роняет
 * её `SQLITE_BUSY_SNAPSHOT` — и попытка ученика теряется вместе с ошибкой.
 *
 * Строку в `attempts` эта функция **не** пишет: для неё нужен `task_id` из
 * `task_bank`. Занятие вставляет попытку само и зовёт `recordAttempt` из своей
 * `immediate`-транзакции (`submitAnswer`), так что запись попытки и сдвиг
 * модели остаются одним целым: засчитанный ответ без сдвига модели (или
 * наоборот) недопустим.
 */
export function recordAttempt(db: Database, topicId: string, attempt: Attempt): TopicState {
  return db.transaction((): TopicState => {
    const next = applyAttempt(readTopicState(db, topicId), attempt);
    writeTopicState(db, next);
    return next;
  }).immediate();
}

interface HistoryRow {
  is_correct: number;
  hint_penalty_applied: number;
  difficulty: number;
  created_at: string;
}

/**
 * Пересчитывает состояние темы, проигрывая все её попытки заново от нулевого
 * состояния. Нужно разбору спора: подтверждённая правота ученика меняет
 * результат уже записанной попытки, а сдвиги `mastery` считаются по цепочке —
 * задним числом её иначе не поправить.
 *
 * Источник истины здесь — таблица `attempts`: состояние, накопленное помимо
 * попыток, пересчёт не сохраняет. Другого способа получить историю у модели нет,
 * а расхождение всё равно означало бы, что `mastery` разошёлся с тем, что ученик
 * реально нарешал.
 */
export function recomputeTopicState(db: Database, topicId: string): TopicState {
  return db.transaction((): TopicState => {
    // Отметки времени внутри батча совпадают до миллисекунды, поэтому порядок
    // добивается по `id`: `applyAttempt` требует неубывающего времени, а при
    // неустойчивом порядке пересчёт то падал бы, то нет.
    const rows = db
      .prepare<[string], HistoryRow>(
        `SELECT attempts.is_correct, attempts.hint_penalty_applied,
                task_bank.difficulty, attempts.created_at
           FROM attempts
           JOIN task_bank ON task_bank.id = attempts.task_id
          WHERE attempts.topic_id = ? AND attempts.is_current = 1
            AND attempts.affects_progress = 1
          ORDER BY attempts.created_at, attempts.id`,
      )
      .all(topicId);

    let state = newTopicState(topicId);
    for (const row of rows) {
      state = applyAttempt(state, {
        correct: row.is_correct === 1,
        difficulty: row.difficulty,
        hintPenaltyApplied: row.hint_penalty_applied === 1,
        at: new Date(row.created_at),
      });
    }

    writeTopicState(db, state);
    return state;
  }).immediate();
}
