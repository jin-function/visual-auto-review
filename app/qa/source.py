"""Explicitly linked local sources, exact locations, conflict-safe edits and backups."""

from __future__ import annotations

import hashlib
import json
import os
import stat
import tempfile
import threading
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlparse
from urllib.request import url2pathname

from .storage import Store, atomic_json, identifier, now, read_json

ALLOWED = {".html", ".htm", ".css"}
MAX_BYTES = 8 * 1024 * 1024
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}


def digest(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def normalize_source(value: dict | None, page_url: str) -> dict | None:
    if value is not None and not isinstance(value, dict):
        raise ValueError("소스 연결 설정을 확인하세요.")
    if not value or not value.get("root"):
        return None
    root = Path(value["root"]).expanduser().resolve(strict=True)
    if not root.is_dir():
        raise ValueError("소스 폴더를 확인하세요.")
    html = Path(value.get("html", "")).expanduser()
    path = (html if html.is_absolute() else root / html).resolve(strict=True)
    if not path.is_relative_to(root) or path.suffix.lower() not in {".html", ".htm"}:
        raise ValueError("소스 폴더 안의 HTML 파일을 선택하세요.")
    relative = path.relative_to(root).as_posix()
    prefix = str(value.get("url_prefix", "")).strip()
    page = urlparse(page_url)
    if not prefix and page.scheme in {"http", "https"}:
        page_path = unquote(page.path)
        prefix_path = page_path[:-len(relative)] if page_path.endswith(relative) else "/"
        prefix = f"{page.scheme}://{page.netloc}{prefix_path}"
    if prefix:
        parsed = urlparse(prefix)
        if parsed.scheme not in {"http", "https"} or parsed.netloc != page.netloc or parsed.scheme != page.scheme:
            raise ValueError("소스 URL 기준은 검수 페이지와 같은 출처여야 합니다.")
        prefix = prefix.rstrip("/") + "/"
    return {"root": str(root), "html": relative, "url_prefix": prefix}


class Document(HTMLParser):
    def __init__(self, text: str):
        super().__init__(convert_charrefs=True)
        self.nodes = []
        self.stack = []
        self.counts = {}
        self.line_offsets = [0]
        for index, char in enumerate(text):
            if char == "\n":
                self.line_offsets.append(index + 1)
        self.feed(text)

    def handle_starttag(self, tag, attributes):
        parent = self.stack[-1] if self.stack else None
        key = (id(parent), tag)
        self.counts[key] = self.counts.get(key, 0) + 1
        line, column = self.getpos()
        node = {"tag": tag, "attributes": dict(attributes), "parent": parent, "nth": self.counts[key],
                "line": line, "column": column + 1, "offset": self.line_offsets[line-1] + column}
        self.nodes.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attributes):
        self.handle_starttag(tag, attributes)
        if self.stack and self.stack[-1]["tag"] == tag:
            self.stack.pop()

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index]["tag"] == tag:
                del self.stack[index:]
                break

    @staticmethod
    def path(node):
        chain = []
        while node:
            if node["tag"] not in {"html", "head", "body", "tbody"}:
                chain.insert(0, (node["tag"], node["nth"]))
            node = node["parent"]
        return chain

    def locate(self, element: dict) -> dict | None:
        if element.get("id"):
            candidates = [n for n in self.nodes if n["attributes"].get("id") == element["id"] and n["tag"] == element["tag"]]
            if len(candidates) == 1:
                return candidates[0]
            if len(candidates) > 1:
                return None
        chain = [(p["tag"], p["nth"]) for p in element.get("path", []) if p["tag"] not in {"html", "head", "body", "tbody"}]
        matches = [n for n in self.nodes if chain and self.path(n) == chain]
        return matches[0] if len(matches) == 1 else None


