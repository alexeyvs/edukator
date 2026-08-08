/** Фоновая подготовка полного свежего набора для боя с боссом. */
import type { Database } from 'better-sqlite3';
import { BOSS_MASTERY, BOSS_TARGET } from './boss-rules.js';
import { hasPriorBossLoss } from './boss-loss.js';
import type { Topic, TopicGraph } from './curriculum.js';
import { readProfile } from './db.js';
import { reserveBossTasks, recentQuestions } from './codex/bank.js';
import { CodexUnavailableError } from './codex/client.js';
import {
  codexConcurrency,
  type CodexConcurrency,
} from './codex/concurrency.js';
import { taskPromptText, type GeneratedTask } from './codex/task-schema.js';
import type { TaskProducer, WorkerLog } from './codex/worker.js';
import { questionFingerprint } from './normalize.js';

/** Один бой не может бесконечно занимать воркер неудачными ответами модели. */
export const MAX_BATCHES_PER_BOSS = 4;

/** Незавершённый claim старше получаса считается оборванным вместе с процессом. */
export const PREPARING_STALE_MS = 30 * 60 * 1000;

interface BatchClaim {
  batchId: number;
  topic: Topic;
  recovered: boolean;
}

interface BatchRow {
  id: number;
  topic_id: string;
  created_at: string;
}

export interface BossPreparationOptions {
  db: Database;
  graph: TopicGraph;
  produce: TaskProducer;
  budget?: CodexConcurrency;
  maxBatches?: number;
  now?: Date;
  log?: WorkerLog;
}

export interface BossPreparationReport {
  topicId?: string;
  batchId?: number;
  batches: number;
  stored: number;
  ready: boolean;
  recovered: boolean;
  codexUnavailable: boolean;
  error?: string;
}

function defaultLog(message: string): void {
  process.stderr.write(`${message}\n`);
}

function validNow(now: Date): Date {
  if (!Number.isFinite(now.getTime())) {
    throw new Error(`Подготовка босса: некорректное время (${String(now)})`);
  }
  return now;
}

/**
 * Подхватывает живой claim либо создаёт его для первой подходящей темы.
 * Проверка состояния и вставка идут одной immediate-транзакцией: два воркера
 * не смогут одновременно начать разные наборы одной темы.
 */
function claimBoss(db: Database, graph: TopicGraph, now: Date): BatchClaim | undefined {
  return db.transaction((): BatchClaim | undefined => {
    const cutoff = new Date(now.getTime() - PREPARING_STALE_MS).toISOString();
    const stale = db.prepare<[string], BatchRow>(
      `SELECT id, topic_id, created_at FROM boss_batches
        WHERE status = 'preparing' AND created_at <= ?
        ORDER BY created_at, id LIMIT 1`,
    ).get(cutoff);
    let recoveredTopicId: string | undefined;
    if (stale !== undefined) {
      db.prepare("UPDATE boss_batches SET status = 'failed' WHERE id = ? AND status = 'preparing'")
        .run(stale.id);
      recoveredTopicId = stale.topic_id;
    }

    const preparing = db.prepare<[], BatchRow>(
      `SELECT id, topic_id, created_at FROM boss_batches
        WHERE status = 'preparing' ORDER BY created_at, id LIMIT 1`,
    ).get();
    if (preparing !== undefined) {
      const topic = graph.byId.get(preparing.topic_id);
      if (topic === undefined) {
        throw new Error(`Подготовка босса: темы «${preparing.topic_id}» нет в карте`);
      }
      return { batchId: preparing.id, topic, recovered: false };
    }

    const eligible = graph.order.find((topic) => {
      const state = db.prepare<[string], { mastery: number; closed_at: string | null }>(
        'SELECT mastery, closed_at FROM topic_state WHERE topic_id = ?',
      ).get(topic.id);
      // Синхронизация карты обычно гарантирует строку, но воркер и раньше
      // переживал рассинхрон одной темы и продолжал греть остальные. Claim
      // босса не должен превращать этот мягкий отказ в падение всего цикла.
      if (state === undefined) return false;
      if (
        (state.mastery <= BOSS_MASTERY && !hasPriorBossLoss(db, topic.id)) ||
        state.closed_at !== null
      ) return false;
      const live = db.prepare<[string], { id: number }>(
        `SELECT id FROM boss_batches
          WHERE topic_id = ? AND status IN ('preparing', 'ready', 'active') LIMIT 1`,
      ).get(topic.id);
      return live === undefined;
    });
    if (eligible === undefined) return undefined;

    const info = db.prepare(
      "INSERT INTO boss_batches (topic_id, status, created_at) VALUES (?, 'preparing', ?)",
    ).run(eligible.id, now.toISOString());
    return {
      batchId: Number(info.lastInsertRowid),
      topic: eligible,
      recovered: recoveredTopicId === eligible.id,
    };
  }).immediate();
}

