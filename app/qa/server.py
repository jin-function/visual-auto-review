"""Loopback-only authenticated workspace API and static user interface."""

from __future__ import annotations

import argparse
import base64
import hmac
import json
import mimetypes
import os
import secrets
import shutil
import signal
import tempfile
import threading
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import VERSION
from .capture import APP_ROOT, default_profile
from .chrome_review import encoded_review
from .export import archive
from .service import Service
from .storage import Store, atomic_json
from .platform_support import default_data_root, open_document


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, service: Service):
        self.service = service
        self.token = secrets.token_urlsafe(32)
        super().__init__(address, Handler)
        self.origin = f"http://127.0.0.1:{self.server_port}"


class Handler(BaseHTTPRequestHandler):
    server: Server

    def log_message(self, *_args) -> None:
        pass

    def _authorized(self) -> bool:
        host = self.headers.get("Host", "")
        if host != f"127.0.0.1:{self.server.server_port}":
            return False
        origin = self.headers.get("Origin")
        if origin and origin != self.server.origin:
            return False
        query = parse_qs(urlparse(self.path).query)
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except Exception:
            return False
        values = [self.headers.get("X-VisualQA", ""), query.get("token", [""])[0],
                  cookie["visualqa"].value if "visualqa" in cookie else ""]
        if self.command == "POST":
            values = [self.headers.get("X-VisualQA", "")]
        return any(hmac.compare_digest(v, self.server.token) for v in values)

    def _headers(self, status: int, content_type: str, size: int, extra: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()

    def _json(self, value, status: int = 200) -> None:
        content = json.dumps(value, ensure_ascii=False, allow_nan=False).encode()
        self._headers(status, "application/json; charset=utf-8", len(content))
        self.wfile.write(content)

    def _file(self, path: Path, content_type: str | None = None, extra: dict | None = None) -> None:
        if not path.is_file():
            raise FileNotFoundError("파일을 찾을 수 없습니다.")
        self._headers(200, content_type or mimetypes.guess_type(path.name)[0] or "application/octet-stream", path.stat().st_size, extra)
        with path.open("rb") as stream:
            shutil.copyfileobj(stream, self.wfile)

    def do_GET(self):
        if not self._authorized():
            self._json({"error": "앱에서 검수 화면을 다시 열어 주세요."}, 403)
            return
        parsed = urlparse(self.path)
        query = {k: v[0] for k, v in parse_qs(parsed.query).items()}
        store = self.server.service.store
        try:
            if parsed.path == "/":
                self._file(APP_ROOT / "web/index.html", "text/html; charset=utf-8", {
                    "Set-Cookie": f"visualqa={self.server.token}; HttpOnly; SameSite=Strict; Path=/"})
            elif parsed.path in {"/app.js", "/source_editor.js", "/style.css"}:
                mime = 'text/javascript; charset=utf-8' if parsed.path.endswith('.js') else 'text/css; charset=utf-8'
                self._file(APP_ROOT / "web" / parsed.path[1:], mime)
            elif parsed.path == "/api/state":
                self._json({"version": VERSION, "projects": store.projects(), "runs": store.runs(),
                            "profile": default_profile(), "data_root": str(store.root)})
            elif parsed.path == "/api/run":
                self._json(store.run(query["id"]))
            elif parsed.path == "/api/result":
                self._json(store.result(query["run"], query["target"], query.get("revision")))
            elif parsed.path == "/api/source/file":
                self._json(self.server.service.sources.read(query["project"], query["path"], int(query.get("line", 1))))
            elif parsed.path == "/api/chrome-review":
                content = encoded_review(store, query["run"], query["target"], query.get("revision"))
                self._headers(200, "application/octet-stream", len(content), {
                    "Content-Disposition": 'attachment; filename="visualqa-review.json"'})
                self.wfile.write(content)
            elif parsed.path == "/api/export":
                with tempfile.TemporaryDirectory(prefix="visualqa-export-") as temp:
                    path = Path(temp) / "report.zip"
                    archive(store, query["run"], path)
                    self._file(path, "application/zip", {"Content-Disposition": 'attachment; filename="visual-qa-report.zip"'})
            elif parsed.path.startswith("/files/"):
                parts = parsed.path.split("/")
                if len(parts) != 6 or parts[5] not in {"reference.png", "actual.png", "diff.png", "overlay.png"}:
                    raise FileNotFoundError("파일 경로가 올바르지 않습니다.")
                self._file(store.revision_path(parts[2], parts[3], parts[4]) / parts[5])
            else:
                self._json({"error": "주소를 찾을 수 없습니다."}, 404)
        except (ValueError, KeyError) as error:
            self._json({"error": str(error)}, 400)
        except FileNotFoundError as error:
            self._json({"error": str(error)}, 404)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:
            self._json({"error": f"처리 중 오류가 발생했습니다: {error}"}, 500)

    def do_POST(self):
        if not self._authorized():
            self._json({"error": "검수 화면의 연결이 만료되었습니다. 앱을 다시 열어 주세요."}, 403)
            return
        service = self.server.service
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 112 * 1024 * 1024:
                raise ValueError("요청 크기가 올바르지 않습니다.")
            value = json.loads(self.rfile.read(length))
            route = urlparse(self.path).path
            if route == "/api/assets":
                content = base64.b64decode(value["content"], validate=True)
                result = service.store.import_asset(content, value["name"])
            elif route == "/api/projects":
                result = service.save_project(value)
            elif route == "/api/start":
                result = service.start(value["project_id"])
            elif route == "/api/retry":
                result = service.retry(value["run_id"])
            elif route == "/api/recalculate":
                result = service.recalculate(value["run_id"], value["target_id"], value["y_offset"], value["reason"])
            elif route == "/api/review":
                result = service.store.review(value["run_id"], value["target_id"], value["revision_id"],
                                               value["finding_id"], value["status"], value["severity"], value.get("note", ""))
            elif route == "/api/source/resolve":
                result = service.source_links(value["run_id"], value["target_id"], value["revision_id"], value["selector"])
            elif route == "/api/source/save":
                result = service.edit_source(value["project_id"], value["path"], value["sha256"], value["content"], connection_id=value["connection_id"])
            elif route == "/api/source/restore":
                result = service.edit_source(value["project_id"], "", value["sha256"], backup_id=value["backup_id"], connection_id=value["connection_id"])
            elif route == "/api/source/open":
                service.sources.check_connection(value["project_id"], value["connection_id"])
                document = service.sources.read(value["project_id"], value["path"], int(value.get("line", 1)))
                open_document(document['absolute_path'], document['line'])
                result = {"opened": True, "path": document["path"], "line": document["line"]}
            elif route == "/api/prune":
                if value.get("confirm") is not True:
                    raise ValueError("이력 정리를 확인해야 합니다.")
                result = {"removed": service.prune(value["project_id"], value["keep"])}
            else:
                self._json({"error": "기능을 찾을 수 없습니다."}, 404)
                return
            self._json(result)
        except (ValueError, TypeError, KeyError) as error:
            self._json({"error": str(error)}, 400)
        except FileNotFoundError as error:
            self._json({"error": str(error)}, 404)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:
            self._json({"error": f"처리 중 오류가 발생했습니다: {error}"}, 500)


def main(arguments=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-root", type=Path, default=Path(os.environ.get("VISUAL_QA_DATA_ROOT", str(default_data_root()))))
    parser.add_argument("--ready-file", type=Path)
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args(arguments)
    service = Service(Store(args.data_root))
    server = Server(("127.0.0.1", args.port), service)
    url = f"{server.origin}/?token={server.token}"
    if args.ready_file:
        atomic_json(args.ready_file, {"url": url, "pid": os.getpid()})
    else:
        print(url, flush=True)
    def stop(*_args):
        service.close()
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        service.close()
        server.server_close()
        if args.ready_file:
            args.ready_file.unlink(missing_ok=True)
    return 0
