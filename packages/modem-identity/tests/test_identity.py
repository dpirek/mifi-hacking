"""Exercise the compiled CLI against an emulated modem; never touches hardware."""
import json
import os
from pathlib import Path
import shlex
import socket
import struct
import subprocess
import tempfile
import threading
import unittest

ORIGINAL = '490154203237518'
TARGET = '356938035643809'


def encode(imei):
    return bytes.fromhex('08' + imei[0] + 'a' + ''.join(imei[i+1] + imei[i] for i in range(1, 15, 2)))


def crc(data):
    value = 0xffff
    for byte in data:
        value ^= byte
        for _ in range(8):
            value = (value >> 1) ^ (0x8408 if value & 1 else 0)
    return value ^ 0xffff


def frame(data):
    data += struct.pack('<H', crc(data))
    return data.replace(b'\x7d', b'\x7d\x5d').replace(b'\x7e', b'\x7d\x5e') + b'\x7e'


def unframe(data):
    decoded = bytearray()
    escaped = False
    for byte in data[:-1]:
        if escaped:
            decoded.append(byte ^ 0x20); escaped = False
        elif byte == 0x7d:
            escaped = True
        else:
            decoded.append(byte)
    assert crc(decoded[:-2]) == int.from_bytes(decoded[-2:], 'little')
    return bytes(decoded[:-2])


class IdentityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.build = tempfile.TemporaryDirectory()
        cls.binary = Path(cls.build.name) / 'modem-identity'
        source = Path(__file__).parents[1] / 'src/modem-identity.c'
        subprocess.run(shlex.split(os.environ.get('CC', 'cc')) + [
            '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2',
            '-DMODEM_IDENTITY_TEST', '-DNV_TIMEOUT_MS=400', str(source), '-o', str(cls.binary)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.build.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.current = encode(ORIGINAL) + bytes([0x7e, 0x7d, 0xa5]) * 39 + b'\x00\x01'
        assert len(self.current) == 128
        self.commands = []
        self.nv_status = 0
        self.write_status = 0
        self.bad_readback = False
        self.bad_crc = False
        self.fragment = False
        self.timeout_write = False
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        self.listener.bind(str(self.root / 'diag'))
        self.listener.listen(1)
        self.listener.settimeout(2)
        self.addCleanup(self.listener.close)

    def modem(self):
        try:
            conn, _ = self.listener.accept()
        except (TimeoutError, OSError):
            return
        with conn:
            while True:
                raw = conn.recv(4096)
                if not raw:
                    break
                packet = unframe(raw)
                self.commands.append(packet)
                assert len(packet) == 133 and packet[1:3] == b'\x26\x02'
                if packet[0] == 0x27:
                    # A durable original snapshot must exist before any NV write.
                    snapshots = list((self.root / 'backup').glob('*.nv'))
                    assert any(p.read_bytes()[16:] == self.current for p in snapshots)
                    if self.timeout_write:
                        continue
                    if not self.nv_status and not self.write_status and not self.bad_readback:
                        self.current = packet[3:131]
                status = self.write_status if packet[0] == 0x27 else self.nv_status
                response = bytes([packet[0]]) + b'\x26\x02' + self.current + struct.pack('<H', status)
                response = frame(response)
                if self.bad_crc:
                    response = response[:-3] + b'\x00\x00\x7e'
                try:
                    if self.fragment:
                        conn.send(frame(b'\x60unsolicited'))
                        conn.send(response[:25]); conn.send(response[25:])
                    else:
                        conn.send(response)
                except BrokenPipeError:
                    break

    def call(self, *args, readonly=False):
        env = dict(os.environ, MODEM_IDENTITY_TEST_SOCKET=str(self.root / 'diag'),
                   MODEM_IDENTITY_TEST_LOCK=str(self.root / 'lock'))
        if readonly:
            env['MODEM_IDENTITY_TEST_READONLY'] = '1'
        thread = threading.Thread(target=self.modem, daemon=True)
        thread.start()
        result = subprocess.run([str(self.binary), *args], capture_output=True, text=True, env=env, timeout=3)
        thread.join(timeout=0.1)
        return result, json.loads(result.stdout)

    def change(self, **kwargs):
        return self.call('set', TARGET, '--expect', ORIGINAL, '--backup-dir', str(self.root / 'backup'), **kwargs)

    def test_validation_rejects_invalid_digits_and_checksum(self):
        for value in (ORIGINAL[:-1] + '9', '0' * 15, '1' * 14, '９' * 15, ';touch /tmp/invalid'):
            r = subprocess.run([str(self.binary), 'validate', value], capture_output=True, text=True)
            self.assertNotEqual(r.returncode, 0)
        r = subprocess.run([str(self.binary), 'validate', TARGET], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0)

    def test_rmtfs_init_uses_explicit_readonly_setting(self):
        init = Path(__file__).parents[2] / 'rmtfs/files/rmtfs.init'
        script = r'''
. "$INIT"
config_load() { :; }
config_get_bool() { eval "$1=$MODE"; }
populate_disk_labels() { :; }
load_qrtr_modules() { :; }
procd_open_instance() { :; }
procd_close_instance() { :; }
procd_set_param() { if [ "$1" = command ]; then shift; printf '%s\n' "$*"; fi; }
procd_append_param() { if [ "$1" = command ]; then shift; printf '%s\n' "$*"; fi; }
start_service
'''
        for mode in ('0', '1'):
            r = subprocess.run(['sh', '-c', script], env=dict(os.environ, INIT=str(init), MODE=mode),
                               capture_output=True, text=True, check=True)
            self.assertEqual('-r' in r.stdout.split(), mode == '1')

    def test_real_codec_and_read(self):
        self.fragment = True
        r, data = self.call('read')
        self.assertEqual(r.returncode, 0, data)
        self.assertEqual(data['imei'], ORIGINAL)
        self.assertEqual(len(self.commands), 1)

    def test_write_preserves_padding_and_backs_up_first(self):
        original = self.current
        r, data = self.change()
        self.assertEqual(r.returncode, 0, data)
        self.assertTrue(data['readback_verified'])
        self.assertFalse(data['persistence_verified'])
        self.assertEqual(self.current[:9], encode(TARGET))
        self.assertEqual(self.current[9:], original[9:])
        backup = Path(data['backup'])
        self.assertEqual(backup.read_bytes()[16:], original)
        self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.root / 'backup').stat().st_mode & 0o777, 0o700)
        self.assertEqual([p[0] for p in self.commands], [0x26, 0x27, 0x26])

    def test_readonly_blocks_write(self):
        r, data = self.change(readonly=True)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('read-only', data['error'])
        self.assertEqual([p[0] for p in self.commands], [0x26])

    def test_restore_roundtrip(self):
        original = self.current
        _, changed = self.change()
        r, result = self.call('restore', changed['backup'], '--expect', TARGET,
                              '--backup-dir', str(self.root / 'backup'))
        self.assertEqual(r.returncode, 0, result)
        self.assertEqual(self.current, original)
        self.assertTrue(result['readback_verified'])

    def test_write_rejected_by_firmware_retains_backup(self):
        self.write_status = 7
        original = self.current
        r, data = self.change()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('status 7', data['error'])
        self.assertEqual(self.current, original)
        self.assertTrue(Path(data['backup']).exists())
        self.assertEqual([p[0] for p in self.commands], [0x26, 0x27])

    def test_restore_checksum_detects_corruption_outside_imei(self):
        _, changed = self.change()
        p = Path(changed['backup'])
        b = bytearray(p.read_bytes()); b[-1] ^= 1; p.write_bytes(b)
        count = len(self.commands)
        r, result = self.call('restore', changed['backup'], '--expect', TARGET,
                              '--backup-dir', str(self.root / 'backup'))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('Invalid', result['error'])
        self.assertEqual([p[0] for p in self.commands[count:]], [0x26])

    def test_changed_current_identity_blocks_write(self):
        r, data = self.call('set', ORIGINAL, '--expect', TARGET)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('differs', data['error'])
        self.assertEqual(len(self.commands), 1)

    def test_idempotent_change_does_not_write_even_readonly(self):
        r, data = self.call('set', ORIGINAL, '--expect', ORIGINAL, readonly=True)
        self.assertEqual(r.returncode, 0)
        self.assertFalse(data['changed'])
        self.assertEqual(len(self.commands), 1)

    def test_private_backup_required(self):
        (self.root / 'backup').mkdir(mode=0o755)
        r, data = self.change()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('0700', data['error'])
        self.assertEqual(len(self.commands), 1)

    def test_rejected_nv_read_does_not_attempt_unlock_or_write(self):
        self.nv_status = 7
        r, data = self.change()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('status 7', data['error'])
        self.assertEqual(len(self.commands), 1)

    def test_readback_mismatch_is_not_success_and_retains_backup(self):
        self.bad_readback = True
        r, data = self.change()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('mismatch', data['error'])
        self.assertTrue(Path(data['backup']).exists())

    def test_timed_out_write_is_never_retried(self):
        self.timeout_write = True
        r, data = self.change()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('outcome unknown', data['error'])
        self.assertEqual([p[0] for p in self.commands], [0x26, 0x27])

    def test_bad_response_crc_is_rejected(self):
        self.bad_crc = True
        r, data = self.call('read')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('timed out', data['error'])

    def test_corrupt_restore_file_does_not_write(self):
        backup = self.root / 'bad.nv'; backup.write_bytes(b'\0' * 144)
        r, data = self.call('restore', str(backup), '--expect', ORIGINAL)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('Invalid', data['error'])
        self.assertEqual(len(self.commands), 1)


if __name__ == '__main__':
    unittest.main()