class Sources:
    def __init__(self, store: Store):
        self.store = store
        self.lock = threading.RLock()

    def config(self, project_id: str) -> dict:
        project = self.store.project(project_id)
        value = project.get("source")
        if not value:
            raise ValueError("프로젝트 설정에서 소스 폴더와 HTML 파일을 먼저 연결하세요.")
        return normalize_source(value, project["url"])

    def connection(self, project_id: str) -> str:
        return digest(json.dumps(self.config(project_id), sort_keys=True).encode())

    def check_connection(self, project_id: str, expected: str) -> None:
        if self.connection(project_id) != expected:
            raise ValueError("소스 연결이 변경되었습니다. 파일을 다시 불러와 주세요.")

    def path(self, project_id: str, relative: str) -> Path:
        config = self.config(project_id)
        root = Path(config["root"])
        if not isinstance(relative, str) or Path(relative).is_absolute():
            raise ValueError("소스 폴더 안의 상대 경로를 사용하세요.")
        path = (root / relative).resolve(strict=True)
        if not path.is_relative_to(root) or path.suffix.lower() not in ALLOWED or not path.is_file():
            raise ValueError("연결한 폴더 안의 HTML·CSS만 편집할 수 있습니다.")
        if path.stat().st_size > MAX_BYTES:
            raise ValueError("편집할 파일은 8MB 이하여야 합니다.")
        return path

    def read(self, project_id: str, relative: str, line: int = 1) -> dict:
        path = self.path(project_id, relative)
        content = path.read_bytes()
        try:
            text = content.decode("utf-8-sig")
        except UnicodeDecodeError as error:
            raise ValueError("UTF-8로 저장된 HTML·CSS 파일만 앱 안에서 편집할 수 있습니다.") from error
        root = Path(self.config(project_id)["root"])
        canonical = path.relative_to(root).as_posix()
        index = read_json(self.store.root / "source-backups" / project_id / "index.json", {})
        backup_id = index.get(canonical)
        if backup_id:
            backup = read_json(self.store.root / "source-backups" / project_id / backup_id / "backup.json", {})
            if backup.get("absolute_path") != str(path):
                backup_id = None
        return {"path": path.relative_to(root).as_posix(), "absolute_path": str(path), "content": text.replace("\r\n", "\n"),
                "sha256": digest(content), "line": max(1, min(int(line), text.count("\n") + 1)), "backup_id": backup_id,
                "connection_id": self.connection(project_id)}

    def local_url(self, config: dict, url: str) -> Path | None:
        parsed = urlparse(url)
        root = Path(config["root"])
        if parsed.scheme == "file" and parsed.netloc in {"", "localhost"}:
            path = Path(url2pathname(parsed.path))
        else:
            prefix = urlparse(config.get("url_prefix", ""))
            prefix_path = unquote(prefix.path)
            if not prefix.netloc or parsed.netloc != prefix.netloc or parsed.scheme != prefix.scheme or not unquote(parsed.path).startswith(prefix_path):
                return None
            path = root / unquote(parsed.path)[len(prefix_path):]
        try:
            path = path.resolve(strict=True)
        except (OSError, ValueError):
            return None
        return path if path.is_relative_to(root) and path.suffix.lower() in ALLOWED and path.is_file() else None

    def resolve(self, project_id: str, inspection: dict) -> dict:
        config = self.config(project_id)
        main = self.read(project_id, config["html"])
        document = Document(main["content"])
        node = document.locate(inspection["element"])
        links = [{"path": main["path"], "line": node["line"] if node else 1, "kind": "html", "selector": inspection["selector"],
                  "exact": bool(node), "label": "HTML 요소" if node else "HTML 파일 · 위치 직접 확인"}]
        warnings = []
        if not node:
            warnings.append("원본 HTML에서 요소 위치를 확정하지 못했습니다. 동적으로 생성된 요소인지 확인하세요.")
        seen = set()
        for rule in inspection.get("rules", []):
            if rule.get("inline"):
                # Chrome's inline stylesheet ranges are relative to the style element.
                path = Path(config["root"]) / config["html"]
                lines = main["content"].splitlines(keepends=True)
                offset = sum(len(s) for s in lines[:rule["sheetStartLine"]]) + rule.get("sheetStartColumn", 0)
                close = main["content"].lower().find("</style", offset)
                text = main["content"][offset:close] if close >= offset else ""
                if digest(text.encode()) != rule["sheetHash"]:
                    warnings.append("일부 인라인 CSS는 현재 원본과 달라 위치 연결을 생략했습니다.")
                    continue
                line = rule["sheetStartLine"] + rule["line"]
            else:
                path = self.local_url(config, rule["url"])
                if path is None:
                    continue
                local = self.read(project_id, path.relative_to(Path(config["root"])).as_posix())
                if digest(local["content"].encode()) != rule["sheetHash"]:
                    warnings.append(f"{local['path']} 내용이 브라우저에서 적용된 CSS와 달라 위치 연결을 생략했습니다.")
                    continue
                line = rule["line"]
            relative = path.relative_to(Path(config["root"])).as_posix()
            key = (relative, line)
            if key in seen:
                continue
            seen.add(key)
            links.append({"path": relative, "line": line, "kind": "css", "exact": True,
                          "label": ("상위 요소 CSS" if rule["inherited"] else "적용 CSS") + " · " + rule["selector"],
                          "selector": rule["selector"], "properties": rule.get("properties", [])})
        return {"selector": inspection["selector"], "element": inspection["element"], "links": links,
                "warnings": list(dict.fromkeys(warnings)), "inspected_at": now()}

    def save(self, project_id: str, relative: str, expected_hash: str, text: str) -> dict:
        if not isinstance(text, str) or "\x00" in text or len(text.encode("utf-8")) > MAX_BYTES:
            raise ValueError("저장할 텍스트는 8MB 이하의 HTML·CSS여야 합니다.")
        with self.lock:
            path = self.path(project_id, relative)
            relative = path.relative_to(Path(self.config(project_id)["root"])).as_posix()
            original = path.read_bytes()
            if digest(original) != expected_hash:
                raise ValueError("다른 곳에서 파일이 변경되었습니다. 다시 불러온 뒤 변경 내용을 확인하세요.")
            normalized = text.replace("\r\n", "\n")
            if b"\r\n" in original:
                normalized = normalized.replace("\n", "\r\n")
            updated = normalized.encode("utf-8")
            if original.startswith(b"\xef\xbb\xbf"):
                updated = b"\xef\xbb\xbf" + updated
            if updated == original:
                return {**self.read(project_id, relative), "changed": False}
            backup_id = identifier()
            backup = self.store.root / "source-backups" / project_id / backup_id
            backup.mkdir(parents=True)
            (backup / "original.bin").write_bytes(original)
            metadata = {"id": backup_id, "project_id": project_id, "path": relative, "absolute_path": str(path),
                        "original_hash": digest(original), "saved_hash": digest(updated), "created_at": now()}
            atomic_json(backup / "backup.json", metadata)
            descriptor, temporary = tempfile.mkstemp(prefix=".visualqa-edit-", dir=path.parent)
            try:
                with os.fdopen(descriptor, "wb") as stream:
                    stream.write(updated); stream.flush(); os.fsync(stream.fileno())
                os.chmod(temporary, stat.S_IMODE(path.stat().st_mode))
                if path != self.path(project_id, relative) or digest(path.read_bytes()) != expected_hash:
                    raise ValueError("저장 직전에 파일이 변경되었습니다. 다시 불러와 주세요.")
                os.replace(temporary, path)
            finally:
                Path(temporary).unlink(missing_ok=True)
            index_path = self.store.root / "source-backups" / project_id / "index.json"
            index = read_json(index_path, {})
            index[relative] = backup_id
            atomic_json(index_path, index)
            return {**self.read(project_id, relative), "changed": True, "backup_id": backup_id}

    def restore(self, project_id: str, backup_id: str, expected_hash: str) -> dict:
        from .storage import valid_id
        backup = self.store.root / "source-backups" / valid_id(project_id) / valid_id(backup_id)
        metadata = read_json(backup / "backup.json")
        if metadata is None:
            raise FileNotFoundError("수정 전 백업을 찾지 못했습니다.")
        if str(self.path(project_id, metadata["path"])) != metadata["absolute_path"]:
            raise ValueError("백업 이후 소스 연결이 변경되어 다른 파일에 복원할 수 없습니다.")
        content = (backup / "original.bin").read_bytes()
        return self.save(project_id, metadata["path"], expected_hash, content.decode("utf-8-sig"))
