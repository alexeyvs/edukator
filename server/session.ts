/**
 * Занятие: выдача задания, приём ответа и разбор спора «я всё-таки прав».
 * Здесь только логика и доступ к базе — HTTP живёт в `server/routes/session.ts`.
 *
 * Тему выбирает планировщик этапа 1, задание берётся из тёплой очереди с
 * откатом на посевной банк: генерировать в момент показа нельзя, батч занимает
 * у модели полминуты.
 *
 * Ответ сверяется нормализатором, без обращения к модели, и попытка вместе со
 * сдвигом `mastery` и счётчиками забега пишется одной транзакцией: засчитанный
 * ответ без сдвига модели или прогресса — это молча разъехавшийся прогноз.
 *
 * Спор ученик не ждёт: маршрут только ставит его в очередь, а разбор идёт фоном
 * и, при подтверждении, дописывает ответ в `accept[]` и пересчитывает модель по
 * всей истории темы. Банк от этого самоисправляется — следующий такой же ответ
 * засчитается сразу.
 */
import type { Database } from 'better-sqlite3';
import type { AnswerFormat, Topic, TopicGraph } from './curriculum.js';
import type { Subject } from './db.js';
import {
  readTopicState,
  recomputeTopicState,
  recordAttempt,
  type TopicState,
} from './mastery.js';
import { checkAnswer, type CheckResult, type RejectReason } from './normalize.js';
import { activeTopics } from './scheduler.js';
import { issuedTask, type BankTask } from './codex/bank.js';
import { takeTaskOrSeed } from './codex/seed-bank.js';
import { duplicateKey, fitsAccept } from './codex/task-schema.js';
import type { DisputeContext, DisputeReviewer } from './codex/dispute.js';
import { runProgress, type RunProgress } from './run.js';
import { SessionError, type SessionErrorCode } from './session-error.js';
import { taskXp } from './xp.js';

export { SessionError, type SessionErrorCode };

/**
 * Задание в том виде, в каком его получает ученик. Ни `answer`, ни `accept[]`
 * здесь нет и быть не может: сверка идёт на сервере, а приехавший в браузер
 * ответ означал бы, что смотреть его проще, чем решать.
 *
 * `explain` и `joke` тоже остаются на сервере до ответа: разбор пересказывает
 * решение целиком, то есть содержит тот же ответ другими словами.
 */
export interface IssuedTask {
  id: number;
  topicId: string;
  subject: Subject;
  topicTitle: string;
  question: string;
  hint: string;
  difficulty: number;
  answerFormat: AnswerFormat;
}

export type NextTaskResult =
  | { status: 'ok'; task: IssuedTask }
  /** Планировщику нечего предложить: всё освоено или закрыто предпосылками. */
  | { status: 'no-topic' }
  /** Тема выбрана, но очередь и посев по ней пусты. */
  | { status: 'no-task'; topicId: string };

export interface NextTaskOptions {
  now?: Date;
  /** Ограничивает перебор тем одним предметом. */
  subject?: Subject;
  /** Активный забег: из него берётся предмет и проверяется его состояние. */
  runId?: number;
  /** Каталог посевного банка; по умолчанию репозиторный. */
  seedDir?: string;
  /** Куда писать про пропущенную тему; по умолчанию stderr. */
  log?: (message: string) => void;
}

/**
 * Следующее задание: тема от планировщика, задание из банка. Целевая сложность —
 * базовая сложность темы; подстройку под точность ученика делает триаж этапа 3.
 *
 * Перебирается **весь** план, а не первые несколько тем: пустая очередь темы не
 * повод сказать «заданий нет» — ответить по ней ученик не может, состояние её не
 * меняется, и планировщик предлагает её же снова, то есть занятие встаёт
 * навсегда. Посев покрывает шесть тем предмета из двадцати с лишним, так что
 * окно фиксированного размера регулярно целиком состоит из пустых тем, а
 * остальной банк остаётся недостижимым. Перебор дешёвый: план строится в памяти.
 *
 * Уже выданное, но неотвеченное задание темы возвращается повторно: перезагрузка
 * страницы не должна сжигать очередь.
 *
 * Состав тем берётся `activeTopics`, а не голым планом: тему идущего забега
 * планировщик считает использованной сегодня и в план не включает, так что на
 * голом плане занятие перескакивало бы с начатой темы на чужую прямо посреди
 * забега — а уже выданное по ней задание осталось бы висеть навсегда, потому что
 * `issuedTask` по выпавшей теме никто не спросит.
 */
