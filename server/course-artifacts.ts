import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  statSync,
} from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import type { Database } from 'better-sqlite3';
import { syncDirectory } from './atomic-write.js';
import { CatalogNotFoundError, PublishedRevisionError } from './course-catalog.js';
import { requireCourseId, type CourseId } from './db.js';

export const CATALOG_DIR = 'catalog';
export const CATALOG_ARTIFACTS_DIR = `${CATALOG_DIR}/artifacts`;
export const CATALOG_TEMP_DIR = `${CATALOG_DIR}/tmp`;
export const CATALOG_MANIFEST_FILE = `${CATALOG_DIR}/manifest.json`;
export const DEFAULT_PDF_MAX_BYTES = 100 * 1024 * 1024;
export const DEFAULT_PDF_MAX_PAGES = 2_000;
export const UPLOAD_NAME_MAX_LENGTH = 255;

const execFileAsync = promisify(execFile);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export class ArtifactValidationError extends Error {}
export class ArtifactTooLargeError extends ArtifactValidationError {}
export class ArtifactStorageError extends Error {}
export class ArtifactNotFoundError extends Error {}

export interface PdfInspection {
  pageCount: number;
}

export interface PdfInspector {
  inspect(path: string): Promise<PdfInspection>;
}

export class QpdfInspector implements PdfInspector {
  constructor(private readonly binary = 'qpdf') {}

  async inspect(path: string): Promise<PdfInspection> {
    try {
      await execFileAsync(this.binary, ['--check', path], {
        timeout: 30_000,
        maxBuffer: 256 * 1024,
      });
      const result = await execFileAsync(this.binary, ['--show-npages', path], {
        timeout: 30_000,
        maxBuffer: 16 * 1024,
      });
      const pageCount = Number(result.stdout.trim());
      if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
        throw new ArtifactValidationError('qpdf вернул некорректное число страниц');
      }
      return { pageCount };
    } catch (error) {
      if (error instanceof ArtifactValidationError) throw error;
      const cause = error as NodeJS.ErrnoException & { stderr?: string };
      if (cause.code === 'ENOENT') {
        throw new ArtifactStorageError('qpdf не установлен: проверка PDF недоступна');
      }
      const detail = cause.stderr?.trim();
      throw new ArtifactValidationError(
        detail === undefined || detail === '' ? 'qpdf отклонил структуру PDF' : `qpdf отклонил PDF: ${detail}`,
      );
    }
  }
}

export interface CourseSource {
  id: number;
  courseId: CourseId;
  revisionId: number;
  uploadName: string;
  sha256: string;
  pageCount: number | null;
  status: 'uploaded' | 'processing' | 'ready' | 'failed';
  error: string | null;
  createdAt: string;
}

interface SourceRow {
  id: number;
  course_id: string;
  revision_id: number;
  upload_name: string;
  sha256: string;
  artifact_path: string;
  page_count: number | null;
  status: CourseSource['status'];
  error: string | null;
  created_at: string;
}

interface RevisionRow {
  id: number;
  course_id: string;
  status: 'draft' | 'published';
}

function sourceFromRow(row: SourceRow): CourseSource {
  return {
    id: row.id,
    courseId: row.course_id,
    revisionId: row.revision_id,
    uploadName: row.upload_name,
    sha256: row.sha256,
    pageCount: row.page_count,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
  };
}

function canonicalUploadName(value: string): string {
  if (value.includes('\0')) throw new ArtifactValidationError('Имя файла содержит запрещённый символ');
  const normalized = basename(value.replaceAll('\\', '/')).trim();
  if (normalized === '' || normalized.length > UPLOAD_NAME_MAX_LENGTH) {
    throw new ArtifactValidationError(`Имя файла должно содержать до ${UPLOAD_NAME_MAX_LENGTH} символов`);
  }
  return normalized;
}

function requireDraft(db: Database, courseId: CourseId, revisionId: number): RevisionRow {
  const row = db.prepare<[number], RevisionRow>('SELECT id, course_id, status FROM course_revisions WHERE id = ?')
    .get(revisionId);
  if (row === undefined || row.course_id !== courseId) {
    throw new CatalogNotFoundError(`Черновик ${revisionId} курса «${courseId}» не найден`);
  }
  if (row.status !== 'draft') throw new PublishedRevisionError(`Опубликованная редакция ${revisionId} неизменяема`);
  return row;
}

