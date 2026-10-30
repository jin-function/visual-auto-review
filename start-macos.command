#!/bin/sh
set -eu
cd -- "$(dirname -- "$0")"
if [ ! -x .venv/bin/python ]; then
    echo 'setup-macos.command를 먼저 실행하세요.'
    read -r ignored
    exit 1
fi
.venv/bin/python start.py || { read -r ignored; exit 1; }
