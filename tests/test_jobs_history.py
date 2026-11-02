import threading
import unittest
from qa.jobs import Jobs
from qa.review_history import moved_candidates


class JobsAndHistoryTests(unittest.TestCase):
    def test_shutdown_waits_for_active_job_and_does_not_start_queued_work(self):
        entered, release, idle = threading.Event(), threading.Event(), threading.Event()
        queue = Jobs(idle.set)
        def first():
            entered.set(); release.wait(3)
        ran = []
        queue.submit('first', first)
        self.assertTrue(entered.wait(2))
        queue.submit('second', lambda: ran.append(True))
        queue.close()
        self.assertFalse(idle.is_set())
        release.set()
        self.assertTrue(idle.wait(3))
        self.assertEqual(ran, [])
        self.assertEqual(queue.active, set())

    def test_shifted_candidate_never_carries_approval_automatically(self):
        before = {'id':'before','kind':'visual','rect':{'x':10,'y':100},'elements':[{'selector':'#title'}]}
        after = {**before,'id':'after','rect':{'x':10,'y':120}}
        previous = {'findings':[before],'reviews':{'before':{'status':'intentional'}}}
        candidates = moved_candidates([after],previous)
        self.assertEqual(candidates[0]['previous_id'],'before')
        self.assertFalse(candidates[0]['automatic'])
        self.assertNotIn('review',after)
