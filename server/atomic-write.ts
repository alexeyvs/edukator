/**
 * Запись файла через соседний временный: сбой посреди записи не обрезает
 * последнюю рабочую версию. Нужна там, где файл в репозитории — единственный
 * снимок состояния: карта тем, посевной банк и распознанное оглавление (самих
 * PDF в репозитории нет, восстановить обрезанный файл нечем).
 */
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Каталог сбрасывается отдельно: `fsync` дескриптора файла доносит до диска
 * содержимое, но не запись о переименовании, и после отключения питания на
 * месте снимка оказался бы прежний файл либо ничего. Восстановить нечем — PDF,
 * по которым он собран, в репозитории нет.
 *
 * После `rename` откатить запись уже нельзя, но и сообщать об успехе нельзя:
 * EIO/ENOSPC на сбросе означает, что единственный снимок может исчезнуть после
 * сбоя питания. Игнорируются только файловые системы, которые прямо сообщают,
 * что `fsync` каталога ими не поддерживается.
 *
 * Экспортируется: заведение базы ребёнка завершается тем же `rename` и обязано
 * доносить его до диска так же. Аргумент — путь файла, а не каталога.
 */
export function syncDirectory(path: string): void {
  let handle: number;
  try {
    handle = openSync(dirname(path), 'r');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EINVAL' || code === 'ENOTSUP') return;
    throw error;
  }

  try {
    fsyncSync(handle);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP') throw error;
  } finally {
    closeSync(handle);
  }
}

export function writeFileAtomic(path: string, content: string): void {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: number | undefined;
  try {
    handle = openSync(tempPath, 'wx');
    writeFileSync(handle, content);
    fsyncSync(handle);
    // Дескриптор снимается с уборки до закрытия, а не после: `closeSync` на
    // переполненном диске выносит отложенную ошибку записи и уходит в catch,
    // оставив `handle` заполненным, — и уборка закрыла бы его второй раз. К
    // этому моменту номер уже свободен и его успевает занять соседний
    // `openSync`, то есть второе закрытие рвёт чужой файл.
    const written = handle;
    handle = undefined;
    closeSync(written);
    renameSync(tempPath, path);
    syncDirectory(path);
  } catch (error) {
    // Уборка не имеет права заслонить причину: на переполненном диске
    // `closeSync` выносит отложенную ошибку записи повторно, и без отдельного
    // catch она заменила бы исходную, а `rmSync` не выполнился бы вовсе —
    // временный файл остался бы лежать рядом со снимком в репозитории.
    if (handle !== undefined) {
      try {
        closeSync(handle);
      } catch {
        /* исходная ошибка важнее */
      }
    }
    try {
      rmSync(tempPath, { force: true });
    } catch {
      /* исходная ошибка важнее */
    }
    throw error;
  }
}