function knownFingerprints(db: Database, topicId: string): Set<string> {
  return new Set(db.prepare<[string], { fingerprint: string }>(
    'SELECT fingerprint FROM task_bank WHERE topic_id = ?',
  ).all(topicId).map(({ fingerprint }) => fingerprint));
}

/** Один ограниченный проход подготовки; исключения модели остаются в отчёте. */
export async function prepareNextBoss(
  options: BossPreparationOptions,
): Promise<BossPreparationReport> {
  const now = validNow(options.now ?? new Date());
  const claim = claimBoss(options.db, options.graph, now);
  if (claim === undefined) {
    return { batches: 0, stored: 0, ready: false, recovered: false, codexUnavailable: false };
  }

  const maxBatches = options.maxBatches ?? MAX_BATCHES_PER_BOSS;
  if (!Number.isInteger(maxBatches) || maxBatches < 1) {
    throw new Error(`Подготовка босса: предел батчей должен быть положительным целым, получено ${maxBatches}`);
  }
  const log = options.log ?? defaultLog;
  const budget = options.budget ?? codexConcurrency;
  const profile = readProfile(options.db);
  const fingerprints = knownFingerprints(options.db, claim.topic.id);
  const gathered: GeneratedTask[] = [];
  let batches = 0;

  try {
    while (gathered.length < BOSS_TARGET && batches < maxBatches) {
      batches += 1;
      const generated = await budget.run(() => options.produce({
        topic: claim.topic,
        difficulty: claim.topic.difficulty,
        profile,
        recent: [
          ...recentQuestions(options.db, claim.topic.id),
          ...gathered.map(taskPromptText),
        ],
      }));
      for (const task of generated) {
        const fingerprint = questionFingerprint(taskPromptText(task));
        if (fingerprint === '' || fingerprints.has(fingerprint)) continue;
        fingerprints.add(fingerprint);
        gathered.push(task);
        if (gathered.length === BOSS_TARGET) break;
      }
    }

    if (gathered.length !== BOSS_TARGET) {
      const message = `собрано ${gathered.length} из ${BOSS_TARGET} новых заданий за ${batches} батч(ей)`;
      log(`воркер: босс темы «${claim.topic.id}» не готов: ${message}`);
      return {
        topicId: claim.topic.id, batchId: claim.batchId, batches, stored: 0,
        ready: false, recovered: claim.recovered, codexUnavailable: false, error: message,
      };
    }

    const result = reserveBossTasks(options.db, claim.batchId, gathered);
    if (!result.ready) {
      const message = 'полный набор столкнулся с уже сохранённым отпечатком';
      log(`воркер: босс темы «${claim.topic.id}» не готов: ${message}`);
      return {
        topicId: claim.topic.id, batchId: claim.batchId, batches, stored: 0,
        ready: false, recovered: claim.recovered, codexUnavailable: false, error: message,
      };
    }
    log(`воркер: босс темы «${claim.topic.id}» готов, сохранено ${result.stored.length} заданий`);
    return {
      topicId: claim.topic.id, batchId: claim.batchId, batches,
      stored: result.stored.length, ready: true, recovered: claim.recovered,
      codexUnavailable: false,
    };
  } catch (error) {
    const message = (error as Error).message;
    const unavailable = error instanceof CodexUnavailableError;
    log(
      `воркер: подготовка босса темы «${claim.topic.id}» отложена` +
      `${unavailable ? ', codex недоступен' : ''}: ${message}`,
    );
    return {
      topicId: claim.topic.id, batchId: claim.batchId, batches, stored: 0,
      ready: false, recovered: claim.recovered, codexUnavailable: unavailable, error: message,
    };
  }
}
