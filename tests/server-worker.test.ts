import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { HOST } from '../server/index.js';
import { dataLockPath } from '../server/data-lock.js';
import { startTenantServer, type TenantServer } from './server-harness.js';
import { openDatabase } from '../server/db.js';
import { loadCurriculum } from '../server/curriculum.js';
import { activeTopics } from '../server/scheduler.js';
import { storeTasks } from '../server/codex/bank.js';
import {
  CodexConcurrency,
  MAX_CODEX_CONCURRENCY,
  MAX_DISPUTE_CONCURRENCY,
} from '../server/codex/concurrency.js';
import { CodexUnavailableError, type CodexRequest } from '../server/codex/client.js';
import type { ProduceRequest } from '../server/codex/worker.js';
import { readCodexQuota } from '../server/control-db.js';
import type { GeneratedTask } from '../server/codex/task-schema.js';
import type { DisputeReview } from '../server/codex/dispute.js';

function generated(question: string): GeneratedTask {
  return {
    instruction: question, material: '', material_format: 'none', choices: [],
    answer: '45',
    accept: ['45'],
    hint: 'Раздели девяносто пополам.',
    explain: '90 : 2 = 45.',
    joke: 'Арифметика без сдачи.',
    difficulty: 2,
  };
}

/** Вердикт проверяющего «всё в порядке»: батч доезжает до банка целиком. */
function verdict(): unknown {
  return {
    answer: '45',
    unambiguous: true,
    natural: true,
    on_topic: true,
    age_appropriate: true,
    hint_safe: true,
    note: '',
  };
}