export function nextTask(
  db: Database,
  graph: TopicGraph,
  options: NextTaskOptions = {},
): NextTaskResult {
  const now = options.now ?? new Date();
  const log = options.log ?? ((message: string): void => void process.stderr.write(`${message}\n`));
  const run = options.runId === undefined ? undefined : readActiveRun(db, options.runId);
  if (run?.kind === 'triage') {
    throw new SessionError('task-not-in-run', `Забег ${run.id} является триажем`);
  }
  if (run !== undefined && runProgress(db, run.id).done) {
    throw new SessionError('run-complete', `Забег ${run.id} достиг цели и готов к завершению`);
  }
  if (run !== undefined && options.subject !== undefined && run.subject !== options.subject) {
    throw new SessionError(
      'task-not-in-run',
      `Занятие: забег ${run.id} относится к другому предмету`,
    );
  }
  const subject = run?.subject ?? options.subject;
  const planned = activeTopics(db, graph, graph.byId.size, now).filter(
    (topic) => subject === undefined || topic.subject === subject,
  );
  const first = planned[0];
  if (first === undefined) return { status: 'no-topic' };

  // Один набор на весь перебор: посев предмета дозаливается целиком, и второй
  // раз за запрос это только разбор того же файла впустую.
  const seeded = new Set<Subject>();
  // Первая поломка перебора: если сорвались все темы плана без исключения, дело
  // не в банке, а в самой базе (заблокированная запись, рассинхронизованная
  // `topic_state`), и молчаливое «заданий нет» увело бы разбирательство не туда.
  let firstFailure: Error | undefined;
  let failed = 0;
  for (const topic of planned) {
    let task: BankTask | null;
    // Поломка одной темы не должна валить весь перебор: повреждённый `accept[]`
    // одного задания — дефект банка, и превращать его в пятисотку на каждом
    // запросе значит остановить занятие целиком, хотя соседние темы полны.
    try {
      task =
        issuedTask(db, topic.id, run?.id) ??
        takeTaskOrSeed(db, graph, topic.id, {
          difficulty: topic.difficulty,
          ...(run === undefined ? {} : { runId: run.id }),
          seeded,
          ...(options.seedDir === undefined ? {} : { dir: options.seedDir }),
        });
    } catch (error) {
      firstFailure ??= error as Error;
      failed += 1;
      log(`тема «${topic.id}» пропущена: ${(error as Error).message}`);
      continue;
    }
    if (task === null) continue;

    return {
      status: 'ok',
      task: {
        id: task.id,
        topicId: topic.id,
        subject: topic.subject,
        topicTitle: topic.title,
        question: task.question,
        hint: task.hint,
        difficulty: task.difficulty,
        answerFormat: topic.answerFormat,
      },
    };
  }

  if (firstFailure !== undefined && failed === planned.length) throw firstFailure;

  // Тема первого забега: она же осталась бы выбранной и на следующем запросе.
  return { status: 'no-task', topicId: first.id };
}

export interface AnswerRequest {
  taskId: number;
  answer: string;
  runId?: number;
  hintUsed?: boolean;
  durationMs?: number;
  /** Время попытки; по умолчанию — сейчас. Задаётся явно в тестах. */
  at?: Date;
  /** Куда писать про отбракованное задание; по умолчанию stderr. */
  log?: (message: string) => void;
}

export interface AnswerResult {
  attemptId: number;
  correct: boolean;
  /** Нормализованный ответ ученика: он же записан в `attempts`. */
  normalized: string;
  reason?: RejectReason;
  /** Эталон, разбор и реакция напарника — их видно только после ответа. */
  answer: string;
  explain: string;
  joke: string;
  state: TopicState;
  /** Начисление за эту попытку; для неверного ответа равно нулю. */
  xp: number;
  /** Счётчики забега после записи попытки либо null для обычного занятия. */
  progress: RunProgress | null;
}

interface SessionRun {
  id: number;
  subject: Subject;
  kind: 'run' | 'triage';
  finished_at: string | null;
}

