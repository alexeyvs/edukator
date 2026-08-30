/**
 * Контракт `scripts/admin-client.ts` с настоящими маршрутами.
 *
 * `tests/admin-client.test.ts` подменяет `fetch` целиком, и мимо него проходит
 * ровно то, что клиент делает своими руками: разбор `Set-Cookie`, сборка
 * многочастного тела (граница, тип содержимого, имя поля, которое читает
 * `request.file()`), коды 201 и 202 и совпадение путей. Цена наглядна — план
 * ветки ошибся и в статусе задания сборки, и в форме статуса источника, и
 * поймано это было чтением серверного кода, а не тестом.
 *
 * Поэтому сервер здесь настоящий, поднятый `buildServer` на `port: 0`, и клиент
 * ходит в него по сети. Петля предусмотрена самим сервером: `isSameOrigin`
 * пропускает голый http на loopback, а `__Host-`-cookie браузер там принимает и
 * без TLS, так что `Secure` не снимается — клиент обязан разобрать cookie ровно
 * в том виде, в каком её отдаёт прод.
 *
 * Внешнего у прогона нет ничего: OCR подменён `OcrRunner`, codex — `run` внутри
 * `buildCourseDraft`, проверка PDF — `inspector` хранилища. Тем же приёмом это
 * делают `tests/admin-course-sources-routes.test.ts` и `e2e/harness.ts`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAdminClient, type AdminClient } from '../scripts/admin-client.js';
import { buildServer } from '../server/index.js';
import { openControlDatabase } from '../server/control-db.js';
import { controlDatabasePath, ensureDataDir } from '../server/data-dir.js';
import { CourseArtifactStore } from '../server/course-artifacts.js';
import { buildCourseDraft } from '../server/course-drafting.js';
import type { OcrRunner } from '../server/ocr-runner.js';
import { createAdminAccount, recordingFailureLog, type HarnessAdmin } from './server-harness.js';

const PDF = Buffer.from('%PDF-1.7\nкусок программы\n%%EOF\n');
const COURSE = 'frp-geografiya-5';

/** Одна тема на страницу: `validateReferences` не пропустит выдуманные номера. */
const TOPICS = ['Географическая карта', 'Материки и океаны', 'Оболочки Земли'];

const sleep = async (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Опрос очереди с потолком попыток. Своего срока у теста быть не может: пауза
 * ожидания живёт в `scripts/import-frp.ts`, а здесь проверяется клиент.
 */
async function until<T>(step: () => Promise<T | undefined>, what: string): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await step();
    if (value !== undefined) return value;
    await sleep(25);
  }
  throw new Error(`не дождались: ${what}`);
}