describe('воркер рабочего сервера', () => {
  let tempDir: string;
  let server: TenantServer | undefined;
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'edukator-server-worker-'));
    mkdirSync(join(tempDir, 'seed-bank'));
  });

  afterEach(async () => {
    await server?.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('запускает спор в отдельном слоте при занятом воркере', async () => {
    expect(MAX_CODEX_CONCURRENCY).toBe(2);
    expect(MAX_DISPUTE_CONCURRENCY).toBe(1);
    const budget = new CodexConcurrency(MAX_CODEX_CONCURRENCY);
    const disputes = new CodexConcurrency(MAX_DISPUTE_CONCURRENCY);
    const releaseProduce: ((tasks: GeneratedTask[]) => void)[] = [];
    let releaseReview: ((review: DisputeReview) => void) | undefined;
    let resolveProduce: (() => void) | undefined;
    const producingTopics: string[] = [];
    let peak = 0;
    const startedProduce = new Promise<void>((resolve) => {
      resolveProduce = resolve;
    });
    server = await startTenantServer({
      dataDir: join(tempDir, 'data'),
      seedDir: join(tempDir, 'seed-bank'),
      codexBudget: budget,
      disputeBudget: disputes,
      worker: {
        topics: 2,
        target: 2,
        threshold: 2,
        produce: (request) => {
          producingTopics.push(request.topic.id);
          peak = Math.max(peak, budget.active + disputes.active);
          if (producingTopics.length === MAX_CODEX_CONCURRENCY) resolveProduce?.();
          return new Promise<GeneratedTask[]>((done) => {
            releaseProduce.push(done);
          });
        },
      },
      review: () => {
        peak = Math.max(peak, budget.active + disputes.active);
        return new Promise<DisputeReview>((done) => {
          releaseReview = done;
        });
      },
    });
    app = server.app;
    const running = app;
    const childDb = server.dbPath;

    // Аренда уже открыта прогревом, а значит и карта синхронизирована; одно
    // готовое задание оставляет тему голодной для воркера и одновременно даёт
    // открыть спор через HTTP.
    const db = openDatabase(server.dbPath);
    const graph = loadCurriculum();
    const topic = activeTopics(db, graph, 1)[0];
    if (topic === undefined) throw new Error('планировщик не выбрал тему для теста');
    storeTasks(db, topic.id, [generated('В инвентаре 90 монет, половину потратили. Сколько осталось?')], {
      courseRevisionId: server.control.prepare<[string], { active_revision_id: number }>(
        'SELECT active_revision_id FROM courses WHERE id = ?',
      ).get(topic.subject)?.active_revision_id ?? null,
    });
    db.close();

    // Воркер заводится на уже открытую базу при переходе сервера к
    // прослушиванию: греть банк ребёнка, который ни разу не пришёл, незачем.
    await running.listen({ host: HOST, port: 0 });
    await startedProduce;

    const next = await running.inject({ method: 'GET', url: '/api/session/next' });
    const taskId = (next.json() as { task: { id: number } }).task.id;
    const answer = await running.inject({
      method: 'POST',
      url: '/api/session/answer',
      payload: { task_id: taskId, answer: '44' },
    });
    const attemptId = (answer.json() as { attempt_id: number }).attempt_id;
    const dispute = await running.inject({
      method: 'POST',
      url: '/api/session/dispute',
      payload: { attempt_id: attemptId },
    });

    expect(dispute.statusCode).toBe(202);
    await viWaitFor(() => releaseReview !== undefined);
    expect(producingTopics).toHaveLength(MAX_CODEX_CONCURRENCY);
    expect(producingTopics).toContain(topic.id);
    expect(budget.active).toBe(MAX_CODEX_CONCURRENCY);
    expect(disputes.active).toBe(1);
    expect(peak).toBe(MAX_CODEX_CONCURRENCY + MAX_DISPUTE_CONCURRENCY);
    expect(disputes.tryRun(() => Promise.resolve())).toBeUndefined();

    let closed = false;
    const closing = running.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    releaseReview?.({ studentCorrect: false, note: 'ответ отличается' });
    releaseProduce.forEach((release, index) => {
      release([
        generated(`Задание для прогрева ${index + 1}, вариант 1`),
        generated(`Задание для прогрева ${index + 1}, вариант 2`),
      ]);
    });
    await closing;

    const reopened = openDatabase(childDb);
    expect(reopened.prepare('SELECT COUNT(*) AS n FROM task_bank WHERE topic_id = ?').get(topic.id))
      .toEqual({ n: 3 });
    reopened.close();
  });

  it('списывает квоту ребёнка на каждый вызов codex своего воркера', async () => {
    // Воркер собирается на подменённом `run`, а не на `produce`: проверяется
    // именно обёртка квоты, которую `buildServer` надевает на вызов модели.
    const calls: CodexRequest[] = [];
    let cycleDone: (() => void) | undefined;
    const finished = new Promise<void>((resolve) => {
      cycleDone = resolve;
    });
    server = await startTenantServer({
      dataDir: join(tempDir, 'data'),
      seedDir: join(tempDir, 'seed-bank'),
      log: () => undefined,
      worker: {
        topics: 1,
        target: 1,
        threshold: 1,
        maxBatches: 1,
        run: (request) => {
          calls.push(request);
          return Promise.resolve(
            request.schemaPath.includes('verdicts')
              ? JSON.stringify({ items: [verdict()] })
              : JSON.stringify({ items: [generated('Сколько монет останется из девяноста?')] }),
          );
        },
        // Пауза наступает после цикла: к этому моменту вызовы кончились, и
        // счётчик можно сверять, не гоняясь за следующим заходом.
        wait: async () => {
          cycleDone?.();
          await new Promise<void>(() => undefined);
        },
      },
    });
    app = server.app;

    await app.listen({ host: HOST, port: 0 });
    await finished;

    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(readCodexQuota(server.control, server.childId).used).toBe(calls.length);
  });

  // `onClose` в Fastify идут в обратном порядке регистрации, так что «снять
  // замок последним» означает «зарегистрировать его хук первым». Обратный
  // порядок освобождал бы каталог, пока уходящий сервер ещё держит открытые
  // базы и незаконченный вызов модели, — и `prefetch` заводил бы вторую пару
  // слотов codex поверх недописанного WAL.
  it('держит замок каталога, пока не закончил закрываться', async () => {
    // Держит **первый** вызов модели и отпускает остальные: обход обязан
    // застрять ровно один раз, иначе закрытие не дождаться вовсе.
    let releaseProduce: ((tasks: GeneratedTask[]) => void) | undefined;
    let reachedProduce: (() => void) | undefined;
    const producing = new Promise<void>((resolve) => {
      reachedProduce = resolve;
    });
    const dataDir = join(tempDir, 'data');
    server = await startTenantServer({
      dataDir,
      seedDir: join(tempDir, 'seed-bank'),
      log: () => undefined,
      worker: {
        topics: 1,
        produce: () => {
          if (releaseProduce !== undefined) return Promise.resolve([]);
          return new Promise<GeneratedTask[]>((done) => {
            releaseProduce = done;
            reachedProduce?.();
          });
        },
        wait: (): Promise<void> => new Promise<void>(() => undefined),
      },
    });
    app = server.app;
    const lockPath = dataLockPath(dataDir);

    await app.listen({ host: HOST, port: 0 });
    await producing;

    const closing = app.close();
    // Закрытие ждёт застрявший обход: замок в этот момент обязан быть на месте.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const heldWhileClosing = existsSync(lockPath);
    releaseProduce?.([]);
    await closing;

    expect(heldWhileClosing).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  // Контроллер доступа стучится в `gate/status` раз в двадцать секунд, а
  // брошенный ребёнок в обход не попадает и в `#served` не появляется никогда:
  // считая опрос агента возвращением, диспетчер срывал бы паузу каждые двадцать
  // секунд, и получасовой отступ по недоступному codex не наступал бы вовсе.
  it('будит прогрев по запросу браузера, но не по опросу агента', async () => {
    let pauses = 0;
    server = await startTenantServer({
      dataDir: join(tempDir, 'data'),
      seedDir: join(tempDir, 'seed-bank'),
      log: () => undefined,
      worker: {
        topics: 1,
        produce: () => Promise.resolve([]),
        wait: (): Promise<void> => {
          pauses += 1;
          return new Promise<void>(() => undefined);
        },
      },
    });
    app = server.app;
    const running = app;
    // Оба ребёнка ни разу не заходили: отметки активности у них нет, в обход они
    // не попадают, и будильник по ним не отфильтруется как «уже свой».
    const byAgent = server.addChild('Агентский', 'agent');
    const byBrowser = server.addChild('Браузерный', 'browser');
    // Первого ребёнка помощник уже прогрел запросом. Отметка снимается, чтобы
    // обход был пустым и мгновенным: иначе «пауза не наступила ещё раз» значило
    // бы всего лишь «обход не успел закончиться».
    server.control.prepare('UPDATE children SET last_activity_at = NULL').run();

    await running.listen({ host: HOST, port: 0 });
    await viWaitFor(() => pauses >= 1);
    const afterStart = pauses;

    const polled = await running.inject({
      method: 'GET',
      url: '/api/gate/status',
      // Явная пустая cookie: помощник подставляет детскую во все запросы, а с ней
      // предъявителем стал бы первый ребёнок, а не агент второго.
      headers: { ...byAgent.headers, cookie: '' },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const afterAgent = pauses;

    const visited = await running.inject({
      method: 'GET',
      url: '/api/gate/status',
      headers: byBrowser.headers,
    });
    await viWaitFor(() => pauses > afterAgent);

    expect(polled.statusCode).toBe(200);
    expect(visited.statusCode).toBe(200);
    expect(afterAgent).toBe(afterStart);
    expect(pauses).toBeGreaterThan(afterAgent);
  });

  // Кешированная аренда отпечаток не перепроверяет, а маршруты и разбор споров —
  // да: по подменённому файлу они отвечают 503 и ничего не пишут. Обход,
  // оставленный без сверки, тратил бы на такого ребёнка суточную квоту целиком
  // и складывал бы задания в отвязанный inode, отчитываясь `stored > 0`, — то
  // есть выглядел бы здоровым до самого перезапуска.
  it('не греет ребёнка, чей файл базы подменили под живым соединением', async () => {
    const warmed: string[] = [];
    server = await startTenantServer({
      dataDir: join(tempDir, 'data'),
      seedDir: join(tempDir, 'seed-bank'),
      log: () => undefined,
      worker: {
        topics: 1,
        produce: (request: ProduceRequest) => {
          warmed.push(request.topic.id);
          return Promise.resolve([]);
        },
        wait: (): Promise<void> => new Promise<void>(() => undefined),
      },
    });
    app = server.app;
    // Единственный ребёнок помощника: его аренда уже в кеше — помощник открыл
    // её запросом при старте.
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${server.dbPath}${suffix}`, { force: true });
    openDatabase(server.dbPath).close();
    // Маршруты подмену уже видят и отвечают 503, ничего не записав.
    expect((await app.inject({ method: 'GET', url: '/api/gate/status' })).statusCode).toBe(503);

    await app.listen({ host: HOST, port: 0 });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(warmed).toEqual([]);
  });

  it('при недоступном codex откладывает воркер, но оставляет обычное занятие рабочим', async () => {
    const logged: string[] = [];
    let firstDelay: number | undefined;
    let reachedWait: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      reachedWait = resolve;
    });
    server = await startTenantServer({
      dataDir: join(tempDir, 'data'),
      seedDir: join(tempDir, 'seed-bank'),
      log: (message) => logged.push(message),
      worker: {
        topics: 1,
        produce: () => Promise.reject(new CodexUnavailableError('codex не найден')),
        wait: async (ms) => {
          // Именно первая пауза: занятие ученика будит диспетчер, и второй
          // заход поставил бы сюда уже удвоенный отступ — тест то краснел бы,
          // то нет, в зависимости от того, кто успел раньше.
          firstDelay ??= ms;
          reachedWait?.();
          await new Promise<void>(() => undefined);
        },
      },
    });
    app = server.app;

    const db = openDatabase(server.dbPath);
    const topic = activeTopics(db, loadCurriculum(), 1)[0];
    if (topic === undefined) throw new Error('планировщик не выбрал тему для теста');
    storeTasks(db, topic.id, [generated('В инвентаре 90 монет, половину потратили. Сколько осталось?')], {
      courseRevisionId: server.control.prepare<[string], { active_revision_id: number }>(
        'SELECT active_revision_id FROM courses WHERE id = ?',
      ).get(topic.subject)?.active_revision_id ?? null,
    });
    db.close();

    await app.listen({ host: HOST, port: 0 });
    await waiting;
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    const next = await app.inject({ method: 'GET', url: '/api/session/next' });
    const taskId = (next.json() as { task: { id: number } }).task.id;
    const answer = await app.inject({
      method: 'POST',
      url: '/api/session/answer',
      payload: { task_id: taskId, answer: '45' },
    });

    expect(health.statusCode).toBe(200);
    expect(next.statusCode).toBe(200);
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toMatchObject({ correct: true });
    expect(firstDelay).toBe(60_000);
    expect(logged.join('\n')).toMatch(/codex недоступен.*пополнение отложено/su);
  });
});

async function viWaitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('условие теста не наступило');
}
