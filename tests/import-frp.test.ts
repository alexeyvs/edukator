import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DOWNLOAD_TIMEOUT_MS, downloadToFile, frpCourseId, IMPORT_POLL_MS, IMPORT_WAIT_TIMEOUT_MS,
  importCourses, parseImportArgs, type ImportOptions,
} from '../scripts/import-frp.js';
import { readFrpManifest } from '../scripts/frp-manifest.js';
import { isCourseId } from '../server/db.js';
import { COURSE_ID_MAX_LENGTH } from '../server/routes/admin/courses.js';
import type { AdminClient } from '../scripts/admin-client.js';
import type { FrpSource } from '../scripts/frp-manifest.js';
import type { PdfTools } from '../scripts/frp-pdf.js';
import type { CourseSource } from '../server/course-artifacts.js';
import type { CatalogRevisionTopic } from '../server/course-catalog.js';

/**
 * Десять страниц: первая несёт заголовки учебного курса, раздела и класса,
 * остальные наследуют состояние — ровно так `sliceFrp` и собирает отрезок.
 * Десять, а не одна, потому что число страниц куска берётся из диапазонов
 * нарезки: на одностраничном документе ссылки тем на страницы 1–10 оказались
 * бы за границей источника, и отбраковка красила бы каждый тест подряд.
 */
const PAGES = [
  'ФЕДЕРАЛЬНАЯ РАБОЧАЯ ПРОГРАММА УЧЕБНОГО КУРСА «ГЕОГРАФИЯ»\nСОДЕРЖАНИЕ ОБУЧЕНИЯ\n5 КЛАСС\nИстория открытия Земли',
  ...Array.from({ length: 9 }, (_, index) => `Раздел ${String(index + 1)}: материки и океаны`),
];
const DOCUMENT = PAGES.join('\f');
/**
 * Отпечаток совпадает и у документа, и у куска: заглушка `qpdf` копирует вход
 * в выход, поэтому вырезанный кусок побайтно равен документу.
 */
const SHA = createHash('sha256').update(DOCUMENT).digest('hex');

const source: FrpSource = {
  subject: 'geografiya',
  title: 'География',
  level: 'ooo',
  url: 'https://edsoo.ru/wp-content/uploads/2025/07/2025_ooo_frp_geografiya-5-9.pdf',
  sha256: SHA,
  grades: [5],
};

const history: FrpSource = { ...source, subject: 'istoriya', title: 'История' };

interface Calls {
  createCourse: unknown[];
  createDraft: unknown[];
  uploadSource: unknown[];
  startBuild: unknown[];
  retrySource: unknown[];
  publish: unknown[];
}

interface CatalogCourseRow {
  id: string;
  title: string;
  grade: string;
  activeRevisionId: number | null;
}

interface FakeState {
  /** Сервер отвечает на заведение курса другим идентификатором. */
  renamesOnCreate?: boolean;
  /** Курсы, уже лежащие в каталоге оператора. */
  courses?: CatalogCourseRow[];
  /** Источники по курсам — то, что отдаёт `listSources`. */
  sources?: Record<string, CourseSource[]>;
  /** У курса уже есть незакрытый черновик прошлого прогона. */
  draft?: boolean;
  /** Темы активной редакции курса — то, что отдаёт `readCourse`. */
  activeTopics?: CatalogRevisionTopic[];
  /** Задание сборки, оставшееся от прошлого прогона. */
  staleJob?: { status: string; error: string | null };
  /** Повторная попытка OCR чинит источник. */
  ocrRetryFixes?: boolean;
  /** Загрузка источника отвечает `duplicate`. */
  duplicate?: boolean;
  /** Курсы, у которых сборка черновика заканчивается отказом. */
  buildFails?: string[];
  /** Черновик собран, но тем в нём меньше порога отбраковки. */
  thinDraft?: boolean;
  /** OCR источника отказывает с этой причиной. */
  ocrError?: string;
}

let dir: string;
let calls: Calls;
let tools: PdfTools;

