import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const helper = resolve('scripts/deploy-release.sh');
const releaseId = '20260821T120000Z-abcdef123456';
const proxy = 'http://deploy-user:deploy-secret@proxy.test:3128';

describe('remote-helper деплоя', () => {
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
      '#!/usr/bin/env bash\nprintf \'systemctl %s\\n\' "$*" >> "$EDUKATOR_DEPLOY_TEST_LOG"\n',
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
        '  printf \'backup\\n\' > "$5/control.db"',
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
        '  exit 22',
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
    expect(`${result.stdout}${result.stderr}`).not.toContain('deploy-secret');
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
    expect(`${result.stdout}${result.stderr}`).not.toContain('deploy-secret');
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

  function deploy(health: 'ok' | 'new-fails') {
    return spawnSync('bash', [helper, archive, releaseId], {
      encoding: 'utf8',
      env: deployEnv(health),
    });
  }

  function deployEnv(health: 'ok' | 'new-fails'): NodeJS.ProcessEnv {
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
      EDUKATOR_DEPLOY_TEST_LOG: commandLog,
      EDUKATOR_DEPLOY_TEST_HEALTH: health,
    };
  }
});
