"""Capture process ownership, diagnostics and bounded failure handling."""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import threading
import sys
from pathlib import Path

from .storage import atomic_json, read_json
from .platform_support import browser_candidates

APP_ROOT = Path(__file__).resolve().parents[1]


def executable(environment: str, candidates: list[str | None]) -> str:
    for candidate in [os.environ.get(environment), *candidates]:
        if candidate and Path(candidate).is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    raise RuntimeError(f"실행 파일을 찾을 수 없습니다: {environment}")


def chrome_path() -> str:
    return executable("VISUAL_QA_CHROME", browser_candidates())


class Capture:
    def __init__(self):
        self.lock = threading.Lock()
        self.children: set[subprocess.Popen] = set()
        self.cancelled = threading.Event()

    def stop(self) -> None:
        self.cancelled.set()
        with self.lock:
            processes = list(self.children)
        for process in processes:
            self._terminate(process)

    @staticmethod
    def _terminate(process: subprocess.Popen) -> None:
        if process.poll() is not None:
            return
        if sys.platform == 'win32':
            try:
                subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10, check=False)
                process.wait(timeout=3)
            except (OSError, subprocess.TimeoutExpired):
                process.kill()
            return
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=3)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def run(self, url: str, target: dict, profile: dict, directory: Path, selector: str | None = None) -> dict:
        if self.cancelled.is_set():
            raise RuntimeError("앱 종료로 캡처가 중단되었습니다.")
        directory.mkdir(parents=True, exist_ok=True)
        config = directory / "capture-config.json"
        atomic_json(config, profile)
        output = directory / ("inspection.json" if selector else "actual.png")
        node = executable("VISUAL_QA_NODE", [str(APP_ROOT / "runtime/node/node.exe"), str(APP_ROOT / "runtime/node/bin/node"), shutil.which("node")])
        command = [node, str(APP_ROOT / "capture_page.js"), chrome_path(), url,
                   str(target["width"]), str(target["viewport_height"]), str(output), str(config)]
        if selector:
            command.append(selector)
        options = {'creationflags': subprocess.CREATE_NEW_PROCESS_GROUP} if sys.platform == 'win32' else {'start_new_session': True}
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, encoding='utf-8', errors='replace', **options)
        with self.lock:
            self.children.add(process)
        try:
            stdout, stderr = process.communicate(timeout=profile["timeoutMs"] / 1000 + 25)
        except subprocess.TimeoutExpired as error:
            self._terminate(process)
            raise RuntimeError("캡처 시간이 초과되었습니다. 페이지 로딩 상태와 캡처 범위를 확인하세요.") from error
        finally:
            with self.lock:
                self.children.discard(process)
        (directory / "capture.log").write_text(stdout + stderr, encoding="utf-8")
        if process.returncode or not output.exists():
            raise RuntimeError((stderr or stdout or "캡처가 중단되었습니다.").strip()[-1800:])
        return read_json(output if selector else output.with_suffix(".png.json"))


def default_profile() -> dict:
    return read_json(APP_ROOT / "profiles.json")["default"]


def validate_profile(value: dict | None) -> dict:
    profile = default_profile()
    value = value or {}
    if not isinstance(value, dict) or set(value) - set(profile):
        raise ValueError("페이지 설정의 항목을 확인하세요.")
    profile.update(value)
    for key in ("toggleSelectors", "diagnosticRoots"):
        if not isinstance(profile[key], list) or not all(isinstance(s, str) and s.strip() for s in profile[key]):
            raise ValueError(f"{key}는 선택자 목록이어야 합니다.")
    # Empty toggle configuration would change legacy behavior; require explicit selectors.
    if not profile["toggleSelectors"]:
        raise ValueError("기존 아코디언 펼침 선택자는 비워둘 수 없습니다.")
    for key in ("readySelector", "captureSelector", "elementSelector", "name"):
        if not isinstance(profile[key], str) or len(profile[key]) > 5000:
            raise ValueError("페이지 선택자 설정을 확인하세요.")
    if not profile["readySelector"] or not profile["elementSelector"]:
        raise ValueError("준비 요소와 진단 요소 선택자가 필요합니다.")
    if not isinstance(profile["timeoutMs"], int) or not 10000 <= profile["timeoutMs"] <= 300000:
        raise ValueError("캡처 제한 시간은 10000~300000ms여야 합니다.")
    if not isinstance(profile["settleMs"], int) or not 100 <= profile["settleMs"] <= 2000:
        raise ValueError("안정화 확인 간격은 100~2000ms여야 합니다.")
    return profile
