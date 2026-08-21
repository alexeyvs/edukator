/**
 * Опенер детских баз для отчётов оператора: одна база, только на чтение, сразу
 * закрыть.
 *
 * Реестра арендаторов это не касается вовсе, и в том весь смысл. Реестр держит
 * базы открытыми ради занятий и отказывает новому арендатору на потолке в 32
 * аренды (`DEFAULT_MAX_OPEN_TENANTS`); отчёт, прошедший через него, вытеснил бы
 * этот потолок на себя — обход тридцати баз ради двух цифр закрыл бы вход
 * тридцать первому ребёнку, который в это время сел заниматься. Здесь
 * соединение живёт ровно один запрос и закрывается в `finally`.
 *
 * Соединение голое (`better-sqlite3`, `readonly`, `fileMustExist`), а не
 * `openDatabase`, и это не экономия настройки: `openDatabase` включает WAL — то
 * есть пишет — и прогоняет `migrate`. Админский отчёт, мигрирующий чужую базу,
 * менял бы её ровно тем действием, которым обещал только посмотреть. Поэтому
 * базу со схемой не той версии обход **не** читает и **не** трогает, а честно
 * отдаёт её номер: «схема 16, ждёт первого захода». Миграция принадлежит
 * первому настоящему заходу ребёнка, а не отчёту оператора.
 *
 * Отказ одной базы не отменяет остальных: он попадает в `failed[]` — тот же
 * принцип, что у `backupDataDir` и `prefetchChildren`. Вылет наружу оставил бы
 * оператора без всей статистики из-за одного испорченного файла, то есть ровно
 * тогда, когда она нужнее всего.
 */
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { childDatabasePath } from '../control-db.js';
import { SCHEMA_VERSION } from '../db.js';

/** Что известно о базе до того, как её начали читать. */
export interface ChildDatabaseMeta {
  childId: string;
  path: string;
  /** `user_version` файла как есть, без миграции. */
  schemaVersion: number;
}

/**
 * Итог чтения одной базы.
 *
 * `stale` — не отказ и не пустой отчёт: база исправна, но её схема не совпадает
 * с ожидаемой приложением, и запросы отчёта по ней либо не выполнились бы вовсе
 * (нет таблицы), либо посчитали бы не то. Сводить это к нулям нельзя — «ребёнок
 * не занимался» и «мы не смотрели» на экране обязаны различаться.
 */
export type ChildReadResult<T> =
  | ({ state: 'read'; value: T } & ChildDatabaseMeta)
  | ({ state: 'stale' } & ChildDatabaseMeta);

/**
 * Чтение открытой базы. Соединение закрывается сразу после возврата, поэтому
 * уносить его наружу нельзя: подготовленный запрос переживёт закрытие только до
 * первого обращения.
 */
export type ChildReader<T> = (db: Database.Database, meta: ChildDatabaseMeta) => T;

/** Ребёнок, чью базу прочитать не вышло. */
export interface ChildReadFailure {
  childId: string;
  reason: string;
}

/** Итог обхода: прочитанные, отложенные по схеме и не открывшиеся. */
export interface ChildrenSweep<T> {
  reports: Array<{ value: T } & ChildDatabaseMeta>;
  /** Базы со схемой не той версии: не читались и не менялись. */
  stale: ChildDatabaseMeta[];
  failed: ChildReadFailure[];
}

/**
 * Открывает базу ребёнка только на чтение и отдаёт её `read`.
 *
 * Пропажа файла — отказ, а не пустой отчёт: `fileMustExist` у голого соединения
 * бросает сам, но проверка стоит отдельно ради внятного текста — у
 * `SQLITE_CANTOPEN` в сообщении нет ребёнка.
 *
 * Путь в текст отказа не попадает: он доезжает до тела HTTP-ответа
 * (`failed[].reason` у обоих отчётов оператора), а каталог данных — подробность
 * машины, которой в ответе не место. Ребёнок назван, а путь по нему считается
 * однозначно.
 */
export function readChildDatabase<T>(
  dataDir: string,
  childId: string,
  read: ChildReader<T>,
): ChildReadResult<T> {
  // Путь считается из непрозрачного `id` и проверяется по `CHILD_ID_PATTERN`:
  // отчёт оператора не имеет права открыть файл по имени, пришедшему снаружи.
  const path = childDatabasePath(dataDir, childId);
  if (!existsSync(path)) {
    throw new Error(`Базы ребёнка ${childId} нет`);
  }

  const db = new Database(path, { fileMustExist: true, readonly: true });
  try {
    const [row] = db.pragma('user_version') as [{ user_version: number }];
    const meta: ChildDatabaseMeta = { childId, path, schemaVersion: row.user_version };
    // База новее приложения попадает сюда же: откатили версию — читать её
    // нынешними запросами так же нельзя, и молчаливый нуль был бы враньём.
    if (meta.schemaVersion !== SCHEMA_VERSION) return { state: 'stale', ...meta };
    return { state: 'read', value: read(db, meta), ...meta };
  } finally {
    db.close();
  }
}

/**
 * Обходит названных детей по одному. Порядок сохраняется: он задан вызывающим,
 * и отчёт с переставленными строками читался бы как другой.
 */
export function sweepChildDatabases<T>(
  dataDir: string,
  childIds: readonly string[],
  read: ChildReader<T>,
): ChildrenSweep<T> {
  const reports: ChildrenSweep<T>['reports'] = [];
  const stale: ChildDatabaseMeta[] = [];
  const failed: ChildReadFailure[] = [];

  for (const childId of childIds) {
    try {
      const result = readChildDatabase(dataDir, childId, read);
      const meta: ChildDatabaseMeta = {
        childId: result.childId,
        path: result.path,
        schemaVersion: result.schemaVersion,
      };
      if (result.state === 'read') reports.push({ ...meta, value: result.value });
      else stale.push(meta);
    } catch (error) {
      // Не-`Error` даёт `undefined`, а `JSON.stringify` его выбрасывает: строка
      // отказа приехала бы на экран вовсе без причины.
      failed.push({ childId, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  return { reports, stale, failed };
}
