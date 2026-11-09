"""Portable review handoff; no direct extension access to the authenticated service."""

from __future__ import annotations

import base64
import hashlib
import json
from urllib.parse import urlparse

from .storage import Store
from .contract import CONTRACT, responsive_config, target_device
from . import VERSION
from .coordinates import reference_placement, reference_rect


class MissingReviewDevices(ValueError):
    def __init__(self, missing: list[str], latest_complete: dict | None):
        names = "·".join(device.upper() for device in missing)
        super().__init__(f"선택한 검수 이력에 {names} 완료 결과가 없습니다.")
        self.missing = missing
        self.latest_complete = latest_complete


def review_targets(run: dict) -> tuple[dict, dict]:
    responsive = responsive_config(run["project"])
    targets = {device: responsive[device] for device in CONTRACT["devices"]
               if run["targets"].get(responsive[device], {}).get("current_revision")}
    return responsive, targets


def latest_complete_review(store: Store, current: dict) -> dict | None:
    for summary in store.run_summaries():
        if summary["project_id"] != current["project_id"] or summary["id"] == current["id"]:
            continue
        try:
            candidate = store.run(summary["id"])
            _, targets = review_targets(candidate)
        except (FileNotFoundError, ValueError):
            continue
        if len(targets) == len(CONTRACT["devices"]) and all(
                candidate["targets"][target]["status"] == "complete" for target in targets.values()):
            return {"run_id": candidate["id"], "created_at": candidate["created_at"]}
    return None


def chrome_review(store: Store, run_id: str, target_id: str, revision_id: str | None = None) -> dict:
    with store.lock:
        run = store.run(run_id)
        result = store.result(run_id, target_id, revision_id)
        metrics = result["metrics"]
        capture = result["capture"]
        url = capture.get("url") or run["project"]["url"]
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("Chrome 확장 도구는 인증 정보가 없는 HTTP·HTTPS 페이지에서 사용하세요. 로컬 HTML은 로컬 서버 주소로 검수하세요.")
        asset = result["asset"]
        image = store.asset_path(asset["id"]).read_bytes()
        if len(image) > 80 * 1024 * 1024:
            raise ValueError("Chrome용 시안 원본은 80MB 이하여야 합니다. 시안을 나눠 주세요.")
        target = run["targets"][target_id]
        return {
            "format": "visualqa.chrome-review", "version": 2, "imageRole": "reference-original",
            "name": f"{run['project']['name']} · {target['name']}",
            "url": url, "runId": run_id, "targetId": target_id, "revisionId": result["id"],
            "device": target_device(next(t for t in run["project"]["targets"] if t["id"] == target_id)),
            "viewportWidth": capture.get("innerWidth") or metrics["width"],
            "placement": reference_placement(capture, metrics),
            "display": {"width": metrics["width"], "height": metrics["reference_height"]},
            "image": {"mime": "image/png", "width": asset["width"], "height": asset["height"],
                      "sha256": hashlib.sha256(image).hexdigest(), "base64": base64.b64encode(image).decode("ascii")},
            "findings": [{"id": finding["id"], "title": finding["title"],
                          "rect": reference_rect(finding["rect"], metrics),
                          "selectors": [item["selector"] for item in finding["elements"]],
                          "review": result.get("reviews", {}).get(finding["id"]),
                          "kind": finding["kind"], "suggestedSeverity": finding["suggested_severity"]}
                         for finding in result["findings"]],
        }


def chrome_bundle(store: Store, run_id: str, target_id: str | None = None, revision_id: str | None = None,
                  *, require_both: bool = False) -> dict:
    """One immutable revision selection per device; never mix different runs."""
    with store.lock:
        run = store.run(run_id)
        responsive, available = review_targets(run)
        missing = [device for device in CONTRACT["devices"] if device not in available]
        if require_both and missing:
            raise MissingReviewDevices(missing, latest_complete_review(store, run))
        targets = []
        unavailable = [{"device": device, "reason": "검수 결과가 없습니다."} for device in missing]
        for selected in available.values():
            chosen_revision = revision_id if selected == target_id else run["targets"][selected]["current_revision"]
            review = chrome_review(store, run_id, selected, chosen_revision)
            if review["image"]["width"] * review["image"]["height"] > CONTRACT["maxImagePixels"]:
                raise ValueError("시안은 1억 픽셀 이하여야 합니다.")
            if len(review["findings"]) > CONTRACT["maxFindings"]:
                raise ValueError("차이 항목이 너무 많습니다. 캡처 범위를 나누세요.")
            targets.append(review)
        if not targets:
            raise ValueError("완료된 PC 또는 MO 검수 결과가 필요합니다.")
        identity = [(t["targetId"], t["revisionId"], t["image"]["sha256"]) for t in targets]
        package_id = hashlib.sha256(json.dumps([run_id, responsive, identity], sort_keys=True).encode()).hexdigest()
        return {"format": CONTRACT["format"], "version": CONTRACT["version"], "packageId": package_id,
                "coordinateSpace": CONTRACT["coordinateSpace"], "producer": {"appVersion": VERSION},
                "name": run["project"]["name"], "url": targets[0]["url"], "runId": run_id,
                "captureOptions": {"removeHidden": (run["project"].get("profile") or {}).get("removeHidden") is True},
                "responsive": {"breakpoint": responsive["breakpoint"]}, "targets": targets, "unavailable": unavailable}


def encoded_review(store: Store, run_id: str, target_id: str | None = None, revision_id: str | None = None,
                   *, require_both: bool = False) -> bytes:
    return json.dumps(chrome_bundle(store, run_id, target_id, revision_id, require_both=require_both), ensure_ascii=False,
                      allow_nan=False, separators=(",", ":")).encode("utf-8")
