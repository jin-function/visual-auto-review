import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image, ImageDraw

from qa.engine import compare, _neighbor_delta
from qa.export import archive
from qa.service import Service
from qa.storage import Store, atomic_json


class EngineTests(unittest.TestCase):
    def test_original_accordion_body_is_preserved(self):
        module = (Path(__file__).parents[1] / "app/page_state.js").read_text()
        body = module.split("async function openAccordions(send, profile, delay) {\n", 1)[1].split("    return toggles;\n}", 1)[0]
        self.assertEqual(hashlib.sha256(body.encode()).hexdigest(),
                         "b272c7ad90e8279bc1fd742ca2d6b4476c5de0a9440d4cdf2cd5216b34584280")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def compare(self, a, b, metadata=None, offset=0, settings=None):
        return compare(a, b, metadata or {}, settings or {}, self.root, offset)

    def test_missing_bottom_is_geometry_failure(self):
        a = Image.new("RGB", (16, 24), "white")
        ImageDraw.Draw(a).rectangle((0, 16, 15, 23), fill="black")
        result = self.compare(a, Image.new("RGB", (16, 16), "white"))
        self.assertEqual(result["metrics"]["height"], 24)
        self.assertEqual(result["metrics"]["changed_pixels"], 16 * 8)
        self.assertEqual(result["metrics"]["verdict"], "FAIL")

    def test_extra_white_bottom_is_not_ignored(self):
        result = self.compare(Image.new("RGB", (8, 8), "white"), Image.new("RGB", (8, 12), "white"))
        self.assertEqual(result["metrics"]["geometry_pixels"], 32)

    def test_red_green_whole_and_strip_are_consistent(self):
        result = self.compare(Image.new("RGB", (16, 16), (255, 0, 0)), Image.new("RGB", (16, 16), (0, 130, 0)))
        self.assertEqual(result["metrics"]["changed_ratio"], 1)
        self.assertEqual(result["strips"][0]["changed_ratio"], 1)

    def test_font_tolerance_does_not_hide_texture_or_invent_colors(self):
        a = Image.new("RGB", (16, 16))
        a.putdata([(0, 0, 0) if (x+y) % 2 else (255, 255, 255) for y in range(16) for x in range(16)])
        b = Image.new("RGB", (16, 16), (128, 128, 128))
        for metadata in ({}, {"textRects": [{"x": 0, "y": 0, "width": 16, "height": 16}]}):
            self.assertEqual(self.compare(a, b, metadata)["metrics"]["changed_ratio"], 1)

    def test_small_element_requires_review(self):
        a = Image.new("RGB", (100, 100), "white")
        ImageDraw.Draw(a).rectangle((40, 40, 47, 47), fill="black")
        result = self.compare(a, Image.new("RGB", a.size, "white"))
        self.assertEqual(result["metrics"]["verdict"], "REVIEW")
        self.assertTrue(result["findings"])

    def test_negative_offset_preserves_both_edges(self):
        a = Image.new("RGB", (16, 16), "white")
        result = self.compare(a, a, offset=-4)
        self.assertEqual(result["metrics"]["height"], 20)
        self.assertEqual(result["metrics"]["reference_top"], 4)
        self.assertEqual(result["metrics"]["geometry_pixels"], 128)

    def test_strip_totals_equal_overall_across_tiles(self):
        a = Image.new("RGB", (24, 1301), "white")
        b = a.copy()
        ImageDraw.Draw(b).rectangle((1, 500, 20, 720), fill="black")
        result = self.compare(a, b)
        self.assertEqual(sum(s["changed_pixels"] for s in result["strips"]), result["metrics"]["changed_pixels"])
        mean = sum(s["mean_delta"] * (s["bottom"] - s["top"]) for s in result["strips"]) / result["metrics"]["height"]
        self.assertAlmostEqual(mean, result["metrics"]["mean_delta"])

    def test_width_mismatch_is_explicit(self):
        with self.assertRaises(ValueError):
            self.compare(Image.new("RGB", (8, 8)), Image.new("RGB", (9, 8)))

    def test_related_elements_use_shifted_coordinates(self):
        a = Image.new("RGB", (16, 24), "white")
        b = a.copy()
        ImageDraw.Draw(b).rectangle((2, 4, 5, 7), fill="black")
        metadata = {"domElements": [{"selector": "#button", "rect": {"x": 2, "y": 4, "width": 4, "height": 4}}]}
        result = self.compare(a, b, metadata, offset=3)
        related = [e for f in result["findings"] for e in f["elements"]]
        self.assertEqual(related[0]["rect"]["y"], 7)

    def test_tiled_text_tolerance_matches_full_frame(self):
        from PIL import ImageFilter
        random = np.random.default_rng(42)
        pixels = (random.integers(0, 2, size=(1153, 48, 1)) * 255).astype(np.uint8)
        pixels = np.repeat(pixels, 3, axis=2)
        shifted = np.roll(pixels, 1, axis=1)
        shifted[509:516, 15:22] = 128
        a, b = Image.fromarray(pixels), Image.fromarray(shifted)
        x, y = pixels.astype(np.int16), shifted.astype(np.int16)
        raw = np.abs(x-y).max(axis=2)
        edge = np.asarray(a.convert("L").filter(ImageFilter.MaxFilter(3)), dtype=np.int16) - np.asarray(a.convert("L").filter(ImageFilter.MinFilter(3)), dtype=np.int16)
        expected = np.where(edge >= 24, np.minimum(raw, np.maximum(_neighbor_delta(x, y, 2), _neighbor_delta(y, x, 2))), raw) >= 24
        result = self.compare(a, b, {"textRects": [{"x": 0, "y": 0, "width": 48, "height": 1153}]}, settings={"font_tolerance": 2})
        self.assertEqual(result["metrics"]["changed_pixels"], int(expected.sum()))
        diff = np.asarray(Image.open(self.root / "diff.png"))
        np.testing.assert_array_equal(np.all(diff == (255, 35, 70), axis=2), expected)


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.temp.name))
        self.service = Service(self.store)
        self.fail_pc = False
        self.capture_variant = 0
        self.service.capture.run = self.fake_capture
        image = Image.new("RGB", (390, 80), "white")
        stream = io.BytesIO(); image.save(stream, "PNG")
        self.asset = self.store.import_asset(stream.getvalue(), "시안.png")
        self.project = self.service.save_project({"name": "검증 프로젝트", "url": "http://127.0.0.1:5500/test", "targets": [
            {"id": "mobile", "name": "모바일", "width": 390, "asset_id": self.asset["id"], "enabled": True} ]})

    def tearDown(self):
        self.service.executor.shutdown(wait=True)
        self.service.close()
        self.temp.cleanup()

    def fake_capture(self, url, target, profile, directory):
        if self.fail_pc and target["id"] == "pc":
            raise RuntimeError("PC capture test failure")
        directory.mkdir(parents=True, exist_ok=True)
        image = Image.new("RGB", (target["width"], 80), "white")
        ImageDraw.Draw(image).rectangle((10, 10, 20 + self.capture_variant, 20), fill="black")
        image.save(directory / "actual.png")
        metadata = {"innerWidth": target["width"], "textRects": [], "domElements": [], "clip": {"width": target["width"], "height": 80}}
        atomic_json(directory / "actual.png.json", metadata)
        return metadata

    def wait(self):
        self.service.executor.submit(lambda: None).result(timeout=15)

    def start(self):
        run = self.service.start(self.project["id"])
        self.wait()
        return self.store.run(run["id"])

    def test_recalculation_commits_every_output_and_keeps_original(self):
        run = self.start()
        old = self.store.result(run["id"], "mobile")
        path = self.store.revision_path(run["id"], "mobile", old["id"]) / "result.json"
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        finding = old["findings"][0]
        self.store.review(run["id"], "mobile", old["id"], finding["id"], "fix", "high", "메모 유지")
        self.service.recalculate(run["id"], "mobile", 3, "상단 여백")
        self.wait()
        result = self.store.result(run["id"], "mobile")
        self.assertNotEqual(result["id"], old["id"])
        self.assertEqual(result["metrics"]["y_offset"], 3)
        self.assertEqual(result["metrics"]["height"], 83)
        self.assertEqual(sum(s["changed_pixels"] for s in result["strips"]), result["metrics"]["changed_pixels"])
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), digest)
        self.assertEqual(Store(self.store.root).result(run["id"], "mobile", old["id"])["reviews"][finding["id"]]["note"], "메모 유지")

    def test_failed_recalculation_preserves_committed_revision(self):
        run = self.start(); old = self.store.result(run["id"], "mobile")
        with patch("qa.service.compare", side_effect=RuntimeError("test failure")):
            self.service.recalculate(run["id"], "mobile", 1, "실패 검증"); self.wait()
        self.assertEqual(self.store.result(run["id"], "mobile")["id"], old["id"])
        self.assertIn("재계산 실패", self.store.run(run["id"])["targets"]["mobile"]["error"])

    def test_retry_only_failed_target(self):
        p = self.store.project(self.project["id"])
        p["targets"].append({"id": "pc", "name": "PC", "width": 390, "enabled": True, "asset_id": self.asset["id"]})
        self.service.save_project(p)
        self.fail_pc = True
        run = self.start(); original = run["targets"]["mobile"]["current_revision"]
        self.assertEqual(run["status"], "partial")
        self.fail_pc = False
        self.service.retry(run["id"]); self.wait()
        current = self.store.run(run["id"])
        self.assertEqual(current["status"], "complete")
        self.assertEqual(current["targets"]["mobile"]["current_revision"], original)
        self.assertEqual(len(current["targets"]["pc"]["attempts"]), 2)

    def test_review_carries_only_identical_evidence(self):
        first = self.start(); result = self.store.result(first["id"], "mobile"); finding = result["findings"][0]
        self.store.review(first["id"], "mobile", result["id"], finding["id"], "intentional", "low", "승인된 차이")
        second = self.start(); same = self.store.result(second["id"], "mobile")
        self.assertEqual(same["reviews"][finding["id"]]["status"], "intentional")
        self.capture_variant = 2
        third = self.start(); changed = self.store.result(third["id"], "mobile")
        self.assertFalse(changed["reviews"])
        self.assertTrue(changed["findings"][0].get("previous_review"))

    def test_restart_recovers_interrupted_run(self):
        run = self.start(); run["status"] = "running"; run["targets"]["mobile"]["status"] = "capturing"
        self.store.save_run(run); self.store.recover_interrupted()
        result = self.store.run(run["id"])
        self.assertEqual(result["status"], "interrupted")
        self.assertEqual(result["targets"]["mobile"]["status"], "interrupted")

    def test_detected_resolved_issue_is_reopened(self):
        first = self.start(); result = self.store.result(first["id"], "mobile"); finding = result["findings"][0]
        self.store.review(first["id"], "mobile", result["id"], finding["id"], "resolved", "high", "수정 완료로 판단")
        second = self.start(); detected = self.store.result(second["id"], "mobile")
        self.assertNotIn(finding["id"], detected["reviews"])
        self.assertEqual(detected["findings"][0]["previous_review"]["status"], "resolved")

    def test_export_contains_current_review_and_all_revisions(self):
        import zipfile
        run = self.start(); result = self.store.result(run["id"], "mobile"); finding = result["findings"][0]
        self.store.review(run["id"], "mobile", result["id"], finding["id"], "fix", "high", "<script>검수 메모</script>")
        path = self.store.root / "report.zip"; archive(self.store, run["id"], path)
        with zipfile.ZipFile(path) as output:
            self.assertIn("index.html", output.namelist())
            report_path = next(n for n in output.namelist() if n.endswith("/report.html"))
            text = output.read(report_path).decode()
            self.assertIn("&lt;script&gt;검수 메모&lt;/script&gt;", text)
            self.assertNotIn("<script>검수 메모", text)

    def test_pruning_is_separate_and_preserves_failures(self):
        first = self.start(); second = self.start()
        removed = self.service.prune(self.project["id"], 1)
        self.assertEqual(removed, [first["id"]])
        self.assertTrue(self.store.run_path(second["id"]).exists())

    def test_invalid_input_does_not_remove_history(self):
        run = self.start()
        with self.assertRaises(ValueError):
            self.service.recalculate(run["id"], "mobile", 50000, "잘못된 보정")
        self.assertTrue(self.store.run_path(run["id"]).exists())


if __name__ == "__main__":
    unittest.main()
