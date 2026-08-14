#!/usr/bin/env bash

set -euo pipefail

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$project_dir"

npm run build:web

export HOST='192.168.100.141'
export EDUKATOR_PARENT_PIN='000000'
exec npm run start:family
