/**
 * Оркестратор массового импорта курсов из федеральных рабочих программ.
 *
 * Связывает готовые модули и больше ничего: нарезка живёт в `frp-outline.ts`,
 * разговор с сервером — в `admin-client.ts`, отбраковка — в `frp-review.ts`.
 * Своя копия любой из них разъехалась бы с оригиналом молча.
 *
 * Ходит по HTTP, а не пишет в `control.db` напрямую: каталог данных держит
 * замок сервера, и второй держатель замка при живом сервере невозможен — так
 * же устроены `prefetch` и `adopt`. Заодно это снимает вопрос, где брать OCR:
 * его делает сервер на Ubuntu, а скрипт запускается откуда угодно.
 *
 * В журнал аварий скрипт не пишет ничего. `LOG_EVENTS` — закрытое объединение,
 * и у каждого имени обязано быть место вызова; `backup-failed` и
 * `prefetch-failed` там потому, что их зовёт cron и кода возврата не видит
 * никто. Импорт запускают руками, каталога данных у него нет вовсе.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdminClient, type AdminClient } from './admin-client.js';
import { isCourseId } from '../server/db.js';
import type { CourseSource } from '../server/course-artifacts.js';
import { readFrpManifest, type FrpSource } from './frp-manifest.js';
import { rangesForGrade, sliceFrp, type FrpSlice, type PageRange } from './frp-outline.js';
import { cutPdf, readPdfPages, DEFAULT_PDF_TOOLS, type PdfTools } from './frp-pdf.js';
import { reviewDraft } from './frp-review.js';
import { createSecretReader } from './secret-input.js';

/** Пауза между опросами очереди OCR и сборки черновика. */
export const IMPORT_POLL_MS = 5_000;
/**
 * Общий срок ожидания одного шага. Молчащая очередь не должна держать прогон
 * вечно: за полчаса сервер успевает и распознать два десятка страниц, и собрать
 * по ним карту тем, а неответивший к этому сроку курс уезжает в `failed[]` и не
 * мешает остальным пятидесяти.
 */
export const IMPORT_WAIT_TIMEOUT_MS = 30 * 60_000;
/**
 * Срок одного скачивания. Единственное ожидание конвейера, у которого сети не
 * видно изнутри: у `runChild` срок обязателен, у опроса очередей он свой, а
 * зависшее соединение без срока держит **весь** ночной прогон вечно и молча —
 * ни отказа, ни строки в `failed[]`, ни кода возврата; утром оператор видит
 * процесс, стоящий на первом предмете. Десять минут — с запасом на сто
 * мегабайт программы по узкому каналу.
 */
export const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

export interface ImportOptions {
  client: AdminClient;
  sources: readonly FrpSource[];
  cacheDir: string;
  download: (url: string, target: string) => Promise<void>;
  subject?: string;
  grade?: number;
  dryRun?: boolean;
  log?: (line: string) => void;
  /**
   * Внешние `pdftotext` и `qpdf`. Подменяются целиком: тесты гоняют конвейер на
   * shell-заглушках, а настоящих инструментов на машине может не быть вовсе.
   */
  tools?: PdfTools;
  pollMs?: number;
  waitTimeoutMs?: number;
}

export interface ImportReport {
  published: string[];
  skipped: string[];
  failed: Array<{ course: string; reason: string }>;
}

/** Разобранный документ уровня образования: файл в кеше и отрезки классов. */
interface Document {
  path: string;
  slices: FrpSlice[];
}

/** Разрешённые настройки прогона — то же самое, но без необязательных полей. */
interface Run {
  client: AdminClient;
  cacheDir: string;
  download: ImportOptions['download'];
  dryRun: boolean;
  log: (line: string) => void;
  tools: PdfTools;
  pollMs: number;
  waitTimeoutMs: number;
}

