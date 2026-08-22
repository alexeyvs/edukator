#!/usr/bin/env bash

set -Eeuo pipefail

project_dir="$(unset CDPATH; cd -- "$(dirname -- "$0")" && pwd)"
cd "$project_dir"

deploy_host="${EDUKATOR_DEPLOY_HOST:-195.133.56.188}"
deploy_user="${EDUKATOR_DEPLOY_USER:-root}"
app_root="${EDUKATOR_DEPLOY_APP_ROOT:-/opt/edukator}"
service="${EDUKATOR_DEPLOY_SERVICE:-edukator}"
env_file="${EDUKATOR_DEPLOY_ENV_FILE:-/etc/edukator/edukator.env}"
health_url="${EDUKATOR_DEPLOY_HEALTH_URL:-http://127.0.0.1:3000/api/health}"
keep_releases="${EDUKATOR_DEPLOY_KEEP_RELEASES:-3}"
target="${deploy_user}@${deploy_host}"
ssh_options=(-o BatchMode=yes -o ConnectTimeout=10)

die() {
  printf 'deploy: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "не найдена команда $1"
}

[[ "$deploy_host" =~ ^[A-Za-z0-9._:-]+$ ]] || die 'недопустимый EDUKATOR_DEPLOY_HOST'
[[ "$deploy_user" =~ ^[A-Za-z0-9._-]+$ ]] || die 'недопустимый EDUKATOR_DEPLOY_USER'
[[ "$app_root" =~ ^/[A-Za-z0-9._/-]+$ ]] || die 'недопустимый EDUKATOR_DEPLOY_APP_ROOT'
[[ "$service" =~ ^[A-Za-z0-9_.@-]+$ ]] || die 'недопустимый EDUKATOR_DEPLOY_SERVICE'
[[ "$env_file" =~ ^/[A-Za-z0-9._/-]+$ ]] || die 'недопустимый EDUKATOR_DEPLOY_ENV_FILE'
[[ "$health_url" =~ ^http://[A-Za-z0-9._:/-]+$ ]] || die 'health URL должен быть внутренним HTTP-адресом'
[[ "$keep_releases" =~ ^[1-9][0-9]*$ ]] || die 'EDUKATOR_DEPLOY_KEEP_RELEASES должен быть положительным числом'

for command_name in git npm ssh scp tar; do
  require_command "$command_name"
done

git rev-parse --show-toplevel >/dev/null 2>&1 || die 'скрипт нужно запускать из Git worktree'
[[ -z "$(git status --porcelain)" ]] || die 'worktree не чистый: закоммитьте или уберите изменения перед деплоем'

printf 'Проверяю доступ к %s...\n' "$target"
ssh "${ssh_options[@]}" "$target" /bin/bash -s -- \
  "$app_root" "$env_file" "$service" <<'REMOTE_PREFLIGHT'
set -euo pipefail
app_root="$1"
env_file="$2"
service="$3"

[[ "$(id -u)" == 0 ]] || { echo 'deploy: удалённый пользователь должен быть root' >&2; exit 1; }
[[ -d "$app_root/app" ]] || { echo "deploy: нет $app_root/app" >&2; exit 1; }
[[ -f "$env_file" ]] || { echo "deploy: нет $env_file" >&2; exit 1; }
command -v flock >/dev/null
command -v runuser >/dev/null
command -v systemctl >/dev/null
systemctl cat "$service" >/dev/null
REMOTE_PREFLIGHT

if ! ssh "${ssh_options[@]}" "$target" /bin/bash -s -- --check \
  < scripts/install-ocr-dependencies.sh; then
  die "OCR-зависимости не готовы. Выполните: ssh $target /bin/bash -s < scripts/install-ocr-dependencies.sh"
fi

printf '%s\n' 'Проверяю приложение перед деплоем...'
npm test
npm run coverage
npm run typecheck
npm run lint
npm run test:e2e
npm run build:web

commit="$(git rev-parse --verify HEAD)"
short_commit="$(git rev-parse --short=12 HEAD)"
release_id="$(date -u +%Y%m%dT%H%M%SZ)-${short_commit}"
temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/edukator-deploy.XXXXXX")"
bundle_dir="$temp_dir/bundle"
archive="$temp_dir/edukator-${release_id}.tar.gz"
remote_dir="/tmp/edukator-deploy-${release_id}"
remote_created=0

cleanup() {
  rm -rf -- "$temp_dir"
  if ((remote_created)); then
    # Переменная проверена выше и не может добавить удалённую shell-команду.
    # shellcheck disable=SC2029
    ssh "${ssh_options[@]}" "$target" \
      "/bin/rm -rf -- '$remote_dir'" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

mkdir -p "$bundle_dir"
git archive --format=tar "$commit" | tar -xf - -C "$bundle_dir"
mkdir -p "$bundle_dir/web"
cp -R web/dist "$bundle_dir/web/dist"
COPYFILE_DISABLE=1 tar -czf "$archive" -C "$bundle_dir" .

printf 'Готовлю релиз %s на %s...\n' "$release_id" "$target"
ssh "${ssh_options[@]}" "$target" /bin/bash -s -- \
  "$remote_dir" <<'REMOTE_PREPARE'
set -euo pipefail
remote_dir="$1"
mkdir -m 700 "$remote_dir"
REMOTE_PREPARE
remote_created=1

scp "${ssh_options[@]}" "$archive" scripts/deploy-release.sh \
  "$target:$remote_dir/"

ssh "${ssh_options[@]}" "$target" /bin/bash -s -- \
  "$app_root" "$env_file" "$service" "$health_url" "$keep_releases" \
  "$remote_dir" "$release_id" <<'REMOTE_DEPLOY'
set -euo pipefail
app_root="$1"
env_file="$2"
service="$3"
health_url="$4"
keep_releases="$5"
remote_dir="$6"
release_id="$7"

export EDUKATOR_DEPLOY_APP_ROOT="$app_root"
export EDUKATOR_DEPLOY_ENV_FILE="$env_file"
export EDUKATOR_DEPLOY_SERVICE="$service"
export EDUKATOR_DEPLOY_HEALTH_URL="$health_url"
export EDUKATOR_DEPLOY_KEEP_RELEASES="$keep_releases"

exec flock -n "$app_root/.deploy.lock" \
  /bin/bash "$remote_dir/deploy-release.sh" \
  "$remote_dir/edukator-${release_id}.tar.gz" "$release_id"
REMOTE_DEPLOY

printf 'Релиз %s (%s) успешно развёрнут на %s.\n' "$release_id" "$short_commit" "$target"
