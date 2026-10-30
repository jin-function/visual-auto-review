"""The only comparison engine, shared by first runs and all recalculations."""

from __future__ import annotations

import hashlib
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ENGINE_VERSION = "3.0.0"
MAX_PIXELS = 100_000_000


def _neighbor_delta(source: np.ndarray, target: np.ndarray, radius: int) -> np.ndarray:
    padded = np.pad(target, ((radius, radius), (radius, radius), (0, 0)), mode="edge")
    height, width = source.shape[:2]
    best = np.full((height, width), 255, dtype=np.int16)
    for dy in range(2 * radius + 1):
        for dx in range(2 * radius + 1):
            candidate = padded[dy:dy + height, dx:dx + width]
            np.minimum(best, np.abs(source - candidate).max(axis=2), out=best)
    return best


def _frame(image: Image.Image, size: tuple[int, int], top: int) -> Image.Image:
    if top == 0 and image.size == size:
        return image
    result = Image.new("RGB", size, "white")
    result.paste(image, (0, top))
    return result


def _rect(rect: dict, width: int, height: int, dy: int = 0) -> tuple[int, int, int, int]:
    left = max(0, min(width, math.floor(rect.get("x", 0))))
    top = max(0, min(height, math.floor(rect.get("y", 0) + dy)))
    right = max(left, min(width, math.ceil(rect.get("x", 0) + rect.get("width", 0))))
    bottom = max(top, min(height, math.ceil(rect.get("y", 0) + dy + rect.get("height", 0))))
    return left, top, right, bottom


def _related(rect: dict, elements: list[dict], changed: np.ndarray, dy: int) -> list[dict]:
    height, width = changed.shape
    candidates = []
    fx, fy = rect["x"], rect["y"]
    fr, fb = fx + rect["width"], fy + rect["height"]
    for element in elements:
        left, top, right, bottom = _rect(element.get("rect", {}), width, height, dy)
        if right <= left or bottom <= top or left >= fr or right <= fx or top >= fb or bottom <= fy:
            continue
        count = int(changed[max(top, fy):min(bottom, fb), max(left, fx):min(right, fr)].sum())
        if not count:
            continue
        area = (right - left) * (bottom - top)
        candidates.append((area, {"selector": element.get("selector", ""),
                                 "text": element.get("text", "")[:240],
                                 "tag": element.get("tag", ""), "styles": element.get("styles", {}),
                                 "rect": {"x": left, "y": top, "width": right - left, "height": bottom - top}}))
    candidates.sort(key=lambda item: item[0])
    selected = []
    for _, item in candidates:
        r = item["rect"]
        if any(r["x"] <= s["rect"]["x"] and r["y"] <= s["rect"]["y"] and
               r["x"] + r["width"] >= s["rect"]["x"] + s["rect"]["width"] and
               r["y"] + r["height"] >= s["rect"]["y"] + s["rect"]["height"] for s in selected):
            continue
        selected.append(item)
        if len(selected) == 3:
            break
    return selected


