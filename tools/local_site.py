"""Serve a user-selected site directory only on this computer."""

import argparse
import functools
import http.server
import webbrowser
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('directory', nargs='?', type=Path)
    parser.add_argument('--port', type=int, default=5500)
    arguments = parser.parse_args()
    directory = arguments.directory
    if directory is None:
        text = input('검수할 사이트 폴더의 전체 경로를 입력하세요.\n> ').strip().strip('"').strip("'")
        directory = Path(text).expanduser()
    directory = directory.resolve(strict=True)
    if not directory.is_dir():
        raise ValueError('사이트 폴더를 선택하세요.')
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(directory))
    server = http.server.ThreadingHTTPServer(('127.0.0.1', arguments.port), handler)
    try:
        url = f'http://127.0.0.1:{server.server_port}/'
        print(f'로컬 사이트: {url}\n폴더: {directory}\n종료하려면 Ctrl+C를 누르세요.', flush=True)
        webbrowser.open(url)
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError) as error:
        print(f'로컬 사이트를 시작하지 못했습니다: {error}\n5500번을 이미 사용하는 서버가 있다면 그 서버 주소를 그대로 사용하세요.')
        raise SystemExit(1)
