import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildCurriculum,
  buildPrompt,
  codexArgs,
  codexOutputSchema,
  CodexUnavailableError,
  formatCurriculum,
  parseArgs,
  parseCodexAnswer,
  parseCurriculumAnswer,
  runCodexCli,
  TOPIC_LIMITS,
  writeCodexSchema,
  writeCurriculumAtomic,
  type CodexRequest,
  type CodexRunner,
} from '../scripts/build-curriculum.js';
import { CURRICULUM_SCHEMA_PATH } from '../server/curriculum.js';
import type { Subject } from '../server/db.js';

let dir: string;
const projectRoot = resolve('.');
const tsxCli = join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const buildCli = join(projectRoot, 'scripts', 'build-curriculum.ts');

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'edukator-curriculum-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Карта из `count` тем, где каждая опирается на предыдущую: валидна и по схеме,
 * и по графу. Вес идёт от 1, а не от 0: тема вне экзамена не может быть
 * предпосылкой, а здесь предпосылкой оказывается каждая, кроме последней.
 */
function curriculum(subject: Subject, count: number): string {
  const topics = Array.from({ length: count }, (_, index) => ({
    id: `${subject}.topic-${index + 1}`,
    subject,
    title: `Тема номер ${index + 1}`,
    exam_weight: (index % 3) + 1,
    difficulty: (index % 3) + 1,
    prereqs: index === 0 ? [] : [`${subject}.topic-${index}`],
    answer_format: 'number',
    prompt_seed: `Задания по теме номер ${index + 1}: спрашивай про счёт, пример формулировки «Вычисли 2 + 2».`,
  }));
  return JSON.stringify({ subject, topics });
}

const VALID_MATH = curriculum('math', 20);

/** Оглавление, достаточное для запуска: содержимое скрипту безразлично, он его только пересылает. */
function writeToc(name: string, text = 'Оглавление\nГлава 1. Дроби ..... 5\nГлава 2. Проценты ..... 40\n'): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

/**
 * Заглушка codex: отдаёт заготовленные ответы по порядку и запоминает запросы.
 * Схема читается прямо в момент вызова — рабочий каталог живёт только внутри
 * `buildCurriculum` и к моменту проверок уже удалён.
 */
function fakeRunner(answers: string[]): CodexRunner & { requests: CodexRequest[]; schemas: string[] } {
  const requests: CodexRequest[] = [];
  const schemas: string[] = [];
  const runner = (request: CodexRequest): Promise<string> => {
    requests.push(request);
    schemas.push(readFileSync(request.schemaPath, 'utf8'));
    const answer = answers[requests.length - 1];
    if (answer === undefined) throw new Error('заглушка codex вызвана больше раз, чем задано ответов');
    return Promise.resolve(answer);
  };
  return Object.assign(runner, { requests, schemas });
}

