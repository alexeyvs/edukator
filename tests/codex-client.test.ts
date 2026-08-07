import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CODEX_FALLBACK_MODEL,
  CODEX_MODEL,
  CODEX_TIMEOUT_MS,
  codexArgs,
  codexOutputSchema,
  CodexUnavailableError,
  DEFAULT_ATTEMPTS,
  parseCodexAnswer,
  runCodexCli,
  writeCodexSchema,
} from '../server/codex/client.js';
import { CURRICULUM_SCHEMA_PATH } from '../server/curriculum.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'edukator-codex-client-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Исполняемая заглушка вместо codex: тестам нужен настоящий процесс, а не мок spawn. */
function fakeCodexBin(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('константы клиента', () => {
  it('держит модели и сроки из спеки', () => {
    expect(CODEX_MODEL).toBe('gpt-5.6-terra');
    expect(CODEX_FALLBACK_MODEL).toBe('gpt-5.6-luna');
    expect(DEFAULT_ATTEMPTS).toBe(3);
    expect(CODEX_TIMEOUT_MS).toBe(600_000);
  });
});

describe('codexOutputSchema', () => {
  it('снимает ключевые слова, на которых структурированный вывод падает', () => {
    const source = JSON.parse(readFileSync(CURRICULUM_SCHEMA_PATH, 'utf8')) as unknown;
    const stripped = JSON.stringify(codexOutputSchema(source));

    for (const keyword of ['uniqueItems', 'minItems', 'minLength', 'pattern', 'minimum', 'maximum']) {
      expect(stripped).not.toContain(`"${keyword}"`);
    }
  });

  it('сохраняет структуру, перечисления и обязательные поля', () => {
    const source = JSON.parse(readFileSync(CURRICULUM_SCHEMA_PATH, 'utf8')) as unknown;
    const stripped = codexOutputSchema(source) as {
      type: string;
      additionalProperties: boolean;
      required: string[];
      properties: { subject: { enum: string[] }; topics: { items: { $ref: string } } };
      $defs: { topic: { required: string[] } };
    };

    expect(stripped.type).toBe('object');
    expect(stripped.additionalProperties).toBe(false);
    expect(stripped.required).toEqual(['subject', 'topics']);
    expect(stripped.properties.subject.enum).toEqual(['math', 'russian', 'english']);
    expect(stripped.properties.topics.items.$ref).toBe('#/$defs/topic');
    expect(stripped.$defs.topic.required).toContain('prompt_seed');
  });

  it('не трогает значения, которые лишь называются как ключевые слова', () => {
    expect(codexOutputSchema({ enum: ['pattern', 'minimum'] })).toEqual({
      enum: ['pattern', 'minimum'],
    });
  });
});

describe('writeCodexSchema', () => {
  it('кладёт очищенную схему в рабочий каталог', () => {
    const path = writeCodexSchema(dir, CURRICULUM_SCHEMA_PATH);
    const written = readFileSync(path, 'utf8');

    expect(path).toBe(join(dir, 'curriculum.codex.json'));
    expect(written).not.toContain('"uniqueItems"');
    expect(JSON.parse(written)).toEqual(
      codexOutputSchema(JSON.parse(readFileSync(CURRICULUM_SCHEMA_PATH, 'utf8'))),
    );
  });

  it('называет копию по исходной схеме, а не одним именем на всех', () => {
    const source = join(dir, 'tasks.json');
    writeFileSync(source, JSON.stringify({ type: 'object', minItems: 1 }));

    const path = writeCodexSchema(dir, source);

    expect(path).toBe(join(dir, 'tasks.codex.json'));
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ type: 'object' });
  });

  it('падает на несуществующей схеме, а не пишет пустую копию', () => {
    expect(() => writeCodexSchema(dir, join(dir, 'ghost.json'))).toThrow(/ENOENT/);
  });
});

describe('codexArgs', () => {
  it('собирает флаги вызова из спеки', () => {
    const args = codexArgs({
      prompt: 'промпт',
      schemaPath: '/s.json',
      outPath: '/o.json',
      model: CODEX_MODEL,
    });

    expect(args).toEqual([
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--skip-git-repo-check',
      '--disable',
      'shell_tool',
      '--disable',
      'unified_exec',
      '--sandbox',
      'read-only',
      '--cd',
      '/',
      '-m',
      'gpt-5.6-terra',
      '--output-schema',
      '/s.json',
      '-o',
      '/o.json',
      'промпт',
    ]);
  });

  it('берёт рабочую модель, когда запрос её не назвал', () => {
    const args = codexArgs({ prompt: 'p', schemaPath: '/s.json', outPath: '/o.json' });
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.6-terra');
  });

  it('уходит на запасную модель, когда она указана явно', () => {
    const args = codexArgs({
      prompt: 'p',
      schemaPath: '/s.json',
      outPath: '/o.json',
      model: CODEX_FALLBACK_MODEL,
    });
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.6-luna');
  });
});

