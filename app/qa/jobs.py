"""Serial job ownership and shutdown; independent of capture and comparison."""
import threading
from concurrent.futures import ThreadPoolExecutor


class Jobs:
    def __init__(self, on_idle):
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='visual-qa')
        self.active = set()
        self.lock = threading.RLock()
        self.closed = False
        self.on_idle = on_idle

    def submit(self, key, operation):
        with self.lock:
            if self.closed:
                raise ValueError('검수 서비스가 종료 중입니다.')
            if key in self.active:
                raise ValueError('이미 처리 중입니다.')
            self.active.add(key)
        def task():
            try:
                if not self.closed:
                    operation()
            finally:
                with self.lock:
                    self.active.discard(key)
                    idle = self.closed and not self.active
                if idle:
                    self.on_idle()
        try:
            return self.executor.submit(task)
        except Exception:
            self.active.discard(key)
            raise

    def close(self):
        with self.lock:
            self.closed = True
            idle = not self.active
        self.executor.shutdown(wait=False)
        if idle:
            self.on_idle()
