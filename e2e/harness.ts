import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { storeTasks } from '../server/codex/bank.js';
import type { DisputeReviewer } from '../server/codex/dispute.js';
import type { GeneratedTask } from '../server/codex/task-schema.js';
import type { TaskProducer } from '../server/codex/worker.js';
import type { LearningProducer } from '../server/learning-prep.js';
import { openDatabase, SUBJECTS, writeProfile, type Subject } from '../server/db.js';
import { buildServer } from '../server/index.js';
import {
  ADMIN_AUDIT_PAGE,
  childDatabasePath,
  createChild,
  createParent,
  issueDeviceInvite,
  issueParentInvite,
  listAdminAudit,
  listServiceableChildren,
  openControlDatabase,
  redeemDeviceInvite,
  revokeDevice,
  redeemParentInvite,
  resolveChildDevice,
  setParentPin,
  type AdminAuditEntry,
} from '../server/control-db.js';
import { CHILD_COOKIE, PARENT_COOKIE } from '../server/auth.js';
import {
  createAdminAccount,
  HARNESS_ADMIN_PASSWORD,
  type HarnessAdmin,
} from '../tests/server-harness.js';
import { controlDatabasePath, ensureDataDir, provisionChildDatabase } from '../server/data-dir.js';
import { hashParentPin } from '../server/parent-pin.js';
import { loadCurriculum, syncTopicState, type TopicGraph } from '../server/curriculum.js';
import { startRun } from '../server/run.js';
import { submitAnswer } from '../server/session.js';

const NOW = new Date('2026-08-08T12:00:00.000Z');
const TOPICS_PER_SUBJECT = 12;
const TASKS_PER_TOPIC = 15;

/**
 * Адрес, на котором сценарий поднимает сервер. Он же — домен cookie: браузер
 * различает их по имени хоста, а не по порту, так что имя нужно знать до
 * `listen`, ещё до того как порт вообще выбран.
 */
const HOST = '127.0.0.1';

/** Имя ребёнка сценария. Оно же стоит в профиле его базы. */
const CHILD_NAME = 'Тимофей';

/**
 * Родитель сценария. Пароль настоящий: им же проверяется форма входа. Адрес
 * латиницей просто для читаемости: браузерной проверки `type=email`, которая
 * отвергала бы кириллицу в имени ящика, у форм больше нет — сервер такие
 * адреса принимает, и отдельный сценарий админки заводит семью именно с ним.
 */
export const E2E_PARENT = {
  email: 'parent@example.com',
  password: 'пароль-подлиннее',
} as const;

/**
 * Оператор сценария. Пароль настоящий и не короче
 * `MIN_ADMIN_PASSWORD_LENGTH`: им же проверяется форма входа в админку.
 */
export const E2E_ADMIN = {
  email: 'admin@example.com',
  password: HARNESS_ADMIN_PASSWORD,
} as const;

/** Кем сценарий смотрит на сервер: вошедшим родителем или машиной ученика. */
export type E2eSide = 'parent' | 'child';

/** Cookie предъявителя в том виде, в каком её принимает браузер сценария. */
export interface E2eCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax';
}

/**
 * Браузер сценария глазами помощника. Названо структурно, а не типом
 * Playwright: помощнику от контекста нужны ровно две операции, и сужение до них
 * означает, что подсунуть сюда что-то ещё нечего.
 */
export interface CookieJar {
  addCookies(cookies: E2eCookie[]): Promise<void>;
  clearCookies(): Promise<void>;
}

