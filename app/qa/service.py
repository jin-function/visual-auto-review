"""Project runs, immutable comparison revisions, review carryover and retries."""

from __future__ import annotations

import shutil
import threading
import tempfile
from pathlib import Path

from .capture import Capture
from .storage import Store, identifier, now, read_json, valid_id
from .source import Sources
from .platform_support import acquire_lease, release_lease
from .projects import Projects
from .revisions import Revisions
from .jobs import Jobs


class Service:
    def __init__(self, store: Store):
        self.store = store
        self.sources = Sources(store)
        self.projects = Projects(store)
        self.revisions = Revisions(store)
        self.inspection_lock = threading.Lock()
        self.lease = (store.root / ".service.lock").open("a+")
        try:
            acquire_lease(self.lease)
        except BlockingIOError as error:
            self.lease.close()
            raise RuntimeError("같은 저장 위치를 사용하는 검수 서비스가 이미 실행 중입니다.") from error
        self.capture = Capture()
        self.lock = threading.RLock()
        self.jobs = Jobs(self._shutdown_finished)
        self.executor = self.jobs.executor
        self.active = self.jobs.active
        self.store.recover_interrupted()

    def _shutdown_finished(self) -> None:
        with self.lock:
            self.store.recover_interrupted()
            if not self.lease.closed:
                release_lease(self.lease)
                self.lease.close()

    def close(self) -> None:
        with self.lock:
            self.capture.stop()
            self.jobs.close()

    def validate_project(self, value: dict) -> dict:
        return self.projects.validate(value)

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
            if self.jobs.closed:
                raise ValueError("검수 서비스가 종료 중입니다.")
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
        self.jobs.submit(key, function)

    def _target_update(self, run_id: str, target_id: str, **changes) -> None:
        with self.store.lock:
            run = self.store.run(run_id)
            run["targets"][target_id].update(changes)
            self.store.save_run(run)

    def retry(self, run_id: str) -> dict:
        with self.lock:
            if self.jobs.closed:
                raise ValueError("검수 서비스가 종료 중입니다.")
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
            if self.jobs.closed:
                raise ValueError("검수 서비스가 종료 중입니다.")
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


    def _revision(self, *args, **kwargs) -> str:
        return self.revisions.build(*args, **kwargs)
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
