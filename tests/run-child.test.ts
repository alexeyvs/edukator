import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runChild } from '../server/run-child.js';

const projectRoot = resolve('.');
const tsxCli = join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const runChildModule = join(projectRoot, 'server', 'run-child.ts');

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function waitUntilExists(path: string): Promise<boolean> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (existsSync(path)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

async function waitUntilDead(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!processExists(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

describe('runChild', () => {
  // Без срока `setTimeout(…, 0)` срабатывает сразу, а на NaN не срабатывает
  // никогда — то есть внешний вызов либо гибнет мгновенно, либо висит вечно.
  it('требует положительный конечный срок', async () => {
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        runChild({ bin: '/bin/echo', args: ['ок'], label: 'проба', timeoutMs }),
      ).rejects.toThrow(/срок/u);
    }
  });

  it.skipIf(process.platform === 'win32')(
    'после выхода лидера добивает потомка, который игнорирует TERM и закрыл stdio',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'edukator-child-'));
      tempDirs.push(dir);
      const pidPath = join(dir, 'survivor.pid');
      const bin = join(dir, 'tree.sh');
      writeFileSync(
        bin,
        [
          '#!/bin/sh',
          "( trap '' TERM; exec >/dev/null 2>&1; while :; do sleep 1; done ) &",
          'survivor=$!',
          'printf \'%s\' "$survivor" > "$1"',
          "trap 'exit 0' TERM",
          'while :; do sleep 1; done',
        ].join('\n'),
      );
      chmodSync(bin, 0o755);

      await expect(
        runChild({ bin, args: [pidPath], label: 'дерево', timeoutMs: 1_000 }),
      ).rejects.toThrow(/превышен срок/);

      const survivor = Number(readFileSync(pidPath, 'utf8'));
      expect(Number.isInteger(survivor)).toBe(true);
      expect(await waitUntilDead(survivor)).toBe(true);
    },
  );

  // Внук, успевший завести свою сессию, из группы уходит: SIGKILL по `-pid` его
  // не достаёт, а унаследованный stdout он держит — и `close`, которому нужны
  // закрытые трубы, не приходит никогда. Без второго срока обещание оставалось
  // бы неразрешённым: у занятия это навсегда занятое место в `reviewing` (спор
  // больше не разберётся), у `prefetch` — процесс, сделавший всю работу и не
  // завершающийся.
  it.skipIf(process.platform === 'win32')(
    'отказывает по сроку, даже когда сбежавший из группы внук держит трубу',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'edukator-escape-'));
      tempDirs.push(dir);
      const pidPath = join(dir, 'escaped.pid');
      const bin = join(dir, 'escape.sh');
      writeFileSync(
        bin,
        [
          '#!/bin/sh',
          // Трубу внук наследует и не закрывает — именно она держит `close`.
          // `setsid` вынесен в perl: отдельной команды `setsid` в macOS нет.
          'perl -MPOSIX -e \'POSIX::setsid(); open(my $f, ">", $ARGV[0]); print $f $$;' +
            ' close($f); sleep 30;\' "$1" &',
          "trap 'exit 0' TERM",
          'while :; do sleep 1; done',
        ].join('\n'),
      );
      chmodSync(bin, 0o755);

      const started = Date.now();
      await expect(
        runChild({ bin, args: [pidPath], label: 'беглец', timeoutMs: 300 }),
      ).rejects.toThrow(/превышен срок/);
      // Отказ приходит по второму сроку, а не «когда-нибудь»: внук спит
      // полминуты, и без второго срока обещание разрешилось бы только с ним.
      expect(Date.now() - started).toBeLessThan(10_000);

      // Уборка: снять беглеца больше некому — он в своей сессии.
      if (existsSync(pidPath)) {
        const escaped = Number(readFileSync(pidPath, 'utf8'));
        if (Number.isInteger(escaped) && processExists(escaped)) {
          process.kill(escaped, 'SIGKILL');
        }
      }
    },
    // Отказ приходит через срок плюс обе отсрочки; умолчание vitest в пять
    // секунд слишком близко к этой сумме, чтобы краснеть от загрузки машины.
    20_000,
  );

  // `detached` уводит потомка из группы терминала — только так его снимает
  // `process.kill(-pid)` по сроку. Обратная сторона: Ctrl-C по `npm run prefetch`
  // до потомка не доходит, а таймер, который снял бы его по сроку, умирает
  // вместе с родителем — два вызова codex по десять минут остаются жечь
  // подписку, и собрать их ответ уже некому.
  it.skipIf(process.platform === 'win32')(
    'снимает потомка, когда родителя убивают сигналом',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'edukator-orphan-'));
      tempDirs.push(dir);
      const pidPath = join(dir, 'child.pid');
      const bin = join(dir, 'sleeper.sh');
      writeFileSync(
        bin,
        ['#!/bin/sh', 'printf \'%s\' "$$" > "$1"', 'while :; do sleep 1; done'].join('\n'),
      );
      chmodSync(bin, 0o755);

      const parentPath = join(dir, 'parent.ts');
      writeFileSync(
        parentPath,
        [
          "import { existsSync } from 'node:fs';",
          `import { runChild } from ${JSON.stringify(runChildModule)};`,
          `const pidPath = ${JSON.stringify(pidPath)};`,
          `void runChild({ bin: ${JSON.stringify(bin)}, args: [pidPath],`,
          "  label: 'сон', timeoutMs: 60_000 }).catch(() => undefined);",
          // Ожидание по факту запуска, а не по таймеру: под нагрузкой полного
          // набора потомок стартует дольше, и фиксированная пауза давала
          // красноту от загрузки машины, а не от кода.
          'let waited = 0;',
          'const timer = setInterval(() => {',
          '  waited += 1;',
          '  if (!existsSync(pidPath)) { if (waited > 250) process.exit(2); return; }',
          '  clearInterval(timer);',
          // Своей смертью, а не выходом: `exit` на сигнал Node не зовёт, и
          // проверять надо именно этот путь.
          "  process.kill(process.pid, 'SIGINT');",
          '}, 20);',
        ].join('\n'),
      );

      const parent = spawnSync(process.execPath, [tsxCli, parentPath], { encoding: 'utf8' });

      expect(parent.stderr).not.toMatch(/Error/u);
      // Код 2 — родитель не дождался запуска потомка; всё остальное значит, что
      // сигнал до него дошёл.
      expect(parent.status).not.toBe(2);
      const child = Number(readFileSync(pidPath, 'utf8'));
      expect(Number.isInteger(child)).toBe(true);
      const dead = await waitUntilDead(child);
      // Провал этой проверки означает ровно то, что потомок остался жив: снять
      // его надо здесь, иначе красный набор оставляет процесс в системе навсегда
      // — срок, который снял бы его, умер вместе с родителем.
      if (!dead) process.kill(-child, 'SIGKILL');
      expect(dead).toBe(true);
    },
  );

  // Та же уборка, но в ветке сервера: на SIGINT у него висит своё закрытие базы,
  // и досылать процессу смерть из-под него нельзя — WAL остался бы
  // неперенесённым. Проверяется прямо здесь, а не в отдельном процессе: иначе
  // ветка «сигнал слушает кто-то ещё» вообще не выполняется ни разу.
  it.skipIf(process.platform === 'win32')(
    'снимает потомка, не убивая процесс, когда сигнал слушает кто-то ещё',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'edukator-signal-'));
      tempDirs.push(dir);
      const pidPath = join(dir, 'child.pid');
      const bin = join(dir, 'sleeper.sh');
      writeFileSync(
        bin,
        ['#!/bin/sh', 'printf \'%s\' "$$" > "$1"', 'while :; do sleep 1; done'].join('\n'),
      );
      chmodSync(bin, 0o755);

      const other = (): void => undefined;
      process.on('SIGINT', other);
      try {
        const pending = runChild({ bin, args: [pidPath], label: 'сон', timeoutMs: 60_000 });
        expect(await waitUntilExists(pidPath)).toBe(true);
        const child = Number(readFileSync(pidPath, 'utf8'));

        process.emit('SIGINT', 'SIGINT');

        expect(await waitUntilDead(child)).toBe(true);
        // Родитель жив и досидел до конца вызова: снятого потомка он видит как
        // обычное завершение по сигналу.
        await expect(pending).resolves.toMatchObject({ code: null });
      } finally {
        process.off('SIGINT', other);
      }
    },
  );
});
