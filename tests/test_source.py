import hashlib
import tempfile
import unittest
from pathlib import Path

from qa.source import Sources, Document, normalize_source
from qa.storage import Store


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.files = self.root / "project"
        self.files.mkdir()
        (self.files / "html").mkdir()
        (self.files / "css").mkdir()
        self.text = '<!doctype html>\n<html>\n    <head>\n        <link rel="stylesheet" href="../css/style.css">\n    </head>\n    <body>\n        <section id="hero">\n            <h1>\n                검수 제목\n            </h1>\n        </section>\n    </body>\n</html>\n'
        (self.files / "html/page.html").write_text(self.text)
        (self.files / "css/style.css").write_text('#hero {\n    padding: 20px;\n}\n')
        self.store = Store(self.root / "data")
        self.config = normalize_source({"root": str(self.files), "html": "html/page.html"}, "http://127.0.0.1:5500/kr/project/html/page.html")
        self.project = self.store.save_project({"name": "소스 검증", "url": "http://127.0.0.1:5500/kr/project/html/page.html", "source": self.config})
        self.sources = Sources(self.store)

    def tearDown(self):
        self.temp.cleanup()

    def test_url_prefix_is_derived_from_html_location(self):
        self.assertEqual(self.config["url_prefix"], "http://127.0.0.1:5500/kr/project/")

    def test_html_exact_id_and_css_rule_link(self):
        css = (self.files / "css/style.css").read_text()
        inspection = {"selector": "#hero", "element": {"id": "hero", "tag": "section"}, "rules": [{
            "url": "http://127.0.0.1:5500/kr/project/css/style.css", "inline": False, "line": 1,
            "sheetHash": hashlib.sha256(css.encode()).hexdigest(), "selector": "#hero", "inherited": False}]}
        result = self.sources.resolve(self.project["id"], inspection)
        self.assertEqual(result["links"][0]["line"], 7)
        self.assertTrue(result["links"][0]["exact"])
        self.assertEqual(result["links"][1]["path"], "css/style.css")

    def test_repeated_elements_resolve_by_dom_path(self):
        doc = Document('<html><body><main><p>첫째</p><p>둘째</p></main></body></html>')
        node = doc.locate({"tag": "p", "path": [{"tag": "html", "nth": 1}, {"tag": "body", "nth": 1}, {"tag": "main", "nth": 1}, {"tag": "p", "nth": 2}]})
        self.assertEqual(node["nth"], 2)

    def test_duplicate_id_is_not_guessed(self):
        doc = Document('<section id="hero"></section><section id="hero"></section>')
        self.assertIsNone(doc.locate({"id": "hero", "tag": "section"}))

    def test_stale_stylesheet_is_not_linked_to_wrong_line(self):
        result = self.sources.resolve(self.project["id"], {"selector": "#hero", "element": {"id": "hero", "tag": "section"}, "rules": [{
            "url": "http://127.0.0.1:5500/kr/project/css/style.css", "inline": False, "line": 100,
            "sheetHash": "different", "selector": "#hero", "inherited": False}]})
        self.assertEqual(len(result["links"]), 1)
        self.assertTrue(result["warnings"])

    def test_inline_stylesheet_location_is_verified(self):
        text = '<html>\n<head>\n<style>\n#hero { padding: 10px; }\n</style>\n</head>\n<body><section id="hero"></section></body>\n</html>'
        (self.files / "html/page.html").write_text(text)
        sheet = '\n#hero { padding: 10px; }\n'
        result = self.sources.resolve(self.project["id"], {"selector": "#hero", "element": {"id": "hero", "tag": "section"}, "rules": [{
            "url": "http://127.0.0.1:5500/kr/project/html/page.html", "inline": True, "line": 2,
            "sheetStartLine": 2, "sheetStartColumn": 7, "sheetHash": hashlib.sha256(sheet.encode()).hexdigest(),
            "selector": "#hero", "inherited": False}]})
        self.assertEqual(result["links"][1]["line"], 4)

    def test_outside_root_and_non_source_files_are_rejected(self):
        (self.root / "outside.html").write_text('outside')
        (self.files / "secret.json").write_text('{}')
        (self.files / "linked.html").symlink_to(self.root / "outside.html")
        for path in ("../outside.html", "secret.json", "linked.html"):
            with self.assertRaises(ValueError):
                self.sources.read(self.project["id"], path)

    def test_external_stylesheets_and_url_traversal_are_not_mapped(self):
        for url in ("https://cdn.example/style.css", "http://127.0.0.1:5500/else/style.css", "http://127.0.0.1:5500/kr/project/%2e%2e/%2e%2e/outside.html"):
            self.assertIsNone(self.sources.local_url(self.config, url))

    def test_save_backs_up_and_restore_survives_new_instance(self):
        doc = self.sources.read(self.project["id"], "html/page.html", 7)
        saved = self.sources.save(self.project["id"], doc["path"], doc["sha256"], doc["content"].replace('검수 제목', '수정한 제목'))
        self.assertTrue(saved["changed"])
        self.assertIn('수정한 제목', (self.files / "html/page.html").read_text())
        reopened = Sources(Store(self.root / "data")).read(self.project["id"], doc["path"])
        self.assertEqual(reopened["backup_id"], saved["backup_id"])
        restored = self.sources.restore(self.project["id"], saved["backup_id"], saved["sha256"])
        self.assertEqual(restored["content"], self.text)
        self.assertNotEqual(restored["backup_id"], saved["backup_id"])

    def test_concurrent_external_change_is_not_overwritten(self):
        doc = self.sources.read(self.project["id"], "html/page.html")
        (self.files / "html/page.html").write_text('외부 편집기에서 변경')
        with self.assertRaises(ValueError):
            self.sources.save(self.project["id"], doc["path"], doc["sha256"], '앱 변경')
        self.assertEqual((self.files / "html/page.html").read_text(), '외부 편집기에서 변경')

    def test_preserves_bom_newline_and_permissions(self):
        path = self.files / "css/style.css"
        path.write_bytes(b'\xef\xbb\xbf#hero {\r\n    padding: 20px;\r\n}\r\n')
        path.chmod(0o640)
        doc = self.sources.read(self.project["id"], "css/style.css")
        self.sources.save(self.project["id"], doc["path"], doc["sha256"], doc["content"].replace('20px','24px'))
        self.assertTrue(path.read_bytes().startswith(b'\xef\xbb\xbf'))
        self.assertIn(b'24px;\r\n', path.read_bytes())
        self.assertEqual(path.stat().st_mode & 0o777, 0o640)

    def test_noop_save_does_not_create_backup(self):
        doc = self.sources.read(self.project["id"], "html/page.html")
        result = self.sources.save(self.project["id"], doc["path"], doc["sha256"], doc["content"])
        self.assertFalse(result["changed"])
        self.assertFalse((self.store.root / "source-backups").exists())

    def test_changed_connection_is_rejected(self):
        connection = self.sources.connection(self.project["id"])
        project = self.store.project(self.project["id"])
        project["source"]["url_prefix"] = "http://127.0.0.1:5500/other/"
        self.store.save_project(project)
        with self.assertRaises(ValueError):
            self.sources.check_connection(project["id"], connection)

    def test_backup_cannot_restore_into_a_different_root(self):
        doc = self.sources.read(self.project["id"], "html/page.html")
        saved = self.sources.save(self.project["id"], doc["path"], doc["sha256"], doc["content"].replace('검수 제목','수정한 제목'))
        other = self.root / "other"
        (other / "html").mkdir(parents=True)
        (other / "html/page.html").write_text(saved["content"])
        project = self.store.project(self.project["id"])
        project["source"]["root"] = str(other)
        self.store.save_project(project)
        self.assertIsNone(self.sources.read(project["id"], doc["path"])["backup_id"])
        with self.assertRaises(ValueError):
            self.sources.restore(project["id"], saved["backup_id"], saved["sha256"])


if __name__ == "__main__":
    unittest.main()
