"""Portable review handoff; no direct extension access to the authenticated service."""

from __future__ import annotations

import base64
import hashlib
import json
from urllib.parse import urlparse

from .storage import Store


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
        clip = capture.get("clip", {})
        target = run["targets"][target_id]
        return {
            "format": "visualqa.chrome-review", "version": 2, "imageRole": "reference-original",
            "name": f"{run['project']['name']} · {target['name']}",
            "url": url, "runId": run_id, "targetId": target_id, "revisionId": result["id"],
            "device": "mo" if target_id.lower() in {"mobile", "mo"} else "pc" if target_id.lower() in {"pc", "desktop"} else None,
            "viewportWidth": capture.get("innerWidth") or metrics["width"],
            "placement": {"x": clip.get("x", 0), "y": clip.get("y", 0) + metrics["reference_top"] - metrics["actual_top"]},
            "display": {"width": metrics["width"], "height": metrics["reference_height"]},
            "image": {"mime": "image/png", "width": asset["width"], "height": asset["height"],
                      "sha256": hashlib.sha256(image).hexdigest(), "base64": base64.b64encode(image).decode("ascii")},
            "findings": [{"id": finding["id"], "title": finding["title"],
                          "rect": {**finding["rect"], "y": finding["rect"]["y"] - metrics["reference_top"]},
                          "selectors": [item["selector"] for item in finding["elements"]]}
                         for finding in result["findings"]],
        }


def encoded_review(store: Store, run_id: str, target_id: str, revision_id: str | None = None) -> bytes:
    return json.dumps(chrome_review(store, run_id, target_id, revision_id), ensure_ascii=False,
                      allow_nan=False, separators=(",", ":")).encode("utf-8")
