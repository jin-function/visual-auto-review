#!/bin/sh
set -eu
cd -- "$(dirname -- "$0")"
if ! command -v python3.12 >/dev/null 2>&1; then
    echo 'Python 3.12를 먼저 설치하세요. README.md의 처음 설정을 확인하세요.'
    read -r ignored
    exit 1
fi
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python start.py --check
printf '\n처음 설정을 완료했습니다. start-macos.command로 실행하세요.\n'
read -r ignored
