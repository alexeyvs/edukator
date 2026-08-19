#!/usr/bin/env bash

set -euo pipefail

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$project_dir"

npm run build:web

# Адрес в домашней сети. Учтите: cookie входа несут префикс `__Host-`, который
# браузер принимает только с `Secure`, то есть по HTTPS (`localhost` — исключение).
# По голому http на этот адрес войти не выйдет ни родителю, ни ученику, и
# `EDUKATOR_INSECURE_COOKIES=1` не помогает: он снимает `Secure`, но не меняет
# имя cookie. Браузером ходите либо с этой же машины по `localhost`, либо через
# обратный прокси с сертификатом (см. раздел «Запуск» в README).
export HOST='192.168.100.141'
# PIN родителя переменной больше не задаётся: он лежит хешем в control.db и
# ставится через `npm run parent -- pin`. Здесь остаётся только pepper, без
# которого сервер не сможет ни проверить PIN, ни завести новый, — и брать его
# из репозитория нельзя, поэтому он ожидается уже в окружении.
: "${EDUKATOR_PIN_PEPPER:?задайте EDUKATOR_PIN_PEPPER (от 16 знаков) перед запуском}"
exec npm run start:family
