import base64
import hashlib
import json
import unittest

import test_refactor
from qa.chrome_review import chrome_review, encoded_review
from qa.storage import atomic_json


class ChromeReviewTests(unittest.TestCase):
    setUp = test_refactor.ServiceTests.setUp
    tearDown = test_refactor.ServiceTests.tearDown
    fake_capture = test_refactor.ServiceTests.fake_capture
    wait = test_refactor.ServiceTests.wait
    start = test_refactor.ServiceTests.start

    def test_export_uses_selected_revision_and_alignment_in_document_coordinates(self):
        run = self.start()
        first = self.store.result(run["id"], "mobile")
        self.service.recalculate(run["id"], "mobile", 13, "검증")
        self.wait()
        latest = self.store.result(run["id"], "mobile")
        latest["capture"]["clip"].update(x=30, y=250)
        atomic_json(self.store.revision_path(run["id"], "mobile", latest["id"]) / "result.json", latest)
        package = chrome_review(self.store, run["id"], "mobile", latest["id"])
        self.assertEqual(package["placement"], {"x": 30, "y": 237})
        self.assertEqual(package["viewportWidth"], 390)
        self.assertEqual(package["device"], "mo")
        self.assertEqual(package["targetId"], "mobile")
        self.assertEqual(package["image"]["height"], 80)
        self.assertEqual(package["display"], {"width": 390, "height": 80})
        self.assertEqual(package["imageRole"], "reference-original")
        self.assertEqual(package["revisionId"], latest["id"])
        image = base64.b64decode(package["image"]["base64"])
        self.assertEqual(hashlib.sha256(image).hexdigest(), package["image"]["sha256"])
        self.assertEqual(image, self.store.asset_path(latest["asset"]["id"]).read_bytes())
        self.assertNotEqual(image, (self.store.revision_path(run["id"], "mobile", latest["id"]) / "diff.png").read_bytes())
        earlier = json.loads(encoded_review(self.store, run["id"], "mobile", first["id"]))
        self.assertEqual(earlier["placement"]["y"], 0)
        self.assertEqual(earlier["revisionId"], first["id"])

    def test_negative_alignment_and_unscaled_original_are_preserved(self):
        import io
        from PIL import Image
        stream = io.BytesIO(); Image.new('RGB', (195, 40), 'blue').save(stream, 'PNG')
        asset = self.store.import_asset(stream.getvalue(), '원본.png')
        self.project['targets'][0]['asset_id'] = asset['id']
        self.project = self.service.save_project(self.project)
        run = self.start()
        self.service.recalculate(run['id'], 'mobile', -11, '상단 보정'); self.wait()
        result = self.store.result(run['id'], 'mobile')
        package = chrome_review(self.store, run['id'], 'mobile')
        self.assertEqual(package['image']['width'], 195)
        self.assertEqual(package['image']['height'], 40)
        self.assertEqual(package['display'], {'width': 390, 'height': 80})
        self.assertEqual(package['placement']['y'], 11)
        self.assertEqual(package['findings'][0]['rect']['y'], result['findings'][0]['rect']['y'] - 11)
        self.assertEqual(base64.b64decode(package['image']['base64']), self.store.asset_path(asset['id']).read_bytes())

    def test_handoff_has_no_service_token_or_source_folder(self):
        run = self.start()
        document = chrome_review(self.store, run["id"], "mobile")
        self.assertEqual(document["url"], self.project["url"])
        self.assertNotIn("source", document)
        self.assertNotIn("token", document)
        self.assertEqual(document["findings"][0]["rect"], self.store.result(run["id"], "mobile")["findings"][0]["rect"])

    def test_unsupported_or_embedded_credentials_rejected_without_changing_results(self):
        run = self.start()
        path = self.store.run_path(run["id"]) / "run.json"
        for url in ("file:///tmp/page.html", "https://user:secret@example.com/page"):
            run["project"]["url"] = url
            atomic_json(path, run)
            with self.assertRaises(ValueError): chrome_review(self.store, run["id"], "mobile")
            self.assertTrue(self.store.result(run["id"], "mobile")["findings"])


if __name__ == "__main__":
    unittest.main()