export interface E2eHarness {
  app: FastifyInstance;
  db: Database;
  url: string;
  /** Ребёнок сценария: его `id` стоит в адресах родительской сводки. */
  childId: string;
  /** Оператор сценария: его `id` стоит в каждой записи журнала действий. */
  adminId: string;
  /**
   * Заголовок `Cookie` для запросов мимо интерфейса. Он нужен потому, что
   * `page.request` ходит не браузером, а узлом, и cookie с `Secure` по голому
   * http не носит — хотя сам браузер 127.0.0.1 доверенным считает.
   */
  cookieHeader(side: E2eSide): string;
  /**
   * Дети родителя из управляющей базы. Нужны сценарию, который заводит второго
   * ребёнка через интерфейс: его `id` в ответе не показывается, а наполнять
   * базу и открывать сводку без него нечем.
   */
  children(): Array<{ id: string; name: string }>;
  /**
   * Наполняет базу ребёнка темами, профилем и банком. Нужен второму ребёнку:
   * заведённый через интерфейс приходит с пустой базой, а пустая не годится ни
   * одному забегу.
   */
  seedChild(childId: string, seed?: SeedChildOptions): void;
  assertCodexNotCalled(): void;
  /**
   * Журнал действий оператора, новые сверху. Экрана у него нет вовсе, а
   * проверять запись о заходе в чужую семью надо: без неё имперсонация не
   * оставляет следа, ради которого её и записывают.
   */
  adminAudit(): AdminAuditEntry[];
  /**
   * Постоянный токен агентского устройства: его выпуск и погашение идут тем же
   * путём, каким их проходит контроллер доступа. Заголовком `Authorization` он
   * открывает ровно `GET /api/gate/status` и ничего больше.
   */
  agentToken(): string;
  /** Отзывает агентское устройство: токен обязан перестать работать на том же запросе. */
  revokeAgent(): void;
  waitForLearningMaterial(topicId: string): Promise<number>;
  prepareBoss(topicId: string): Promise<void>;
  seedParentsDashboard(): void;
  upholdDispute(): void;
  close(): Promise<void>;
}

/** Чем наполняется база ребёнка. Всё остальное сценарий досеивает сам. */
export interface SeedChildOptions {
  /** Имя в профиле; по умолчанию — имя ребёнка сценария. */
  name?: string;
  triagePassed?: Subject;
  learningForecastFixture?: Subject;
}

interface HarnessOptions extends SeedChildOptions {
  controlledWorker?: boolean;
  controlledDispute?: boolean;
  parentPin?: string;
  /** Браузер сценария: помощник кладёт в него cookie предъявителя. */
  context?: CookieJar;
  /** Кем сценарий входит в этот браузер. По умолчанию — машина ученика. */
  signIn?: E2eSide;
}

function writeCurriculum(directory: string): void {
  for (const subject of SUBJECTS) {
    const answerFormat = subject === 'math' ? 'number' : subject === 'russian' ? 'text' : 'choice';
    writeFileSync(
      join(directory, `${subject}.json`),
      JSON.stringify({
        subject,
        topics: Array.from({ length: TOPICS_PER_SUBJECT }, (_, index) => ({
          id: `${subject}.${index + 1}`,
          subject,
          title: `Тема ${subject} ${index + 1}`,
          exam_weight: 3,
          difficulty: 2,
          prereqs: [],
          answer_format: answerFormat,
          prompt_seed: `Проверить тему ${subject} ${index + 1}.`,
        })),
      }),
    );
  }
}