function stub(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function courseSource(overrides: Partial<CourseSource> = {}): CourseSource {
  return {
    id: 1,
    courseId: 'frp-geografiya-5',
    revisionId: 7,
    uploadName: `${SHA}-5.pdf`,
    sha256: SHA,
    pageCount: 10,
    status: 'ready',
    error: null,
    createdAt: '2026-08-30T00:00:00.000Z',
    ...overrides,
  };
}

function draftTopics(state: FakeState): CatalogRevisionTopic[] {
  return Array.from({ length: state.thinDraft === true ? 2 : 10 }, (_, index) => ({
    id: `topic-${String(index + 1)}`,
    title: `Тема ${String(index + 1)}`,
    examWeight: 2,
    difficulty: 2,
    prereqs: [],
    answerFormat: 'number' as const,
    promptSeed: 'Генерируй задания',
    active: true,
    position: index,
    sourceRefs: [{ sourceId: 1, pageFrom: index + 1, pageTo: index + 1 }],
  }));
}

function fakeClient(state: FakeState = {}): AdminClient {
  // Черновик у курса либо остался от прошлого прогона, либо заводится этим:
  // второй черновик курсу запрещён, и `readDraft` обязан это отражать.
  let hasDraft = state.draft === true;
  // Состояние источника и задания сборки живёт между запросами: повторная
  // попытка OCR и перезапуск сборки только так и проверяются.
  let sourceReady = state.ocrError === undefined;
  let job: { status: string; error: string | null } | null = state.staleJob ?? null;
  return {
    login: async () => undefined,
    listCourses: async () => state.courses ?? [],
    listSources: async (courseId) => state.sources?.[courseId] ?? [],
    readCourse: async (courseId) => {
      const course = (state.courses ?? []).find((item) => item.id === courseId);
      if (course === undefined) return undefined;
      return {
        course: {
          id: course.id,
          title: course.title,
          grade: course.grade,
          status: 'published' as const,
          activeRevisionId: course.activeRevisionId,
          createdAt: '2026-08-30T00:00:00.000Z',
          updatedAt: '2026-08-30T00:00:00.000Z',
          archivedAt: null,
        },
        revisions: course.activeRevisionId === null ? [] : [{
          id: course.activeRevisionId,
          courseId: course.id,
          revisionNumber: 1,
          status: 'published' as const,
          basedOnRevisionId: null,
          editVersion: 1,
          title: course.title,
          grade: course.grade,
          publishedBy: 'admin-1',
          createdAt: '2026-08-30T00:00:00.000Z',
          publishedAt: '2026-08-30T00:00:00.000Z',
          topics: state.activeTopics ?? draftTopics(state),
        }],
      };
    },
    createCourse: async (input) => {
      calls.createCourse.push(input);
      hasDraft = true;
      // Идентификатор курса называет запрос, а не сервер: маршрут
      // `POST /api/admin/courses` принимает `id` и заводит курс под ним.
      if (input.id === undefined) throw new Error('курс заведён без идентификатора');
      const id = state.renamesOnCreate === true ? `иной-${input.id}` : input.id;
      return { course: { id }, draft: { id: 1, editVersion: 1 } };
    },
    createDraft: async (courseId, activeRevisionId) => {
      calls.createDraft.push({ courseId, activeRevisionId });
      hasDraft = true;
      return { revision: { id: 2, editVersion: 1 } };
    },
    readDraft: async () => (hasDraft
      ? { revision: { id: 2, editVersion: 3 }, topics: draftTopics(state) }
      : undefined),
    uploadSource: async (courseId, filePath) => {
      calls.uploadSource.push({ courseId, filePath });
      return { source: { id: 1, revisionId: 2 }, duplicate: state.duplicate === true };
    },
    // Настоящая форма ответа маршрута: готовность читается из `sourceStatus`,
    // причина отказа — из `job.error`. Список `pages` пуст намеренно — число
    // страниц куска обязано происходить из диапазонов нарезки, а не отсюда.
    sourceStatus: async (_courseId, sourceId) => (sourceReady
      ? {
        sourceId,
        sourceStatus: 'ready',
        job: { id: 1, status: 'succeeded' as const, attempts: 1, currentPage: null, error: null },
        pages: [],
      }
      : {
        sourceId,
        sourceStatus: 'failed',
        job: { id: 1, status: 'failed' as const, attempts: 1, currentPage: 3, error: state.ocrError ?? null },
        pages: [],
      }),
    retrySource: async (courseId, sourceId) => {
      calls.retrySource.push({ courseId, sourceId });
      if (state.ocrRetryFixes === true) sourceReady = true;
    },
    startBuild: async (courseId, revisionId, editVersion) => {
      calls.startBuild.push({ courseId, revisionId, editVersion });
      job = (state.buildFails ?? []).includes(courseId)
        ? { status: 'failed', error: 'модель не ответила' }
        : { status: 'succeeded', error: null };
    },
    buildStatus: async () => ({ revisionId: 2, job }),
    publish: async (courseId, revisionId, editVersion, idempotencyKey) => {
      calls.publish.push({ courseId, revisionId, editVersion, idempotencyKey });
      return {};
    },
  };
}

function options(state: FakeState = {}, overrides: Partial<ImportOptions> = {}): ImportOptions {
  return {
    client: fakeClient(state),
    sources: [source],
    cacheDir: dir,
    download: async (_url, target) => { writeFileSync(target, DOCUMENT); },
    tools,
    // Опрос очереди в миллисекундах: на боевых паузах тест ветки «не дождались»
    // шёл бы минутами.
    pollMs: 1,
    waitTimeoutMs: 20,
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'import-frp-'));
  calls = {
    createCourse: [], createDraft: [], uploadSource: [], startBuild: [], retrySource: [], publish: [],
  };
  tools = {
    // `pdftotext -layout <файл> -`: заглушка печатает файл как есть, документ
    // в тесте — уже текст с разделителями страниц.
    pdftotext: stub('pdftotext', 'cat "$2"'),
    // Вход — аргумент сразу после `--pages`, выход — последний: так заглушка
    // переживает добавление любого флага перед списком страниц.
    qpdf: stub('qpdf', [
      'prev=""; inp=""; out=""',
      'for a in "$@"; do',
      '  if [ "$prev" = "--pages" ]; then inp="$a"; fi',
      '  prev="$a"; out="$a"',
      'done',
      'cp "$inp" "$out"',
    ].join('\n')),
  };
});