function currentDraft(db: Database, courseId: CourseId): RevisionRow {
  const row = db.prepare<[string], RevisionRow>(
    "SELECT id, course_id, status FROM course_revisions WHERE course_id = ? AND status = 'draft'",
  ).get(courseId);
  if (row === undefined) throw new CatalogNotFoundError(`У курса «${courseId}» нет черновика`);
  return row;
}

/** Resolves a catalog-relative path and rejects absolute paths and escapes. */
export function resolveCatalogPath(dataDir: string, storedPath: string): string {
  if (storedPath === '' || storedPath.startsWith('/') || storedPath.includes('\\')) {
    throw new ArtifactStorageError('Некорректный путь артефакта');
  }
  const root = resolve(dataDir);
  const full = resolve(root, storedPath);
  if (full === root || !full.startsWith(`${root}${sep}`)) {
    throw new ArtifactStorageError('Путь артефакта выходит из каталога данных');
  }
  return full;
}

function artifactRelativePath(courseId: CourseId, revisionId: number, sha256: string): string {
  return `${CATALOG_ARTIFACTS_DIR}/${courseId}/${revisionId}/${sha256}.pdf`;
}

function syncFile(path: string): void {
  const handle = openSync(path, 'r');
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

export interface CourseArtifactStoreOptions {
  inspector?: PdfInspector;
  maxBytes?: number;
  maxPages?: number;
  now?: () => Date;
  /** Test seam for simulating a failure after the durable temporary write. */
  beforeCommit?: (tempPath: string) => void | Promise<void>;
}

export class CourseArtifactStore {
  readonly maxBytes: number;
  readonly maxPages: number;
  private readonly inspector: PdfInspector;
  private readonly now: () => Date;
  private readonly beforeCommit: ((tempPath: string) => void | Promise<void>) | undefined;

  constructor(
    private readonly db: Database,
    private readonly dataDir: string,
    options: CourseArtifactStoreOptions = {},
  ) {
    this.inspector = options.inspector ?? new QpdfInspector();
    this.maxBytes = options.maxBytes ?? DEFAULT_PDF_MAX_BYTES;
    this.maxPages = options.maxPages ?? DEFAULT_PDF_MAX_PAGES;
    this.now = options.now ?? (() => new Date());
    this.beforeCommit = options.beforeCommit;
  }

  list(courseId: CourseId): CourseSource[] {
    requireCourseId(courseId);
    const course = this.db.prepare<[string], { id: string }>('SELECT id FROM courses WHERE id = ?').get(courseId);
    if (course === undefined) throw new CatalogNotFoundError(`Курс «${courseId}» не найден`);
    return this.db.prepare<[string], SourceRow>(
      `SELECT * FROM course_sources WHERE course_id = ? ORDER BY revision_id DESC, id`,
    ).all(courseId).map(sourceFromRow);
  }

  async uploadToCurrentDraft(
    courseId: CourseId,
    uploadName: string,
    input: Readable,
  ): Promise<{ source: CourseSource; duplicate: boolean }> {
    requireCourseId(courseId);
    const revision = currentDraft(this.db, courseId);
    return this.upload(courseId, revision.id, uploadName, input);
  }

  async upload(
    courseId: CourseId,
    revisionId: number,
    uploadName: string,
    input: Readable,
  ): Promise<{ source: CourseSource; duplicate: boolean }> {
    requireCourseId(courseId);
    requireDraft(this.db, courseId, revisionId);
    const safeName = canonicalUploadName(uploadName);
    const tempRoot = resolveCatalogPath(this.dataDir, CATALOG_TEMP_DIR);
    await mkdir(tempRoot, { recursive: true });
    const tempPath = resolve(tempRoot, `${randomUUID()}.upload.tmp`);
    const handle = await open(tempPath, 'wx', 0o600);
    const hash = createHash('sha256');
    let bytes = 0;
    let signature = Buffer.alloc(0);
    try {
      for await (const raw of input) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
        bytes += chunk.length;
        if (bytes > this.maxBytes) {
          throw new ArtifactTooLargeError(`PDF превышает предел ${this.maxBytes} байт`);
        }
        if (signature.length < 5) {
          signature = Buffer.concat([signature, chunk.subarray(0, 5 - signature.length)]);
        }
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
          if (bytesWritten < 1) throw new ArtifactStorageError('Не удалось полностью записать PDF');
          offset += bytesWritten;
        }
      }
      if ((input as Readable & { truncated?: boolean }).truncated === true) {
        throw new ArtifactTooLargeError(`PDF превышает предел ${this.maxBytes} байт`);
      }
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
    await handle.close();

    let moved = false;
    let targetPath: string | undefined;
    try {
      if (!signature.equals(Buffer.from('%PDF-'))) {
        throw new ArtifactValidationError('Файл не начинается с сигнатуры %PDF-');
      }
      const inspection = await this.inspector.inspect(tempPath);
      if (!Number.isSafeInteger(inspection.pageCount) || inspection.pageCount < 1) {
        throw new ArtifactValidationError('PDF не содержит корректного числа страниц');
      }
      if (inspection.pageCount > this.maxPages) {
        throw new ArtifactValidationError(`PDF содержит больше ${this.maxPages} страниц`);
      }
      const sha256 = hash.digest('hex');
      const existing = this.db.prepare<[number, string], SourceRow>(
        'SELECT * FROM course_sources WHERE revision_id = ? AND sha256 = ?',
      ).get(revisionId, sha256);
      if (existing !== undefined) {
        if (!existsSync(resolveCatalogPath(this.dataDir, existing.artifact_path))) {
          throw new ArtifactStorageError(`Артефакт источника ${existing.id} отсутствует на диске`);
        }
        return { source: sourceFromRow(existing), duplicate: true };
      }
      if (this.beforeCommit !== undefined) await this.beforeCommit(tempPath);
      requireDraft(this.db, courseId, revisionId);
      const storedPath = artifactRelativePath(courseId, revisionId, sha256);
      targetPath = resolveCatalogPath(this.dataDir, storedPath);
      await mkdir(dirname(targetPath), { recursive: true });
      await rename(tempPath, targetPath);
      moved = true;
      syncDirectory(targetPath);
      const sourceId = this.db.transaction((): number => {
        requireDraft(this.db, courseId, revisionId);
        return Number(this.db.prepare(
          `INSERT INTO course_sources
             (course_id, revision_id, upload_name, sha256, artifact_path, page_count, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'uploaded', ?)`,
        ).run(
          courseId,
          revisionId,
          safeName,
          sha256,
          storedPath,
          inspection.pageCount,
          this.now().toISOString(),
        ).lastInsertRowid);
      }).immediate();
      const row = this.db.prepare<[number], SourceRow>('SELECT * FROM course_sources WHERE id = ?').get(sourceId);
      if (row === undefined) throw new ArtifactStorageError('Загруженный источник не найден после записи');
      return { source: sourceFromRow(row), duplicate: false };
    } finally {
      if (!moved) await rm(tempPath, { force: true }).catch(() => undefined);
      // A DB failure after rename must not leave an unreferenced file that looks committed.
      if (moved && targetPath !== undefined) {
        const referenced = this.db.prepare<[string], { count: number }>(
          'SELECT COUNT(*) AS count FROM course_sources WHERE artifact_path = ?',
        ).get(relative(resolve(this.dataDir), targetPath).split(sep).join('/'))?.count ?? 0;
        if (referenced === 0) await rm(targetPath, { force: true }).catch(() => undefined);
      }
    }
  }

  async remove(courseId: CourseId, sourceId: number): Promise<CourseSource> {
    requireCourseId(courseId);
    const row = this.db.prepare<[number], SourceRow>('SELECT * FROM course_sources WHERE id = ?').get(sourceId);
    if (row === undefined || row.course_id !== courseId) throw new ArtifactNotFoundError('Источник не найден');
    requireDraft(this.db, courseId, row.revision_id);
    const sourcePath = resolveCatalogPath(this.dataDir, row.artifact_path);
    const trashRoot = resolveCatalogPath(this.dataDir, CATALOG_TEMP_DIR);
    await mkdir(trashRoot, { recursive: true });
    const trashPath = resolve(trashRoot, `${randomUUID()}.delete.tmp`);
    let moved = false;
    if (existsSync(sourcePath)) {
      await rename(sourcePath, trashPath);
      moved = true;
      syncDirectory(sourcePath);
      syncDirectory(trashPath);
    }
    try {
      this.db.transaction(() => {
        requireDraft(this.db, courseId, row.revision_id);
        const deleted = this.db.prepare('DELETE FROM course_sources WHERE id = ?').run(sourceId);
        if (deleted.changes !== 1) throw new ArtifactNotFoundError('Источник не найден');
      }).immediate();
    } catch (error) {
      if (moved) {
        await rename(trashPath, sourcePath).catch(() => undefined);
        syncDirectory(sourcePath);
        syncDirectory(trashPath);
      }
      throw error;
    }
    if (moved) await rm(trashPath, { force: true });
    return sourceFromRow(row);
  }

  /** Removes only stale temporary files and files absent from the DB manifest. */
  async cleanupUnused(olderThan: Date): Promise<string[]> {
    const removed: string[] = [];
    const failed = this.db.prepare<[string], SourceRow>(
      `SELECT cs.*
         FROM course_sources cs
         JOIN course_revisions cr ON cr.id = cs.revision_id
        WHERE cs.status = 'failed' AND cs.created_at < ? AND cr.status = 'draft'
          AND NOT EXISTS (SELECT 1 FROM revision_topic_sources rts WHERE rts.source_id = cs.id)
          AND NOT EXISTS (SELECT 1 FROM catalog_jobs cj WHERE cj.source_id = cs.id)
        ORDER BY cs.id`,
    ).all(olderThan.toISOString());
    for (const row of failed) {
      await this.remove(row.course_id, row.id);
      removed.push(row.artifact_path);
    }
    const referenced = new Set(
      this.db.prepare<[], { artifact_path: string }>('SELECT artifact_path FROM course_sources')
        .all().map((row) => row.artifact_path),
    );
    const visit = async (storedDir: string): Promise<void> => {
      const root = resolveCatalogPath(this.dataDir, storedDir);
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries) {
        const path = resolve(root, entry.name);
        if (entry.isDirectory()) {
          await visit(relative(resolve(this.dataDir), path).split(sep).join('/'));
          continue;
        }
        if (!entry.isFile()) continue;
        const storedPath = relative(resolve(this.dataDir), path).split(sep).join('/');
        const info = await stat(path);
        const temporary = storedPath.startsWith(`${CATALOG_TEMP_DIR}/`);
        const orphan = storedPath.startsWith(`${CATALOG_ARTIFACTS_DIR}/`) && !referenced.has(storedPath);
        if ((temporary || orphan) && info.mtime < olderThan) {
          await rm(path, { force: true });
          removed.push(storedPath);
        }
      }
    };
    await visit(CATALOG_TEMP_DIR);
    await visit(CATALOG_ARTIFACTS_DIR);
    return removed.sort();
  }
}