/** Исполняемая заглушка вместо codex: тестам нужен настоящий процесс, а не мок spawn. */
function fakeCodexBin(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('buildPrompt', () => {
  it('передаёт оглавление и требования к карте', () => {
    const prompt = buildPrompt('math', 'Глава 1. Дроби ..... 5');

    expect(prompt).toContain('Глава 1. Дроби');
    expect(prompt).toContain('математика');
    expect(prompt).toContain('20-25 тем');
    expect(prompt).toContain('exam_weight');
    expect(prompt).toContain('prompt_seed');
  });

  it('называет предмет и формат id так же, как схема', () => {
    expect(buildPrompt('english', 'Contents')).toContain('«english»');
    expect(buildPrompt('english', 'Contents')).toMatch(/аудирование.*exam_weight 0/i);
    expect(buildPrompt('russian', 'Оглавление')).toContain('«russian.<латиницей-через-дефис>»');
  });

  it('дописывает текст прошлой ошибки, чтобы модель не повторила её', () => {
    const prompt = buildPrompt('math', 'Оглавление', 'тема «math.x» дублируется');
    expect(prompt).toContain('тема «math.x» дублируется');
    expect(prompt).toContain('Исправь ровно это');
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

describe('parseCurriculumAnswer', () => {
  it('разбирает корректный ответ codex в карту тем', () => {
    const graph = parseCurriculumAnswer(VALID_MATH, 'math');

    expect(graph.byId.size).toBe(20);
    expect(graph.byId.get('math.topic-1')?.title).toBe('Тема номер 1');
    expect(graph.order[0]?.id).toBe('math.topic-1');
    expect(graph.subjects).toEqual(['math']);
  });

  it('отвергает ответ с чужим предметом', () => {
    expect(() => parseCurriculumAnswer(curriculum('russian', 20), 'math')).toThrow(
      /предмет «russian».*«math\.json»/s,
    );
  });

  it('отвергает ответ, не прошедший схему', () => {
    const broken = JSON.parse(VALID_MATH) as { topics: { exam_weight: number }[] };
    broken.topics[0]!.exam_weight = 9;
    expect(() => parseCurriculumAnswer(JSON.stringify(broken), 'math')).toThrow(/не соответствует схеме/);
  });

  it('отвергает цикл в prereqs', () => {
    const broken = JSON.parse(VALID_MATH) as { topics: { id: string; prereqs: string[] }[] };
    broken.topics[0]!.prereqs = ['math.topic-20'];
    expect(() => parseCurriculumAnswer(JSON.stringify(broken), 'math')).toThrow(/цикл в prereqs/);
  });

  it('отвергает горстку тем: схеме хватает одной, планировщику — нет', () => {
    expect(() => parseCurriculumAnswer(curriculum('math', TOPIC_LIMITS.min - 1), 'math')).toThrow(
      /в ответе 14 тем, а нужно 20-25/,
    );
  });

  it('отвергает карту сверх допуска', () => {
    expect(() => parseCurriculumAnswer(curriculum('math', TOPIC_LIMITS.max + 1), 'math')).toThrow(
      /в ответе 31 тем/,
    );
  });
});

describe('formatCurriculum', () => {
  it('пишет карту в том же виде, что лежит в репозитории', () => {
    const text = formatCurriculum('math', parseCurriculumAnswer(VALID_MATH, 'math'));

    expect(text.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(text) as { subject: string; topics: { id: string }[] };
    expect(parsed.subject).toBe('math');
    expect(parsed.topics).toHaveLength(20);
    expect(Object.keys(parsed.topics[0]!)).toEqual([
      'id',
      'subject',
      'title',
      'exam_weight',
      'difficulty',
      'prereqs',
      'answer_format',
      'prompt_seed',
    ]);
  });
});

describe('buildCurriculum', () => {
  it('пишет карту предмета с первой попытки', async () => {
    const outDir = join(dir, 'out-ok');
    const run = fakeRunner([VALID_MATH]);

    const result = await buildCurriculum({
      subject: 'math',
      tocPath: writeToc('math.txt'),
      outDir,
      run,
    });

    expect(result.attempts).toBe(1);
    expect(result.failures).toEqual([]);
    expect(result.outPath).toBe(join(outDir, 'math.json'));
    const written = JSON.parse(readFileSync(result.outPath, 'utf8')) as { topics: unknown[] };
    expect(written.topics).toHaveLength(20);

    expect(run.requests).toHaveLength(1);
    expect(run.requests[0]?.model).toBe('gpt-5.6-terra');
    // Схема уходит очищенной копией: с оригиналом структурированный вывод падает.
    expect(run.requests[0]?.schemaPath.endsWith('curriculum.codex.json')).toBe(true);
    expect(run.schemas[0]).not.toContain('"uniqueItems"');
    expect(run.schemas[0]).toContain('"prompt_seed"');
    expect(run.requests[0]?.prompt).toContain('Глава 1. Дроби');
  });

  it('повторяет вызов после неразбираемого JSON и кладёт ошибку в следующий промпт', async () => {
    const run = fakeRunner(['вот ваша карта тем', VALID_MATH]);

    const result = await buildCurriculum({
      subject: 'math',
      tocPath: writeToc('math-retry.txt'),
      outDir: join(dir, 'out-retry'),
      run,
    });

    expect(result.attempts).toBe(2);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatch(/не разбирается как JSON/);
    expect(run.requests[1]?.prompt).toContain('не разбирается как JSON');
  });

  it('повторяет вызов после проваленной валидации', async () => {
    const broken = JSON.parse(VALID_MATH) as { topics: { prereqs: string[] }[] };
    broken.topics[0]!.prereqs = ['math.ghost'];
    const run = fakeRunner([JSON.stringify(broken), VALID_MATH]);

    const result = await buildCurriculum({
      subject: 'math',
      tocPath: writeToc('math-invalid.txt'),
      outDir: join(dir, 'out-invalid'),
      run,
    });

    expect(result.attempts).toBe(2);
    expect(result.failures[0]).toMatch(/несуществующую тему «math.ghost»/);
  });

  it('исчерпав попытки, падает с отчётом по каждой и не пишет файл', async () => {
    const outDir = join(dir, 'out-exhausted');
    const oldPath = join(outDir, 'math.json');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(oldPath, 'старая рабочая карта', { flag: 'w' });
    const run = fakeRunner(['не json', '{"subject":"math"}', curriculum('math', 2)]);

    await expect(
      buildCurriculum({
        subject: 'math',
        tocPath: writeToc('math-exhausted.txt'),
        outDir,
        run,
      }),
    ).rejects.toThrow(/не собрана за 3 попыт.*попытка 1.*попытка 2.*попытка 3/s);

    expect(run.requests).toHaveLength(3);
    expect(readFileSync(oldPath, 'utf8')).toBe('старая рабочая карта');
  });

  it('уважает заданное число попыток', async () => {
    const run = fakeRunner(['не json', 'тоже не json']);

    await expect(
      buildCurriculum({
        subject: 'math',
        tocPath: writeToc('math-attempts.txt'),
        outDir: join(dir, 'out-attempts'),
        attempts: 1,
        run,
      }),
    ).rejects.toThrow(/не собрана за 1 попыт/);

    expect(run.requests).toHaveLength(1);
  });

  it('не повторяет попытки, если codex вовсе не запускается', async () => {
    let calls = 0;
    const run = (): Promise<string> => {
      calls += 1;
      return Promise.reject(new CodexUnavailableError('codex не найден'));
    };

    await expect(
      buildCurriculum({
        subject: 'math',
        tocPath: writeToc('math-nocodex.txt'),
        outDir: join(dir, 'out-nocodex'),
        run,
      }),
    ).rejects.toThrow(/codex не найден/);

    expect(calls).toBe(1);
  });

  it('сообщает об отсутствующем оглавлении и не трогает codex', async () => {
    const run = fakeRunner([]);

    await expect(
      buildCurriculum({ subject: 'russian', tocPath: join(dir, 'ghost.txt'), outDir: dir, run }),
    ).rejects.toThrow(/не найдено.*extract-toc/s);

    expect(run.requests).toHaveLength(0);
  });

  it('сообщает о пустом оглавлении', async () => {
    await expect(
      buildCurriculum({
        subject: 'russian',
        tocPath: writeToc('empty.txt', '   \n'),
        outDir: dir,
        run: fakeRunner([]),
      }),
    ).rejects.toThrow(/пусто/);
  });

  it('отвергает некорректное число попыток', async () => {
    for (const attempts of [0, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        buildCurriculum({
          subject: 'math',
          tocPath: writeToc(`math-${String(attempts)}.txt`),
          outDir: dir,
          attempts,
          run: fakeRunner([]),
        }),
      ).rejects.toThrow(/положительным целым/);
    }
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

describe('writeCurriculumAtomic', () => {
  it('заменяет существующую карту целиком', () => {
    const path = join(dir, 'atomic.json');
    writeFileSync(path, 'старая карта');

    writeCurriculumAtomic(path, 'новая карта');

    expect(readFileSync(path, 'utf8')).toBe('новая карта');
  });

  it('убирает временный файл, если публикация не удалась', () => {
    const target = join(dir, 'atomic-target');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'sentinel'), 'не трогать');

    expect(() => writeCurriculumAtomic(target, 'карта')).toThrow();

    expect(readFileSync(join(target, 'sentinel'), 'utf8')).toBe('не трогать');
    expect(
      readdirSync(dir).filter((name) => name.startsWith('atomic-target.') && name.endsWith('.tmp')),
    ).toEqual([]);
  });
});

describe('writeCodexSchema', () => {
  it('кладёт очищенную схему в рабочий каталог', () => {
    const path = writeCodexSchema(dir);
    const written = readFileSync(path, 'utf8');

    expect(path).toBe(join(dir, 'curriculum.codex.json'));
    expect(written).not.toContain('"uniqueItems"');
    expect(JSON.parse(written)).toEqual(
      codexOutputSchema(JSON.parse(readFileSync(CURRICULUM_SCHEMA_PATH, 'utf8'))),
    );
  });
});

describe('codexArgs', () => {
  it('собирает флаги вызова из спеки', () => {
    const args = codexArgs({
      prompt: 'промпт',
      schemaPath: '/s.json',
      outPath: '/o.json',
      model: 'gpt-5.6-terra',
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

describe('build-curriculum CLI', () => {
  it('возвращает код 1 и диагностику при ошибочных аргументах', () => {
    const result = spawnSync(process.execPath, [tsxCli, buildCli, '--subject', 'physics'], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/build-curriculum:.*--subject/s);
  });

  it('собирает карту через настоящий CLI-вход и исполняемую заглушку codex', () => {
    const binDir = join(dir, 'cli-bin');
    const outDir = join(dir, 'cli-out');
    mkdirSync(binDir, { recursive: true });
    const answerPath = join(dir, 'cli-answer.json');
    writeFileSync(answerPath, VALID_MATH);
    const codex = join(binDir, 'codex');
    writeFileSync(
      codex,
      '#!/bin/sh\nout=""\nwhile [ "$#" -gt 0 ]; do\n' +
        '  if [ "$1" = "-o" ]; then out="$2"; shift 2; else shift; fi\n' +
        'done\ncp "$FAKE_CURRICULUM" "$out"\n',
    );
    chmodSync(codex, 0o755);

    const result = spawnSync(
      process.execPath,
      [tsxCli, buildCli, '--subject', 'math', '--toc', writeToc('cli-toc.txt'), '--out', outDir],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
          FAKE_CURRICULUM: answerPath,
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/math: 20 тем.*math\.json/s);
    expect(JSON.parse(readFileSync(join(outDir, 'math.json'), 'utf8'))).toMatchObject({
      subject: 'math',
    });
  });
});

describe('parseArgs', () => {
  it('разбирает предмет и необязательные флаги', () => {
    const args = parseArgs([
      '--subject',
      'russian',
      '--toc',
      'toc.txt',
      '--out',
      'out',
      '--attempts',
      '2',
      '--model',
      'gpt-5.6-sol',
    ]);

    expect(args.subject).toBe('russian');
    expect(args.tocPath?.endsWith('toc.txt')).toBe(true);
    expect(args.outDir?.endsWith('out')).toBe(true);
    expect(args.attempts).toBe(2);
    expect(args.model).toBe('gpt-5.6-sol');
  });

  it('оставляет пути по умолчанию, когда флагов нет', () => {
    const args = parseArgs(['--subject', 'math']);
    expect(args.tocPath).toBeUndefined();
    expect(args.outDir).toBeUndefined();
    expect(args.attempts).toBeUndefined();
  });

  it('отвергает неизвестный предмет', () => {
    expect(() => parseArgs(['--subject', 'physics'])).toThrow(/--subject/);
  });

  it('отвергает нечисловые попытки', () => {
    expect(() => parseArgs(['--subject', 'math', '--attempts', 'три'])).toThrow(/--attempts/);
  });

  it('отвергает флаг без значения', () => {
    expect(() => parseArgs(['--subject'])).toThrow(/нет значения/);
  });

  it('отвергает непонятный аргумент', () => {
    expect(() => parseArgs(['math'])).toThrow(/Непонятный аргумент/);
  });

  it('отвергает неизвестный и повторный флаг', () => {
    expect(() => parseArgs(['--subject', 'math', '--ouut', 'x'])).toThrow(/Неизвестный флаг/);
    expect(() => parseArgs(['--subject', 'math', '--subject', 'math'])).toThrow(/дважды/);
  });
});
