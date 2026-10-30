"""Project runs, immutable comparison revisions, review carryover and retries."""

from __future__ import annotations

import copy
import hashlib
import os
import shutil
import threading
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse

from PIL import Image

from .capture import Capture, validate_profile
from .engine import compare
from .storage import Store, atomic_json, identifier, now, read_json, valid_id
from .source import Sources, normalize_source
from .platform_support import acquire_lease, release_lease


class Service:
    def __init__(self, store: Store):
        self.store = store
        self.sources = Sources(store)
        self.inspection_lock = threading.Lock()
        self.lease = (store.root / ".service.lock").open("a+")
        try:
            acquire_lease(self.lease)
        except BlockingIOError as error:
            self.lease.close()
            raise RuntimeError("같은 저장 위치를 사용하는 검수 서비스가 이미 실행 중입니다.") from error
        self.capture = Capture()
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="visual-qa")
        self.active: set[str] = set()
        self.lock = threading.RLock()
        self.store.recover_interrupted()

    def close(self) -> None:
        self.capture.stop()
        self.executor.shutdown(wait=False, cancel_futures=True)
        if not self.active and not self.lease.closed:
            release_lease(self.lease)
            self.lease.close()

    def validate_project(self, value: dict) -> dict:
        project = copy.deepcopy(value)
        project["name"] = str(project.get("name", "")).strip()[:160]
        if not project["name"]:
            raise ValueError("프로젝트 이름을 입력하세요.")
        url = str(project.get("url", "")).strip()
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https", "file"} or (parsed.scheme != "file" and not parsed.hostname):
            raise ValueError("http://, https:// 또는 file:// 주소를 입력하세요.")
        project["url"] = url
        project["source"] = normalize_source(project.get("source"), url)
        targets = project.get("targets", [])
        if not isinstance(targets, list) or not 1 <= len(targets) <= 8:
            raise ValueError("검수 대상은 1~8개여야 합니다.")
        seen = set()
        enabled = 0
        for target in targets:
            target["id"] = valid_id(target.get("id", ""))
            if target["id"] in seen:
                raise ValueError("검수 대상 이름이 중복되었습니다.")
            seen.add(target["id"])
            target["name"] = str(target.get("name", target["id"]))[:80]
            target["enabled"] = bool(target.get("enabled", True))
            enabled += target["enabled"]
            for key, default, low, high in (("width", 390, 240, 3840), ("viewport_height", 844, 320, 2160)):
                number = target.get(key, default)
                if not isinstance(number, int) or not low <= number <= high:
                    raise ValueError(f"{target['name']}의 크기 설정을 확인하세요.")
                target[key] = number
            if target["enabled"]:
                if not target.get("asset_id"):
                    raise ValueError(f"{target['name']} 시안을 선택하세요.")
                self.store.asset(target.get("asset_id", ""))
            target["normalize"] = bool(target.get("normalize", True))
        if not enabled:
            raise ValueError("검수 대상을 하나 이상 선택하세요.")
        project["profile"] = validate_profile(project.get("profile"))
        settings = project.get("settings", {})
        project["settings"] = {"pixel_threshold": settings.get("pixel_threshold", 24),
                               "font_tolerance": settings.get("font_tolerance", 1),
                               "strip_height": settings.get("strip_height", 600)}
        s = project["settings"]
        if not isinstance(s["pixel_threshold"], int) or not 1 <= s["pixel_threshold"] <= 255:
            raise ValueError("색상 허용값은 1~255여야 합니다.")
        if s["font_tolerance"] not in (0, 1, 2) or not isinstance(s["strip_height"], int) or not 64 <= s["strip_height"] <= 4000:
            raise ValueError("텍스트 허용치 또는 구간 높이를 확인하세요.")
        if project.get("id"):
            valid_id(project["id"])
        return project

    def save_project(self, value: dict) -> dict:
        with self.lock:
            return self.store.save_project(self.validate_project(value))

    def source_links(self, run_id: str, target_id: str, revision_id: str, selector: str) -> dict:
        run = self.store.run(run_id)
        result = self.store.result(run_id, target_id, revision_id)
        selectors = {e["selector"] for e in result["capture"].get("domElements", [])}
        if not isinstance(selector, str) or selector not in selectors:
            raise ValueError("캡처된 요소를 선택하세요.")
        project = self.store.project(run["project_id"])
        if project["url"] != run["project"]["url"]:
            raise ValueError("프로젝트의 주소가 변경되었습니다. 새 검수 후 요소를 선택하세요.")
        self.sources.config(project["id"])
        if not self.inspection_lock.acquire(blocking=False):
            raise ValueError("다른 요소의 소스를 확인하고 있습니다. 잠시 후 다시 선택하세요.")
        try:
            target = next(t for t in run["project"]["targets"] if t["id"] == target_id)
            with tempfile.TemporaryDirectory(prefix="visualqa-source-") as temporary:
                inspection = self.capture.run(project["url"], target, run["project"]["profile"], Path(temporary), selector)
            return self.sources.resolve(project["id"], inspection)
        finally:
            self.inspection_lock.release()

    def edit_source(self, project_id: str, path: str, sha256: str, content: str | None = None,
                    backup_id: str | None = None, connection_id: str | None = None) -> dict:
        with self.lock:
            if connection_id is not None:
                self.sources.check_connection(project_id, connection_id)
            if self.inspection_lock.locked() or any(self.store.run(key)["project_id"] == project_id for key in self.active):
                raise ValueError("캡처·요소 확인이 끝난 뒤 소스를 저장하세요.")
            if backup_id:
                return self.sources.restore(project_id, backup_id, sha256)
            return self.sources.save(project_id, path, sha256, content)

    def start(self, project_id: str) -> dict:
        project = self.validate_project(self.store.project(project_id))
        with self.lock:
            if any(self.store.run(r)["project_id"] == project_id for r in self.active):
                raise ValueError("이 프로젝트의 검수가 진행 중입니다.")
            run = {"id": identifier(), "project_id": project_id, "project": project,
                   "created_at": now(), "status": "queued", "targets": {}}
            for target in project["targets"]:
                if target["enabled"]:
                    run["targets"][target["id"]] = {"name": target["name"], "status": "queued",
                                                     "attempts": [], "revisions": []}
            self.store.save_run(run)
            self._submit(run["id"], lambda: self._run(run["id"]))
            return run

    def _submit(self, key: str, function) -> None:
        if key in self.active:
            raise ValueError("이미 처리 중입니다.")
        self.active.add(key)
        def task():
            try:
                function()
            finally:
                with self.lock:
                    self.active.discard(key)
        self.executor.submit(task)

    def _target_update(self, run_id: str, target_id: str, **changes) -> None:
        with self.store.lock:
            run = self.store.run(run_id)
            run["targets"][target_id].update(changes)
            self.store.save_run(run)

    def retry(self, run_id: str) -> dict:
        with self.lock:
            run = self.store.run(run_id)
            targets = [key for key, value in run["targets"].items() if value["status"] in {"failed", "interrupted"}]
            if not targets:
                raise ValueError("재시도할 실패 항목이 없습니다.")
            if run_id in self.active:
                raise ValueError("이미 처리 중입니다.")
            for target_id in targets:
                run["targets"][target_id]["status"] = "queued"
            run["status"] = "queued"
            self.store.save_run(run)
            self._submit(run_id, lambda: self._run(run_id, targets))
            return run

    def _run(self, run_id: str, only: list[str] | None = None) -> None:
        run = self.store.run(run_id)
        run["status"] = "running"
        self.store.save_run(run)
        for target in run["project"]["targets"]:
            target_id = target["id"]
            if target_id not in run["targets"] or (only is not None and target_id not in only):
                continue
            attempt_id = identifier()
            directory = self.store.run_path(run_id) / "targets" / target_id / "attempts" / attempt_id
            item = self.store.run(run_id)["targets"][target_id]
            attempts = item["attempts"] + [{"id": attempt_id, "started_at": now(), "status": "capturing"}]
            self._target_update(run_id, target_id, status="capturing", error=None, attempts=attempts)
            try:
                metadata = self.capture.run(run["project"]["url"], target, run["project"]["profile"], directory)
                self._target_update(run_id, target_id, status="comparing", current_attempt=attempt_id)
                revision_id = self._revision(run_id, target_id, 0, "최초 비교", metadata, directory)
                attempts[-1].update(status="complete", finished_at=now())
                self._target_update(run_id, target_id, status="complete", current_revision=revision_id, attempts=attempts)
            except Exception as error:
                attempts[-1].update(status="failed", finished_at=now(), error=str(error))
                self._target_update(run_id, target_id, status="failed", error=str(error), attempts=attempts)
        with self.store.lock:
            run = self.store.run(run_id)
            complete = sum(t["status"] == "complete" for t in run["targets"].values())
            run["status"] = "complete" if complete == len(run["targets"]) else "partial" if complete else "failed"
            run["finished_at"] = now()
            self.store.save_run(run)

    def recalculate(self, run_id: str, target_id: str, offset: int, reason: str) -> dict:
        with self.lock:
            run = self.store.run(run_id)
            target_id = valid_id(target_id)
            target = run["targets"][target_id]
            if target["status"] != "complete" or run_id in self.active:
                raise ValueError("완료된 항목만 위치를 보정할 수 있습니다.")
            if not isinstance(offset, int) or abs(offset) > 10000:
                raise ValueError("Y 보정값은 -10000~10000px의 정수여야 합니다.")
            if not str(reason).strip():
                raise ValueError("보정 이유를 입력하세요.")
            self._target_update(run_id, target_id, status="comparing", error=None)
            def action():
                try:
                    directory = self.store.run_path(run_id) / "targets" / target_id / "attempts" / target["current_attempt"]
                    revision_id = self._revision(run_id, target_id, offset, str(reason)[:1000],
                                                 read_json(directory / "actual.png.json"), directory)
                    self._target_update(run_id, target_id, status="complete", current_revision=revision_id)
                except Exception as error:
                    # Previously committed revision remains viewable and unmodified.
                    self._target_update(run_id, target_id, status="complete", error=f"재계산 실패: {error}")
            self._submit(run_id, action)
            return self.store.run(run_id)

    def _previous(self, run: dict, target_id: str) -> tuple[dict | None, dict | None]:
        current = run["targets"][target_id]
        if current.get("current_revision"):
            return self.store.result(run["id"], target_id), run
        for previous in self.store.runs(run["project_id"]):
            if previous["id"] == run["id"] or previous["created_at"] >= run["created_at"]:
                continue
            if previous["targets"].get(target_id, {}).get("current_revision"):
                return self.store.result(previous["id"], target_id), previous
        return None, None

    def _revision(self, run_id: str, target_id: str, offset: int, reason: str, metadata: dict, directory: Path) -> str:
        run = self.store.run(run_id)
        target = next(t for t in run["project"]["targets"] if t["id"] == target_id)
        asset = self.store.asset(target["asset_id"])
        revision_id = identifier()
        final = self.store.revision_path(run_id, target_id, revision_id)
        temporary = final.with_name(".building-" + revision_id)
        temporary.mkdir(parents=True)
        try:
            with Image.open(self.store.asset_path(target["asset_id"])) as image:
                reference = image.convert("RGB")
            with Image.open(directory / "actual.png") as image:
                actual = image.convert("RGB")
            width = actual.width
            scale = width / reference.width
            if reference.width != width:
                if not target["normalize"]:
                    raise ValueError(f"시안 폭 {reference.width}px와 캡처 폭 {width}px가 다릅니다. 시안 배율 설정을 확인하세요.")
                reference = reference.resize((width, max(1, round(reference.height * scale))), Image.Resampling.LANCZOS)
            result = compare(reference, actual, metadata, run["project"]["settings"], temporary, offset)
            if any(metadata.get(key) for key in ("brokenImages", "httpErrors", "consoleErrors", "resourceFailures")):
                if result["metrics"]["verdict"] == "PASS":
                    result["metrics"]["verdict"] = "REVIEW"
            signature = hashlib.sha256(str((target["asset_id"], width, run["project"]["url"],
                                            run["project"]["profile"], run["project"]["settings"])).encode()).hexdigest()
            result.update(id=revision_id, run_id=run_id, target_id=target_id, created_at=now(),
                          y_offset=offset, reason=reason, asset=asset, reference_scale=scale,
                          baseline_signature=signature, settings=run["project"]["settings"], capture=metadata)
            previous, previous_run = self._previous(run, target_id)
            reviews = {}
            history = {"compatible": False, "previous_run": None, "new": [], "persisting": [], "not_detected": []}
            if previous:
                history["previous_run"] = previous_run["id"]
                history["previous_revision"] = previous["id"]
                history["compatible"] = previous.get("baseline_signature") == signature
                if history["compatible"]:
                    old = {f["id"]: f for f in previous["findings"]}
                    new = {f["id"]: f for f in result["findings"]}
                    for finding in result["findings"]:
                        previous_finding = old.get(finding["id"])
                        prior_review = previous.get("reviews", {}).get(finding["id"])
                        if previous_finding:
                            history["persisting"].append(finding["id"])
                            if prior_review:
                                finding["previous_review"] = prior_review
                                if previous_finding["evidence"] == finding["evidence"] and prior_review["status"] != "resolved":
                                    reviews[finding["id"]] = prior_review
                        else:
                            history["new"].append(finding["id"])
                    history["not_detected"] = [{"id": f["id"], "rect": f["rect"], "title": f["title"],
                                                "previous_review": previous.get("reviews", {}).get(f["id"])}
                                               for f in previous["findings"] if f["id"] not in new]
            result["history"] = history
            atomic_json(temporary / "result.json", result)
            atomic_json(temporary / "reviews.json", reviews)
            atomic_json(temporary / "review-history.json", [])
            os.replace(temporary, final)
            with self.store.lock:
                fresh = self.store.run(run_id)
                fresh["targets"][target_id]["revisions"].append({"id": revision_id, "created_at": result["created_at"],
                                                               "y_offset": offset, "reason": reason})
                self.store.save_run(fresh)
            return revision_id
        except Exception:
            shutil.rmtree(temporary, ignore_errors=True)
            raise

    def prune(self, project_id: str, keep: int) -> list[str]:
        if not isinstance(keep, int) or keep < 1:
            raise ValueError("완료 이력은 최소 한 개 이상 보관해야 합니다.")
        removed = []
        with self.lock, self.store.lock:
            runs = [r for r in self.store.runs(project_id) if r["status"] == "complete"]
            for run in runs[keep:]:
                if run["id"] in self.active:
                    continue
                shutil.rmtree(self.store.run_path(run["id"]))
                removed.append(run["id"])
        return removed