export interface ArtifactManifestEntry {
  path: string;
  sha256: string;
  size: number;
}

export interface ArtifactManifest {
  version: 1;
  artifacts: ArtifactManifestEntry[];
}

export function sha256File(path: string): string {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const handle = openSync(path, 'r');
  try {
    for (;;) {
      const count = readSync(handle, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(handle);
  }
  return hash.digest('hex');
}

export function copyArtifactForBackup(
  sourceDataDir: string,
  targetDataDir: string,
  storedPath: string,
  expectedSha256: string,
): ArtifactManifestEntry {
  if (!SHA256_PATTERN.test(expectedSha256)) throw new ArtifactStorageError('Некорректный SHA-256 источника');
  const source = resolveCatalogPath(sourceDataDir, storedPath);
  const target = resolveCatalogPath(targetDataDir, storedPath);
  const info = lstatSync(source);
  if (!info.isFile() || info.isSymbolicLink()) throw new ArtifactStorageError(`Артефакт ${storedPath} не является файлом`);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target, constants.COPYFILE_EXCL);
  syncFile(target);
  syncDirectory(target);
  const actual = sha256File(target);
  if (actual !== expectedSha256) {
    rmSync(target, { force: true });
    throw new ArtifactStorageError(`SHA-256 артефакта ${storedPath} не совпадает с каталогом`);
  }
  return { path: storedPath, sha256: actual, size: statSync(target).size };
}

export function verifyArtifactManifest(dataDir: string, manifest: ArtifactManifest): void {
  if (manifest.version !== 1 || !Array.isArray(manifest.artifacts)) {
    throw new ArtifactStorageError('Некорректный manifest артефактов');
  }
  const paths = new Set<string>();
  for (const entry of manifest.artifacts) {
    if (paths.has(entry.path)) throw new ArtifactStorageError(`Путь ${entry.path} повторяется в manifest`);
    paths.add(entry.path);
    if (!SHA256_PATTERN.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new ArtifactStorageError(`Некорректная запись manifest для ${entry.path}`);
    }
    const path = resolveCatalogPath(dataDir, entry.path);
    const info = statSync(path);
    if (!info.isFile() || info.size !== entry.size || sha256File(path) !== entry.sha256) {
      throw new ArtifactStorageError(`Артефакт ${entry.path} не прошёл проверку manifest`);
    }
  }
}
