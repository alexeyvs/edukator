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

/** Имя курса до того, как сервер назначил идентификатор: им называют отказ. */
function courseLabel(source: FrpSource, grade: number): string {
  return source.courseId?.[String(grade)] ?? `${source.title}, ${String(grade)} класс`;
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
async function alreadyImported(
  run: Run,
  course: { id: string; activeRevisionId: number | null },
  cutSha: string,
): Promise<boolean> {
  const active = course.activeRevisionId;
  if (active === null) return false;
  const sources = await run.client.listSources(course.id);
  return sources.some((item) => item.sha256 === cutSha && item.revisionId === active);
}

/** Девять шагов прогона на один курс. Наружу не бросает: отказ — это исход. */
async function importCourse(
  run: Run,
  source: FrpSource,
  grade: number,
  documents: Map<string, Promise<Document>>,
): Promise<CourseOutcome> {
  let course = courseLabel(source, grade);
  try {
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

    // Шаг 3: взять курс из манифеста или создать. Идентификатор из манифеста
    // назван только там, где курс уже есть (`math`, `russian`, `english`);
    // остальные назначает сервер, и найти свой курс можно лишь по паре
    // «название + класс», которую этот же прогон и записал.
    const wantedId = source.courseId?.[String(grade)];
    const courses = await run.client.listCourses();
    const existing = wantedId === undefined
      ? courses.find((item) => item.title === source.title && item.grade === gradeLabel(grade))
      : courses.find((item) => item.id === wantedId);
    if (existing !== undefined) {
      course = existing.id;
      if (await alreadyImported(run, existing, cutSha)) {
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
    let previousTopicIds: string[] = [];
    if (existing === undefined) {
      const created = await run.client.createCourse({
        ...(wantedId === undefined ? {} : { id: wantedId }),
        title: source.title,
        grade: gradeLabel(grade),
      });
      course = created.course.id;
      draft = created.draft;
    } else {
      const open = await run.client.readDraft(course);
      if (open === undefined) {
        if (existing.activeRevisionId === null) {
          throw new Error(`у курса «${course}» нет ни черновика, ни активной редакции`);
        }
        await run.client.createDraft(course, existing.activeRevisionId);
      }
      // Черновик перечитывается и после создания: он заводится копией активной
      // редакции, и её темы — единственное, чем меряется сохранность прогресса
      // детей. Читать опубликованные темы напрямую нечем.
      const opened = await run.client.readDraft(course);
      if (opened === undefined) throw new Error(`черновик курса «${course}» не открылся`);
      draft = opened.revision;
      previousTopicIds = opened.topics.map((topic) => topic.id);
    }

    // Шаг 5: загрузить кусок.
    const uploaded = await run.client.uploadSource(course, cutPath);

    // Шаг 6: дождаться готовности источника.
    await awaitSource(run, course, uploaded.source.id);

    // Шаг 7: запустить сборку и дождаться её.
    let starting = true;
    if (uploaded.duplicate) {
      // Дубликат означает, что кусок загрузил прошлый прогон: сборка ему уже
      // заказана. Перезапускать её по отказавшему заданию нельзя — `buildStatus`
      // не называет номер задания, и первый же опрос после старта не отличил бы
      // новое от прежнего отказавшего, то есть прогон объявил бы отказ по
      // вчерашней причине. Отказавшая сборка называется в отчёте, и её
      // перезапускает оператор из админки.
      starting = (await run.client.buildStatus(course)).job === null;
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
      // Сохранность прогресса меряется только там, где было что терять.
      ...(previousTopicIds.length === 0 ? {} : { previousTopicIds }),
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

/** Скачивание одной программы. Живая сеть — только здесь и только в CLI. */
async function downloadToFile(url: string, target: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`скачивание ${url} отклонено кодом ${String(response.status)}`);
  }
  await writeFile(target, Buffer.from(await response.arrayBuffer()));
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