function task(subject: Subject, topic: number, index: number): GeneratedTask {
  if (subject === 'russian') {
    if (index === 2) {
      return {
        instruction: `Собери предложение в задании ${subject}.${topic} номер ${index}.`,
        material: '',
        material_format: 'none',
        choices: [],
        word_tiles: ['winter.', 'in', 'Moscow', 'is', 'cold'],
        answer: 'Moscow is cold in winter.',
        accept: ['Moscow is cold in winter.'],
        hint: 'Сначала найди подлежащее и сказуемое. Затем поставь обстоятельство времени в естественную позицию.',
        explain: 'Получается законченное предложение: Moscow is cold in winter.',
        joke: 'Слова встали в очередь без талончиков.',
        difficulty: index % 3 + 1,
      };
    }
    return {
      instruction: `Вставь слово в задании ${subject}.${topic} номер ${index}.`,
      material: 'На полке лежит школьный ___ .',
      material_format: 'text',
      choices: [],
      answer: 'учебник',
      accept: ['учебник'],
      hint: 'Определи, какой предмет обычно лежит на школьной полке. Подставь слово и проверь согласование с прилагательным.',
      explain: 'На полке лежит школьный учебник.',
      joke: 'Учебник нашёлся без помощи библиотечного детектива.',
      difficulty: index % 3 + 1,
    };
  }
  if (subject === 'english') {
    return {
      instruction: `Выбери правильный перевод в задании ${subject}.${topic} номер ${index}.`,
      material: 'window',
      material_format: 'text',
      choices: ['дверь', 'окно', 'крыша'],
      answer: 'окно',
      accept: ['окно'],
      hint: 'Вспомни предмет, через который в комнату попадает дневной свет. Сопоставь это значение с каждым вариантом и проверь, что остальные обозначают другие части здания.',
      explain: 'Window переводится как «окно».',
      joke: 'Английский открыл окно возможностей.',
      difficulty: index % 3 + 1,
    };
  }
  return {
    // Инлайн-формула в инструкции — не украшение: до `SafeRichText` в условии
    // ученик читал бы «\(40+5\)» исходником, и сценарий это ловит.
    instruction: String.raw`Задание ${subject}.${topic} номер ${index}: вычисли значение \(40+5\).`,
    material: '40 + 5',
    material_format: 'math',
    choices: [],
    answer: '45',
    accept: ['45'],
    hint: 'Раздели число на десятки и единицы. Прибавь единицы к десяткам и проверь результат обратным вычитанием.',
    explain: '40 + 5 = 45.',
    joke: 'Пять единиц добрались до ответа.',
    difficulty: index % 3 + 1,
  };
}

function seedTasks(db: Database): void {
  for (const subject of SUBJECTS) {
    for (let topic = 1; topic <= TOPICS_PER_SUBJECT; topic += 1) {
      storeTasks(
        db,
        `${subject}.${topic}`,
        Array.from(
          { length: TASKS_PER_TOPIC },
          (_, index) => task(subject, topic, index + 1),
        ),
      );
    }
  }
}

function markTriagePassed(db: Database, subject: Subject): void {
  db.prepare(
    `INSERT INTO runs (subject, kind, topic_id, started_at, finished_at, summary)
     VALUES (?, 'triage', ?, ?, ?, ?)`,
  ).run(subject, `${subject}.1`, NOW.toISOString(), NOW.toISOString(), '{}');
}

function seedLearningForecastFixture(db: Database, subject: Subject): void {
  db.prepare(
    `UPDATE topic_state
        SET mastery = CASE WHEN topic_id = ? THEN 0.3 ELSE 0.5 END,
            confidence = 0.8,
            attempts = 5,
            last_seen = ?,
            next_review = ?
      WHERE topic_id LIKE ?`,
  ).run(
    `${subject}.1`,
    NOW.toISOString(),
    '2026-08-07T12:00:00.000Z',
    `${subject}.%`,
  );
}

/**
 * Наполняет базу ребёнка. Темы синхронизируются здесь же: реестр делает это при
 * первом открытии базы, а помощник приходит раньше него — и банк заданий без
 * строк `topic_state` не принял бы ни одного задания.
 */
function seedChildDatabase(db: Database, graph: TopicGraph, seed: SeedChildOptions): void {
  syncTopicState(db, graph);
  writeProfile(db, {
    name: seed.name ?? CHILD_NAME,
    partnerName: 'Кекс',
    interests: ['скейт'],
    examDate: '2027-05-20',
  });
  seedTasks(db);
  if (seed.triagePassed !== undefined) markTriagePassed(db, seed.triagePassed);
  if (seed.learningForecastFixture !== undefined) {
    seedLearningForecastFixture(db, seed.learningForecastFixture);
  }
}

