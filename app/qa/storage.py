"""Local, atomic storage. A run never removes or overwrites another run."""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, UnidentifiedImageError


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def identifier() -> str:
    return uuid.uuid4().hex


def read_json(path: Path, default=None):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{identifier()}.tmp")
    try:
        with temporary.open("w", encoding="utf-8") as stream:
            os.chmod(temporary, 0o600)
            json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def valid_id(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", value):
        raise ValueError("식별자가 올바르지 않습니다.")
    return value


class Store:
    def __init__(self, root: Path):
        self.root = root.expanduser().resolve()
        self.lock = threading.RLock()
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        for name in ("projects", "assets", "runs"):
            (self.root / name).mkdir(parents=True, exist_ok=True)

    def project_path(self, project_id: str) -> Path:
        return self.root / "projects" / f"{valid_id(project_id)}.json"

    def run_path(self, run_id: str) -> Path:
        return self.root / "runs" / valid_id(run_id)

    def project(self, project_id: str) -> dict:
        result = read_json(self.project_path(project_id))
        if result is None:
            raise FileNotFoundError("프로젝트를 찾을 수 없습니다.")
        return result

    def projects(self) -> list[dict]:
        with self.lock:
            return sorted((read_json(p) for p in (self.root / "projects").glob("*.json")),
                          key=lambda p: p.get("updated_at", ""), reverse=True)

    def save_project(self, project: dict) -> dict:
        with self.lock:
            project = dict(project)
            project.setdefault("id", identifier())
            project.setdefault("created_at", now())
            project["updated_at"] = now()
            atomic_json(self.project_path(project["id"]), project)
            return project

    def import_asset(self, content: bytes, name: str) -> dict:
        if not content or len(content) > 80 * 1024 * 1024:
            raise ValueError("시안 파일은 80MB 이하여야 합니다.")
        try:
            with Image.open(io.BytesIO(content)) as image:
                if image.width * image.height > 100_000_000:
                    raise ValueError("시안은 1억 픽셀 이하여야 합니다.")
                image.load()
                width, height = image.size
                normalized = io.BytesIO()
                image.convert("RGB").save(normalized, "PNG", compress_level=1)
        except (UnidentifiedImageError, Image.DecompressionBombError) as error:
            raise ValueError("읽을 수 있는 JPG 또는 PNG 시안을 선택하세요.") from error
        asset_id = hashlib.sha256(content).hexdigest()
        metadata = {"id": asset_id, "name": Path(name).name[:240], "width": width,
                    "height": height, "sha256": asset_id, "created_at": now()}
        with self.lock:
            image_path = self.asset_path(asset_id)
            if not image_path.exists():
                temporary = image_path.with_suffix(".tmp")
                temporary.write_bytes(normalized.getvalue())
                os.replace(temporary, image_path)
                atomic_json(image_path.with_suffix(".json"), metadata)
            return read_json(image_path.with_suffix(".json"))

    def asset_path(self, asset_id: str) -> Path:
        return self.root / "assets" / f"{valid_id(asset_id)}.png"

    def asset(self, asset_id: str) -> dict:
        result = read_json(self.asset_path(asset_id).with_suffix(".json"))
        if result is None:
            raise FileNotFoundError("저장된 시안이 없습니다. 시안을 다시 선택하세요.")
        return result

    def save_run(self, run: dict) -> None:
        with self.lock:
            atomic_json(self.run_path(run["id"]) / "run.json", run)

    def run(self, run_id: str) -> dict:
        result = read_json(self.run_path(run_id) / "run.json")
        if result is None:
            raise FileNotFoundError("검수 이력을 찾을 수 없습니다.")
        return result

    def runs(self, project_id: str | None = None) -> list[dict]:
        with self.lock:
            items = [read_json(p) for p in (self.root / "runs").glob("*/run.json")]
            return sorted((r for r in items if not project_id or r["project_id"] == project_id),
                          key=lambda r: r["created_at"], reverse=True)

    def revision_path(self, run_id: str, target_id: str, revision_id: str) -> Path:
        return self.run_path(run_id) / "targets" / valid_id(target_id) / "revisions" / valid_id(revision_id)

    def result(self, run_id: str, target_id: str, revision_id: str | None = None) -> dict:
        run = self.run(run_id)
        target = run["targets"][valid_id(target_id)]
        revision_id = revision_id or target.get("current_revision")
        if not revision_id:
            raise FileNotFoundError("아직 생성된 비교 결과가 없습니다.")
        path = self.revision_path(run_id, target_id, revision_id)
        result = read_json(path / "result.json")
        if result is None:
            raise FileNotFoundError("비교 결과를 찾을 수 없습니다.")
        result["reviews"] = read_json(path / "reviews.json", {})
        return result

    def review(self, run_id: str, target_id: str, revision_id: str, finding_id: str,
               status: str, severity: str, note: str) -> dict:
        if status not in {"pending", "fix", "intentional", "resolved"}:
            raise ValueError("검수 상태가 올바르지 않습니다.")
        if severity not in {"low", "medium", "high"}:
            raise ValueError("심각도가 올바르지 않습니다.")
        with self.lock:
            result = self.result(run_id, target_id, revision_id)
            finding = next((f for f in result["findings"] if f["id"] == finding_id), None)
            if finding is None:
                raise FileNotFoundError("검수 항목을 찾을 수 없습니다.")
            path = self.revision_path(run_id, target_id, revision_id)
            reviews = result["reviews"]
            entry = {"status": status, "severity": severity, "note": str(note)[:10000],
                     "evidence": finding["evidence"], "updated_at": now()}
            reviews[finding_id] = entry
            events = read_json(path / "review-history.json", [])
            events.append({"finding_id": finding_id, **entry})
            atomic_json(path / "review-history.json", events)
            atomic_json(path / "reviews.json", reviews)
            return entry

    def recover_interrupted(self) -> None:
        for run in self.runs():
            if run["status"] in {"queued", "running"}:
                run["status"] = "interrupted"
                for target in run["targets"].values():
                    if target["status"] in {"queued", "capturing", "comparing"}:
                        target.update(status="interrupted", error="이전 실행이 중단되었습니다. 실패 항목 재시도로 이어갈 수 있습니다.")
                self.save_run(run)