describe('importCourses', () => {
  it('публикует курс класса из документа уровня', async () => {
    const report = await importCourses(options());
    expect(report.published).toEqual(['frp-geografiya-5']);
    expect(report.failed).toEqual([]);
    expect(calls.publish).toHaveLength(1);
    // Публикуется та редакция и та версия, которые вернул черновик после
    // сборки: сборка меняет `edit_version`, и сохранённая до неё дала бы 409.
    expect(calls.publish[0]).toMatchObject({ courseId: 'frp-geografiya-5', revisionId: 2, editVersion: 3 });
  });

  it('отказ одного курса не отменяет остальные', async () => {
    const report = await importCourses(options({ buildFails: ['frp-istoriya-5'] }, {
      sources: [source, history],
    }));
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]?.course).toBe('frp-istoriya-5');
    expect(report.failed[0]?.reason).toMatch(/модель не ответила/u);
    // Свойство, ради которого тест написан: сосед по прогону доведён до
    // публикации, а не брошен вместе с отказавшим.
    expect(report.published).toEqual(['frp-geografiya-5']);
  });

  it('повторный прогон на опубликованном курсе не создаёт ни черновика, ни источника', async () => {
    const report = await importCourses(options({
      courses: [{ id: 'frp-geografiya-5', title: 'География', grade: '5 класс', activeRevisionId: 7 }],
      sources: { 'frp-geografiya-5': [courseSource({ revisionId: 7 })] },
    }));
    expect(report.skipped).toContain('frp-geografiya-5');
    expect(calls.createDraft).toHaveLength(0);
    expect(calls.uploadSource).toHaveLength(0);
    expect(calls.publish).toHaveLength(0);
  });

  it('брошенный черновик с тем же отпечатком не считается готовым курсом', async () => {
    // Тот же отпечаток, но источник висит на черновике (редакция 8), а активна
    // седьмая: прошлый прогон умер между загрузкой и публикацией. Без сверки
    // номера редакции курс считался бы готовым и остался бы неопубликованным
    // навсегда.
    const report = await importCourses(options({
      draft: true,
      courses: [{ id: 'frp-geografiya-5', title: 'География', grade: '5 класс', activeRevisionId: 7 }],
      sources: { 'frp-geografiya-5': [courseSource({ revisionId: 8 })] },
    }));
    expect(report.skipped).toEqual([]);
    expect(report.published).toEqual(['frp-geografiya-5']);
  });

  it('legacy-курс без источников получает новую редакцию, а не пропуск', async () => {
    // `math` заведён `bootstrapLegacyCourses` из `content/curriculum`, PDF у
    // него нет вовсе — значит совпадения отпечатка нет и курс импортируется.
    const legacy: FrpSource = { ...source, courseId: { '5': 'math' } };
    const report = await importCourses(options({
      courses: [{ id: 'math', title: 'Математика', grade: '5 класс', activeRevisionId: 4 }],
      sources: { 'math': [] },
    }, { sources: [legacy] }));
    expect(report.published).toEqual(['math']);
    expect(calls.createCourse).toHaveLength(0);
    expect(calls.createDraft).toEqual([{ courseId: 'math', activeRevisionId: 4 }]);
  });

  it('источник, ответивший duplicate, не запускает вторую сборку', async () => {
    await importCourses(options({
      duplicate: true,
      staleJob: { status: 'succeeded', error: null },
    }));
    expect(calls.startBuild).toHaveLength(0);
    expect(calls.publish).toHaveLength(1);
  });

  it('dry-run не делает ни одного изменяющего запроса', async () => {
    const report = await importCourses(options({}, { dryRun: true }));
    expect(calls.createCourse).toHaveLength(0);
    expect(calls.uploadSource).toHaveLength(0);
    expect(calls.publish).toHaveLength(0);
    expect(report.published).toEqual([]);
  });

  it('subject режет прогон', async () => {
    const report = await importCourses(options({}, { subject: 'istoriya' }));
    expect(report.published).toEqual([]);
    expect(calls.createCourse).toHaveLength(0);
  });

  it('grade режет прогон', async () => {
    const report = await importCourses(options({}, { grade: 9 }));
    expect(report.published).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(calls.createCourse).toHaveLength(0);
  });

  it('несовпадение sha256 отказывает курсу и называет адрес', async () => {
    const report = await importCourses(options({}, {
      download: async (_url, target) => { writeFileSync(target, 'другой документ'); },
    }));
    expect(report.failed[0]?.reason).toMatch(/sha256/u);
    expect(report.failed[0]?.reason).toMatch(/edsoo\.ru/u);
    expect(calls.uploadSource).toHaveLength(0);
  });

  it('черновик, не прошедший отбраковку, не публикуется', async () => {
    const report = await importCourses(options({ thinDraft: true }));
    expect(calls.publish).toHaveLength(0);
    expect(report.failed[0]?.reason).toMatch(/тем/u);
  });

  it('класс без отрезков в документе отказывает курсу, а не пустым PDF', async () => {
    const report = await importCourses(options({}, {
      sources: [{ ...source, grades: [9] }],
    }));
    expect(calls.uploadSource).toHaveLength(0);
    expect(report.failed[0]?.reason).toMatch(/класс/u);
  });

  it('источник, не ставший готовым, называет причину OCR', async () => {
    const report = await importCourses(options({ ocrError: 'скан страницы 3 нечитаем' }));
    expect(calls.startBuild).toHaveLength(0);
    expect(report.failed[0]?.reason).toMatch(/скан страницы 3 нечитаем/u);
  });

  it('сохранность прогресса меряется темами активной редакции, а не черновика', async () => {
    // Прошлый прогон собрал черновик и умер до публикации, поэтому в черновике
    // лежат уже ФРП-темы. Считая прежними их, проверка сравнивала бы карту саму
    // с собой и не срабатывала бы никогда — а теряется при этом накопленный
    // `topic_state` детей на legacy-курсе.
    const legacy: FrpSource = { ...source, courseId: { '5': 'math' } };
    const report = await importCourses(options({
      draft: true,
      courses: [{ id: 'math', title: 'Математика', grade: '5 класс', activeRevisionId: 4 }],
      sources: { 'math': [courseSource({ courseId: 'math', revisionId: 8 })] },
      activeTopics: Array.from({ length: 10 }, (_, index) => ({
        ...draftTopics({})[0] as CatalogRevisionTopic,
        id: `math.legacy-${String(index + 1)}`,
      })),
    }, { sources: [legacy] }));
    expect(calls.publish).toHaveLength(0);
    expect(report.failed[0]?.reason).toMatch(/прежних тем/u);
  });

  it('отказавшая сборка прошлого прогона перезапускается, а не выдаётся за сегодняшнюю', async () => {
    const report = await importCourses(options({
      duplicate: true,
      staleJob: { status: 'failed', error: 'модель не ответила вчера' },
    }));
    expect(calls.startBuild).toHaveLength(1);
    expect(report.published).toEqual(['frp-geografiya-5']);
  });

  it('отказавший OCR прошлого прогона ставится в очередь повторно', async () => {
    // Загрузка дубликата в очередь не ставит (маршрут ставит только `!duplicate`),
    // поэтому без явной повторной попытки такой источник не обработается никогда.
    const report = await importCourses(options({
      duplicate: true,
      staleJob: { status: 'succeeded', error: null },
      ocrError: 'скан страницы 3 нечитаем',
      ocrRetryFixes: true,
    }));
    expect(calls.retrySource).toEqual([{ courseId: 'frp-geografiya-5', sourceId: 1 }]);
    expect(report.published).toEqual(['frp-geografiya-5']);
  });

  it('чужой черновик оператора не переписывается', async () => {
    // Черновик с темами, но без нашего куска, завёл человек: сборка заменила бы
    // все его темы, а публикация выложила бы результат без него.
    const report = await importCourses(options({
      draft: true,
      courses: [{ id: 'frp-geografiya-5', title: 'География', grade: '5 класс', activeRevisionId: 7 }],
      sources: { 'frp-geografiya-5': [] },
    }));
    expect(calls.uploadSource).toHaveLength(0);
    expect(report.failed[0]?.reason).toMatch(/черновик/u);
  });

  it('переименованный оператором курс опознаётся по идентификатору, а не по названию', async () => {
    // Оператор переименовал курс в админке (`PATCH /api/admin/courses/:id`).
    // Поиск по паре «название + класс» его не нашёл бы и завёл второй курс:
    // у родителя два одинаковых, различить нечем, а прогресс детей остался бы
    // на первом. Идентификаторы вечны — переименовать курс потом нечем.
    const report = await importCourses(options({
      courses: [{
        id: 'frp-geografiya-5',
        title: 'География (углублённо)',
        grade: '5 класс, второй поток',
        activeRevisionId: 7,
      }],
      sources: { 'frp-geografiya-5': [courseSource({ revisionId: 7 })] },
    }));
    expect(calls.createCourse).toEqual([]);
    expect(report.skipped).toEqual(['frp-geografiya-5']);
  });

  it('новый курс заводится под детерминированным идентификатором', async () => {
    await importCourses(options());
    expect(calls.createCourse).toEqual([
      { id: 'frp-geografiya-5', title: 'География', grade: '5 класс' },
    ]);
  });

  it('курс, заведённый сервером под другим именем, отказывает прогону', async () => {
    // Такого курса следующий прогон не найдёт: он ищет ровно по названному
    // идентификатору, а молчаливое согласие оставило бы дубль навсегда.
    const report = await importCourses(options({ renamesOnCreate: true }));
    expect(calls.publish).toHaveLength(0);
    expect(report.failed[0]?.reason).toMatch(/иной-frp-geografiya-5/u);
  });

  it('документ качается один раз на все классы уровня', async () => {
    let downloads = 0;
    await importCourses(options({}, {
      sources: [{ ...source, grades: [5, 5] }],
      download: async (_url, target) => { downloads += 1; writeFileSync(target, DOCUMENT); },
    }));
    expect(downloads).toBe(1);
  });
});