def compare(reference: Image.Image, actual: Image.Image, metadata: dict, settings: dict,
            output: Path, y_offset: int = 0) -> dict:
    threshold = int(settings.get("pixel_threshold", 24))
    radius = int(settings.get("font_tolerance", 1))
    strip_height = int(settings.get("strip_height", 600))
    if not 1 <= threshold <= 255 or radius not in (0, 1, 2) or not 64 <= strip_height <= 4000:
        raise ValueError("비교 설정 범위를 확인하세요.")
    if not isinstance(y_offset, int) or abs(y_offset) > 10000:
        raise ValueError("Y 보정값은 -10000~10000px의 정수여야 합니다.")
    if reference.width != actual.width:
        raise ValueError(f"비교 이미지 폭이 다릅니다: 시안 {reference.width}px, 캡처 {actual.width}px")
    if reference.mode != "RGB":
        reference = reference.convert("RGB")
    if actual.mode != "RGB":
        actual = actual.convert("RGB")
    origin = min(0, y_offset)
    ref_top, actual_top = -origin, y_offset - origin
    width = reference.width
    height = max(reference.height + ref_top, actual.height + actual_top)
    if width <= 0 or height <= 0 or width * height > MAX_PIXELS:
        raise ValueError("비교 영역은 1억 픽셀 이하여야 합니다. 캡처 범위를 나누어 주세요.")
    output.mkdir(parents=True, exist_ok=True)
    ref_frame = _frame(reference, (width, height), ref_top)
    actual_frame = _frame(actual, (width, height), actual_top)
    changed = np.zeros((height, width), dtype=bool)
    delta_rows = np.zeros(height, dtype=np.float64)
    text_mask = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(text_mask)
    for rect in metadata.get("textRects", []):
        left, top, right, bottom = _rect(rect, width, height, actual_top)
        if right > left and bottom > top:
            draw.rectangle((left, top, right - 1, bottom - 1), fill=255)
    geometry_rows = np.zeros(height, dtype=bool)
    rows = np.arange(height)
    geometry_rows[:] = ~((rows >= ref_top) & (rows < ref_top + reference.height) &
                         (rows >= actual_top) & (rows < actual_top + actual.height))
    diff = actual_frame.copy()
    for top in range(0, height, 512):
        bottom = min(height, top + 512)
        tile_top, tile_bottom = max(0, top - radius), min(height, bottom + radius)
        box = (0, tile_top, width, tile_bottom)
        ref_tile = ref_frame.crop(box)
        act_tile = actual_frame.crop(box)
        a = np.asarray(ref_tile, dtype=np.int16)
        b = np.asarray(act_tile, dtype=np.int16)
        delta = np.abs(a - b).max(axis=2)
        if radius and metadata.get("textRects"):
            # RGB tuples must match a real neighboring pixel in BOTH directions.
            # Never apply the text tolerance to arbitrary images or geometry.
            text = np.asarray(text_mask.crop(box)) > 0
            allow = text & (delta >= threshold)
            if allow.any():
                edge = np.asarray(ref_tile.convert("L").filter(ImageFilter.MaxFilter(3)), dtype=np.int16)
                edge -= np.asarray(ref_tile.convert("L").filter(ImageFilter.MinFilter(3)), dtype=np.int16)
                allow &= edge >= threshold
                if allow.any():
                    ys, xs = np.nonzero(allow)
                    left, right = max(0, int(xs.min()) - radius), min(width, int(xs.max()) + radius + 1)
                    first, last = max(0, int(ys.min()) - radius), min(a.shape[0], int(ys.max()) + radius + 1)
                    region = np.s_[first:last, left:right]
                    forward = _neighbor_delta(a[region], b[region], radius)
                    reverse = _neighbor_delta(b[region], a[region], radius)
                    delta[region] = np.where(allow[region], np.minimum(delta[region], np.maximum(forward, reverse)), delta[region])
        start = top - tile_top
        delta = delta[start:start + bottom - top]
        delta[geometry_rows[top:bottom], :] = 255
        tile_changed = delta >= threshold
        changed[top:bottom] = tile_changed
        delta_rows[top:bottom] = delta.sum(axis=1)
        image_array = np.asarray(actual_frame.crop((0, top, width, bottom))).copy()
        image_array[tile_changed] = (255, 35, 70)
        diff.paste(Image.fromarray(image_array), (0, top))
    row_counts = changed.sum(axis=1)
    strips = []
    for top in range(0, height, strip_height):
        bottom = min(height, top + strip_height)
        count = int(row_counts[top:bottom].sum())
        strips.append({"top": top, "bottom": bottom, "changed_pixels": count,
                       "changed_ratio": count / ((bottom - top) * width),
                       "mean_delta": float(delta_rows[top:bottom].sum() / ((bottom - top) * width)),
                       "verdict": "REVIEW" if count else "PASS"})
    findings = []
    for strip in strips:
        top, bottom = strip["top"], strip["bottom"]
        if not strip["changed_pixels"]:
            continue
        active = np.flatnonzero(row_counts[top:bottom]) + top
        groups = []
        begin = previous = int(active[0])
        for value in active[1:]:
            value = int(value)
            if value - previous > 8 or geometry_rows[value] != geometry_rows[previous]:
                groups.append((begin, previous + 1))
                begin = value
            previous = value
        groups.append((begin, previous + 1))
        for start, end in groups:
            columns = np.flatnonzero(changed[start:end].any(axis=0))
            left, right = int(columns[0]), int(columns[-1]) + 1
            rect = {"x": left, "y": start, "width": right - left, "height": end - start}
            related = _related(rect, metadata.get("domElements", []), changed, actual_top)
            geometry = bool(geometry_rows[start:end].any())
            kind = "geometry" if geometry else "visual"
            key = f"{kind}:{start // strip_height}:{related[0]['selector'] if related else ''}:{start}:{left}"
            finding_id = hashlib.sha256(key.encode()).hexdigest()[:20]
            evidence = hashlib.sha256()
            evidence.update(str(rect).encode())
            evidence.update(ref_frame.crop((left, start, right, end)).tobytes())
            evidence.update(actual_frame.crop((left, start, right, end)).tobytes())
            evidence.update(str((settings, y_offset, ENGINE_VERSION)).encode())
            count = int(changed[start:end, left:right].sum())
            findings.append({"id": finding_id, "kind": kind, "rect": rect,
                             "title": "비교 영역 누락·추가" if geometry else "시각 차이 확인",
                             "changed_pixels": count, "changed_ratio": count / ((right - left) * (end - start)),
                             "elements": related, "evidence": evidence.hexdigest(),
                             "suggested_severity": "high" if geometry else "medium"})
    geometry_count = int(geometry_rows.sum()) * width
    count = int(row_counts.sum())
    metrics = {"engine_version": ENGINE_VERSION, "width": width, "height": height,
               "reference_height": reference.height, "actual_height": actual.height,
               "height_delta": actual.height - reference.height, "y_offset": y_offset,
               "reference_top": ref_top, "actual_top": actual_top,
               "changed_pixels": count, "changed_ratio": count / (width * height),
               "mean_delta": float(delta_rows.sum() / (width * height)),
               "geometry_pixels": geometry_count, "font_tolerance": radius,
               "verdict": "FAIL" if geometry_count else "REVIEW" if count else "PASS",
               "verdict_notice": "자동 판정은 확인 필요 영역을 표시합니다. 최종 판단은 항목별 검수 상태로 관리합니다."}
    for name, image in (("reference.png", ref_frame), ("actual.png", actual_frame),
                        ("diff.png", diff), ("overlay.png", Image.blend(ref_frame, actual_frame, 0.5))):
        image.save(output / name, "PNG", compress_level=1)
    return {"metrics": metrics, "strips": strips, "findings": findings}
