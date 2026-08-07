import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { databasePath, openDatabase } from './db.js';
import {
  CURRICULUM_DIR,
  loadCurriculum,
  syncTopicState,
  type SyncResult,
  type TopicGraph,
} from './curriculum.js';
import { loadSeedBank, type LoadSeedBankResult } from './codex/seed-bank.js';
import {
  registerSessionRoutes,
  registerUnavailableSession,
  type SessionRoutesOptions,
} from './routes/session.js';

export { databasePath };

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

/**
 * Версия приложения из package.json — отдаётся в /api/health. Нечитаемый или
 * битый файл роняет не запрос, а только само поле: маршрут здоровья читают,
 * чтобы узнать причину поломки, и 500 вместо «database: error» её как раз прячет.
 */
export function readVersion(): string {
  try {
    const raw = readFileSync(resolve(projectRoot, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch (error) {
    process.stderr.write(`версия не прочитана из package.json: ${(error as Error).message}\n`);
    return '0.0.0';
  }
}

export type DatabaseStatus = 'ok' | 'error';

/**
 * Проверка живости базы: открыть, домигрировать до текущей схемы и выполнить
 * тривиальный запрос. Миграция на уже актуальной базе — чтение одной прагмы,
 * так что health остаётся дешёвым.
 *
 * Причина отказа уходит в stderr: логгер Fastify выключен, а «database: error»
 * без текста не отличает занятый файл от непрочитанной схемы — а читают health
 * ровно тогда, когда это и надо различить.
 */
export function checkDatabase(path: string = databasePath()): DatabaseStatus {
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    // `fileMustExist` проверяется атомарно самим SQLite: отдельный existsSync
    // оставлял окно, в котором пропавший файл успевал создаться заново.
    db = openDatabase(path, { fileMustExist: true });
    db.prepare('SELECT 1').get();
    return 'ok';
  } catch (error) {
    process.stderr.write(`база ${path} недоступна: ${(error as Error).message}\n`);
    return 'error';
  } finally {
    db?.close();
  }
}

/**
 * Заводит в `topic_state` темы, которых там ещё нет (спека: «при старте сервера
 * отсутствующие темы заводятся с нулевыми значениями»). Без этого планировщик
 * считает недостающую строку нулевым состоянием и спокойно ставит тему в план,
 * а `recordAttempt` на первом же ответе по ней падает.
 */
export function syncCurriculumState(
  path: string = databasePath(),
  curriculumDir: string = CURRICULUM_DIR,
): SyncResult {
  return syncLoadedCurriculum(path, loadCurriculum(curriculumDir));
}

/**
 * Заливает посевной банк в `task_bank`. Идемпотентна: повторный запуск ничего
 * не добавляет — задания отсекаются по отпечатку формулировки. Вызывается один
 * раз за старт, после того как темы заведены: без строк `topic_state` вставка
 * упала бы на внешнем ключе.
 */
export function loadSeedTasks(
  path: string,
  graph: TopicGraph,
  seedDir?: string,
): LoadSeedBankResult {
  const db = openDatabase(path);
  try {
    return loadSeedBank(db, graph, seedDir === undefined ? {} : { dir: seedDir });
  } finally {
    db.close();
  }
}

function syncLoadedCurriculum(path: string, graph: TopicGraph): SyncResult {
  const db = openDatabase(path);
  try {
    const result = syncTopicState(db, graph);

    // Осиротевшие строки не удаляются (тема может вернуться в карту), но и
    // молчать о них нельзя: обычно это переименованный `id`, то есть прогресс,
    // который больше никогда не попадёт ни в план, ни в прогноз.
    if (result.stale.length > 0) {
      process.stderr.write(
        `в topic_state есть состояния без темы в карте: ${result.stale.join(', ')}\n`,
      );
    }

    return result;
  } finally {
    db.close();
  }
}

/** Слушаем все интерфейсы — чтобы заходить с других устройств домашней сети. */
export const HOST = '0.0.0.0';

export type CurriculumStatus = 'ok' | 'error';

/** Настройки занятия, которые тесты подменяют: разбирающий спор и запуск фона. */
export type ServerOptions = Omit<SessionRoutesOptions, 'db' | 'graph'>;

export function buildServer(
  curriculumDir: string = CURRICULUM_DIR,
  options: ServerOptions = {},
): FastifyInstance {
  const app = Fastify({ logger: false });
  let curriculum: CurriculumStatus = 'ok';
  let graph: TopicGraph | undefined;
  let curriculumSynchronized = false;

  // Непрочитанная карта тем не должна мешать серверу подняться: иначе
  // /api/health — единственное, что умеет назвать причину поломки — становится
  // недоступен ровно в тот раз, когда он и нужен.
  try {
    graph = loadCurriculum(curriculumDir);
  } catch (error) {
    curriculum = 'error';
    process.stderr.write(`карта тем не загружена: ${(error as Error).message}\n`);
  }

  function trySyncCurriculum(): boolean {
    if (graph === undefined) return false;
    try {
      syncLoadedCurriculum(databasePath(), graph);
      curriculumSynchronized = true;
      return true;
    } catch (error) {
      process.stderr.write(`синхронизация карты тем не выполнена: ${(error as Error).message}\n`);
      return false;
    }
  }

  // Посев заливается один раз за старт, а не на каждом /api/health: он
  // идемпотентен, но разбирать три файла и биться об уникальный индекс на
  // каждом опросе здоровья незачем. Отсутствие или порча посева сервер не
  // роняет — без него приложение работает, просто первая тема холодная.
  function trySeedBank(): void {
    if (graph === undefined) return;
    try {
      const seeded = loadSeedTasks(databasePath(), graph, options.seedDir);
      if (seeded.loaded > 0) {
        process.stderr.write(`посевной банк: добавлено ${seeded.loaded} задани(й)\n`);
      }
    } catch (error) {
      process.stderr.write(`посевной банк не загружен: ${(error as Error).message}\n`);
    }
  }

  function tryOpenSession(): ReturnType<typeof openDatabase> | undefined {
    try {
      return openDatabase(databasePath());
    } catch (error) {
      process.stderr.write(`занятие не поднято: база недоступна: ${(error as Error).message}\n`);
      return undefined;
    }
  }

  if (trySyncCurriculum()) trySeedBank();

  // Занятию нужно живое соединение: выдача задания, приём ответа и разбор спора
  // идут транзакциями, а открывать базу на каждый запрос значит терять WAL и
  // получать чужой снимок посреди read-modify-write.
  const sessionDb = graph !== undefined && curriculumSynchronized ? tryOpenSession() : undefined;
  if (graph !== undefined && sessionDb !== undefined) {
    registerSessionRoutes(app, { ...options, db: sessionDb, graph });
    app.addHook('onClose', () => {
      sessionDb.close();
    });
  } else {
    registerUnavailableSession(
      app,
      graph === undefined ? 'карта тем не загружена' : 'база недоступна',
    );
  }

  // `status` выводится из проверки базы, а не из факта «маршрут ответил»:
  // здоровье читают ровно тогда, когда что-то сломалось, и зелёный статус над
  // «database: error» ввёл бы в заблуждение именно в этот момент.
  app.get('/api/health', (_request, reply) => {
    let database = checkDatabase();
    if (graph !== undefined) {
      // Исправную базу синхронизируем всегда: файл могли заменить под живым
      // процессом. Но исчезнувшую после успешного старта базу не создаём заново
      // — потеря прогресса должна остаться красным health. Повторная попытка
      // создать базу нужна только для восстановления после ошибки старта.
      const synchronized = database === 'ok' || !curriculumSynchronized
        ? trySyncCurriculum()
        : false;
      database = synchronized ? checkDatabase() : 'error';
    }
    const status: DatabaseStatus = database === 'ok' && curriculum === 'ok' ? 'ok' : 'error';

    return reply
      .code(status === 'ok' ? 200 : 503)
      .send({
        status,
        version: readVersion(),
        database,
        curriculum,
      });
  });

  return app;
}

const isDirectRun = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const app = buildServer();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ host: HOST, port });
  console.log(`edukator слушает http://${HOST}:${port}`);
}
