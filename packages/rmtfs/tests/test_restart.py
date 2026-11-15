"""Exercise service restart ordering with simulated daemon lifetimes."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

INIT=Path(__file__).parents[1]/'files/rmtfs.init'
SCRIPT=r'''
. "$TEST_INIT"
stop() { echo stop >> "$TEST_LOG"; }
start() { echo start >> "$TEST_LOG"; }
sync() { echo sync >> "$TEST_LOG"; }
sleep() { :; }
logger() { :; }
rmtfs_running() {
    n=$(cat "$TEST_COUNT")
    n=$((n + 1)); echo "$n" > "$TEST_COUNT"
    [ "$n" -le "$TEST_BUSY" ]
}
restart
'''
class RestartTests(unittest.TestCase):
    def check_restart(self,busy):
        with tempfile.TemporaryDirectory() as directory:
            p=Path(directory);(p/'count').write_text('0')
            env=dict(os.environ,TEST_INIT=str(INIT),TEST_LOG=str(p/'log'),TEST_COUNT=str(p/'count'),TEST_BUSY=str(busy))
            result=subprocess.run(['sh','-c',SCRIPT],env=env,capture_output=True,text=True,timeout=3)
            return result,(p/'log').read_text().splitlines(),int((p/'count').read_text())
    def test_restart_waits_for_daemon_exit_then_syncs_then_starts(self):
        result,events,checks=self.check_restart(3)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(events,['stop','sync','start'])
        self.assertEqual(checks,4)
    def test_stuck_daemon_prevents_overlapping_start(self):
        result,events,checks=self.check_restart(100)
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(events,['stop'])
        self.assertEqual(checks,36)
if __name__=='__main__':unittest.main()