type CourseOutcome =
  | { status: 'published' | 'skipped' | 'planned'; course: string }
  | { status: 'failed'; course: string; reason: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Приставка детерминированного идентификатора курса. Отделяет курсы импорта от
 * заведённых руками и от трёх legacy-имён (`math`, `russian`, `english`).
 */
export const FRP_COURSE_ID_PREFIX = 'frp';

/**
 * Идентификатор курса «предмет + класс».
 *
 * Считается из манифеста, а не ищется по названию: display `title` и `grade`
 * ключом не являются нигде (`CLAUDE.md`), оператор вправе переименовать курс в
 * админке — и следующий прогон, ищущий по названию, завёл бы **второй**
 * «География, 5 класс», собрал и опубликовал бы его. У родителя два одинаковых
 * курса, различить нечем, а прогресс детей остался бы на первом. Починить это
 * потом нечем: идентификаторы, розданные первым прогоном, вечны.
 *
 * `courseId` манифеста — исключение ровно для трёх legacy-курсов: они уже
 * существуют под своими именами, и приставка завела бы им дубль.
 */
export function frpCourseId(source: FrpSource, grade: number): string {
  const named = source.courseId?.[String(grade)];
  const id = named ?? `${FRP_COURSE_ID_PREFIX}-${source.subject}-${String(grade)}`;
  // Проверяется и собранный, и названный руками: манифест ведётся человеком, а
  // отказ сервера на заведении назвал бы виноватым запрос, а не строку файла.
  if (!isCourseId(id)) {
    throw new Error(
      `«${id}» не годится в идентификатор курса: ожидаются строчная латиница, цифры и ` +
        'одиночные разделители — поправьте subject или courseId в манифесте',
    );
  }
  return id;
}

/** Отображаемый класс курса. Ключом он не служит нигде — только сопоставлением. */
function gradeLabel(grade: number): string {
  return `${String(grade)} класс`;
}

async function sha256Of(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

const sleep = async (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Опрос с паузой и общим сроком. `step` возвращает `undefined`, пока ждать
 * есть чего, и бросает, если ждать больше нечего.
 */
async function pollUntil<T>(
  step: () => Promise<T | undefined>,
  timedOut: () => string,
  run: Run,
): Promise<T> {
  const deadline = Date.now() + run.waitTimeoutMs;
  for (;;) {
    const value = await step();
    if (value !== undefined) return value;
    // Срок проверяется после опроса, а не до: иначе нулевой срок отказывал бы,
    // ни разу не спросив сервер.
    if (Date.now() >= deadline) throw new Error(timedOut());
    await sleep(run.pollMs);
  }
}

/**
 * Скачивает документ в кеш и сверяет отпечаток. Файл кладётся под именем своего
 * `sha256` и переиспользуется: качать одну программу заново для каждого из пяти
 * её классов незачем.
 */
async function fetchDocument(run: Run, source: FrpSource): Promise<string> {
  await mkdir(run.cacheDir, { recursive: true });
  const target = join(run.cacheDir, `${source.sha256}.pdf`);
  if (existsSync(target) && (await sha256Of(target)) === source.sha256) return target;
  // Соседний временный файл и `rename`: оборванное скачивание не имеет права
  // остаться в кеше под именем, которое утверждает его отпечаток.
  const temp = `${target}.part`;
  await rm(temp, { force: true });
  run.log(`скачиваю ${source.url}`);
  await run.download(source.url, temp);
  const actual = await sha256Of(temp);
  if (actual !== source.sha256) {
    await rm(temp, { force: true });
    throw new Error(
      `файл по адресу ${source.url} не совпал с манифестом: sha256 ${actual} вместо ${source.sha256}. ` +
        'Похоже, вышла новая редакция программы — манифест обновляется руками',
    );
  }
  await rename(temp, target);
  return target;
}

/**
 * Документ на предмет и уровень разбирается один раз на весь прогон: в кеше
 * лежит обещание, поэтому и отказ скачивания достаётся всем классам этого
 * документа один и тот же.
 */
async function documentFor(
  run: Run,
  source: FrpSource,
  cache: Map<string, Promise<Document>>,
): Promise<Document> {
  const ready = cache.get(source.sha256);
  if (ready !== undefined) return ready;
  const started = (async (): Promise<Document> => {
    const path = await fetchDocument(run, source);
    const pages = await readPdfPages(path, run.tools);
    return { path, slices: sliceFrp(pages) };
  })();
  cache.set(source.sha256, started);
  return started;
}

/** Страниц в куске столько, сколько мы отрезали: см. `reviewDraft`. */
function pagesIn(ranges: readonly PageRange[]): number {
  return ranges.reduce((sum, range) => sum + (range.to - range.from + 1), 0);
}

/** Ждёт готовности источника; отказ OCR называет причиной из `job.error`. */
async function awaitSource(run: Run, courseId: string, sourceId: number): Promise<void> {
  let last = 'неизвестно';
  let reason: string | null = null;
  await pollUntil(
    async () => {
      const status = await run.client.sourceStatus(courseId, sourceId);
      last = status.sourceStatus;
      reason = status.job?.error ?? null;
      if (status.sourceStatus === 'ready') return true;
      if (status.sourceStatus === 'failed') {
        throw new Error(`OCR источника ${String(sourceId)} отказал: ${reason ?? 'причина не названа'}`);
      }
      return undefined;
    },
    () => `источник ${String(sourceId)} не стал готовым: состояние «${last}»` +
      (reason === null ? '' : `, ${String(reason)}`),
    run,
  );
}

/** Ждёт конца сборки черновика; отказ и отмена называют причину задания. */
async function awaitBuild(run: Run, courseId: string): Promise<void> {
  let last = 'задание ещё не заведено';
  await pollUntil(
    async () => {
      const job = (await run.client.buildStatus(courseId)).job;
      if (job === null) return undefined;
      last = job.status;
      if (job.status === 'succeeded') return true;
      // `cancelled` — остановка сервера посреди сборки. Ждать его дальше значит
      // ждать до срока того, что уже не произойдёт.
      if (job.status === 'failed' || job.status === 'cancelled') {
        throw new Error(`сборка черновика не удалась (${job.status}): ${job.error ?? 'причина не названа'}`);
      }
      return undefined;
    },
    () => `сборка черновика не закончилась: состояние «${last}»`,
    run,
  );
}

/**
 * Курс уже импортирован тогда и только тогда, когда среди его источников есть
 * наш кусок **и** он принадлежит активной редакции. Одного отпечатка мало:
 * `list` отдаёт источники черновика, когда черновик есть, — то есть прогон,
 * прерванный между загрузкой и публикацией, выглядел бы завершённым и остался
 * бы незавершённым навсегда.
 */
function alreadyImported(
  sources: readonly CourseSource[],
  activeRevisionId: number | null,
  cutSha: string,
): boolean {
  if (activeRevisionId === null) return false;
  return sources.some((item) => item.sha256 === cutSha && item.revisionId === activeRevisionId);
}

/**
 * Прежние темы читаются у **активной** редакции, а не у черновика: черновик к
 * моменту проверки уже собран — своим прогоном или прошлым, — и сравнение его
 * тем с ними же всегда даёт единицу, то есть порог `MIN_KEPT_TOPIC_IDS` не
 * срабатывал бы никогда. Курс без активной редакции защищать не от чего:
 * прогресса детей на нём ещё нет.
 */
async function publishedTopicIds(
  run: Run,
  courseId: string,
  activeRevisionId: number | null,
): Promise<string[] | undefined> {
  if (activeRevisionId === null) return undefined;
  const card = await run.client.readCourse(courseId);
  const active = card?.revisions.find((revision) => revision.id === activeRevisionId);
  return active?.topics.map((topic) => topic.id);
}

/** Девять шагов прогона на один курс. Наружу не бросает: отказ — это исход. */
async function importCourse(
  run: Run,
  source: FrpSource,
  grade: number,
  documents: Map<string, Promise<Document>>,
): Promise<CourseOutcome> {
  // Идентификатор известен до первого запроса и служит именем курса в отчёте.
  // До его вычисления курс называть нечем: манифест мог назвать негодный.
  let course = `${source.subject}, ${String(grade)} класс`;
  try {
    course = frpCourseId(source, grade);

    // Шаг 1: скачать документ уровня и сверить отпечаток.
    const document = await documentFor(run, source, documents);

    // Шаг 2: нарезать кусок «предмет + класс».
    const ranges = rangesForGrade(document.slices, grade);
    if (ranges.length === 0) {
      throw new Error(
        `в документе нет ни одного отрезка ${String(grade)} класса: ни «Содержание обучения», ` +
          'ни «Тематическое планирование» этого класса нарезка не нашла',
      );
    }
    const pages = pagesIn(ranges);
    const cutPath = join(run.cacheDir, `${source.sha256}-${String(grade)}.pdf`);
    await cutPdf(document.path, cutPath, ranges, run.tools);
    const cutSha = await sha256Of(cutPath);

    // Шаг 3: взять курс по его идентификатору или создать. Ищется только по
    // нему: название оператор вправе поменять, идентификатор — нет.
    const courses = await run.client.listCourses();
    const existing = courses.find((item) => item.id === course);
    let catalogSources: CourseSource[] = [];
    if (existing !== undefined) {
      course = existing.id;
      catalogSources = await run.client.listSources(course);
      if (alreadyImported(catalogSources, existing.activeRevisionId, cutSha)) {
        run.log(`${course}: уже собран из этого куска программы`);
        return { status: 'skipped', course };
      }
    }

    if (run.dryRun) {
      run.log(
        `${course}: ${String(pages)} страниц из ${String(ranges.length)} отрезков — ` +
          (existing === undefined ? 'завёл бы курс и опубликовал редакцию' : 'опубликовал бы новую редакцию'),
      );
      return { status: 'planned', course };
    }

    // Шаг 4: открыть черновик. Незакрытый черновик прошлого прогона
    // продолжается, а не заводится заново: второй черновик курсу запрещён.
    let draft: { id: number; editVersion: number };
    let previousTopicIds: string[] | undefined;
    if (existing === undefined) {
      const created = await run.client.createCourse({
        id: course,
        title: source.title,
        grade: gradeLabel(grade),
      });
      draft = created.draft;
    } else {
      previousTopicIds = await publishedTopicIds(run, course, existing.activeRevisionId);
      const open = await run.client.readDraft(course);
      if (open === undefined) {
        if (existing.activeRevisionId === null) {
          throw new Error(`у курса «${course}» нет ни черновика, ни активной редакции`);
        }
        await run.client.createDraft(course, existing.activeRevisionId);
        const opened = await run.client.readDraft(course);
        if (opened === undefined) throw new Error(`черновик курса «${course}» не открылся`);
        draft = opened.revision;
      } else {
        // Черновик с темами, но без нашего куска, завёл человек: сборка
        // заменила бы все его темы, а публикация выложила бы результат без
        // него. Курс уезжает в `failed[]` — это верный исход, разберётся
        // оператор.
        if (open.topics.length > 0 && !catalogSources.some((item) => item.sha256 === cutSha)) {
          throw new Error(
            `у курса «${course}» открыт черновик, собранный не этим прогоном: ` +
              'его темы были бы заменены сборкой. Разберитесь в админке',
          );
        }
        draft = open.revision;
      }
    }

    // Шаг 5: загрузить кусок.
    const uploaded = await run.client.uploadSource(course, cutPath);

    // Шаг 6: дождаться готовности источника. Загрузка дубликата в очередь OCR
    // не ставит (маршрут ставит только `!duplicate`), поэтому источник,
    // оставленный прошлым прогоном в отказе, надо переставить руками: иначе он
    // не обработается никогда, а прогон выдал бы вчерашнюю причину за
    // сегодняшнюю и курс выпадал бы из «перезапусти прогон» навсегда.
    if (uploaded.duplicate) {
      const before = await run.client.sourceStatus(course, uploaded.source.id);
      if (before.sourceStatus === 'failed') {
        run.log(`${course}: источник ${String(uploaded.source.id)} в отказе, ставлю в очередь заново`);
        await run.client.retrySource(course, uploaded.source.id);
      }
    }
    await awaitSource(run, course, uploaded.source.id);

    // Шаг 7: запустить сборку и дождаться её.
    let starting = true;
    if (uploaded.duplicate) {
      // Дубликат означает, что кусок загрузил прошлый прогон: идущей сборке
      // второй старт не нужен. А вот отказавшую и отменённую перезапускаем —
      // иначе ожидание сразу отдаёт вчерашнюю причину как сегодняшнюю. Гонки с
      // прежней строкой задания нет: `CourseDraftBuildRunner.start` зовёт
      // сборку синхронно, и она переводит задание в `running` до первого
      // `await`, то есть уже к моменту ответа 202.
      const job = (await run.client.buildStatus(course)).job;
      starting = job === null || job.status === 'failed' || job.status === 'cancelled';
    }
    if (starting) await run.client.startBuild(course, draft.id, draft.editVersion);
    await awaitBuild(run, course);

    // Шаг 8: проверить собранный черновик. Версия перечитывается: сборка
    // заменила темы и подняла `edit_version`, а сохранённая до неё дала бы 409.
    const built = await run.client.readDraft(course);
    if (built === undefined) throw new Error(`черновик курса «${course}» исчез после сборки`);
    const review = reviewDraft({
      courseId: course,
      topics: built.topics,
      source: { id: uploaded.source.id, pages },
      // Сохранность прогресса меряется только там, где было что терять:
      // у курса, который ещё ни разу не публиковался, прежних тем нет вовсе.
      ...(previousTopicIds === undefined ? {} : { previousTopicIds }),
    });
    if (!review.ok) throw new Error(`черновик не прошёл отбраковку: ${review.problems.join('; ')}`);

    // Шаг 9: опубликовать.
    await run.client.publish(course, built.revision.id, built.revision.editVersion, `import-frp:${cutSha}`);
    run.log(
      `${course}: опубликован — ${String(built.topics.length)} тем, ` +
        `покрытие ${String(Math.round(review.coverage * 100))}%`,
    );
    return { status: 'published', course };
  } catch (error) {
    return { status: 'failed', course, reason: messageOf(error) };
  }
}

/**
 * Прогон по манифесту. Курсы идут строго по одному: OCR-очередь на сервере
 * однопоточная, а `catalogCodexConcurrency` равен единице — второй поток встал
 * бы в ту же очередь, не ускорив ничего.
 *
 * Отказ одного курса прогон не отменяет: он уезжает в `failed[]` и доносится
 * кодом возврата, как у `backupDataDir` и `prefetchChildren`. Вылет наружу
 * оставил бы каталог полусобранным, а остальные предметы — незаведёнными.
 */
export async function importCourses(options: ImportOptions): Promise<ImportReport> {
  const run: Run = {
    client: options.client,
    cacheDir: options.cacheDir,
    download: options.download,
    dryRun: options.dryRun === true,
    log: options.log ?? ((): void => undefined),
    tools: options.tools ?? DEFAULT_PDF_TOOLS,
    pollMs: options.pollMs ?? IMPORT_POLL_MS,
    waitTimeoutMs: options.waitTimeoutMs ?? IMPORT_WAIT_TIMEOUT_MS,
  };
  const report: ImportReport = { published: [], skipped: [], failed: [] };
  const documents = new Map<string, Promise<Document>>();

  for (const source of options.sources) {
    if (options.subject !== undefined && source.subject !== options.subject) continue;
    for (const grade of source.grades) {
      if (options.grade !== undefined && grade !== options.grade) continue;
      const outcome = await importCourse(run, source, grade, documents);
      if (outcome.status === 'published') report.published.push(outcome.course);
      else if (outcome.status === 'skipped') report.skipped.push(outcome.course);
      else if (outcome.status === 'failed') {
        report.failed.push({ course: outcome.course, reason: outcome.reason });
        run.log(`${outcome.course}: отказ — ${outcome.reason}`);
      }
    }
  }
  return report;
}

export interface ImportArgs {
  baseUrl: string;
  email: string;
  subject?: string;
  grade?: number;
  dryRun: boolean;
  cacheDir?: string;
}

const KNOWN_FLAGS = new Set(['base-url', 'email', 'subject', 'grade', 'cache-dir', 'dry-run']);

/**
 * Разбор аргументов свой: общий `parseAccountArgs` требует `--data-dir`,
 * которого здесь нет вовсе — скрипт ходит по HTTP. Запрет секретов во флагах
 * повторяется дословно: аргументы видны в `ps` и остаются в истории оболочки.
 */
export function parseImportArgs(argv: readonly string[]): ImportArgs {
  const values = new Map<string, string>();
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? '';
    if (!flag.startsWith('--')) {
      throw new Error(
        `Аргумент №${String(index + 1)} не похож на флаг: ожидается --base-url, --email, ` +
          '--subject, --grade, --cache-dir или --dry-run. Значение не показано: им мог оказаться пароль',
      );
    }
    // Имя отделяется от значения до всякого сообщения: `--password=hunter2`
    // иначе уехал бы в текст отказа целиком, вместе с секретом.
    const equals = flag.indexOf('=');
    const name = equals < 0 ? flag.slice(2) : flag.slice(2, equals);
    const shown = `--${name}`;
    if (name === 'password' || name === 'pin') {
      throw new Error(`Секрет не передаётся флагом ${shown}: он виден в списке процессов, скрипт спросит его сам`);
    }
    if (!KNOWN_FLAGS.has(name)) throw new Error(`Неизвестный флаг: ${shown}`);
    if (name === 'dry-run') {
      if (equals >= 0) throw new Error(`Флаг ${shown} значения не принимает`);
      dryRun = true;
      continue;
    }
    if (values.has(name)) throw new Error(`Флаг ${shown} указан дважды`);
    const value = equals < 0 ? argv[index + 1] : flag.slice(equals + 1);
    if (value === undefined || value.trim() === '' || (equals < 0 && value.startsWith('--'))) {
      throw new Error(`У флага ${shown} нет значения`);
    }
    values.set(name, value);
    if (equals < 0) index += 1;
  }

  const baseUrl = values.get('base-url');
  if (baseUrl === undefined) throw new Error('Не указан --base-url: скрипт ходит на сервер по HTTP');
  const email = values.get('email');
  if (email === undefined) throw new Error('Не указан --email: без адреса оператора не войти');
  const rawGrade = values.get('grade');
  const grade = rawGrade === undefined ? undefined : Number(rawGrade);
  if (grade !== undefined && !Number.isInteger(grade)) {
    throw new Error(`У флага --grade нечисловое значение «${rawGrade ?? ''}»`);
  }
  const cacheDir = values.get('cache-dir');
  const subject = values.get('subject');
  return {
    baseUrl,
    email,
    dryRun,
    ...(subject === undefined ? {} : { subject }),
    ...(grade === undefined ? {} : { grade }),
    ...(cacheDir === undefined ? {} : { cacheDir: resolve(cacheDir) }),
  };
}

/**
 * Скачивание одной программы. Живая сеть — только здесь и только в CLI.
 *
 * Срок держит и заголовки, и тело: один `AbortSignal.timeout` уезжает в
 * `fetch`, а тело читается тем же ответом — прерванный сигналом поток
 * отказывает, а не висит.
 */
export async function downloadToFile(
  url: string,
  target: string,
  timeoutMs: number = DOWNLOAD_TIMEOUT_MS,
): Promise<void> {
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  let body: ArrayBuffer;
  try {
    response = await fetch(url, { signal });
    if (!response.ok) {
      throw new Error(`скачивание ${url} отклонено кодом ${String(response.status)}`);
    }
    body = await response.arrayBuffer();
  } catch (error) {
    // Отказ по сроку называется сроком: `TimeoutError` от `fetch` приходит
    // словами «This operation was aborted», по которым причину не узнать, а
    // отказ уезжает в `failed[]` и читается человеком утром.
    if (signal.aborted) {
      throw new Error(`скачивание ${url} не уложилось в срок ${String(timeoutMs)} мс`);
    }
    throw error;
  }
  await writeFile(target, Buffer.from(body));
}

async function main(): Promise<void> {
  const args = parseImportArgs(process.argv.slice(2));
  const reader = createSecretReader();
  let password: string;
  try {
    password = await reader.read(`Пароль оператора ${args.email}: `);
  } finally {
    // Открытый stdin держит цикл событий: без закрытия процесс не вышел бы и
    // после успешного прогона.
    reader.close();
  }

  const client = createAdminClient(args.baseUrl);
  await client.login(args.email, password);
  const report = await importCourses({
    client,
    sources: readFrpManifest(),
    cacheDir: args.cacheDir ?? mkdtempSync(join(tmpdir(), 'import-frp-')),
    download: downloadToFile,
    dryRun: args.dryRun,
    log: (line) => process.stdout.write(`${line}\n`),
    ...(args.subject === undefined ? {} : { subject: args.subject }),
    ...(args.grade === undefined ? {} : { grade: args.grade }),
  });

  process.stdout.write(
    `итог: опубликовано ${String(report.published.length)}, пропущено ${String(report.skipped.length)}, ` +
      `отказано ${String(report.failed.length)}\n`,
  );
  for (const failure of report.failed) {
    process.stderr.write(`import-frp ${failure.course}: ${failure.reason}\n`);
  }
  if (report.failed.length > 0) process.exitCode = 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: Error) => {
    process.stderr.write(`import-frp: ${error.message}\n`);
    process.exitCode = 1;
  });
}
