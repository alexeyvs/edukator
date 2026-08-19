#!/usr/bin/env bash

set -euo pipefail

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$project_dir"

npm run build:web

export HOST='192.168.100.141'
# PIN родителя переменной больше не задаётся: он лежит хешем в control.db и
# ставится через `npm run parent -- pin`. Здесь остаётся только pepper, без
# которого сервер не сможет ни проверить PIN, ни завести новый, — и брать его
# из репозитория нельзя, поэтому он ожидается уже в окружении.
: "${EDUKATOR_PIN_PEPPER:?задайте EDUKATOR_PIN_PEPPER (от 16 знаков) перед запуском}"
exec npm run start:family