function bossTask(topicId: string, serial: number, position: number): GeneratedTask {
  return {
    instruction: `Босс ${topicId}: реши уникальное задание ${serial}.${position}.`,
    material: `40 + ${position}`,
    material_format: 'math',
    choices: [],
    answer: String(40 + position),
    accept: [String(40 + position)],
    hint: 'У босса подсказка не показывается.',
    explain: `40 + ${position} = ${40 + position}.`,
    joke: `Босс потерял деление номер ${position}.`,
    difficulty: 2,
  };
}

function controlledProducer(): TaskProducer {
  let serial = 0;
  return async ({ topic }) => {
    serial += 1;
    return Array.from({ length: 5 }, (_, index) => bossTask(topic.id, serial, index + 1));
  };
}

function controlledLearningProducer(): LearningProducer {
  let serial = 0;
  return async ({ topic: selected }) => {
    serial += 1;
    const topicNumber = Number(selected.id.split('.').at(-1)) || 1;
    return {
      content: {
        introduction: `Тестовый материал ${serial} по теме ${selected.title}.`,
        objectives: ['Разобраться в правиле', 'Применить его самостоятельно'],
        sections: [
          { title: 'Идея', blocks: [{ type: 'paragraph', content: 'Короткое объяснение идеи.' }] },
          { title: 'Правило', blocks: [{ type: 'example', content: 'Разбираем правило на примере.' }] },
          { title: 'Проверка', blocks: [{ type: 'warning', content: 'Проверяем ответ перед завершением.' }] },
        ],
        summary: ['Вспомни правило.', 'Проверь ответ.'],
      },
      tasks: Array.from(
        { length: 5 },
        (_, index) => task(selected.subject, topicNumber, TASKS_PER_TOPIC + serial * 10 + index),
      ),
    };
  };
}