function readActiveRun(db: Database, runId: number): SessionRun {
  const run = db
    .prepare<[number], SessionRun>('SELECT id, subject, kind, finished_at FROM runs WHERE id = ?')
    .get(runId);
  if (run === undefined) {
    throw new SessionError('run-not-found', `Занятие: забег ${runId} не найден`);
  }
  if (run.finished_at !== null) {
    throw new SessionError('run-finished', `Занятие: забег ${runId} уже завершён`);
  }
  return run;
}

interface TaskRow {
  id: number;
  topic_id: string;
  answer: string;
  accept: string;
  explain: string | null;
  joke: string | null;
  difficulty: number;
  status: string;
  issued_run_id: number | null;
}

function parseAccept(raw: string, id: number): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Занятие: задание ${id} хранит accept[] не как JSON (${raw})`);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error(`Занятие: accept[] задания ${id} должен быть массивом строк`);
  }
  return parsed as string[];
}

function readTask(db: Database, taskId: number): TaskRow {
  const row = db
    .prepare<[number], TaskRow>(
      `SELECT id, topic_id, answer, accept, explain, joke, difficulty, status, issued_run_id
         FROM task_bank WHERE id = ?`,
    )
    .get(taskId);
  if (row === undefined) {
    throw new SessionError('task-not-found', `Занятие: задания ${taskId} нет в банке`);
  }
  return row;
}

function topicOf(graph: TopicGraph, topicId: string): Topic {
  const topic = graph.byId.get(topicId);
  if (topic === undefined) {
    throw new Error(`Занятие: темы «${topicId}» нет в карте`);
  }
  return topic;
}

/**
 * Отметка попытки не раньше последней известной по теме. Нечитаемое `last_seen`
 * не чинится здесь: на нём осмысленно падает сам `applyAttempt`, назвав колонку.
 */
function notBefore(at: Date, lastSeen: string | null): Date {
  if (lastSeen === null) return at;
  const previous = Date.parse(lastSeen);
  if (!Number.isFinite(previous) || at.getTime() >= previous) return at;
  return new Date(previous);
}

/**
 * Принимает ответ: сверяет, пишет попытку и двигает модель знаний.
 *
 * Задание, которое ученику не выдавали, ответа не принимает: `takeTask`
 * помечает выданное `used`, и всё остальное — либо чужая очередь, либо подбор
 * идентификатора руками. По той же причине ответ на задание принимается один
 * раз: второй сдвинул бы `mastery` дважды за одно и то же.
 */
export function submitAnswer(
  db: Database,
  graph: TopicGraph,
  request: AnswerRequest,
): AnswerResult {
  const requestedAt = request.at ?? new Date();
  const hintUsed = request.hintUsed ?? false;
  const durationMs = Math.max(0, Math.round(request.durationMs ?? 0));
  const log =
    request.log ?? ((message: string): void => void process.stderr.write(`${message}\n`));

  // Всё одной `immediate`-транзакцией: проверка «уже отвечали», запись попытки
  // и сдвиг модели обязаны видеть один снимок, иначе два одновременных ответа
  // на одно задание оба пройдут проверку и оба сдвинут `mastery`.
  const outcome = db.transaction((): AnswerResult | { defect: string } => {
    const row = readTask(db, request.taskId);
    const topic = topicOf(graph, row.topic_id);
    const run = request.runId === undefined ? undefined : readActiveRun(db, request.runId);
    if (run?.kind === 'run' && runProgress(db, run.id).done) {
      throw new SessionError('run-complete', `Забег ${run.id} достиг цели и готов к завершению`);
    }
    if (run !== undefined && run.subject !== topic.subject) {
      throw new SessionError(
        'task-not-in-run',
        `Занятие: задание ${request.taskId} не относится к забегу ${run.id}`,
      );
    }
    if ((run?.id ?? null) !== row.issued_run_id) {
      throw new SessionError(
        'task-not-in-run',
        `Занятие: задание ${request.taskId} выдано другому забегу`,
      );
    }
    if (run?.kind === 'triage' && hintUsed) {
      throw new SessionError(
        'task-not-in-run',
        `Занятие: в триаже ${run.id} нельзя использовать подсказку`,
      );
    }
    if (row.status !== 'used') {
      throw new SessionError(
        'task-not-issued',
        `Занятие: задание ${request.taskId} ученику не выдавалось`,
      );
    }

    const answered = db
      .prepare<[number], { id: number }>('SELECT id FROM attempts WHERE task_id = ? LIMIT 1')
      .get(request.taskId);
    if (answered !== undefined) {
      throw new SessionError(
        'already-answered',
        `Занятие: на задание ${request.taskId} уже отвечали`,
      );
    }

    // Пропавшая из карты тема — не дефект задания, а расхождение карты с базой:
    // задания темы целы и вернутся вместе с ней (`syncTopicState` ровно поэтому
    // ничего не удаляет), а `rejected` выкинул бы их из выгружаемого посева
    // навсегда. Такое уходит пятисоткой; повторной выдачи она не вызовет —
    // темы вне карты в план не попадают.
    // Шаг часов назад (поправка NTP, ручной перевод времени на ноутбуке) не
    // имеет права стоить ученику ответа. `applyAttempt` требует неубывающего
    // времени и на нарушении бросает обычной ошибкой — а она изнутри этой
    // транзакции откатывает уже вставленную попытку и уходит наружу
    // пятисоткой, и так на каждой повторной отправке, пока часы не догонят
    // сохранённое `last_seen`. Запрет заводился для импорта истории не по
    // порядку; живой ответ происходит сейчас, поэтому его отметка
    // подтягивается к последней известной, а не отвергается.
    const at = notBefore(requestedAt, readTopicState(db, row.topic_id).lastSeen);

    // Дефект самого задания — нечитаемый `accept[]`, эталон без числа на
    // числовой теме — не должен вставать поперёк занятия навсегда. Выдача такое
    // задание уже пропускает (`nextTask`), а здесь оно уже выдано: без пометки
    // задание остаётся `used` без попытки, `issuedTask` возвращает его снова, и
    // ученик получает ту же пятисотку до конца занятия. Пометка `rejected`
    // выводит его из очереди.
    let check: CheckResult;
    try {
      check = checkAnswer(
        request.answer,
        { answer: row.answer, accept: parseAccept(row.accept, row.id) },
        topic.answerFormat,
      );
    } catch (error) {
      db.prepare("UPDATE task_bank SET status = 'rejected' WHERE id = ?").run(row.id);
      return { defect: (error as Error).message };
    }

    const info = db
      .prepare(
        `INSERT INTO attempts
          (task_id, topic_id, run_id, answer, is_correct, hint_used, duration_ms, created_at)
         VALUES
          (@taskId, @topicId, @runId, @answer, @isCorrect, @hintUsed, @durationMs, @createdAt)`,
      )
      .run({
        taskId: row.id,
        topicId: row.topic_id,
        runId: run?.id ?? null,
        // Пишется то, что ученик набрал: нормализованную запись всегда можно
        // получить заново, а вот разбор спора смотрит именно на исходную.
        answer: request.answer.trim(),
        isCorrect: check.correct ? 1 : 0,
        hintUsed: hintUsed ? 1 : 0,
        durationMs,
        createdAt: at.toISOString(),
      });

    const state = recordAttempt(db, row.topic_id, {
      correct: check.correct,
      difficulty: row.difficulty,
      hintUsed,
      at,
    });
    const xp = taskXp({ difficulty: row.difficulty, correct: check.correct, hintUsed });
    if (run !== undefined) {
      db.prepare(
        `UPDATE runs
            SET total = total + 1,
                correct = correct + @correct
          WHERE id = @runId`,
      ).run({ runId: run.id, correct: check.correct ? 1 : 0 });
    }

    return {
      attemptId: Number(info.lastInsertRowid),
      correct: check.correct,
      normalized: check.normalized,
      ...(check.reason === undefined ? {} : { reason: check.reason }),
      answer: row.answer,
      explain: row.explain ?? '',
      joke: row.joke ?? '',
      state,
      xp,
      progress: run === undefined ? null : runProgress(db, run.id),
    };
  }).immediate();

  // Отказ бросается уже после фиксации: пометка `rejected` обязана уцелеть, а
  // исключение изнутри транзакции откатило бы её вместе со всем остальным.
  // Наружу уходит только факт — причина называет эталонный ответ, а его ученик
  // видеть не должен, поэтому подробности идут в журнал.
  if ('defect' in outcome) {
    log(`задание ${request.taskId} отбраковано при приёме ответа: ${outcome.defect}`);
    throw new SessionError(
      'task-defective',
      `Занятие: задание ${request.taskId} отбраковано, возьмите следующее`,
    );
  }
  return outcome;
}

export type DisputeStatus = 'open' | 'upheld' | 'rejected';

export interface OpenDisputeResult {
  id: number;
  status: DisputeStatus;
  /** Спор заведён этим вызовом: только тогда его надо ставить на разбор. */
  created: boolean;
}

/**
 * Ставит спорный ответ в очередь разбора. Повторное нажатие кнопки отдаёт тот
 * же спор, а не заводит второй: разбор стоит вызова модели, и два вердикта по
 * одной попытке всё равно спорили бы уже друг с другом.
 */
export function openDispute(db: Database, attemptId: number): OpenDisputeResult {
  return db.transaction((): OpenDisputeResult => {
    const attempt = db
      .prepare<
        [number],
        { id: number; is_correct: number; run_id: number | null; finished_at: string | null }
      >(
        `SELECT attempts.id, attempts.is_correct, attempts.run_id, runs.finished_at
           FROM attempts
           LEFT JOIN runs ON runs.id = attempts.run_id
          WHERE attempts.id = ?`,
      )
      .get(attemptId);
    if (attempt === undefined) {
      throw new SessionError('attempt-not-found', `Занятие: попытки ${attemptId} нет`);
    }
    // Заведённый спор ищется раньше проверки «попытка и так засчитана»: после
    // подтверждённого спора попытка как раз становится верной, и на повторное
    // нажатие кнопки ученик должен получить вердикт по своему спору, а не отказ.
    const existing = db
      .prepare<[number], { id: number; status: DisputeStatus }>(
        'SELECT id, status FROM disputes WHERE attempt_id = ? ORDER BY id LIMIT 1',
      )
      .get(attemptId);
    if (existing !== undefined) {
      return { id: existing.id, status: existing.status, created: false };
    }

    if (attempt.run_id !== null && attempt.finished_at !== null) {
      throw new SessionError('run-finished', `Забег ${attempt.run_id} уже завершён`);
    }

    if (attempt.is_correct === 1) {
      throw new SessionError(
        'attempt-correct',
        `Занятие: попытка ${attemptId} и так засчитана, спорить не о чем`,
      );
    }

    const info = db.prepare('INSERT INTO disputes (attempt_id) VALUES (?)').run(attemptId);
    return { id: Number(info.lastInsertRowid), status: 'open', created: true };
  }).immediate();
}

export interface ResolveDisputeResult {
  id: number;
  status: DisputeStatus;
  /** Обоснование разбирающего; у уже закрытого спора — сохранённое. */
  resolution: string;
  /** `accept[]` задания после разбора: при подтверждении он пополнен. */
  accept: string[];
  /** Состояние темы после пересчёта; `null`, если пересчитывать было нечего. */
  state: TopicState | null;
}

interface DisputeRow {
  id: number;
  status: DisputeStatus;
  resolution: string | null;
  attempt_id: number;
  run_id: number | null;
  topic_id: string;
  given: string;
  task_id: number;
  question: string;
  answer: string;
  accept: string;
}

function readDispute(db: Database, disputeId: number): DisputeRow {
  const row = db
    .prepare<[number], DisputeRow>(
      `SELECT disputes.id, disputes.status, disputes.resolution,
              attempts.id AS attempt_id, attempts.run_id, attempts.topic_id,
              attempts.answer AS given,
              task_bank.id AS task_id, task_bank.question, task_bank.answer, task_bank.accept
         FROM disputes
         JOIN attempts ON attempts.id = disputes.attempt_id
         JOIN task_bank ON task_bank.id = attempts.task_id
        WHERE disputes.id = ?`,
    )
    .get(disputeId);
  if (row === undefined) {
    throw new SessionError('dispute-not-found', `Занятие: спора ${disputeId} нет`);
  }
  return row;
}

/**
 * Разбирает спор и, если ученик прав, возвращает ему баллы задним числом:
 * попытка становится верной, ответ дописывается в `accept[]` задания, а модель
 * знаний темы пересчитывается по всей её истории.
 *
 * Пересчёт, а не обратный сдвиг: `mastery` меняется цепочкой, и после спорной
 * попытки успели пройти другие — вычесть из результата один шаг задним числом
 * уже нельзя.
 *
 * Уже закрытый спор второй раз не разбирается: вызов возвращает сохранённый
 * вердикт, не трогая ни модель, ни задание.
 *
 * Подтверждение спора всегда засчитывает попытку, но не всякий ответ попадает в
 * `accept[]`: пустая строка, «45 и 46» и число, отличное от эталона, не проходят
 * `fitsAccept` и дописаны не будут — иначе выгруженный посевной файл предмета
 * перестал бы разбираться этим же `parseTaskBatch`.
 */
export async function resolveDispute(
  db: Database,
  graph: TopicGraph,
  disputeId: number,
  review: DisputeReviewer,
): Promise<ResolveDisputeResult> {
  const dispute = readDispute(db, disputeId);
  const accept = parseAccept(dispute.accept, dispute.task_id);
  if (dispute.status !== 'open') {
    return {
      id: dispute.id,
      status: dispute.status,
      resolution: dispute.resolution ?? '',
      accept,
      state: null,
    };
  }

  const topic = topicOf(graph, dispute.topic_id);
  const context: DisputeContext = {
    topic,
    question: dispute.question,
    expected: dispute.answer,
    accept,
    given: dispute.given,
  };
  // Вызов модели — вне транзакции: он идёт минуты, а под WAL всё это время
  // держал бы запись, то есть занятие вставало бы на каждом споре.
  const verdict = await review(context);

  return db.transaction((): ResolveDisputeResult => {
    // Спор перечитывается уже под записью: пока шёл вызов модели, его мог
    // закрыть параллельный разбор, и второй вердикт удвоил бы `accept[]`.
    const fresh = readDispute(db, disputeId);
    const current = parseAccept(fresh.accept, fresh.task_id);
    if (fresh.status !== 'open') {
      return {
        id: fresh.id,
        status: fresh.status,
        resolution: fresh.resolution ?? '',
        accept: current,
        state: null,
      };
    }

    const status: DisputeStatus = verdict.studentCorrect ? 'upheld' : 'rejected';
    db.prepare(
      `UPDATE disputes
          SET status = @status, resolution = @resolution,
              resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = @id`,
    ).run({ id: disputeId, status, resolution: verdict.note });

    if (!verdict.studentCorrect) {
      return { id: disputeId, status, resolution: verdict.note, accept: current, state: null };
    }

    const given = fresh.given.trim();
    const keys = new Set(
      [fresh.answer, ...current].map((value) => duplicateKey(value, topic.answerFormat)),
    );
    const next =
      !fitsAccept(given, topic.answerFormat, fresh.answer) ||
      keys.has(duplicateKey(given, topic.answerFormat))
        ? current
        : [...current, given];

    db.prepare('UPDATE task_bank SET accept = @accept WHERE id = @id').run({
      id: fresh.task_id,
      accept: JSON.stringify(next),
    });
    db.prepare('UPDATE attempts SET is_correct = 1 WHERE id = ?').run(fresh.attempt_id);
    if (fresh.run_id !== null) {
      db.prepare('UPDATE runs SET correct = correct + 1 WHERE id = ?').run(fresh.run_id);
    }

    return {
      id: disputeId,
      status,
      resolution: verdict.note,
      accept: next,
      state: recomputeTopicState(db, fresh.topic_id),
    };
  }).immediate();
}

/**
 * Споры, ждущие разбора. Отдельной очереди по ним нет: спор ставит на разбор
 * маршрут, и он же переставляет его на следующем нажатии кнопки, если разбор не
 * состоялся (codex недоступен, ответ не разобрался, сервер перезапустился).
 * Список нужен, чтобы такой спор было видно снаружи занятия.
 */
export function openDisputes(db: Database): number[] {
  return db
    .prepare<[], { id: number }>("SELECT id FROM disputes WHERE status = 'open' ORDER BY id")
    .all()
    .map((row) => row.id);
}
