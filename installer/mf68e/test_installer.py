"""Offline safety tests: sparse synthetic eMMC and simulated EDL, never real USB."""
import argparse
import contextlib
import io
import json
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import uuid

import install


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.backup = self.root / 'stock.bin'
        self.stock = json.loads(Path(__file__).with_name('stock-layout.json').read_text())
        entries = bytearray(32 * 128)
        for p in self.stock:
            start = (p['number'] - 1) * 128
            entries[start:start + 16] = install.LINUX_FS
            entries[start + 16:start + 32] = uuid.UUID(int=p['number']).bytes_le
            struct.pack_into('<QQ', entries, start + 32, p['start_sector'],
                             p['start_sector'] + p['sectors'] - 1)
            entries[start + 56:start + 128] = p['name'].encode('utf-16le').ljust(72, b'\0')
        entries += bytes(32 * 512 - len(entries))
        def header(current, alternate, entry_lba):
            h = bytearray(512)
            h[:8] = b'EFI PART'
            struct.pack_into('<III', h, 8, 0x10000, 92, 0)
            struct.pack_into('<QQQQ', h, 24, current, alternate, 34, install.CAPACITY // 512 - 34)
            struct.pack_into('<QII', h, 72, entry_lba, 32, 128)
            return install.fix_header(h, entries)
        self.primary = bytes(512) + header(1, install.CAPACITY // 512 - 1, 2) + entries
        self.secondary = entries + header(install.CAPACITY // 512 - 1, 1, install.CAPACITY // 512 - 33)
        with self.backup.open('wb') as f:
            f.truncate(install.CAPACITY)
            f.write(self.primary)
            f.seek(install.CAPACITY - len(self.secondary))
            f.write(self.secondary)
        images = self.root / 'images'; images.mkdir()
        boot = bytearray(1024); boot[:8] = b'ANDROID!'
        boot[64:64 + len(b'root=/dev/mmcblk0p14')] = b'root=/dev/mmcblk0p14'
        names = {'boot': 'openwrt-msm89xx-msm8916-generic-mf68e-squashfs-boot.img',
                 'root': 'openwrt-msm89xx-msm8916-generic-mf68e-squashfs-system.img'}
        (images / names['boot']).write_bytes(boot)
        (images / names['root']).write_bytes(b'hsqs' + bytes(1020))
        (images / 'sha256sums').write_text(''.join(install.sha(images / n) + '  ' + n + '\n' for n in names.values()))
        firmware = self.root / 'firmware'; firmware.mkdir()
        for name in ('rpm', 'sbl1', 'tz', 'hyp', 'aboot'):
            (firmware / (name + '.mbn')).write_bytes(b'generic,mf68e' + bytes(605312 if name == 'tz' else 2000))
        provenance = dict(compatible='generic,mf68e', files={p.name: install.sha(p) for p in firmware.glob('*.mbn')})
        (firmware / 'build-info.json').write_text(json.dumps(provenance))
        loader = self.root / 'loader.bin'; loader.write_bytes(b'synthetic-test-loader')
        self.loader_patch = patch.object(install, 'LOADER_SHA', install.sha(loader))
        self.loader_patch.start(); self.addCleanup(self.loader_patch.stop)
        self.verify_patch = patch.object(install, 'verify_backup')
        self.verify_patch.start(); self.addCleanup(self.verify_patch.stop)
        self.bundle = self.root / 'bundle'
        with contextlib.redirect_stdout(io.StringIO()):
            install.prepare(argparse.Namespace(backup=self.backup, images=images,
                firmware=firmware, loader=loader, output=self.bundle))
        self.args = argparse.Namespace(bundle=self.bundle, backup=self.backup, write=True,
            device_serial='5664c9ea', edl=Path(__file__), python=Path('python3'))

    def test_layout_preserves_radio_and_allocates_sufficient_tz(self):
        m = install.load_bundle(self.bundle)
        new = {p['name']: p for p in m['partitions']}
        for p in self.stock:
            if p['name'] not in ('system', 'userdata', 'tz'):
                self.assertEqual((p['start_sector'], p['sectors']),
                                 (new[p['name']]['start'], new[p['name']]['sectors']))
        self.assertEqual(new['rootfs']['number'], 14)
        self.assertEqual(new['rootfs_data']['number'], 15)
        self.assertEqual(new['modem']['number'], 3)
        self.assertEqual(new['persist']['number'], 6)
        self.assertGreater(new['tz']['sectors'] * 512, 605312)
        protected = [p for p in self.stock if p['name'] in
                     ('modem', 'modemst1', 'modemst2', 'fsc', 'fsg', 'persist', 'sec', 'recovery')]
        for op in m['operations']:
            for p in protected:
                self.assertFalse(op['start'] < p['start_sector'] + p['sectors'] and
                                 p['start_sector'] < op['start'] + op['sectors'])

    def simulator(self, calls, changes, corrupt_live=False, corrupt_write=False):
        def run(command, **kwargs):
            action, start, count_or_file = command[2:5]
            start = int(start)
            calls.append(action)
            if action == 'ws':
                changes.append((start * 512, Path(count_or_file).read_bytes()))
            elif action == 'rs':
                size = int(count_or_file) * 512
                data = bytearray(install.read_at(self.backup, start * 512, size))
                for offset, payload in changes:
                    low, high = max(start * 512, offset), min(start * 512 + size, offset + len(payload))
                    if low < high:
                        data[low-start*512:high-start*512] = payload[low-offset:high-offset]
                if corrupt_live or (corrupt_write and changes):
                    data[0] ^= 1
                Path(command[5]).write_bytes(data)
            else:
                raise AssertionError('Unexpected EDL command ' + action)
            return subprocess.CompletedProcess(command, 0, '', '')
        return run

    def test_full_simulated_flash_verifies_all_writes_and_commits_gpt_last(self):
        calls, changes = [], []
        with patch.object(subprocess, 'run', side_effect=self.simulator(calls, changes)), contextlib.redirect_stdout(io.StringIO()):
            install.execute(self.args)
        self.assertEqual(calls[:6], ['rs'] * 6)
        self.assertEqual(calls[6:], ['ws', 'rs'] * 10)
        self.assertEqual(changes[-1][0], 0)
        journal = json.loads((self.bundle / 'flash-journal.json').read_text())
        self.assertEqual(len([j for j in journal if j['state'] == 'verified']), 10)
        self.assertEqual(changes[-1][1], (self.bundle / 'gpt-primary.bin').read_bytes())

    def test_wrong_live_device_never_writes(self):
        calls, changes = [], []
        with patch.object(subprocess, 'run', side_effect=self.simulator(calls, changes, corrupt_live=True)):
            with self.assertRaisesRegex(ValueError, 'Live device differs'):
                install.execute(self.args)
        self.assertNotIn('ws', calls)

    def test_failed_readback_stops_before_bootloader_and_gpt(self):
        calls, changes = [], []
        with patch.object(subprocess, 'run', side_effect=self.simulator(calls, changes, corrupt_write=True)), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(ValueError, 'Write verification failed'):
                install.execute(self.args)
        self.assertEqual(calls.count('ws'), 1)

    def test_redirected_write_is_rejected_before_usb(self):
        p = self.bundle / 'manifest.json'
        m = json.loads(p.read_text()); m['operations'][0]['start'] = 535552
        p.write_text(json.dumps(m))
        with patch.object(subprocess, 'run') as usb:
            with self.assertRaisesRegex(ValueError, 'Incorrect write address'):
                install.execute(self.args)
            usb.assert_not_called()

    def test_corrupted_payload_is_rejected_before_usb(self):
        (self.bundle / 'boot.bin').write_bytes(bytes(1024))
        with patch.object(subprocess, 'run') as usb:
            with self.assertRaisesRegex(ValueError, 'Payload checksum mismatch'):
                install.execute(self.args)
            usb.assert_not_called()

    def test_corrupted_stock_gpt_is_rejected(self):
        with self.backup.open('r+b') as f:
            f.seek(512 + 16); f.write(bytes(4))
        with self.assertRaisesRegex(ValueError, 'Invalid GPT header CRC'):
            install.make_layout(self.backup)

    def test_default_flash_is_offline(self):
        self.args.write = False
        with patch.object(subprocess, 'run') as usb, contextlib.redirect_stdout(io.StringIO()):
            install.execute(self.args)
            usb.assert_not_called()


if __name__ == '__main__':
    unittest.main()