describe('frpCourseId', () => {
  it('собирает идентификатор из предмета и класса', () => {
    // Число вписано руками: собранное из той же функции ожидание пережило бы
    // подмену правила, а идентификатор, розданный первым прогоном, вечен.
    expect(frpCourseId(source, 5)).toBe('frp-geografiya-5');
  });

  it('legacy-курс называется именем манифеста, а не приставкой', () => {
    expect(frpCourseId({ ...source, courseId: { '5': 'math' } }, 5)).toBe('math');
  });

  it('идентификаторы всех курсов манифеста годятся серверу', () => {
    // Предметы с длинными именами (`russkij-yazyk`, `obshhestvoznanie`) —
    // ровно тот случай, ради которого проверка стоит: `COURSE_ID_PATTERN`
    // разрешает дефис только между непустыми отрезками, а маршрут вдобавок
    // режет по длине.
    for (const item of readFrpManifest()) {
      for (const grade of item.grades) {
        const id = frpCourseId(item, grade);
        expect(isCourseId(id)).toBe(true);
        expect(id.length).toBeLessThanOrEqual(COURSE_ID_MAX_LENGTH);
      }
    }
  });

  it('предмет, не годящийся в идентификатор, отказывает курсу', () => {
    expect(() => frpCourseId({ ...source, subject: 'ГЕО' }, 5)).toThrow(/идентификатор/u);
  });
});