describe('admin-client против настоящего сервера', () => {
  let dir: string;
  let control: Database;
  let app: FastifyInstance;
  let client: AdminClient;
  let admin: HarnessAdmin;
  let pdfPath: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'edukator-admin-client-http-'));
    ensureDataDir(dir);
    const webDist = join(dir, 'dist');
    mkdirSync(webDist);
    writeFileSync(join(webDist, 'index.html'), '<h1>Собранный интерфейс</h1>');
    pdfPath = join(dir, 'geografiya-5.pdf');
    writeFileSync(pdfPath, PDF);

    control = openControlDatabase(controlDatabasePath(dir));
    admin = createAdminAccount(control);

    const runner: OcrRunner = {
      checkDependencies: async () => undefined,
      processPage: async ({ pageNumber }) => ({
        text: `Страница ${String(pageNumber)}. Материки, океаны и оболочки Земли.`,
        image: Buffer.from(`страница-${String(pageNumber)}`),
      }),
      stop: async () => undefined,
    };

    app = buildServer(undefined, {
      dataDir: dir,
      worker: false,
      webDist,
      failures: recordingFailureLog(),
      catalogWorker: { runner, autoPollMs: 5 },
      courseArtifacts: new CourseArtifactStore(control, dir, {
        // Настоящая проверка зовёт qpdf; на машине разработчика его может не
        // быть вовсе, а проверяется здесь не она.
        inspector: { inspect: async () => ({ pageCount: TOPICS.length }) },
      }),
      catalogDraftBuilder: (input) => buildCourseDraft({
        ...input,
        attempts: 1,
        run: async ({ prompt }) => {
          if (prompt.startsWith('Составь краткий фактологический конспект')) {
            return JSON.stringify({ summary: 'Материки, океаны и оболочки Земли.' });
          }
          const sourceId = Number(control.prepare<[], { id: number }>(
            'SELECT id FROM course_sources ORDER BY id DESC LIMIT 1',
          ).get()?.id);
          return JSON.stringify({
            topics: TOPICS.map((title, index) => ({
              client_id: `topic-${String(index + 1)}`,
              existing_id: null,
              title,
              exam_weight: 3,
              difficulty: index % 3 + 1,
              prereqs: index === 0 ? [] : [`topic-${String(index)}`],
              answer_format: 'text',
              prompt_seed: `Спрашивай про раздел «${title}».`,
              source_refs: [{ source_id: sourceId, page_from: index + 1, page_to: index + 1 }],
            })),
          });
        },
      }),
    });
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    client = createAdminClient(url);
  });

  afterEach(async () => {
    await app.close();
    control.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('проходит вход, курс, источник, сборку и публикацию по сети', async () => {
    // Вход: настоящий `Set-Cookie` со всеми атрибутами прода. Разобрать его —
    // работа клиента, и подменённый `fetch` эту работу делал за него.
    await client.login(admin.email, admin.password);

    // 201 и тело с курсом и черновиком.
    const created = await client.createCourse({
      id: COURSE, title: 'География', grade: '5 класс',
    });
    expect(created.course.id).toBe(COURSE);
    // Рядом лежат три legacy-курса, заведённые стартом сервера: список
    // прочитан целиком, а свой курс ищется в нём по идентификатору.
    const listed = await client.listCourses();
    expect(listed.find((item) => item.id === COURSE))
      .toMatchObject({ title: 'География', grade: '5 класс', activeRevisionId: null });

    // Многочастное тело собирает сам клиент: имя поля `source`, тип
    // `application/pdf` и граница обязаны совпасть с тем, что читает
    // `request.file()`, иначе маршрут отвечает «PDF-файл не передан».
    const uploaded = await client.uploadSource(COURSE, pdfPath);
    expect(uploaded.duplicate).toBe(false);
    expect(uploaded.source.revisionId).toBe(created.draft.id);

    const ready = await until(async () => {
      const status = await client.sourceStatus(COURSE, uploaded.source.id);
      return status.sourceStatus === 'pending' || status.sourceStatus === 'processing'
        ? undefined
        : status;
    }, 'OCR источника');
    // Форма ответа настоящая: `sourceStatus` рядом с `job` и `pages`. Именно на
    // ней ошибся план, и подменённый `fetch` ошибку повторил бы.
    expect(ready.sourceStatus).toBe('ready');
    expect(ready.job?.status).toBe('succeeded');
    expect(ready.pages).toHaveLength(TOPICS.length);
    expect(await client.listSources(COURSE)).toMatchObject([
      { id: uploaded.source.id, status: 'ready', pageCount: TOPICS.length },
    ]);

    // 202 и задание, видимое отдельным запросом.
    await client.startBuild(COURSE, created.draft.id, created.draft.editVersion);
    const build = await until(async () => {
      const status = await client.buildStatus(COURSE);
      return status.job === null || status.job.status === 'running' ? undefined : status;
    }, 'сборку черновика');
    expect(build.job?.status).toBe('succeeded');

    const draft = await client.readDraft(COURSE);
    expect(draft?.topics.map((topic) => topic.title)).toEqual(TOPICS);

    await client.publish(
      COURSE,
      draft?.revision.id as number,
      draft?.revision.editVersion as number,
      `import-frp:${COURSE}`,
    );
    const card = await client.readCourse(COURSE);
    expect(card?.course.activeRevisionId).toBe(created.draft.id);
    expect(card?.revisions.find((item) => item.id === created.draft.id)?.topics)
      .toHaveLength(TOPICS.length);
  });

  it('черновика у свежего курса нет — это состояние, а не поломка', async () => {
    await client.login(admin.email, admin.password);
    // 404 обязан прийти как `undefined`: курс без черновика — обычный ход
    // прогона, и ошибкой он остановил бы импорт на первом же предмете.
    // Идентификатор годный, курса нет: маршрут отвечает 404, а не 400 — иначе
    // проверялась бы форма запроса, а не разбор состояния.
    expect(await client.readCourse('frp-geografiya-9')).toBeUndefined();
    expect(await client.readDraft(COURSE)).toBeUndefined();
  });

  it('вход с неверным паролем не выдаёт cookie и отказывает', async () => {
    await expect(client.login(admin.email, 'пароль-совсем-другой-длинный'))
      .rejects.toThrow();
    // Отказ входа обязан быть отказом клиента: с непроставленной cookie первая
    // же операция упёрлась бы в 401, и виноватым был бы назван не вход.
    await expect(client.listCourses()).rejects.toThrow();
  });
});