describe('parseCodexAnswer', () => {
  it('разбирает чистый JSON', () => {
    expect(parseCodexAnswer('{"subject":"math"}')).toEqual({ subject: 'math' });
  });

  it('снимает обрамление ```json', () => {
    expect(parseCodexAnswer('```json\n{"subject":"math"}\n```')).toEqual({ subject: 'math' });
  });

  it('сообщает о неразбираемом ответе и показывает его начало', () => {
    expect(() => parseCodexAnswer('Конечно! Вот карта тем:')).toThrow(
      /не разбирается как JSON.*Конечно/s,
    );
  });

  it('сообщает о пустом ответе', () => {
    expect(() => parseCodexAnswer('   \n')).toThrow(/пуст/);
  });
});

describe('runCodexCli', () => {
  it('возвращает записанный моделью ответ и не ждёт stdin', async () => {
    // `cat` прочитал бы стандартный ввод до конца: если stdin не закрыт,
    // заглушка повиснет и тест упадёт по таймауту.
    const bin = fakeCodexBin(
      'codex-ok',
      'cat > /dev/null\nwhile [ "$#" -gt 0 ]; do\n' +
        '  if [ "$1" = "-o" ]; then echo "{\\"ok\\":true}" > "$2"; exit; fi\n' +
        '  shift\n' +
        'done\nexit 2',
    );
    const outPath = join(dir, 'answer-ok.json');

    await expect(
      runCodexCli({ prompt: 'p', schemaPath: '/s.json', outPath, model: 'm', bin }),
    ).resolves.toContain('"ok":true');
  });

  it('сообщает о ненулевом коде возврата вместе со stderr', async () => {
    const bin = fakeCodexBin('codex-fail', 'echo "лимит подписки исчерпан" >&2\nexit 3');

    await expect(
      runCodexCli({
        prompt: 'p',
        schemaPath: '/s.json',
        outPath: join(dir, 'answer-fail.json'),
        model: 'm',
        bin,
      }),
    ).rejects.toThrow(/завершился с кодом 3.*лимит подписки/s);
  });

  it('сообщает, что ответ не записан, если codex вышел с нулём и ничего не создал', async () => {
    const bin = fakeCodexBin('codex-silent', 'exit 0');

    await expect(
      runCodexCli({
        prompt: 'p',
        schemaPath: '/s.json',
        outPath: join(dir, 'answer-missing.json'),
        model: 'm',
        bin,
      }),
    ).rejects.toThrow(/не записал ответ/);
  });

  it('сообщает о пустом файле ответа', async () => {
    const outPath = join(dir, 'answer-empty.json');
    const bin = fakeCodexBin('codex-empty', `: > "${outPath}"`);

    await expect(
      runCodexCli({ prompt: 'p', schemaPath: '/s.json', outPath, model: 'm', bin }),
    ).rejects.toThrow(/пустой ответ/);
  });

  it('отдельно сообщает, что codex не установлен', async () => {
    await expect(
      runCodexCli({
        prompt: 'p',
        schemaPath: '/s.json',
        outPath: join(dir, 'answer-none.json'),
        model: 'm',
        bin: join(dir, 'codex-does-not-exist'),
      }),
    ).rejects.toThrow(CodexUnavailableError);
  });

  it('останавливает зависший codex по сроку', async () => {
    const bin = fakeCodexBin('codex-hang', "trap '' TERM\nwhile :; do sleep 1; done");
    await expect(
      runCodexCli({
        prompt: 'p',
        schemaPath: '/s.json',
        outPath: join(dir, 'answer-timeout.json'),
        model: 'm',
        bin,
        timeoutMs: 30,
      }),
    ).rejects.toThrow(/превышен срок/);
  });

  it('останавливает codex, который льёт слишком много вывода', async () => {
    const bin = fakeCodexBin('codex-noisy', 'yes x | head -c 200');
    await expect(
      runCodexCli({
        prompt: 'p',
        schemaPath: '/s.json',
        outPath: join(dir, 'answer-noisy.json'),
        model: 'm',
        bin,
        maxOutputBytes: 64,
      }),
    ).rejects.toThrow(/вывод превысил 64 байт/);
  });
});
