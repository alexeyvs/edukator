#!/usr/bin/env bash

set -euo pipefail

controller_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
venv_dir="$controller_dir/.venv"

python_bin="${EDUKATOR_PYTHON:-}"
if [[ -z "$python_bin" ]]; then
  for candidate in python3.13 python3.12 python3.11 python3; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c \
      'import sys; raise SystemExit(sys.version_info < (3, 11))'; then
      python_bin="$(command -v "$candidate")"
      break
    fi
  done
fi

if [[ -z "$python_bin" ]] || ! "$python_bin" -c \
  'import sys; raise SystemExit(sys.version_info < (3, 11))'; then
  echo 'Нужен Python 3.11 или новее. Можно передать путь через EDUKATOR_PYTHON.' >&2
  exit 1
fi

"$python_bin" -m venv "$venv_dir"
# Тестовая зависимость ставится сразу: гейт `npm run family:test` живёт в этом
# же окружении, а второй установки после первой ошибки никто не помнит.
"$venv_dir/bin/python" -m pip install --disable-pip-version-check -e "$controller_dir[test]"

echo "Контроллер установлен в $venv_dir"
