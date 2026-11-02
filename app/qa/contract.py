"""Shared handoff limits and explicit project/device configuration."""
import json
from pathlib import Path

CONTRACT = json.loads((Path(__file__).resolve().parents[1] / "review-contract.json").read_text(encoding="utf-8"))


def target_device(target: dict) -> str:
    if target.get("device") in CONTRACT["devices"]:
        return target["device"]
    name = target["id"].lower()
    if name in {"mobile", "mo"}:
        return "mo"
    if name in {"desktop", "pc"}:
        return "pc"
    return "mo" if target["width"] < CONTRACT["defaultBreakpoint"] else "pc"


def responsive_config(project: dict) -> dict:
    value = project.get("responsive") or {}
    if not isinstance(value, dict):
        raise ValueError("반응형 시안 설정을 확인하세요.")
    breakpoint = value.get("breakpoint", CONTRACT["defaultBreakpoint"])
    if type(breakpoint) is not int or not 320 <= breakpoint <= 4096:
        raise ValueError("PC 전환 폭은 320~4096px 정수여야 합니다.")
    result = {"breakpoint": breakpoint}
    for device in CONTRACT["devices"]:
        candidates = [t for t in project["targets"] if t.get("enabled", True) and target_device(t) == device]
        selected = value.get(device)
        if selected and not any(t["id"] == selected for t in candidates):
            raise ValueError(f"{device.upper()} 오버레이에 사용할 검수 대상을 확인하세요.")
        defaults = [t for t in candidates if t["id"].lower() in ({"pc", "desktop"} if device == "pc" else {"mo", "mobile"})]
        if not selected and len(candidates) > 1 and len(defaults) != 1:
            raise ValueError(f"프로젝트 설정에서 {device.upper()} 오버레이 대상을 선택하세요.")
        result[device] = selected or ((defaults or candidates)[0]["id"] if candidates else None)
    return result
