import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CODEX_FALLBACK_MODEL,
  CODEX_MODEL,
  CODEX_ROLES,
  CODEX_ROLE_ENV,
  CODEX_TIMEOUT_MS,
  modelForRole,
  type CodexRole,
  codexArgs,
  codexOutputSchema,
  CodexRunError,
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
    expect(CODEX_MODEL).toBe('gpt-5.6-sol');
    expect(CODEX_FALLBACK_MODEL).toBe('gpt-5.6-terra');
    expect(DEFAULT_ATTEMPTS).toBe(3);
    expect(CODEX_TIMEOUT_MS).toBe(600_000);
  });
});

describe('модель на роль', () => {
  it('без переменных окружения все роли берут модель по умолчанию', () => {
    for (const role of CODEX_ROLES) {
      expect(modelForRole(role, {})).toBe(CODEX_MODEL);
    }
  });

  it('переменная окружения роли перекрывает умолчание, не задевая остальные', () => {
    const env = { [CODEX_ROLE_ENV.validate]: 'gpt-5.6-terra' };

    expect(modelForRole('validate', env)).toBe('gpt-5.6-terra');
    expect(modelForRole('generate', env)).toBe(CODEX_MODEL);
    expect(modelForRole('dispute', env)).toBe(CODEX_MODEL);
    expect(modelForRole('curriculum', env)).toBe(CODEX_MODEL);
  });

  it('у каждой роли своя переменная, дублей нет', () => {
    const names = CODEX_ROLES.map((role) => CODEX_ROLE_ENV[role]);
    expect(new Set(names).size).toBe(names.length);
  });

  it('пустая переменная считается незаданной, а не пустой моделью', () => {
    expect(modelForRole('generate', { [CODEX_ROLE_ENV.generate]: '' })).toBe(CODEX_MODEL);
    expect(modelForRole('generate', { [CODEX_ROLE_ENV.generate]: '   ' })).toBe(CODEX_MODEL);
  });

  it('обрезает пробелы вокруг имени модели', () => {
    expect(modelForRole('generate', { [CODEX_ROLE_ENV.generate]: '  gpt-5.6-luna  ' })).toBe(
      'gpt-5.6-luna',
    );
  });

  it('неизвестная роль отвергается с внятной ошибкой', () => {
    expect(() => modelForRole('нет-такой' as CodexRole, {})).toThrow(/неизвестная роль/);
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

  it('сохраняет структуру, строковый course ID и обязательные поля', () => {
    const source = JSON.parse(readFileSync(CURRICULUM_SCHEMA_PATH, 'utf8')) as unknown;
    const stripped = codexOutputSchema(source) as {
      type: string;
      additionalProperties: boolean;
      required: string[];
      properties: { subject: { type: string; enum?: string[] }; topics: { items: { $ref: string } } };
      $defs: { topic: { required: string[] } };
    };

    expect(stripped.type).toBe('object');
    expect(stripped.additionalProperties).toBe(false);
    expect(stripped.required).toEqual(['subject', 'topics']);
    expect(stripped.properties.subject.type).toBe('string');
    expect(stripped.properties.subject.enum).toBeUndefined();
    expect(stripped.properties.topics.items.$ref).toBe('#/$defs/topic');
    expect(stripped.$defs.topic.required).toContain('prompt_seed');
  });

  it('не трогает значения, которые лишь называются как ключевые слова', () => {
    expect(codexOutputSchema({ enum: ['pattern', 'minimum'] })).toEqual({
      enum: ['pattern', 'minimum'],
    });
  });

  // Ключи под `properties` — имена полей данных, а не ключевые слова. Вырезав
  // такое поле, чистка оставила бы его в `required`, и схема стала бы
  // невыполнимой: модель не смогла бы вернуть ничего.
  it('не вырезает поле данных, названное как запрещённое ключевое слово', () => {
    const stripped = codexOutputSchema({
      type: 'object',
      required: ['pattern', 'minimum'],
      properties: {
        pattern: { type: 'string', minLength: 1 },
        minimum: { type: 'integer', minimum: 0 },
      },
    }) as {
      required: string[];
      properties: Record<string, Record<string, unknown>>;
    };

    expect(Object.keys(stripped.properties).sort()).toEqual(['minimum', 'pattern']);
    expect(stripped.required).toEqual(['pattern', 'minimum']);
    // А ограничения внутри самих полей всё равно сняты.
    expect(stripped.properties['pattern']).toEqual({ type: 'string' });
    expect(stripped.properties['minimum']).toEqual({ type: 'integer' });
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
      'gpt-5.6-sol',
      '--output-schema',
      '/s.json',
      '-o',
      '/o.json',
      'промпт',
    ]);
  });

  it('берёт рабочую модель, когда запрос её не назвал', () => {
    const args = codexArgs({ prompt: 'p', schemaPath: '/s.json', outPath: '/o.json' });
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.6-sol');
  });

  it('уходит на запасную модель, когда она указана явно', () => {
    const args = codexArgs({
      prompt: 'p',
      schemaPath: '/s.json',
      outPath: '/o.json',
      model: CODEX_FALLBACK_MODEL,
    });
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.6-terra');
  });

  it('передаёт ограниченный массив изображений повторяемым --image', () => {
    const first = join(dir, 'page-1.jpg');
    const second = join(dir, 'page-2.jpg');
    writeFileSync(first, Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    writeFileSync(second, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const args = codexArgs({ prompt: 'p', schemaPath: '/s.json', outPath: '/o.json', images: [first, second] });
    expect(args.slice(-5)).toEqual(['--image', first, '--image', second, 'p']);
    expect(() => codexArgs({ prompt: 'p', schemaPath: '/s', outPath: '/o', images: Array(7).fill(first) as string[] }))
      .toThrow(/изображений больше 6/u);
    expect(() => codexArgs({ prompt: 'p', schemaPath: '/s', outPath: '/o', images: ['relative.jpg'] }))
      .toThrow(/абсолютным/u);
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

  // Отдельный класс, а не текст: по нему вызывающий отличает сорванный запуск от
  // негодного ответа модели и не отправляет диагностику CLI обратно в промпт.
  it('помечает сорванный запуск отдельным классом ошибки', async () => {
    const outPath = join(dir, 'answer-run-error.json');

    await expect(
      runCodexCli({
        prompt: 'p',
        schemaPath: '/s.json',
        outPath,
        model: 'm',
        bin: fakeCodexBin('codex-code', 'exit 4'),
      }),
    ).rejects.toBeInstanceOf(CodexRunError);
    await expect(
      runCodexCli({
        prompt: 'p',
        schemaPath: '/s.json',
        outPath,
        model: 'm',
        bin: fakeCodexBin('codex-blank', `: > "${outPath}"`),
      }),
    ).rejects.toBeInstanceOf(CodexRunError);
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

  // Не `CodexRunError`: три попытки по сроку — это полчаса на одну тему, после
  // которых воркер ещё и сбросил бы отступ. Молчащий codex — отказ уровня цикла.
  it('считает превышенный срок недоступностью codex, а не сорванным запуском', async () => {
    const bin = fakeCodexBin('codex-hang', "trap '' TERM\nwhile :; do sleep 1; done");
    const call = runCodexCli({
      prompt: 'p',
      schemaPath: '/s.json',
      outPath: join(dir, 'answer-timeout.json'),
      model: 'm',
      bin,
      timeoutMs: 30,
    });

    await expect(call).rejects.toBeInstanceOf(CodexUnavailableError);
    await expect(call).rejects.toThrow(/превышен срок/);
  });

  // Переполнение вывода — беда одного вызова: следующий придёт с другим
  // промптом, и останавливать из-за него весь цикл незачем. Но и замечанием к
  // модели диагностика CLI не является — отсюда `CodexRunError`.
  it('останавливает codex, который льёт слишком много вывода', async () => {
    const bin = fakeCodexBin('codex-noisy', 'yes x | head -c 200');
    const call = runCodexCli({
      prompt: 'p',
      schemaPath: '/s.json',
      outPath: join(dir, 'answer-noisy.json'),
      model: 'm',
      bin,
      maxOutputBytes: 64,
    });

    await expect(call).rejects.toBeInstanceOf(CodexRunError);
    await expect(call).rejects.toThrow(/вывод превысил 64 байт/);
  });

  // Права на файл не появятся к третьей попытке ровно так же, как не появится
  // сам файл: и то и другое — несостоявшийся запуск, а не ответ модели.
  it('считает недоступностью и запуск, сорвавшийся не из-за отсутствия файла', async () => {
    const bin = join(dir, 'codex-no-exec');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o600 });

    await expect(
      runCodexCli({
        prompt: 'p',
        schemaPath: '/s.json',
        outPath: join(dir, 'answer-no-exec.json'),
        model: 'm',
        bin,
      }),
    ).rejects.toBeInstanceOf(CodexUnavailableError);
  });

  // Слишком длинный промпт даёт `E2BIG` — беду одного вызова, а не всего codex.
  // Записанная в недоступность, она уводила бы воркер в получасовой отступ, а
  // `npm run prefetch` — в ненулевой код возврата на исправной модели.
  it('не считает недоступностью сорванный запуск, который следующий вызов переживёт', async () => {
    const bin = fakeCodexBin('codex-e2big', 'exit 0');
    // Аргументы длиннее ARG_MAX: `spawn` отказывает с `E2BIG` ещё до процесса.
    const call = runCodexCli({
      prompt: 'п'.repeat(4 * 1024 * 1024),
      schemaPath: '/s.json',
      outPath: join(dir, 'answer-e2big.json'),
      model: 'm',
      bin,
    });

    await expect(call).rejects.toBeInstanceOf(CodexRunError);
    await expect(call).rejects.not.toBeInstanceOf(CodexUnavailableError);
    // Именно несостоявшийся запуск, а не «codex вышел с нулём и ничего не создал»:
    // без кода ошибки тест проходил бы и на успешно запустившейся заглушке.
    await expect(call).rejects.toThrow(/не запустился.*E2BIG/);
  });

  // Ответ идёт не через stdout, а через `--output-last-message`, то есть предел
  // вывода `runChild` его не покрывает. Без своей проверки зациклившаяся на
  // токенах генерация роняла бы процесс на `ERR_STRING_TOO_LONG` — в сервере
  // это унесло бы и занятие.
  it('отвергает слишком большой файл ответа, не читая его в память', async () => {
    const outPath = join(dir, 'answer-huge.json');
    const bin = fakeCodexBin('codex-huge', `yes '{"x":1}' | head -c 400 > "${outPath}"`);

    const call = runCodexCli({
      prompt: 'p',
      schemaPath: '/s.json',
      outPath,
      model: 'm',
      bin,
      maxOutputBytes: 64,
    });

    await expect(call).rejects.toBeInstanceOf(CodexRunError);
    await expect(call).rejects.toThrow(/400 байт при пределе 64/);
  });
});
