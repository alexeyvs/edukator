#!/usr/bin/env bash

set -Eeuo pipefail

archive="${1:-}"
release_id="${2:-}"
app_root="${EDUKATOR_DEPLOY_APP_ROOT:-/opt/edukator}"
env_file="${EDUKATOR_DEPLOY_ENV_FILE:-/etc/edukator/edukator.env}"
service="${EDUKATOR_DEPLOY_SERVICE:-edukator}"
health_url="${EDUKATOR_DEPLOY_HEALTH_URL:-http://127.0.0.1:3000/api/health}"
keep_releases="${EDUKATOR_DEPLOY_KEEP_RELEASES:-3}"
run_user="${EDUKATOR_DEPLOY_RUN_USER:-edukator}"
owner="${EDUKATOR_DEPLOY_OWNER:-edukator:edukator}"
home_dir="${EDUKATOR_DEPLOY_HOME:-/var/lib/edukator}"
backup_root="${EDUKATOR_DEPLOY_BACKUP_ROOT:-$home_dir/deploy-backups}"
health_attempts="${EDUKATOR_DEPLOY_HEALTH_ATTEMPTS:-30}"
health_delay="${EDUKATOR_DEPLOY_HEALTH_DELAY:-1}"
require_root="${EDUKATOR_DEPLOY_REQUIRE_ROOT:-1}"
systemctl_bin="${EDUKATOR_DEPLOY_SYSTEMCTL_BIN:-systemctl}"
curl_bin="${EDUKATOR_DEPLOY_CURL_BIN:-curl}"
chown_bin="${EDUKATOR_DEPLOY_CHOWN_BIN:-chown}"
runuser_bin="${EDUKATOR_DEPLOY_RUNUSER_BIN:-runuser}"
npm_bin="${EDUKATOR_DEPLOY_NPM_BIN:-/opt/node/bin/npm}"

die() {
  printf 'deploy: %s\n' "$*" >&2
  exit 1
}

[[ -n "$archive" && -f "$archive" ]] || die 'архив релиза не найден'
[[ "$release_id" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7,40}$ ]] || die 'недопустимый идентификатор релиза'
[[ "$app_root" =~ ^/[A-Za-z0-9._/-]+$ ]] || die 'недопустимый каталог приложения'
[[ "$service" =~ ^[A-Za-z0-9_.@-]+$ ]] || die 'недопустимое имя сервиса'
[[ "$keep_releases" =~ ^[1-9][0-9]*$ ]] || die 'число хранимых релизов должно быть положительным'
[[ "$health_attempts" =~ ^[1-9][0-9]*$ ]] || die 'число health-попыток должно быть положительным'
[[ "$health_delay" =~ ^[0-9]+$ ]] || die 'пауза health-check должна быть целым числом секунд'
if [[ "$require_root" == 1 && "$(id -u)" != 0 ]]; then
  die 'remote-helper должен работать от root'
fi

for executable in "$systemctl_bin" "$curl_bin" "$chown_bin" "$runuser_bin" "$npm_bin"; do
  [[ -x "$executable" ]] || command -v "$executable" >/dev/null 2>&1 || die "не найдена команда $executable"
done

app_dir="$app_root/app"
releases_dir="$app_root/releases"
stage_dir="$app_root/.staging-$release_id"
previous_dir="$releases_dir/${release_id}-previous"
failed_dir="$releases_dir/${release_id}-failed"
backup_dir="$backup_root/$release_id"

[[ -d "$app_dir" ]] || die "нет текущего приложения $app_dir"
[[ -f "$env_file" ]] || die "нет файла окружения $env_file"
[[ ! -e "$stage_dir" && ! -e "$previous_dir" && ! -e "$failed_dir" && ! -e "$backup_dir" ]] || die 'каталоги этого релиза уже существуют'

service_stopped=0
previous_saved=0
new_installed=0
deploy_succeeded=0

