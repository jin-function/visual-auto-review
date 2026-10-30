"""Start the same local review workspace on Windows and macOS."""
from __future__ import annotations

import argparse
import importlib.util
import os
import shutil
import signal
import subprocess
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / 'app'))


def main() -> int:
    parser = argparse.ArgumentParser(description='시안 검수 실행')
    parser.add_argument('--check', action='store_true', help='실행 환경만 확인')
    parser.add_argument('--no-open', action='store_true', help='브라우저를 자동으로 열지 않음')
    parser.add_argument('--data-root', type=Path)
    parser.add_argument('--ready-file', type=Path)
    args = parser.parse_args()
    if sys.version_info < (3, 11):
        raise RuntimeError('Python 3.12를 설치하고 처음 설정을 다시 실행하세요.')
    for module in ('numpy', 'PIL'):
        if importlib.util.find_spec(module) is None:
            raise RuntimeError('필요한 라이브러리가 없습니다. 운영체제에 맞는 setup 파일을 먼저 실행하세요.')
    node = os.environ.get('VISUAL_QA_NODE') or shutil.which('node')
    if not node:
        raise RuntimeError('Node.js 22 이상을 설치한 뒤 이 창을 닫고 다시 실행하세요.')
    node_version = subprocess.check_output([node, '--version'], text=True, encoding='utf-8').strip()
    if int(node_version.removeprefix('v').split('.')[0]) < 22:
        raise RuntimeError('Node.js 22 이상이 필요합니다.')
    os.environ['VISUAL_QA_NODE'] = node
    from qa.capture import chrome_path
    from qa.platform_support import default_data_root
    from qa.server import Server
    from qa.service import Service
    from qa.storage import Store, atomic_json
    browser = chrome_path()
    if args.check:
        print(f'실행 환경 확인 완료 · Python {sys.version.split()[0]} · Node {node_version} · 브라우저 {Path(browser).name}')
        return 0
    data_root = args.data_root or Path(os.environ.get('VISUAL_QA_DATA_ROOT', str(default_data_root())))
    service = Service(Store(data_root))
    server = None
    try:
        server = Server(('127.0.0.1', 0), service)
        url = f'{server.origin}/?token={server.token}'
        if args.ready_file:
            atomic_json(args.ready_file, {'url': url, 'pid': os.getpid()})
        def stop(*_args):
            service.close()
            threading.Thread(target=server.shutdown, daemon=True).start()
        for name in ('SIGINT', 'SIGTERM', 'SIGBREAK'):
            value = getattr(signal, name, None)
            if value is not None:
                signal.signal(value, stop)
        if not args.no_open:
            subprocess.Popen([browser, '--new-window', url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print(f'검수 페이지: {url}\n이 창을 열어 두세요. 종료하려면 Ctrl+C를 누릅니다.', flush=True)
        server.serve_forever(poll_interval=.2)
    finally:
        service.close()
        if server:
            server.server_close()
        if args.ready_file:
            args.ready_file.unlink(missing_ok=True)
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (RuntimeError, OSError, ValueError) as error:
        print(f'실행하지 못했습니다.\n{error}', file=sys.stderr)
        raise SystemExit(1)
