import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const helper = resolve('scripts/deploy-release.sh');
const ocrSetup = resolve('scripts/install-ocr-dependencies.sh');
const releaseId = '20260821T120000Z-abcdef123456';
const proxy = 'http://deploy-user:deploy-secret@proxy.test:3128';

// Каждый сценарий гоняет настоящий bash, а тот — `npm ci` заглушкой, `curl`
// health и `sleep`: с умолчанием vitest в 5 секунд файл краснел под нагрузкой
// полного прогона, не имея к делу никакого отношения. Отдельный срок ставится
// на весь файл, а не на один сценарий: медленный здесь любой из них.
describe('remote-helper деплоя', { timeout: 30_000 }, () => {
  let root: string;
  let appRoot: string;
  let archive: string;
  let envFile: string;
  let fakeBin: string;
  let commandLog: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'edukator-deploy-'));
    appRoot = join(root, 'opt', 'edukator');
    archive = join(root, 'release.tar.gz');
    envFile = join(root, 'edukator.env');
    fakeBin = join(root, 'bin');
    commandLog = join(root, 'commands.log');

    mkdirSync(join(appRoot, 'app'), { recursive: true });
    mkdirSync(join(root, 'home'), { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(join(root, 'data', 'children'), { recursive: true });
    mkdirSync(join(root, 'data', 'catalog', 'artifacts'), { recursive: true });
    mkdirSync(join(root, 'cgroup', 'edukator-test'), { recursive: true });
    writeFileSync(join(root, 'cgroup', 'edukator-test', 'cgroup.procs'), '');
    writeFileSync(join(root, 'data', 'control.db'), 'control-before\n');
    writeFileSync(join(root, 'data', 'children', 'child.db'), 'child-before\n');
    writeFileSync(join(root, 'data', 'catalog', 'artifacts', 'book.pdf'), 'pdf-before\n');
    writeFileSync(join(appRoot, 'app', 'version'), 'old\n');
    writeFileSync(
      envFile,
      [
        `http_proxy=${proxy}`,
        `https_proxy=${proxy}`,
        `HTTP_PROXY=${proxy}`,
        `HTTPS_PROXY=${proxy}`,
        'NO_PROXY=127.0.0.1,localhost',
        `EDUKATOR_DATA_DIR=${join(root, 'data')}`,
        '',
      ].join('\n'),
      { mode: 0o600 },
    );

    executable(
      'systemctl',
      [
        '#!/usr/bin/env bash',
        'marker=normal',
        '[[ -e "$EDUKATOR_DATA_DIR/.maintenance" ]] && marker=maintenance',
        'printf \'systemctl %s %s\\n\' "$*" "$marker" >> "$EDUKATOR_DEPLOY_TEST_LOG"',
        'if [[ "${1:-}" == "show" ]]; then printf \'/edukator-test\\n\'; exit 0; fi',
        'if [[ "${EDUKATOR_DEPLOY_TEST_HEALTH:-ok}" == "unexpected-stop" ]] &&',
        '   [[ "${1:-}" == "stop" ]] &&',
        '   [[ "$(cat "$EDUKATOR_DEPLOY_APP_ROOT/app/version" 2>/dev/null)" == "new" ]]; then exit 9; fi',
        '',
      ].join('\n'),
    );
    executable('chown', '#!/usr/bin/env bash\nexit 0\n');
    executable(
      'runuser',
      [
        '#!/usr/bin/env bash',
        'while [[ "$1" != "--" ]]; do shift; done',
        'shift',
        'exec "$@"',
        '',
      ].join('\n'),
    );
    executable(
      'npm',
      [
        '#!/usr/bin/env bash',
        `[[ "\${http_proxy:-}" == ${JSON.stringify(proxy)} ]] || exit 51`,
        'printf \'npm %s %s\\n\' "$PWD" "$*" >> "$EDUKATOR_DEPLOY_TEST_LOG"',
        'if [[ "$1 $2 $3" == "run backup --" ]]; then',
        '  mkdir -p "$5"',
        '  cp "$EDUKATOR_DATA_DIR/control.db" "$5/control.db"',
        '  cp -a "$EDUKATOR_DATA_DIR/children" "$5/children"',
        '  cp -a "$EDUKATOR_DATA_DIR/catalog" "$5/catalog"',
        '  hash="$(sha256sum "$5/catalog/artifacts/book.pdf" | awk \'{print $1}\')"',
        '  printf \'{"version":1,"artifacts":[{"path":"catalog/artifacts/book.pdf","sha256":"%s","size":11}]}\\n\' "$hash" > "$5/catalog/manifest.json"',
        'fi',
        '',
      ].join('\n'),
    );
    executable(
      'curl',
      [
        '#!/usr/bin/env bash',
        'if [[ "${EDUKATOR_DEPLOY_TEST_HEALTH:-ok}" == "new-fails" ]] &&',
        '   [[ "$(cat "$EDUKATOR_DEPLOY_APP_ROOT/app/version" 2>/dev/null)" == "new" ]]; then',
        '  printf \'control-migrated\\n\' > "$EDUKATOR_DATA_DIR/control.db"',
        '  printf \'child-migrated\\n\' > "$EDUKATOR_DATA_DIR/children/child.db"',
        '  printf \'pdf-migrated\\n\' > "$EDUKATOR_DATA_DIR/catalog/artifacts/book.pdf"',
        '  exit 22',
        'fi',
        'if [[ "${EDUKATOR_DEPLOY_TEST_HEALTH:-ok}" == "unexpected-stop" ]] &&',
        '   [[ "$(cat "$EDUKATOR_DEPLOY_APP_ROOT/app/version" 2>/dev/null)" == "new" ]]; then',
        '  printf \'control-migrated\\n\' > "$EDUKATOR_DATA_DIR/control.db"',
        '  printf \'child-migrated\\n\' > "$EDUKATOR_DATA_DIR/children/child.db"',
        '  printf \'pdf-migrated\\n\' > "$EDUKATOR_DATA_DIR/catalog/artifacts/book.pdf"',
        'fi',
        'exit 0',
        '',
      ].join('\n'),
    );

    const source = join(root, 'source');
    mkdirSync(join(source, 'web', 'dist'), { recursive: true });
    writeFileSync(join(source, 'package.json'), '{}\n');
    writeFileSync(join(source, 'package-lock.json'), '{}\n');
    writeFileSync(join(source, 'web', 'dist', 'index.html'), '<!doctype html>\n');
    writeFileSync(join(source, 'version'), 'new\n');
    const packed = spawnSync('tar', ['-czf', archive, '-C', source, '.'], { encoding: 'utf8' });
    expect(packed.status, packed.stderr).toBe(0);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('ставит подготовленный релиз и сохраняет предыдущий', () => {
    const result = deploy('ok');

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(appRoot, 'app', 'version'), 'utf8')).toBe('new\n');
    expect(
      readFileSync(join(appRoot, 'releases', `${releaseId}-previous`, 'version'), 'utf8'),
    ).toBe('old\n');
    expect(readFileSync(commandLog, 'utf8')).toContain('ci --include=dev --no-audit --no-fund');
    expect(readFileSync(commandLog, 'utf8')).toContain('run backup -- --out');
    expect(existsSync(join(root, 'home', 'deploy-backups', releaseId, 'control.db'))).toBe(true);
    expect(readFileSync(commandLog, 'utf8')).toContain('start edukator-test maintenance');
    expect(readFileSync(commandLog, 'utf8')).toContain('start edukator-test normal');
    expect(existsSync(join(root, 'data', '.maintenance'))).toBe(false);
    expect(`${result.stdout}${result.stderr}`).not.toContain('deploy-secret');
  });

  it('после stop удаляет оставшийся замок остановленного процесса', () => {
    const stalePid = 2_000_000_001;
    writeFileSync(
      join(root, 'data', 'edukator.lock'),
      `${JSON.stringify({ pid: stalePid, owner: 'сервер', since: new Date(0), nonce: 'old' })}\n`,
    );
    writeFileSync(join(root, 'cgroup', 'edukator-test', 'cgroup.procs'), `${stalePid}\n`);

    const result = deploy('ok');

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(root, 'data', 'edukator.lock'))).toBe(false);
  });

  it('не удаляет замок процесса вне cgroup сервиса', () => {
    const foreignPid = 2_000_000_002;
    writeFileSync(
      join(root, 'data', 'edukator.lock'),
      `${JSON.stringify({ pid: foreignPid, owner: 'ручной прогрев', since: new Date(0), nonce: 'foreign' })}\n`,
    );
    writeFileSync(join(root, 'cgroup', 'edukator-test', 'cgroup.procs'), '12345\n');

    const result = deploy('ok');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('вне cgroup');
    expect(existsSync(join(root, 'data', 'edukator.lock'))).toBe(true);
    expect(readFileSync(join(appRoot, 'app', 'version'), 'utf8')).toBe('old\n');
  });

  it('возвращает предыдущий релиз, когда health-check новой версии не проходит', () => {
    const result = deploy('new-fails');

    expect(result.status).toBe(1);
    expect(readFileSync(join(appRoot, 'app', 'version'), 'utf8')).toBe('old\n');
    expect(readFileSync(join(appRoot, 'releases', `${releaseId}-failed`, 'version'), 'utf8')).toBe(
      'new\n',
    );
    expect(result.stderr).toContain('предыдущая версия восстановлена');
    expect(existsSync(join(root, 'home', 'deploy-backups', releaseId, 'control.db'))).toBe(true);
    expect(readFileSync(join(root, 'data', 'control.db'), 'utf8')).toBe('control-before\n');
    expect(readFileSync(join(root, 'data', 'children', 'child.db'), 'utf8')).toBe('child-before\n');
    expect(readFileSync(join(root, 'data', 'catalog', 'artifacts', 'book.pdf'), 'utf8'))
      .toBe('pdf-before\n');
    expect(existsSync(join(root, 'data', '.maintenance'))).toBe(false);
    expect(`${result.stdout}${result.stderr}`).not.toContain('deploy-secret');
  });

  it('на неожиданном EXIT после миграции возвращает код и predeploy snapshot', () => {
    const result = deploy('unexpected-stop');

    expect(result.status).toBe(9);
    expect(readFileSync(join(appRoot, 'app', 'version'), 'utf8')).toBe('old\n');
    expect(readFileSync(join(root, 'data', 'control.db'), 'utf8')).toBe('control-before\n');
    expect(readFileSync(join(root, 'data', 'children', 'child.db'), 'utf8')).toBe('child-before\n');
    expect(readFileSync(join(root, 'data', 'catalog', 'artifacts', 'book.pdf'), 'utf8'))
      .toBe('pdf-before\n');
    expect(existsSync(join(root, 'data', '.maintenance'))).toBe(false);
  });

  it('отказывается деплоить без каталога данных и с каталогом внутри релиза', () => {
    const proxyLines = [
      `http_proxy=${proxy}`,
      `https_proxy=${proxy}`,
      `HTTP_PROXY=${proxy}`,
      `HTTPS_PROXY=${proxy}`,
    ];

    // Без переменной приложение берёт умолчание `<корень проекта>/data`, то
    // есть каталог внутри `app`: деплой унёс бы живые базы вместе с прежней
    // версией, поднял бы пустую `control.db` и отчитался успехом.
    writeFileSync(envFile, [...proxyLines, ''].join('\n'), { mode: 0o600 });
    const missing = deploy('ok');
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('EDUKATOR_DATA_DIR');
    expect(readFileSync(join(appRoot, 'app', 'version'), 'utf8')).toBe('old\n');

    writeFileSync(
      envFile,
      [...proxyLines, `EDUKATOR_DATA_DIR=${join(appRoot, 'app', 'data')}`, ''].join('\n'),
      { mode: 0o600 },
    );
    const inside = deploy('ok');
    expect(inside.status).toBe(1);
    expect(inside.stderr).toContain('унёс бы данные вместе с версией');
    expect(readFileSync(join(appRoot, 'app', 'version'), 'utf8')).toBe('old\n');
  });

  it('видит каталог данных внутри релиза и через симлинк, и через ..', () => {
    // Текстовое сравнение путей ловит только прямое написание, а `mv "$app_dir"`
    // унёс бы живые базы в `releases/` при любом из трёх — и health отдал бы 200
    // на пустой `control.db`, потому что открытых аренд после подъёма нет.
    const proxyLines = [
      `http_proxy=${proxy}`,
      `https_proxy=${proxy}`,
      `HTTP_PROXY=${proxy}`,
      `HTTPS_PROXY=${proxy}`,
    ];
    const inside = join(appRoot, 'app', 'data');
    mkdirSync(inside, { recursive: true });
    const link = join(root, 'через-симлинк');
    symlinkSync(inside, link);

    for (const disguise of [link, join(root, 'opt', '..', 'opt', 'edukator', 'app', 'data')]) {
      writeFileSync(
        envFile,
        [...proxyLines, `EDUKATOR_DATA_DIR=${disguise}`, ''].join('\n'),
        { mode: 0o600 },
      );
      const result = deploy('ok');
      expect([disguise, result.status], result.stderr).toEqual([disguise, 1]);
      expect(result.stderr).toContain('унёс бы данные вместе с версией');
      expect(readFileSync(join(appRoot, 'app', 'version'), 'utf8')).toBe('old\n');
    }
  });

  it('отвергает идентификатор релиза, который можно использовать как путь', () => {
    const result = spawnSync('bash', [helper, archive, '../release'], {
      encoding: 'utf8',
      env: deployEnv('ok'),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('недопустимый идентификатор релиза');
    expect(existsSync(join(appRoot, 'releases'))).toBe(false);
  });

  function executable(name: string, body: string): void {
    const path = join(fakeBin, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }

  function deploy(health: 'ok' | 'new-fails' | 'unexpected-stop') {
    return spawnSync('bash', [helper, archive, releaseId], {
      encoding: 'utf8',
      env: deployEnv(health),
    });
  }

  function deployEnv(health: 'ok' | 'new-fails' | 'unexpected-stop'): NodeJS.ProcessEnv {
    return {
      ...process.env,
      EDUKATOR_DEPLOY_APP_ROOT: appRoot,
      EDUKATOR_DEPLOY_ENV_FILE: envFile,
      EDUKATOR_DEPLOY_SERVICE: 'edukator-test',
      EDUKATOR_DEPLOY_HOME: join(root, 'home'),
      EDUKATOR_DEPLOY_REQUIRE_ROOT: '0',
      EDUKATOR_DEPLOY_HEALTH_ATTEMPTS: '1',
      EDUKATOR_DEPLOY_HEALTH_DELAY: '0',
      EDUKATOR_DEPLOY_SYSTEMCTL_BIN: join(fakeBin, 'systemctl'),
      EDUKATOR_DEPLOY_CURL_BIN: join(fakeBin, 'curl'),
      EDUKATOR_DEPLOY_CHOWN_BIN: join(fakeBin, 'chown'),
      EDUKATOR_DEPLOY_RUNUSER_BIN: join(fakeBin, 'runuser'),
      EDUKATOR_DEPLOY_NPM_BIN: join(fakeBin, 'npm'),
      EDUKATOR_DEPLOY_NODE_BIN: process.execPath,
      EDUKATOR_DEPLOY_CGROUP_ROOT: join(root, 'cgroup'),
      EDUKATOR_DEPLOY_TEST_LOG: commandLog,
      EDUKATOR_DEPLOY_TEST_HEALTH: health,
    };
  }
});

describe('OCR preflight и подготовка Ubuntu', () => {
  let root: string;
  let fakeBin: string;
  let osRelease: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'edukator-ocr-setup-'));
    fakeBin = join(root, 'bin');
    osRelease = join(root, 'os-release');
    mkdirSync(fakeBin);
    writeFileSync(osRelease, 'ID=ubuntu\nVERSION_ID=22.04\n');
    for (const name of ['ocrmypdf', 'tesseract', 'pdftotext', 'pdftoppm', 'qpdf']) {
      const version = name === 'ocrmypdf' ? '13.4.0'
        : name === 'tesseract' ? '5.3.0'
        : name === 'qpdf' ? '10.6.3' : '22.02.0';
      executable(name, [
        '#!/usr/bin/env bash',
        'if [[ "$1" == "--list-langs" ]]; then printf \'List of available languages (2):\\nrus\\neng\\n\'; exit; fi',
        `printf '%s ${version}\\n' ${JSON.stringify(name)}`,
        '',
      ].join('\n'));
    }
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('read-only проверяет версии и rus+eng', () => {
    const result = check();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('зависимости готовы');
  });

  it('идемпотентно устанавливает точный набор Ubuntu-пакетов', () => {
    const log = join(root, 'apt.log');
    executable('apt-get', [
      '#!/usr/bin/env bash',
      'printf \'%s\\n\' "$*" >> "$EDUKATOR_OCR_APT_LOG"',
      '',
    ].join('\n'));
    const env = {
      EDUKATOR_OCR_REQUIRE_ROOT: '0',
      EDUKATOR_OCR_APT_LOG: log,
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = spawnSync('bash', [ocrSetup], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          EDUKATOR_OCR_OS_RELEASE: osRelease,
          ...env,
        },
      });
      expect(result.status, result.stderr).toBe(0);
    }
    const calls = readFileSync(log, 'utf8');
    expect(calls.match(/^update$/gmu)).toHaveLength(2);
    expect(calls.match(/install -y --no-install-recommends ocrmypdf tesseract-ocr tesseract-ocr-rus tesseract-ocr-eng poppler-utils qpdf/gmu))
      .toHaveLength(2);
  });

  it.each(['ocrmypdf', 'tesseract', 'pdftotext', 'pdftoppm', 'qpdf'])(
    'называет отсутствующий пакет %s',
    (missing) => {
      const result = check({ EDUKATOR_OCR_FORCE_MISSING: missing });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(missing);
      expect(result.stderr).not.toContain(proxy);
    },
  );

  it.each(['rus', 'eng'])('отказывает без языка %s', (missing) => {
    executable('tesseract', [
      '#!/usr/bin/env bash',
      `if [[ "$1" == "--list-langs" ]]; then printf '${missing === 'rus' ? 'eng' : 'rus'}\\n'; exit; fi`,
      "printf 'tesseract 5.3.0\\n'",
      '',
    ].join('\n'));
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(missing);
  });

  function executable(name: string, body: string): void {
    const path = join(fakeBin, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }

  function check(extra: NodeJS.ProcessEnv = {}) {
    return spawnSync('bash', [ocrSetup, '--check'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        EDUKATOR_OCR_OS_RELEASE: osRelease,
        ...extra,
      },
    });
  }
});