describe('паузы прогона', () => {
  it('держит боевые значения опроса и срока ожидания', () => {
    // Числа вписаны руками: собранные из тех же констант, они пережили бы
    // подмену — а тесты гоняют конвейер с паузой в миллисекунду, на которой
    // боевая пауза от опечатки неотличима.
    expect(IMPORT_POLL_MS).toBe(5_000);
    expect(IMPORT_WAIT_TIMEOUT_MS).toBe(30 * 60 * 1000);
    expect(DOWNLOAD_TIMEOUT_MS).toBe(10 * 60 * 1000);
  });
});

describe('downloadToFile', () => {
  let server: Server;
  let base: string;
  /** Соединения, которым ответ не отдаётся: их закрывает `afterEach`. */
  let hanging: Array<() => void>;

  beforeEach(async () => {
    hanging = [];
    server = createServer((request, response) => {
      if (request.url === '/hang') {
        // Заголовки отданы, тело — никогда: ровно то зависшее соединение,
        // которое до срока держало ночной прогон вечно и молча.
        response.writeHead(200, { 'content-type': 'application/pdf' });
        hanging.push(() => { response.end(); });
        return;
      }
      response.writeHead(200, { 'content-type': 'application/pdf' });
      response.end('программа');
    });
    await new Promise<void>((ready) => { server.listen(0, '127.0.0.1', ready); });
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterEach(async () => {
    for (const finish of hanging) finish();
    await new Promise<void>((closed) => { server.close(() => { closed(); }); });
  });

  it('скачивает документ в указанный файл', async () => {
    const target = join(dir, 'ok.pdf');
    await downloadToFile(`${base}/frp.pdf`, target, 5_000);
    expect(readFileSync(target, 'utf8')).toBe('программа');
  });

  it('молчащее соединение отказывает по сроку, а не держит прогон вечно', async () => {
    await expect(downloadToFile(`${base}/hang`, join(dir, 'hang.pdf'), 30))
      .rejects.toThrow(/срок|timeout|abort/iu);
  });
});

describe('parseImportArgs', () => {
  it('разбирает адрес, оператора и фильтры прогона', () => {
    const args = parseImportArgs([
      '--base-url', 'https://edukator.ru', '--email', 'оператор@пример.рф',
      '--subject', 'geografiya', '--grade', '7', '--dry-run',
    ]);
    expect(args).toMatchObject({
      baseUrl: 'https://edukator.ru',
      email: 'оператор@пример.рф',
      subject: 'geografiya',
      grade: 7,
      dryRun: true,
    });
  });

  it('пароль флагом не принимается: он виден в списке процессов', () => {
    expect(() => parseImportArgs([
      '--base-url', 'https://edukator.ru', '--email', 'о@п.рф', '--password', 'hunter2',
    ])).toThrow(/списке процессов/u);
  });

  it('без адреса сервера прогон не начинается', () => {
    expect(() => parseImportArgs(['--email', 'о@п.рф'])).toThrow(/--base-url/u);
  });

  it('нечисловой класс — отказ, а не молчаливый пропуск фильтра', () => {
    expect(() => parseImportArgs([
      '--base-url', 'https://edukator.ru', '--email', 'о@п.рф', '--grade', 'семь',
    ])).toThrow(/--grade/u);
  });
});
