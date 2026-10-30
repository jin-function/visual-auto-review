"""Portable, read-only reports generated from the same saved results."""

from __future__ import annotations

import html
import json
import zipfile
from pathlib import Path

from .storage import Store


def escape(value) -> str:
    return html.escape(str(value), quote=True)


def report(result: dict, name: str) -> str:
    metrics = result["metrics"]
    states = {"pending": "확인 필요", "fix": "수정 필요", "intentional": "의도된 차이", "resolved": "해결"}
    items = []
    for finding in result["findings"]:
        review = result.get("reviews", {}).get(finding["id"], {})
        rect = finding["rect"]
        selectors = ", ".join(e["selector"] for e in finding["elements"])
        items.append(f"""        <li>
            <p>
                {escape(finding['title'])} · Y {rect['y']}px · {states.get(review.get('status'), '확인 필요')}
            </p>
            <p>
                {escape(selectors)}
            </p>
            <p>
                {escape(review.get('note', ''))}
            </p>
        </li>""")
    return f"""<!doctype html>
<html lang="ko">
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>
            {escape(name)} 검수 결과
        </title>
        <style>
            body {{ margin: 32px; color: #172a3a; font: 15px/1.7 -apple-system, sans-serif; }}
            .images {{ display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 16px; align-items: start; }}
            img {{ width: 100%; height: auto; }}
            figure {{ margin: 0; }}
            li {{ border-bottom: 1px solid #ddd; }}
        </style>
    </head>
    <body>
        <h1>
            {escape(name)} 검수 결과
        </h1>
        <p>
            자동 판정 {metrics['verdict']} · 차이 {metrics['changed_ratio']:.2%} · 높이 차이 {metrics['height_delta']:+d}px · Y 보정 {metrics['y_offset']:+d}px.
        </p>
        <p>
            {escape(result['reason'])}
        </p>
        <p>
            내보낸 시점의 읽기 전용 결과입니다.
            원본 검수 상태와 보정 이력은 앱에 보존됩니다.
        </p>
        <div class="images">
            <figure>
                <figcaption>
                    시안
                </figcaption>
                <img src="reference.png" alt="시안">
            </figure>
            <figure>
                <figcaption>
                    실제 캡처
                </figcaption>
                <img src="actual.png" alt="실제 캡처">
            </figure>
            <figure>
                <figcaption>
                    차이
                </figcaption>
                <img src="diff.png" alt="차이 강조">
            </figure>
        </div>
        <ol>
{chr(10).join(items)}
        </ol>
    </body>
</html>
"""


def archive(store: Store, run_id: str, destination: Path) -> None:
    with store.lock:
        run = store.run(run_id)
        root = store.run_path(run_id)
        with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_STORED) as output:
            for path in root.rglob("*"):
                if path.is_file() and not any(part.startswith(".") for part in path.relative_to(root).parts):
                    output.write(path, path.relative_to(root).as_posix())
            links = []
            for target_id, target in run["targets"].items():
                if not target.get("current_revision"):
                    continue
                result = store.result(run_id, target_id)
                relative = f"targets/{target_id}/revisions/{result['id']}/report.html"
                output.writestr(relative, report(result, target["name"]))
                links.append(f'            <li>\n                <a href="{relative}">\n                    {escape(target["name"])}\n                </a>\n            </li>')
            output.writestr("index.html", """<!doctype html>
<html lang="ko">
    <head>
        <meta charset="utf-8">
        <title>
            검수 결과
        </title>
    </head>
    <body>
        <h1>
            검수 결과
        </h1>
        <ul>
""" + "\n".join(links) + "\n        </ul>\n    </body>\n</html>\n")
