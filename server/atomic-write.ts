/**
 * Запись файла через соседний временный: сбой посреди записи не обрезает
 * последнюю рабочую версию. Нужна там, где файл в репозитории — единственный
 * снимок состояния: карта тем и посевной банк.
 */
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export function writeFileAtomic(path: string, content: string): void {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: number | undefined;
  try {
    handle = openSync(tempPath, 'wx');
    writeFileSync(handle, content);
    fsyncSync(handle);
    closeSync(handle);
    handle = undefined;
    renameSync(tempPath, path);
  } catch (error) {
    if (handle !== undefined) closeSync(handle);
    rmSync(tempPath, { force: true });
    throw error;
  }
}
