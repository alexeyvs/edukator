/**
 * Запись файла через соседний временный: сбой посреди записи не обрезает
 * последнюю рабочую версию. Нужна там, где файл в репозитории — единственный
 * снимок состояния: карта тем, посевной банк и распознанное оглавление (самих
 * PDF в репозитории нет, восстановить обрезанный файл нечем).
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
    // Дескриптор снимается с уборки до закрытия, а не после: `closeSync` на
    // переполненном диске выносит отложенную ошибку записи и уходит в catch,
    // оставив `handle` заполненным, — и уборка закрыла бы его второй раз. К
    // этому моменту номер уже свободен и его успевает занять соседний
    // `openSync`, то есть второе закрытие рвёт чужой файл.
    const written = handle;
    handle = undefined;
    closeSync(written);
    renameSync(tempPath, path);
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
