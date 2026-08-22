import type { Database } from 'better-sqlite3';
import { resolveCatalogPath } from './course-artifacts.js';

export const SOURCE_CHUNK_CHARS = 1_200;
export const DEFAULT_RETRIEVAL_FRAGMENTS = 8;
export const MAX_RETRIEVAL_FRAGMENTS = 16;
export const DEFAULT_RETRIEVAL_IMAGES = 4;
export const MAX_RETRIEVAL_IMAGES = 6;

export interface SourceReference {
  sourceId: number;
  pageFrom: number;
  pageTo: number;
}

export interface RetrievedSourceFragment {
  sourceId: number;
  sourceName: string;
  pageNumber: number;
  text: string;
  image?: string;
}

export interface SourceContext {
  fragments: readonly RetrievedSourceFragment[];
  images: readonly string[];
}

function bounded(value: number | undefined, fallback: number, max: number, label: string): number {
  const actual = value ?? fallback;
  if (!Number.isSafeInteger(actual) || actual < 0 || actual > max) {
    throw new RangeError(`${label}: ожидается целое число 0..${max}`);
  }
  return actual;
}

/** Rebuilds deterministic page chunks; the FTS triggers keep the contentless index in sync. */
export function indexSourcePage(
  db: Database,
  sourceId: number,
  pageNumber: number,
  text: string,
  chunkChars = SOURCE_CHUNK_CHARS,
): number {
  if (!Number.isSafeInteger(chunkChars) || chunkChars < 100) throw new RangeError('Размер фрагмента слишком мал');
  const normalized = text.replace(/\s+/gu, ' ').trim();
  return db.transaction(() => {
    db.prepare('DELETE FROM source_chunks WHERE source_id = ? AND page_number = ?').run(sourceId, pageNumber);
    if (normalized === '') return 0;
    const insert = db.prepare(
      'INSERT INTO source_chunks (source_id, page_number, chunk_number, text) VALUES (?, ?, ?, ?)',
    );
    let count = 0;
    let offset = 0;
    while (offset < normalized.length) {
      let end = Math.min(offset + chunkChars, normalized.length);
      if (end < normalized.length) {
        const boundary = normalized.lastIndexOf(' ', end);
        if (boundary > offset + Math.floor(chunkChars / 2)) end = boundary;
      }
      insert.run(sourceId, pageNumber, count, normalized.slice(offset, end));
      count += 1;
      offset = end;
      while (normalized[offset] === ' ') offset += 1;
    }
    return count;
  }).immediate();
}

function ftsQuery(query: string): string | null {
  const tokens = query.toLocaleLowerCase('ru-RU').match(/[\p{L}\p{N}]{2,}/gu)?.slice(0, 12) ?? [];
  return tokens.length === 0 ? null : tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' OR ');
}

export function retrieveCourseSources(
  db: Database,
  options: {
    revisionId: number;
    query?: string;
    topicId?: string;
    dataDir?: string;
    maxFragments?: number;
    maxImages?: number;
  },
): SourceContext {
  const maxFragments = bounded(options.maxFragments, DEFAULT_RETRIEVAL_FRAGMENTS, MAX_RETRIEVAL_FRAGMENTS, 'Фрагменты');
  const maxImages = bounded(options.maxImages, DEFAULT_RETRIEVAL_IMAGES, MAX_RETRIEVAL_IMAGES, 'Изображения');
  if (maxFragments === 0) return { fragments: [], images: [] };
  const match = ftsQuery(options.query ?? '');
  const params: Array<string | number> = [options.revisionId];
  let topicJoin = '';
  let topicWhere = '';
  if (options.topicId !== undefined) {
    topicJoin = `JOIN revision_topic_sources rts ON rts.source_id = sc.source_id
      AND sc.page_number BETWEEN rts.page_from AND rts.page_to`;
    topicWhere = 'AND rts.revision_id = ? AND rts.topic_id = ?';
    params.push(options.revisionId, options.topicId);
  }
  let ftsJoin = '';
  let rank = 'sc.source_id, sc.page_number, sc.chunk_number';
  if (match !== null) {
    ftsJoin = 'JOIN source_chunks_fts fts ON fts.rowid = sc.id';
    topicWhere += ' AND source_chunks_fts MATCH ?';
    params.push(match);
    rank = 'bm25(source_chunks_fts), sc.source_id, sc.page_number, sc.chunk_number';
  }
  params.push(maxFragments);
  const rows = db.prepare<unknown[], {
    source_id: number; upload_name: string; page_number: number; text: string; image_path: string | null;
  }>(
    `SELECT sc.source_id, cs.upload_name, sc.page_number, sc.text, sp.image_path
       FROM source_chunks sc
       JOIN course_sources cs ON cs.id = sc.source_id
       JOIN source_pages sp ON sp.source_id = sc.source_id AND sp.page_number = sc.page_number
       ${ftsJoin} ${topicJoin}
      WHERE cs.revision_id = ? AND cs.status = 'ready' ${topicWhere}
      ORDER BY ${rank} LIMIT ?`,
  ).all(...params);
  const images: string[] = [];
  const seenImages = new Set<string>();
  const fragments = rows.map((row): RetrievedSourceFragment => {
    const image = row.image_path !== null && options.dataDir !== undefined
      ? resolveCatalogPath(options.dataDir, row.image_path) : undefined;
    if (image !== undefined && images.length < maxImages && !seenImages.has(image)) {
      images.push(image);
      seenImages.add(image);
    }
    return {
      sourceId: row.source_id,
      sourceName: row.upload_name,
      pageNumber: row.page_number,
      text: row.text,
      ...(image === undefined ? {} : { image }),
    };
  });
  return { fragments, images };
}
