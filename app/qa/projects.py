"""Project validation and legacy configuration normalization."""
import copy
from urllib.parse import urlparse
from .capture import validate_profile
from .source import normalize_source
from .storage import valid_id
from .contract import responsive_config, target_device


class Projects:
    def __init__(self, store):
        self.store = store

    def validate(self, value: dict) -> dict:
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
        for target in targets:
            if target.get("device") not in (None, "pc", "mo"):
                raise ValueError("검수 대상 종류는 PC 또는 MO여야 합니다.")
            target["device"] = target_device(target)
        project["responsive"] = responsive_config(project)
        if project.get("id"):
            valid_id(project["id"])
        return project
