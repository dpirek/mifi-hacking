"""Test ping history collection without making network requests."""
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

SAMPLER=Path(__file__).parents[1]/'root/usr/libexec/mifi-ping'
class PingTests(unittest.TestCase):
 def collect(self, offline=False, preload=False):
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory); state=root/'state';state.mkdir()
   fake=root/'ping'
   fake.write_text('#!/bin/sh\n[ "$OFFLINE" != 1 ] || exit 1\necho "64 bytes from 1.1.1.1: seq=0 ttl=55 time=12.345 ms"\n')
   fake.chmod(0o755)
   (state/'target').write_text('1.1.1.1\n')
   if preload:
    now=int(time.time())
    (state/'history').write_text(''.join(f'{now-i*10} 5\n' for i in range(400,0,-1)))
   env=dict(os.environ,MIFI_PING_BIN=str(fake),MIFI_PING_DIR=str(state),MIFI_PING_TARGET='1.1.1.1',OFFLINE=str(int(offline)))
   subprocess.run(['sh',str(SAMPLER),'--once'],env=env,check=True,timeout=4)
   return (state/'history').read_text().splitlines(), (state/'history').stat().st_mode & 0o777
 def test_success_preserves_milliseconds(self):
  lines,mode=self.collect();self.assertEqual(lines[-1].split()[1],'12.345');self.assertEqual(mode,0o600)
 def test_timeout_is_recorded_as_failed_not_zero(self):
  lines,_=self.collect(offline=True);self.assertEqual(lines[-1].split()[1],'-1')
 def test_history_is_limited_to_one_hour_and_360_samples(self):
  lines,_=self.collect(preload=True);self.assertLessEqual(len(lines),360)
  self.assertGreater(int(lines[0].split()[0]),int(time.time())-3600)
if __name__=='__main__':unittest.main()