async function waitUntil(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`E2E не дождался состояния: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function startE2eHarness(
  options: HarnessOptions = {},
): Promise<E2eHarness> {
  const tempDir = mkdtempSync(join(tmpdir(), 'edukator-e2e-'));
  const curriculumDir = join(tempDir, 'curriculum');
  const seedDir = join(tempDir, 'seed-bank');
  const binDir = join(tempDir, 'bin');
  const codexMarker = join(tempDir, 'codex-called');
  mkdirSync(curriculumDir);
  mkdirSync(seedDir);
  mkdirSync(binDir);
  writeCurriculum(curriculumDir);

  const codexShim = join(binDir, 'codex');
  writeFileSync(codexShim, `#!/bin/sh\ntouch '${codexMarker}'\nexit 97\n`);
  chmodSync(codexShim, 0o755);

  const dataDir = ensureDataDir(join(tempDir, 'data'));
  const pepper = 'e2e-pepper-достаточной-длины';
  const previousPath = process.env.PATH;
  const previousPepper = process.env.EDUKATOR_PIN_PEPPER;
  process.env.PATH = `${binDir}:${previousPath ?? ''}`;
  // Без pepper сервер считает PIN ненастроенным: сценарий с управлением
  // доступом получил бы 503 вместо проверки PIN.
  process.env.EDUKATOR_PIN_PEPPER = pepper;

  let releaseDispute: (() => void) | undefined;
  const disputeGate = new Promise<void>((resolve) => { releaseDispute = resolve; });
  const review: DisputeReviewer = async () => {
    if (options.controlledDispute === true) await disputeGate;
    return {
      studentCorrect: true,
      note: 'Ответ ученика равнозначен эталону.',
    };
  };
  // Семья заводится до сборки сервера: реестр открывает базу ребёнка по
  // первому обращению, а сценарий приходит уже с готовой cookie предъявителя.
  const control = openControlDatabase(controlDatabasePath(dataDir));
  const graph = loadCurriculum(curriculumDir);
  const parentId = createParent(control, E2E_PARENT.email, NOW);
  const parentInvite = issueParentInvite(control, parentId, NOW);
  const redeemedParent = redeemParentInvite(control, parentInvite.token, E2E_PARENT.password, NOW);
  if (!redeemedParent.ok) throw new Error('E2E: родитель не завёл пароль');
  if (options.parentPin !== undefined) {
    setParentPin(control, parentId, hashParentPin(options.parentPin, pepper));
  }
  // Оператор заводится теми же часами, что и всё остальное: `setAdminPassword`
  // двигает `credentials_changed_at`, а сервер сценария живёт на `NOW`, и
  // заведённый настоящими часами оператор не смог бы войти вовсе.
  const admin: HarnessAdmin = createAdminAccount(control, { ...E2E_ADMIN, now: NOW });
  const childId = createChild(control, parentId, CHILD_NAME, NOW);
  provisionChildDatabase(control, childId, dataDir);
  // Устройство ученика гасится сразу: сценарию нужна не ссылка, а готовая
  // cookie, и проходить экран погашения перед каждым забегом значило бы
  // проверять вход по тринадцать раз вместо одного.
  const deviceInvite = issueDeviceInvite(control, childId, 'browser', 'Ноутбук', NOW);
  const claimed = redeemDeviceInvite(control, deviceInvite.token, NOW);
  if (!claimed.ok) throw new Error('E2E: устройство ученика не погашено');
  // Ученик считается севшим за компьютер: отметку активности ставит разбор его
  // токена, а без неё диспетчер держит ребёнка спящим и не готовит ему ни
  // босса, ни персональный разбор — сценарий ждал бы их до срока.
  resolveChildDevice(control, claimed.token, NOW);
  // Агентское устройство заводится тем же путём, что и детское: сценарий
  // проверяет шов «ссылка → погашение → Bearer», а не подложенную строку.
  const agentInvite = issueDeviceInvite(control, childId, 'agent', 'Контроллер', NOW);
  const claimedAgent = redeemDeviceInvite(control, agentInvite.token, NOW);
  if (!claimedAgent.ok) throw new Error('E2E: агентское устройство не погашено');
  const tokens: Record<E2eSide, string> = {
    parent: redeemedParent.session.token,
    child: claimed.token,
  };
  const dbPath = childDatabasePath(dataDir, childId);

  /**
   * Cookie стороны. `Secure` снять нельзя ни в каком тесте: cookie с префиксом
   * `__Host-` без него браузер не примет вовсе, а 127.0.0.1 он и по голому http
   * считает доверенным источником.
   */
  function cookieFor(side: E2eSide): E2eCookie {
    return {
      name: side === 'parent' ? PARENT_COOKIE : CHILD_COOKIE,
      value: tokens[side],
      domain: HOST,
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: side === 'parent' ? 'Strict' : 'Lax',
    };
  }

  async function signIn(jar: CookieJar, side: E2eSide): Promise<void> {
    // Чужая cookie снимается: браузер, несущий обе, выбирал бы сторону порядком
    // разбора предъявителя, а не сценарием.
    await jar.clearCookies();
    await jar.addCookies([cookieFor(side)]);
  }

  const app = buildServer(curriculumDir, {
    dataDir,
    worker: options.controlledWorker === true
      ? {
          produce: controlledProducer(),
          learningProduce: controlledLearningProducer(),
          wait: async () => new Promise((resolve) => setTimeout(resolve, 10)),
        }
      : false,
    seedDir,
    review,
    integrityReview: async (items) => items.map((item) => ({
      id: item.id,
      decision: 'meaningful',
      confidence: 0.99,
      reason: 'Ответ в браузерном сценарии осмысленный.',
    })),
    now: () => NOW,
  });
  const db = openDatabase(dbPath);

  try {
    seedChildDatabase(db, graph, options);
    const url = await app.listen({ host: HOST, port: 0 });
    if (options.context !== undefined) await signIn(options.context, options.signIn ?? 'child');

    function assertCodexNotCalled(): void {
      if (existsSync(codexMarker)) {
        throw new Error('E2E вызвал настоящий путь codex вместо тестовой подмены');
      }
    }

    return {
      app,
      db,
      url,
      childId,
      adminId: admin.adminId,
      children(): Array<{ id: string; name: string }> {
        return listServiceableChildren(control).map(({ id, name }) => ({ id, name }));
      },
      adminAudit(): AdminAuditEntry[] {
        return listAdminAudit(control, { limit: ADMIN_AUDIT_PAGE }).entries;
      },
      cookieHeader(side: E2eSide): string {
        const cookie = cookieFor(side);
        return `${cookie.name}=${cookie.value}`;
      },
      agentToken(): string {
        if (!claimedAgent.ok) throw new Error('E2E: агентское устройство не погашено');
        return claimedAgent.token;
      },
      revokeAgent(): void {
        if (!claimedAgent.ok) throw new Error('E2E: агентское устройство не погашено');
        if (!revokeDevice(control, claimedAgent.deviceId, NOW)) {
          throw new Error('E2E: агентское устройство не отозвано');
        }
      },
      seedChild(id: string, seed: SeedChildOptions = {}): void {
        // `fileMustExist` намеренно: сценарий сеет ребёнка, заведённого
        // маршрутом семьи, и ровно этим проверяет, что маршрут действительно
        // создал базу. Без него сорвавшееся заведение заводило бы базу здесь и
        // забег шёл бы зелёным по базе, которую создал сам тест.
        const childDb = openDatabase(childDatabasePath(dataDir, id), { fileMustExist: true });
        try {
          seedChildDatabase(childDb, graph, seed);
        } finally {
          childDb.close();
        }
      },
      assertCodexNotCalled,
      async waitForLearningMaterial(topicId: string): Promise<number> {
        await waitUntil(
          () => db.prepare<[string], { status: string }>(
            "SELECT status FROM learning_materials WHERE topic_id = ? AND status = 'ready'",
          ).get(topicId)?.status === 'ready',
          `готовый учебный материал ${topicId}`,
        );
        const material = db.prepare<[string], { id: number }>(
          "SELECT id FROM learning_materials WHERE topic_id = ? AND status = 'ready'",
        ).get(topicId);
        if (material === undefined) throw new Error(`E2E: материал ${topicId} исчез после подготовки`);
        return material.id;
      },
      async prepareBoss(topicId: string): Promise<void> {
        const topic = graph.byId.get(topicId);
        if (topic === undefined) throw new Error(`E2E: неизвестная тема ${topicId}`);
        const run = startRun(db, graph, topic.subject, { now: NOW });
        const rows = db.prepare<[string], { id: number; answer: string }>(
          `SELECT id, answer FROM task_bank
            WHERE topic_id = ? AND status IN ('valid', 'ready') ORDER BY id LIMIT 12`,
        ).all(topicId);
        for (const [index, row] of rows.entries()) {
          db.prepare("UPDATE task_bank SET status = 'used', issued_run_id = ? WHERE id = ?")
            .run(run.runId, row.id);
          submitAnswer(db, graph, {
            runId: run.runId, taskId: row.id, answer: row.answer,
            at: new Date(NOW.getTime() + index),
          });
          const mastery = db.prepare<[string], { mastery: number }>(
            'SELECT mastery FROM topic_state WHERE topic_id = ?',
          ).get(topicId)?.mastery ?? 0;
          if (mastery > 0.75) break;
        }
        const achieved = db.prepare<[string], { mastery: number }>(
          'SELECT mastery FROM topic_state WHERE topic_id = ?',
        ).get(topicId)?.mastery ?? 0;
        if (achieved <= 0.75) {
          throw new Error(`E2E: обычные ответы не открыли босса ${topicId}, mastery=${achieved}`);
        }
        await waitUntil(
          () => db.prepare<[string], { status: string }>(
            "SELECT status FROM boss_batches WHERE topic_id = ? AND status = 'ready'",
          ).get(topicId)?.status === 'ready',
          `готовый boss-батч ${topicId}`,
        );
      },
      seedParentsDashboard(): void {
        db.prepare(
          `UPDATE topic_state SET mastery = 0.4, confidence = 0.8, attempts = 4,
             last_seen = '2026-08-08T10:00:00.000Z', next_review = '2026-08-10T10:00:00.000Z'
           WHERE topic_id IN ('math.1', 'russian.1', 'english.1')`,
        ).run();
        db.prepare(
          `INSERT INTO forecast_snapshots (subject, score, band, created_at) VALUES
             ('math', 3.4, 0.4, '2026-08-01T12:00:00.000Z'),
             ('math', 3.3, 0.3, '2026-08-08T11:00:00.000Z'),
             ('russian', 3.0, 0.5, '2026-08-01T12:00:00.000Z'),
             ('english', 3.1, 0.5, '2026-08-01T12:00:00.000Z')`,
        ).run();

        const insertRun = db.prepare(
          `INSERT INTO runs
             (subject, kind, topic_id, started_at, finished_at, summary, total, correct)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
        );
        const ordinary = Number(insertRun.run(
          'math', 'run', 'math.1', '2026-08-07T09:00:00.000Z',
          '2026-08-07T09:10:00.000Z', '{}', 1,
        ).lastInsertRowid);
        const triage = Number(insertRun.run(
          'russian', 'triage', 'russian.1', '2026-08-06T09:00:00.000Z',
          '2026-08-06T09:10:00.000Z', '{}', 1,
        ).lastInsertRowid);
        const boss = Number(insertRun.run(
          'english', 'boss', 'english.1', '2026-08-08T09:00:00.000Z',
          '2026-08-08T09:10:00.000Z', null, 1,
        ).lastInsertRowid);
        db.prepare(
          "INSERT INTO boss_batches (topic_id, run_id, status, created_at, activated_at, finished_at) VALUES ('english.1', ?, 'won', ?, ?, ?)",
        ).run(boss, '2026-08-08T08:50:00.000Z', '2026-08-08T09:00:00.000Z', '2026-08-08T09:10:00.000Z');

        const taskId = db.prepare<[string], { id: number }>(
          'SELECT id FROM task_bank WHERE topic_id = ? ORDER BY id LIMIT 1',
        );
        const insertAttempt = db.prepare(
          `INSERT INTO attempts (task_id, topic_id, run_id, answer, is_correct, duration_ms, created_at)
           VALUES (?, ?, ?, ?, 1, ?, ?)`,
        );
        insertAttempt.run(taskId.get('math.1')?.id, 'math.1', ordinary, '45', 60_000, '2026-08-07T09:05:00.000Z');
        insertAttempt.run(taskId.get('russian.1')?.id, 'russian.1', triage, 'учебник', 120_000, '2026-08-06T09:05:00.000Z');
        insertAttempt.run(taskId.get('english.1')?.id, 'english.1', boss, 'окно', 180_000, '2026-08-08T09:05:00.000Z');
      },
      upholdDispute(): void {
        releaseDispute?.();
      },
      async close(): Promise<void> {
        releaseDispute?.();
        await app.close();
        control.close();
        db.close();
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        if (previousPepper === undefined) delete process.env.EDUKATOR_PIN_PEPPER;
        else process.env.EDUKATOR_PIN_PEPPER = previousPepper;
        const codexCalled = existsSync(codexMarker);
        rmSync(tempDir, { recursive: true, force: true });
        if (codexCalled) throw new Error('E2E вызвал настоящий путь codex вместо тестовой подмены');
      },
    };
  } catch (error) {
    await app.close();
    control.close();
    db.close();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousPepper === undefined) delete process.env.EDUKATOR_PIN_PEPPER;
    else process.env.EDUKATOR_PIN_PEPPER = previousPepper;
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}
