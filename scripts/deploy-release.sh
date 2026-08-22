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
node_bin="${EDUKATOR_DEPLOY_NODE_BIN:-${npm_bin%/npm}/node}"
maintenance_name='.maintenance'

die() {
  printf 'deploy: %s\n' "$*" >&2
  exit 1
}

[[ -n "$archive" && -f "$archive" ]] || die 'архив релиза не найден'
[[ "$release_id" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7,40}$ ]] || die 'недопустимый идентификатор релиза'
[[ "$app_root" =~ ^/[A-Za-z0-9._/-]+$ ]] || die 'недопустимый каталог приложения'
# Хвостовой слэш срезается сразу: регулярка выше его разрешает, а сравнение
# ниже строит из `$app_root` образец `"$app_root"/*` — с `/opt/edukator/` он
# становится `/opt/edukator//*` и не совпадает ни с чем.
app_root="${app_root%/}"
[[ "$service" =~ ^[A-Za-z0-9_.@-]+$ ]] || die 'недопустимое имя сервиса'
[[ "$keep_releases" =~ ^[1-9][0-9]*$ ]] || die 'число хранимых релизов должно быть положительным'
[[ "$health_attempts" =~ ^[1-9][0-9]*$ ]] || die 'число health-попыток должно быть положительным'
[[ "$health_delay" =~ ^[0-9]+$ ]] || die 'пауза health-check должна быть целым числом секунд'
if [[ "$require_root" == 1 && "$(id -u)" != 0 ]]; then
  die 'remote-helper должен работать от root'
fi

for executable in "$systemctl_bin" "$curl_bin" "$chown_bin" "$runuser_bin" "$npm_bin" "$node_bin"; do
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
data_may_be_modified=0
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
    if ((data_may_be_modified)); then
      restore_snapshot "$EDUKATOR_DATA_DIR"
    else
      rm -f -- "$EDUKATOR_DATA_DIR/$maintenance_name"
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
# Каталог данных проверяется здесь, а не сервером: без переменной приложение
# берёт умолчание `<корень проекта>/data`, то есть `$app_dir/data`. Деплой
# унёс бы живые базы вместе с прежней версией в `releases/`, поднял бы пустую
# `control.db`, прошёл health зелёным — и стёр бы единственную копию, когда
# срок хранения релизов дойдёт до этого каталога.
[[ -n "${EDUKATOR_DATA_DIR:-}" ]] || die "в $env_file не задан EDUKATOR_DATA_DIR"
[[ "$EDUKATOR_DATA_DIR" == /* ]] || die 'EDUKATOR_DATA_DIR должен быть абсолютным путём'
# Сравниваются канонические пути, а не текст. Текстовая проверка пропускает три
# обычных написания одного и того же каталога — `..` в середине, симлинк и
# хвостовой слэш, — а цена пропуска здесь максимальная: `mv "$app_dir"` унёс бы
# живые базы в `releases/`, новая версия поднялась бы на пустой `control.db`,
# health отдал бы 200 (открытых аренд нет, управляющая база исправна), и срок
# хранения релизов стёр бы единственную копию.
#
# Канонизируется **родитель**, а не сам путь: каталога данных может ещё не быть
# (первый запуск заводит его сам), и `readlink -f` на несуществующем хвосте
# отдаёт пустоту — то есть проверка молча отключалась бы ровно на первом деплое.
canonical_path() {
  local target="${1%/}" head tail resolved
  # Существующий каталог канонизируется целиком: иначе симлинк на последнем
  # шаге (`/srv/data -> /opt/edukator/app/data`) остался бы неразвёрнутым.
  if resolved="$(cd -- "$target" 2>/dev/null && pwd -P)"; then
    printf '%s' "$resolved"
    return
  fi
  head="${target%/*}"
  tail="${target##*/}"
  [[ -n "$head" ]] || head=/
  if resolved="$(cd -- "$head" 2>/dev/null && pwd -P)"; then
    printf '%s/%s' "${resolved%/}" "$tail"
  else
    # Родителя тоже нет: сравниваем как есть. Хуже прежнего не станет, а
    # деплой в несуществующее дерево упадёт следующей же командой.
    printf '%s' "$target"
  fi
}
data_real="$(canonical_path "$EDUKATOR_DATA_DIR")"
app_root_real="$(canonical_path "$app_root")"
case "${data_real%/}/" in
  "${app_root_real%/}"/*) die "EDUKATOR_DATA_DIR лежит внутри $app_root: деплой унёс бы данные вместе с версией" ;;
esac
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

restore_snapshot() {
  local data_dir="$1" manifest artifact expected actual
  [[ -f "$backup_dir/control.db" ]] || die 'в снимке нет control.db'
  manifest="$backup_dir/catalog/manifest.json"
  if [[ -f "$manifest" ]]; then
    command -v sha256sum >/dev/null 2>&1 || die 'для проверки снимка нужен sha256sum'
    while IFS=$'\t' read -r artifact expected; do
      [[ -n "$artifact" && "$artifact" != /* && "$artifact" != *'..'* ]] \
        || die 'manifest снимка содержит недопустимый путь'
      [[ -f "$backup_dir/$artifact" ]] || die 'в снимке отсутствует catalog artifact'
      actual="$(sha256sum "$backup_dir/$artifact" | awk '{print $1}')"
      [[ "$actual" == "$expected" ]] || die 'catalog artifact снимка не прошёл проверку'
    done < <("$node_bin" -e '
      const fs=require("fs"); const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      for (const x of p.artifacts ?? []) console.log(`${x.path}\t${x.sha256}`);
    ' "$manifest")
  fi

  rm -f -- "$data_dir/control.db" "$data_dir/control.db-wal" "$data_dir/control.db-shm"
  rm -rf -- "$data_dir/children" "$data_dir/catalog"
  cp "$backup_dir/control.db" "$data_dir/control.db"
  [[ ! -d "$backup_dir/children" ]] || cp -a "$backup_dir/children" "$data_dir/children"
  [[ ! -d "$backup_dir/catalog" ]] || cp -a "$backup_dir/catalog" "$data_dir/catalog"
  mkdir -p "$data_dir/children"
  rm -f -- "$data_dir/$maintenance_name"
  "$chown_bin" -R "$owner" "$data_dir/control.db" "$data_dir/children" \
    "$data_dir/catalog" 2>/dev/null || true
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
  restore_snapshot "$EDUKATOR_DATA_DIR"
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
touch "$EDUKATOR_DATA_DIR/$maintenance_name"
"$chown_bin" "$owner" "$EDUKATOR_DATA_DIR/$maintenance_name"
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

# С этого момента новая версия может открыть и мигрировать базы прежде, чем
# оборвётся SSH/скрипт. Любой аварийный EXIT обязан вернуть не только код, но и
# согласованный predeploy snapshot.
data_may_be_modified=1
if ! "$systemctl_bin" start "$service"; then
  show_failure
  rollback
fi
service_stopped=0
if ! wait_for_health; then
  show_failure
  rollback
fi
"$systemctl_bin" stop "$service"
service_stopped=1
rm -f -- "$EDUKATOR_DATA_DIR/$maintenance_name"
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
data_may_be_modified=0

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
