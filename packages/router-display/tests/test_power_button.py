"""Run the real power handler with a FIFO and a harmless poweroff substitute."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

HANDLER = Path(__file__).parents[2] / 'configs-mifi/files/rc.button.power'

class PowerButtonTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.fifo = self.root / 'fifo'
        os.mkfifo(self.fifo)
        self.fd = os.open(self.fifo, os.O_RDWR | os.O_NONBLOCK)
        self.uptime = self.root / 'uptime'
        self.shutdown = self.root / 'shutdown'
        poweroff = self.root / 'poweroff'
        poweroff.write_text('#!/bin/sh\ntouch "$TEST_SHUTDOWN"\n')
        poweroff.chmod(0o755)
        bindir = self.root / 'bin'; bindir.mkdir()
        for name in ('sync', 'logger'):
            p = bindir / name; p.write_text('#!/bin/sh\nexit 0\n'); p.chmod(0o755)
        self.env = dict(os.environ, PATH=str(bindir)+':'+os.environ['PATH'],
                        POWER_BUTTON_FIFO=str(self.fifo), POWER_BUTTON_STATE=str(self.root/'last'),
                        POWER_BUTTON_UPTIME=str(self.uptime), POWER_BUTTON_POWEROFF=str(poweroff),
                        TEST_SHUTDOWN=str(self.shutdown), BUTTON='power')
    def tearDown(self):
        os.close(self.fd); self.temp.cleanup()
    def event(self, now, seen=0, action='released'):
        self.uptime.write_text(str(now)+' 0\n')
        subprocess.run(['sh', str(HANDLER)], env=dict(self.env, ACTION=action, SEEN=str(seen)), check=True, timeout=3)
        try: return os.read(self.fd, 1024).decode()
        except BlockingIOError: return ''
    def test_double_press_shows_wifi_and_never_shuts_down(self):
        self.assertEqual(self.event(100), 'full\n')
        self.assertEqual(self.event(100.3), 'wifi\n')
        self.assertFalse(self.shutdown.exists())
        self.assertEqual(self.event(100.4), 'sms\n')
        self.assertEqual(self.event(100.5), 'full\n')
    def test_triple_press_requires_three_consecutive_short_presses(self):
        self.assertEqual(self.event(100), 'full\n')
        self.assertEqual(self.event(100.3), 'wifi\n')
        self.assertEqual(self.event(101), 'full\n')
        self.assertEqual(self.event(101.2), 'wifi\n')
        self.assertEqual(self.event(101.4), 'sms\n')
        self.assertFalse(self.shutdown.exists())
        self.assertFalse((self.root/'last').exists())

    def test_separate_presses_wake_status(self):
        self.assertEqual(self.event(100), 'full\n')
        self.assertEqual(self.event(101), 'full\n')
        self.assertFalse(self.shutdown.exists())
    def test_three_second_hold_powers_off_and_clears_double_press(self):
        self.event(100)
        self.assertEqual(self.event(104, seen=3), '')
        self.assertTrue(self.shutdown.exists())
        self.assertFalse((self.root/'last').exists())
    def test_press_wakes_immediately_and_invalid_duration_is_ignored(self):
        self.assertEqual(self.event(100, action='pressed'), 'full\n')
        self.assertEqual(self.event(100, seen='invalid'), '')
        self.assertFalse(self.shutdown.exists())
    def test_no_fifo_reader_does_not_hang_handler(self):
        os.close(self.fd)
        self.fd = os.open(self.fifo, os.O_RDONLY | os.O_NONBLOCK)
        os.close(self.fd)
        # Keep tearDown safe, but leave the FIFO with no reader.
        self.fd = os.open(self.root/'uptime', os.O_CREAT | os.O_RDWR, 0o600)
        self.uptime.write_text('100 0\n')
        subprocess.run(['sh', str(HANDLER)], env=dict(self.env, ACTION='released', SEEN='0'), check=True, timeout=3)
        self.assertFalse(self.shutdown.exists())

if __name__ == '__main__': unittest.main()
