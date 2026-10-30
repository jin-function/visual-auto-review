#!/usr/bin/env python3
"""App entrypoint and compatible command-line capture entrypoint."""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from qa.capture import default_profile
from qa.export import report
from qa.service import Service
from qa.storage import Store


def cli(arguments: list[str]) -> int:
    parser = argparse.ArgumentParser(description="시안 검수 v3")
    parser.add_argument("--url", required=True)
    parser.add_argument("--mobile-design", type=Path)
    parser.add_argument("--pc-design", type=Path)
    parser.add_argument("--mobile-width", type=int, default=390)
    parser.add_argument("--pc-width", type=int, default=1920)
    parser.add_argument("--capture-height", type=int, default=844)
    parser.add_argument("--source-html", type=Path)
    parser.add_argument("--output", type=Path, default=Path("visual-qa-results-v3"))
    parser.add_argument("--pixel-threshold", type=int, default=24)
    parser.add_argument("--font-tolerance", type=int, choices=(0, 1, 2), default=1)
    parser.add_argument("--strip-height", type=int, default=600)
    parser.add_argument("--warn-ratio", type=float, default=.08, help="이전 버전 호환 옵션. v3에서는 최종 판정에 사용하지 않습니다.")
    parser.add_argument("--fail-ratio", type=float, default=.20, help="이전 버전 호환 옵션. v3에서는 최종 판정에 사용하지 않습니다.")
    parser.add_argument("--replace-results", action="store_true", help="이전 버전 호환 옵션. 기존 결과를 삭제하지 않습니다.")
    parser.add_argument("--profile", type=Path, help="페이지별 캡처 설정 JSON")
    args = parser.parse_args(arguments)
    if not args.mobile_design and not args.pc_design:
        parser.error("모바일 또는 PC 시안이 필요합니다.")
    service = Service(Store(args.output))
    try:
        targets = []
        for name, path, width in (("mobile", args.mobile_design, args.mobile_width), ("pc", args.pc_design, args.pc_width)):
            if path:
                asset = service.store.import_asset(path.expanduser().read_bytes(), path.name)
                targets.append({"id": name, "name": "모바일" if name == "mobile" else "PC", "asset_id": asset["id"],
                                "enabled": True, "width": width, "viewport_height": args.capture_height, "normalize": True})
        profile = json.loads(args.profile.read_text(encoding="utf-8")) if args.profile else default_profile()
        project = service.save_project({"name": args.url, "url": args.url, "targets": targets, "profile": profile,
                                        "source_html": str(args.source_html) if args.source_html else None,
                                        "settings": {"pixel_threshold": args.pixel_threshold, "font_tolerance": args.font_tolerance,
                                                     "strip_height": args.strip_height}})
        if args.replace_results:
            print("안내: v3에서는 이전 결과 삭제 옵션을 무시하고 실행별 이력을 보존합니다.")
        run = service.start(project["id"])
        while run["status"] in {"queued", "running"}:
            time.sleep(.1)
            run = service.store.run(run["id"])
        for target_id, target in run["targets"].items():
            if target.get("current_revision"):
                result = service.store.result(run["id"], target_id)
                directory = service.store.revision_path(run["id"], target_id, result["id"])
                (directory / "report.html").write_text(report(result, target["name"]), encoding="utf-8")
                print(f"{target_id}: {result['metrics']['verdict']} / 차이 {result['metrics']['changed_ratio']:.2%}")
                print(f"  보고서: {directory / 'report.html'}")
            else:
                print(f"{target_id}: 실패 / {target.get('error', '')}", file=sys.stderr)
        return 0 if run["status"] == "complete" else 1
    except (ValueError, RuntimeError, OSError) as error:
        print(f"오류: {error}", file=sys.stderr)
        return 1
    finally:
        service.close()


if __name__ == "__main__":
    if "--serve" in sys.argv:
        from qa.server import main
        raise SystemExit(main([a for a in sys.argv[1:] if a != "--serve"]))
    raise SystemExit(cli(sys.argv[1:]))
