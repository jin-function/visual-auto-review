"""Build and atomically commit comparison revisions independently of jobs."""
import hashlib
import os
import shutil
from pathlib import Path
from PIL import Image
from .engine import compare
from .storage import atomic_json, identifier, now
from .review_history import moved_candidates


class Revisions:
    def __init__(self, store):
        self.store = store

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


    def build(self, run_id: str, target_id: str, offset: int, reason: str, metadata: dict, directory: Path) -> str:
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
            profile = dict(run["project"]["profile"])
            if not profile.get("removeHidden"):
                profile.pop("removeHidden", None)  # Preserve pre-option comparisons when disabled.
            signature = hashlib.sha256(str((target["asset_id"], width, run["project"]["url"],
                                            profile, run["project"]["settings"])).encode()).hexdigest()
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
            history["moved_candidates"] = moved_candidates(result["findings"], previous) if previous and history["compatible"] else []
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
