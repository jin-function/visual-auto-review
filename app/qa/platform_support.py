"""Operating-system details shared by the native and portable launchers."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path


def default_data_root() -> Path:
    if sys.platform == 'win32':
        return Path(os.environ.get('LOCALAPPDATA', str(Path.home() / 'AppData/Local'))) / 'VisualQA/v3'
    return Path.home() / 'Library/Application Support/VisualQA/v3'


def acquire_lease(stream) -> None:
    if sys.platform == 'win32':
        import msvcrt
        stream.seek(0, os.SEEK_END)
        if not stream.tell():
            stream.write('\0'); stream.flush()
        stream.seek(0)
        try:
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as error:
            raise BlockingIOError('검수 데이터가 사용 중입니다.') from error
    else:
        import fcntl
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)


def release_lease(stream) -> None:
    if sys.platform == 'win32':
        import msvcrt
        stream.seek(0); msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        import fcntl
        fcntl.flock(stream, fcntl.LOCK_UN)


def browser_candidates() -> list[str | None]:
    candidates = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        str(Path.home() / 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ]
    if sys.platform == 'win32':
        bases = [os.environ.get(name) for name in ('LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)')]
        candidates = [str(Path(base) / relative) for relative in (
            'Google/Chrome/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe'
        ) for base in bases if base]
    return [*candidates, shutil.which('google-chrome'), shutil.which('chromium')]


def open_document(path: str, line: int) -> None:
    if sys.platform == 'win32':
        candidates = [Path(base) / 'Microsoft VS Code/Code.exe' for base in (
            os.environ.get('PROGRAMFILES', ''), os.environ.get('PROGRAMFILES(X86)', '')
        ) if base]
        local = os.environ.get('LOCALAPPDATA')
        if local:
            candidates.insert(0, Path(local) / 'Programs/Microsoft VS Code/Code.exe')
        editor = next((candidate for candidate in candidates if candidate.is_file()), None)
        if editor:
            subprocess.Popen([str(editor), '--goto', f'{path}:{line}'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            os.startfile(path)
    else:
        editor = shutil.which('code') or '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'
        if Path(editor).is_file():
            subprocess.Popen([editor, '--goto', f'{path}:{line}'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            subprocess.run(['/usr/bin/open', '-t', path], check=True, timeout=15)
