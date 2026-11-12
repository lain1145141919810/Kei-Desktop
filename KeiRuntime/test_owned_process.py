import asyncio
import os
import subprocess
import sys
import unittest
from bridge.owned_process import OwnedJob


@unittest.skipUnless(os.name == 'nt', 'Windows ownership test')
class JobTests(unittest.TestCase):
    def test_job_kills_owned_descendant_and_not_foreign_process(self):
        foreign = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(60)'],
            creationflags=subprocess.CREATE_NO_WINDOW)
        parent = subprocess.Popen([sys.executable, '-c',
            'import sys,subprocess,time;sys.stdin.readline();'
            'p=subprocess.Popen([sys.executable,"-c","import time;time.sleep(60)"]);'
            'print(p.pid,flush=True);time.sleep(60)'], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW)
        job = None
        try:
            job = OwnedJob(parent.pid)
            parent.stdin.write(b'go\n')
            parent.stdin.flush()
            child = int(parent.stdout.readline())
            job.close()
            parent.stdin.close()
            parent.wait(timeout=5)
            import psutil
            import time
            for _ in range(30):
                if not psutil.pid_exists(child): break
                time.sleep(.1)
            self.assertFalse(psutil.pid_exists(child))
            self.assertIsNone(foreign.poll())
        finally:
            if job: job.close()
            for proc in (parent,foreign):
                if proc.poll() is None: proc.kill()
                proc.wait(timeout=5)
            parent.stdout.close()


if __name__ == '__main__': unittest.main()
