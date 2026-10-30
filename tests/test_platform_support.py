import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from qa.platform_support import acquire_lease, release_lease, default_data_root, browser_candidates


class PlatformTests(unittest.TestCase):
    def test_lock_prevents_a_second_service_and_releases_for_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'lease'
            with path.open('a+') as first, path.open('a+') as second:
                acquire_lease(first)
                with self.assertRaises(BlockingIOError):
                    acquire_lease(second)
                release_lease(first)
                acquire_lease(second)
                release_lease(second)

    def test_windows_data_and_browser_locations_use_the_new_computers_environment(self):
        with patch('qa.platform_support.sys.platform', 'win32'), patch('qa.platform_support.shutil.which', return_value=None), patch.dict(os.environ, {
            'LOCALAPPDATA': '/new-user/Local', 'PROGRAMFILES': '/new-system/Program Files',
            'PROGRAMFILES(X86)': '/new-system/Program Files (x86)',
        }):
            self.assertEqual(default_data_root(), Path('/new-user/Local/VisualQA/v3'))
            candidates = browser_candidates()
            self.assertIn('/new-user/Local/Google/Chrome/Application/chrome.exe', candidates)
            self.assertIn('/new-system/Program Files/Google/Chrome/Application/chrome.exe', candidates)
            self.assertFalse(any('/Users/spring' in str(candidate) for candidate in candidates))


if __name__ == '__main__':
    unittest.main()
