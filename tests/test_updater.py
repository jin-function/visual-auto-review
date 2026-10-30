import sys
import unicodedata
import unittest
from pathlib import Path

sys.path.insert(0,str(Path(__file__).parents[1]))
from maintenance import command_contains


class UpdaterTests(unittest.TestCase):
    def test_decomposed_korean_process_path_matches(self):
        path='/example/Desktop/검수용/시안 검수.app/Contents/Resources/visual_qa.py'
        command='python3 '+unicodedata.normalize('NFD',path)+' --serve'
        self.assertTrue(command_contains(command,path))

    def test_backup_process_is_not_matched_as_installed_app(self):
        path='/example/Desktop/검수용/시안 검수.app/Contents/MacOS/VisualQALauncher'
        command='/example/Desktop/검수용/시안 검수 v3.0 백업.app/Contents/MacOS/VisualQALauncher'
        self.assertFalse(command_contains(command,path))
