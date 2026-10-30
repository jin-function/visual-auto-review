#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RUNTIME="$SCRIPT_DIR/runtime"
PYTHON="${VISUAL_QA_PYTHON:-$RUNTIME/python/bin/python3.12}"
NODE="${VISUAL_QA_NODE:-$RUNTIME/node/bin/node}"
if [ ! -x "$PYTHON" ] || [ ! -x "$NODE" ]; then
    echo "앱에 포함된 실행 환경을 찾지 못했습니다." >&2
    exit 1
fi
if [ -z "${VISUAL_QA_PYTHON:-}" ]; then
    export PYTHONHOME="$RUNTIME/python"
fi
export PYTHONDONTWRITEBYTECODE=1
export PYTHONNOUSERSITE=1
export VISUAL_QA_NODE="$NODE"
exec "$PYTHON" "$SCRIPT_DIR/visual_qa.py" "$@"