on_exit() {
  local status=$?
  trap - EXIT HUP INT TERM
  set +e

  # При обрыве SSH или неожиданной ошибке между stop и успешным health-check
  # возвращаем каталог и запускаем сервис. SIGKILL обработать невозможно.
  if (( ! deploy_succeeded && (service_stopped || previous_saved) )); then
    "$systemctl_bin" stop "$service" >/dev/null 2>&1 || true
    if ((new_installed)) && [[ -d "$app_dir" && ! -e "$failed_dir" ]]; then
      mv "$app_dir" "$failed_dir" || true
    fi
    if ((previous_saved)) && [[ -d "$previous_dir" && ! -e "$app_dir" ]]; then
      mv "$previous_dir" "$app_dir" || true
    fi
    "$systemctl_bin" start "$service" >/dev/null 2>&1 || true
  fi
  if [[ -d "$stage_dir" ]]; then
    rm -rf -- "$stage_dir"
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$releases_dir"
mkdir "$stage_dir"

if tar -tzf "$archive" | grep -E '(^/|(^|/)\.\.(/|$))' >/dev/null; then
  die 'архив содержит путь за пределами релиза'
fi
tar -xzf "$archive" -C "$stage_dir"
[[ -f "$stage_dir/package.json" && -f "$stage_dir/package-lock.json" ]] || die 'в архиве нет package.json или package-lock.json'
[[ -f "$stage_dir/web/dist/index.html" ]] || die 'в архиве нет собранного web/dist'

"$chown_bin" -R "$owner" "$stage_dir"

# Файл принадлежит root и не копируется в релиз. Экспорт нужен только дочернему
# npm: секреты прокси не попадают ни в argv, ни в вывод deploy-скрипта.
set -a
# shellcheck disable=SC1090
source "$env_file"
set +a
if [[ -z "${HTTPS_PROXY:-${https_proxy:-${HTTP_PROXY:-${http_proxy:-}}}}" ]]; then
  die "в $env_file не задан HTTP(S)-прокси"
fi
export HOME="$home_dir"
export npm_config_cache="$home_dir/.npm"

# Позиционные параметры раскрывает дочерний bash уже после смены пользователя.
# shellcheck disable=SC2016
"$runuser_bin" -u "$run_user" --preserve-environment -- \
  /bin/bash -c 'cd -- "$1" && exec "$2" ci --include=dev --no-audit --no-fund' \
  _ "$stage_dir" "$npm_bin"

mkdir -p "$backup_root"
"$chown_bin" "$owner" "$backup_root"
# Снимок снимает ещё текущая версия приложения до начала миграций новой.
# shellcheck disable=SC2016
"$runuser_bin" -u "$run_user" --preserve-environment -- \
  /bin/bash -c 'cd -- "$1" && exec "$2" run backup -- --out "$3"' \
  _ "$app_dir" "$npm_bin" "$backup_dir"
[[ -d "$backup_dir" ]] || die 'команда backup завершилась без каталога снимка'

wait_for_health() {
  local attempt
  for ((attempt = 1; attempt <= health_attempts; attempt += 1)); do
    if "$curl_bin" -fsS --max-time 3 "$health_url" >/dev/null; then
      return 0
    fi
    sleep "$health_delay"
  done
  return 1
}

show_failure() {
  "$systemctl_bin" --no-pager --full status "$service" >&2 || true
  if command -v journalctl >/dev/null 2>&1; then
    journalctl -u "$service" --no-pager --lines=40 >&2 || true
  fi
}

rollback() {
  "$systemctl_bin" stop "$service" || true
  service_stopped=1
  if [[ -d "$app_dir" ]]; then
    mv "$app_dir" "$failed_dir"
    new_installed=0
  fi
  if ! mv "$previous_dir" "$app_dir"; then
    die "автооткат не смог вернуть $previous_dir"
  fi
  previous_saved=0
  "$systemctl_bin" start "$service"
  service_stopped=0
  if ! wait_for_health; then
    show_failure
    die "предыдущая версия вернулась, но её health-check не прошёл; снимок данных: $backup_dir"
  fi
  die "health-check новой версии не прошёл; предыдущая версия восстановлена, сбойный релиз оставлен в $failed_dir, снимок данных — в $backup_dir"
}

"$systemctl_bin" stop "$service"
service_stopped=1
if ! mv "$app_dir" "$previous_dir"; then
  if "$systemctl_bin" start "$service"; then
    service_stopped=0
  fi
  die 'не удалось сохранить текущую версию'
fi
previous_saved=1
if ! mv "$stage_dir" "$app_dir"; then
  mv "$previous_dir" "$app_dir"
  previous_saved=0
  if "$systemctl_bin" start "$service"; then
    service_stopped=0
  fi
  die 'не удалось установить подготовленную версию'
fi
new_installed=1

if ! "$systemctl_bin" start "$service"; then
  show_failure
  rollback
fi
service_stopped=0
if ! wait_for_health; then
  show_failure
  rollback
fi
deploy_succeeded=1

old_releases=()
while IFS= read -r old_release; do
  old_releases+=("$old_release")
done < <(
  find "$releases_dir" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | LC_ALL=C sort -r
)
for ((index = keep_releases; index < ${#old_releases[@]}; index += 1)); do
  release_to_remove="$releases_dir/${old_releases[index]}"
  rm -rf -- "${release_to_remove:?}" || printf 'deploy: не удалось удалить старый релиз %s\n' "$release_to_remove" >&2
done

old_backups=()
while IFS= read -r old_backup; do
  old_backups+=("$old_backup")
done < <(find "$backup_root" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | LC_ALL=C sort -r)
for ((index = keep_releases; index < ${#old_backups[@]}; index += 1)); do
  backup_to_remove="$backup_root/${old_backups[index]}"
  rm -rf -- "${backup_to_remove:?}" || printf 'deploy: не удалось удалить старый снимок %s\n' "$backup_to_remove" >&2
done

printf 'deploy: сервис %s обновлён, health-check пройден, снимок данных: %s\n' "$service" "$backup_dir"
