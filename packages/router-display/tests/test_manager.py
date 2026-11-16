"""Exercise the real display-manager timers with fake backlight/FIFO/config."""
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import unittest


class ManagerTests(unittest.TestCase):
    def test_periodic_updates_stop_when_off_and_resume_on_wake(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            backlight = root / 'backlight'; backlight.mkdir()
            (backlight / 'max_brightness').write_text('100\n')
            (backlight / 'brightness').write_text('100\n')
            (backlight / 'bl_power').write_text('0\n')
            bindir = root / 'bin'; bindir.mkdir()
            for name, body in [('logger', '#!/bin/sh\nexit 0\n'), ('uci', '#!/bin/sh\necho status\n')]:
                p = bindir / name; p.write_text(body); p.chmod(0o755)
            functions = root / 'functions.sh'
            functions.write_text('''config_load() { [ "$1" = display ]; }
config_get() {
 case "$3" in
  timeout_dim|timeout_off) value=2 ;;
  fifo) value="$TEST_FIFO" ;;
  update_interval) value=1 ;;
  enable_lockscreen) value=0 ;;
  *) value="$4" ;;
 esac
 eval "$1=\\\"$value\\\""
}
''')
            updater = root / 'update'
            updater.write_text('#!/bin/sh\nprintf "frame %s\\n" "$DISPLAY_PAGE" >> "$TEST_UPDATE_LOG"\n'); updater.chmod(0o755)
            fifo = root / 'fifo'; log = root / 'updates'
            env = dict(os.environ, PATH=str(bindir)+':'+os.environ['PATH'],
                       DISPLAY_PID_FILE=str(root/'pid'), DISPLAY_BACKLIGHT_PATH=str(backlight),
                       DISPLAY_FUNCTIONS_LIB=str(functions), DISPLAY_UPDATE_BIN=str(updater),
                       TEST_FIFO=str(fifo), TEST_UPDATE_LOG=str(log))
            script = Path(__file__).parents[1] / 'files/display-manager.sh'
            p = subprocess.Popen(['sh',str(script)],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
            try:
                deadline=time.monotonic()+2
                while not log.exists() and time.monotonic()<deadline: time.sleep(.05)
                self.assertTrue(log.exists(),'Manager did not render its initial frame')
                time.sleep(4.4)
                self.assertEqual((backlight/'brightness').read_text().strip(),'1')
                count=len(log.read_text().splitlines())
                self.assertGreaterEqual(count,3,'No live status updates while awake')
                time.sleep(1.2)
                self.assertEqual(len(log.read_text().splitlines()),count,'Ticks must not keep the display awake')
                fd=os.open(fifo,os.O_WRONLY|os.O_NONBLOCK)
                os.write(fd,b'full\n');os.close(fd)
                time.sleep(.2)
                self.assertGreater(len(log.read_text().splitlines()),count)
                self.assertEqual((backlight/'brightness').read_text().strip(),'100')
                fd=os.open(fifo,os.O_WRONLY|os.O_NONBLOCK)
                os.write(fd,b'wifi\n');os.close(fd)
                time.sleep(.2)
                self.assertEqual(log.read_text().splitlines()[-1], 'frame wifi')
                time.sleep(2.2)
                self.assertEqual((backlight/'brightness').read_text().strip(),'100', 'QR must remain bright long enough to scan')
                fd=os.open(fifo,os.O_WRONLY|os.O_NONBLOCK)
                os.write(fd,b'sms\n');os.close(fd)
                time.sleep(.2)
                self.assertEqual(log.read_text().splitlines()[-1], 'frame sms')
                time.sleep(2.2)
                self.assertEqual((backlight/'brightness').read_text().strip(),'100', 'SMS must remain bright for reading')
                fd=os.open(fifo,os.O_WRONLY|os.O_NONBLOCK)
                os.write(fd,b'full\n');os.close(fd)
                time.sleep(.2)
                self.assertEqual(log.read_text().splitlines()[-1], 'frame status')

            finally:
                os.killpg(p.pid,signal.SIGTERM)
                p.communicate(timeout=3)
            self.assertFalse(fifo.exists(),'FIFO left behind after stopping manager')
            self.assertFalse((root/'pid').exists(),'PID file left behind after stopping manager')

    def test_sleep_ping_graph_updates_and_wake_restores_status(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            backlight=root/'backlight'; backlight.mkdir()
            for name,value in [('max_brightness','800'),('brightness','800'),('bl_power','0')]:
                (backlight/name).write_text(value+'\n')
            bindir=root/'bin'; bindir.mkdir()
            logger=bindir/'logger'; logger.write_text('#!/bin/sh\nexit 0\n'); logger.chmod(0o755)
            functions=root/'functions'
            functions.write_text('''config_load() { :; }
config_get() {
 case "$3" in
 timeout_dim|timeout_off) value=1 ;;
 fifo) value="$TEST_FIFO" ;;
 update_interval) value=3 ;;
 *) value="$4" ;;
 esac
 export "$1=$value"
}
''')
            updater=root/'update'; updater.write_text('#!/bin/sh\necho "$DISPLAY_PAGE" >> "$TEST_UPDATE_LOG"\n'); updater.chmod(0o755)
            fifo=root/'fifo'; log=root/'updates'
            env=dict(os.environ,PATH=str(bindir)+':'+os.environ['PATH'],
                     DISPLAY_PID_FILE=str(root/'pid'),DISPLAY_BACKLIGHT_PATH=str(backlight),
                     DISPLAY_FUNCTIONS_LIB=str(functions),DISPLAY_UPDATE_BIN=str(updater),
                     TEST_FIFO=str(fifo),TEST_UPDATE_LOG=str(log))
            script=Path(__file__).parents[1]/'files/display-manager.sh'
            process=subprocess.Popen(['sh',str(script)],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
            try:
                deadline=time.monotonic()+2
                while not log.exists() and time.monotonic()<deadline: time.sleep(.05)
                self.assertEqual(log.read_text().splitlines()[0],'status')
                time.sleep(2.4)
                self.assertEqual((backlight/'brightness').read_text().strip(),'80')
                self.assertEqual(log.read_text().splitlines()[-1],'ping')
                count=log.read_text().splitlines().count('ping')
                time.sleep(1.2)
                self.assertEqual(log.read_text().splitlines().count('ping'),count,'Cached ping graph should not redraw every second')
                time.sleep(8.8)
                self.assertGreater(log.read_text().splitlines().count('ping'),count)
                fd=os.open(fifo,os.O_WRONLY|os.O_NONBLOCK); os.write(fd,b'full\n'); os.close(fd)
                time.sleep(.2)
                self.assertEqual(log.read_text().splitlines()[-1],'status')
                self.assertEqual((backlight/'brightness').read_text().strip(),'800')
            finally:
                os.killpg(process.pid,signal.SIGTERM); process.communicate(timeout=3)


if __name__=='__main__':unittest.main()
