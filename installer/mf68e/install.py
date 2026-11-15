#!/usr/bin/env python3
"""Experimental installer for the backed-up 5664c9ea device. No implicit writes."""
import argparse
import hashlib
import json
import pathlib
import struct
import subprocess
import sys
import tempfile
import uuid
import zlib

SECTOR = 512
CAPACITY = 3909091328
BACKUP_SHA = 'f94da5bcaa1eaef2b9d550dd609707011fa6acf7a28687740573d2be183cb6a7'
LOADER_SHA = '53f193500c03248f0d671ab57bfe9ca8a42967e97f28403294b4b3f854075aca'
LINUX_FS = uuid.UUID('0fc63daf-8483-4772-8e79-3d69d8477de4').bytes_le


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(path):
    with pathlib.Path(path).open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def verify_backup(path):
    require(path.stat().st_size == CAPACITY, 'Wrong backup size')
    require(sha(path) == BACKUP_SHA, 'Wrong or corrupted device backup')


def read_at(path, offset, length):
    with pathlib.Path(path).open('rb') as f:
        f.seek(offset)
        result = f.read(length)
    require(len(result) == length, 'Truncated input')
    return result


def parse_gpt(header, entries, expected_lba):
    require(header[:8] == b'EFI PART', 'Missing GPT signature')
    size, crc = struct.unpack_from('<II', header, 12)
    require(92 <= size <= SECTOR, 'Invalid GPT header size')
    check = bytearray(header[:size])
    struct.pack_into('<I', check, 16, 0)
    require(zlib.crc32(check) == crc, 'Invalid GPT header CRC')
    require(struct.unpack_from('<Q', header, 24)[0] == expected_lba, 'Wrong GPT LBA')
    count, entry_size, crc = struct.unpack_from('<III', header, 80)
    require(count in (32, 128) and entry_size == 128, 'Unsupported GPT geometry')
    require(zlib.crc32(entries[:count * entry_size]) == crc, 'Invalid GPT entries CRC')
    parts = []
    for i in range(count):
        entry = entries[i * entry_size:(i + 1) * entry_size]
        if entry[:16] != bytes(16):
            start, end = struct.unpack_from('<QQ', entry, 32)
            parts.append(dict(number=i + 1, name=entry[56:128].decode('utf-16le').split('\0')[0],
                              start=start, sectors=end - start + 1))
    ordered = sorted(parts, key=lambda p: p['start'])
    first, last = struct.unpack_from('<QQ', header, 40)
    for p in ordered:
        require(first <= p['start'] and p['sectors'] > 0 and
                p['start'] + p['sectors'] - 1 <= last, 'Partition outside GPT bounds')
    for a, b in zip(ordered, ordered[1:]):
        require(a['start'] + a['sectors'] <= b['start'], 'Overlapping GPT partitions')
    return parts


def fix_header(header, entries):
    header = bytearray(header)
    count, size = struct.unpack_from('<II', header, 80)
    struct.pack_into('<I', header, 88, zlib.crc32(entries[:count * size]))
    struct.pack_into('<I', header, 16, 0)
    length = struct.unpack_from('<I', header, 12)[0]
    struct.pack_into('<I', header, 16, zlib.crc32(header[:length]))
    return bytes(header)


def make_layout(backup):
    primary = read_at(backup, 0, 34 * SECTOR)
    secondary = read_at(backup, CAPACITY - 33 * SECTOR, 33 * SECTOR)
    original = primary[2 * SECTOR:]
    old_parts = parse_gpt(primary[SECTOR:2 * SECTOR], original, 1)
    parse_gpt(secondary[-SECTOR:], secondary[:-SECTOR], CAPACITY // SECTOR - 1)
    require(original == secondary[:-SECTOR], 'GPT copies disagree')
    entries = [bytearray(original[i:i + 128]) for i in range(0, len(original), 128)]
    # Keep physical locations. Reorder GPT entries to match the shipped kernel/preinit.
    entries[0], entries[2] = entries[2], entries[0]  # modem must be p3 for firmware dumper
    entries[23], entries[5] = entries[5], entries[23]  # persist must be p6 for firmware dumper
    entries[13], entries[22] = entries[22], entries[13]  # system <-> modemst2
    entries[14], entries[30] = entries[30], entries[14]  # userdata <-> misc
    for index, name in ((13, 'rootfs'), (14, 'rootfs_data')):
        entries[index][:16] = LINUX_FS
        entries[index][56:128] = name.encode('utf-16le').ljust(72, b'\0')
    # db410c tz.mbn is 605312 bytes, larger than the stock 512 KiB slot.
    # Allocate 1 MiB inside the stock unpartitioned first 64 MiB gap.
    struct.pack_into('<QQ', entries[7], 32, 4096, 6143)
    new_entries = b''.join(entries)
    p_header = fix_header(primary[SECTOR:2 * SECTOR], new_entries)
    b_header = fix_header(secondary[-SECTOR:], new_entries)
    new_parts = parse_gpt(p_header, new_entries, 1)
    parse_gpt(b_header, new_entries, CAPACITY // SECTOR - 1)
    old = {p['name']: p for p in old_parts}
    new = {p['name']: p for p in new_parts}
    require(new['modem']['number'] == 3 and new['persist']['number'] == 6,
            'Firmware dumper requires modem at p3 and persist at p6')
    for name, p in old.items():
        if name not in ('system', 'userdata', 'tz'):
            require((p['start'], p['sectors']) ==
                    (new[name]['start'], new[name]['sectors']), 'Moved a preserved partition')
    return primary[:SECTOR] + p_header + new_entries, new_entries + b_header, new_parts


def prepare(args):
    verify_backup(args.backup)
    require(sha(args.loader) == LOADER_SHA, 'Loader differs from the successfully tested loader')
    require(not args.output.exists(), 'Output already exists; use a new output directory')
    primary, secondary, partitions = make_layout(args.backup)
    parts = {p['name']: p for p in partitions}
    sources = {name: args.firmware / (name + '.mbn')
               for name in ('sbl1', 'rpm', 'tz', 'hyp', 'aboot')}
    sources['boot'] = args.images / 'openwrt-msm89xx-msm8916-generic-mf68e-squashfs-boot.img'
    sources['rootfs'] = args.images / 'openwrt-msm89xx-msm8916-generic-mf68e-squashfs-system.img'
    checksums = {}
    for line in (args.images / 'sha256sums').read_text().splitlines():
        checksum, filename = line.split(maxsplit=1)
        checksums[filename.lstrip('*')] = checksum
    for name in ('boot', 'rootfs'):
        require(sha(sources[name]) == checksums.get(sources[name].name),
                'OpenWrt image checksum mismatch: ' + name)
    provenance = json.loads((args.firmware / 'build-info.json').read_text())
    require(provenance['compatible'] == 'generic,mf68e', 'Wrong firmware compatible string')
    for name in ('sbl1', 'rpm', 'tz', 'hyp', 'aboot'):
        require(sha(sources[name]) == provenance['files'][name + '.mbn'],
                'Firmware checksum mismatch: ' + name)
    require(read_at(sources['boot'], 0, 8) == b'ANDROID!', 'Invalid Android boot image')
    cmdline = read_at(sources['boot'], 64, 512).split(b'\0')[0]
    require(b'root=/dev/mmcblk0p14' in cmdline, 'Unexpected boot image root device')
    require(read_at(sources['rootfs'], 0, 4) == b'hsqs', 'Rootfs is not squashfs')
    require(b'generic,mf68e' in sources['aboot'].read_bytes(), 'Bootloader lacks MF68E identifier')
    payloads = {}
    for name, source in sources.items():
        data = source.read_bytes()
        require(len(data) > 0, 'Empty firmware payload: ' + name)
        data += bytes((-len(data)) % SECTOR)
        require(len(data) <= parts[name]['sectors'] * SECTOR, 'Payload exceeds partition: ' + name)
        payloads[name] = data
    # Make preinit format a fresh overlay instead of accepting Android's ext4 userdata.
    payloads['overlay-reset'] = bytes(1024 * 1024)
    payloads['gpt-secondary'] = secondary
    payloads['gpt-primary'] = primary
    order = ['rootfs', 'boot', 'rpm', 'tz', 'hyp', 'aboot', 'sbl1',
             'overlay-reset', 'gpt-secondary', 'gpt-primary']
    args.output.mkdir(parents=True)
    (args.output / 'loader.bin').write_bytes(args.loader.read_bytes())
    (args.output / 'build-info.json').write_text(json.dumps(provenance, indent=2) + '\n')
    operations = []
    for name in order:
        start = (parts[name]['start'] if name in parts else
                 parts['rootfs_data']['start'] if name == 'overlay-reset' else
                 CAPACITY // SECTOR - 33 if name == 'gpt-secondary' else 0)
        filename = name + '.bin'
        path = args.output / filename
        path.write_bytes(payloads[name])
        operations.append(dict(name=name, file=filename, start=start,
                               sectors=len(payloads[name]) // SECTOR, sha256=sha(path)))
    manifest = dict(format=1, experimental=True, device_adb_serial='5664c9ea',
                    device_edl_serial='03d861b9', backup_sha256=BACKUP_SHA,
                    capacity=CAPACITY, loader_sha256=LOADER_SHA, partitions=partitions,
                    operations=operations, hardware_boot_validated=False)
    (args.output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps(manifest, indent=2))


def load_bundle(bundle):
    m = json.loads((bundle / 'manifest.json').read_text())
    require(m['format'] == 1 and m['capacity'] == CAPACITY and m['backup_sha256'] == BACKUP_SHA,
            'Wrong bundle identity')
    require(sha(bundle / 'loader.bin') == LOADER_SHA, 'Loader checksum mismatch')
    for op in m['operations']:
        path = bundle / op['file']
        require(path.resolve().parent == bundle.resolve(), 'Invalid payload path')
        require(path.stat().st_size == op['sectors'] * SECTOR, 'Payload length mismatch')
        require(sha(path) == op['sha256'], 'Payload checksum mismatch: ' + op['name'])
        require(op['start'] >= 0 and op['start'] + op['sectors'] <= CAPACITY // SECTOR,
                'Write outside device')
    return m


def execute(args):
    m = load_bundle(args.bundle)
    verify_backup(args.backup)
    # Reconstruct the expected bundle layout rather than trusting a hand-edited manifest.
    primary, secondary, parts = make_layout(args.backup)
    require(m['partitions'] == parts, 'Bundle layout differs from device-specific migration')
    require((args.bundle / 'gpt-primary.bin').read_bytes() == primary and
            (args.bundle / 'gpt-secondary.bin').read_bytes() == secondary, 'Wrong GPT payloads')
    expected_names = ['rootfs', 'boot', 'rpm', 'tz', 'hyp', 'aboot', 'sbl1',
                      'overlay-reset', 'gpt-secondary', 'gpt-primary']
    require([op['name'] for op in m['operations']] == expected_names, 'Unexpected operation order')
    by_name = {p['name']: p for p in parts}
    for op in m['operations']:
        name = op['name']
        expected = (by_name[name]['start'] if name in by_name else
                    by_name['rootfs_data']['start'] if name == 'overlay-reset' else
                    CAPACITY // SECTOR - 33 if name == 'gpt-secondary' else 0)
        require(op['start'] == expected, 'Incorrect write address: ' + name)
        limit = by_name[name]['sectors'] if name in by_name else (
            2048 if name == 'overlay-reset' else 33 if name == 'gpt-secondary' else 34)
        require(op['sectors'] <= limit, 'Oversized write: ' + name)
    if not args.write:
        print('OFFLINE VALIDATION PASSED. No USB access or device writes performed.')
        for op in m['operations']:
            print(f"{op['name']}: sector {op['start']}, {op['sectors'] * SECTOR} bytes")
        return
    require(args.device_serial == '5664c9ea', 'Explicit target serial required')
    require(args.edl and args.edl.is_file(), '--edl must point to edl.py')
    require(not (args.bundle / 'flash-journal.json').exists(),
            'Previous flash journal exists; inspect it before attempting recovery')
    loader = str((args.bundle / 'loader.bin').resolve())
    def edl(*command):
        if command[0] == 'rs':
            pathlib.Path(command[3]).unlink(missing_ok=True)
        result = subprocess.run([str(args.python), str(args.edl), *map(str, command),
                                 '--loader=' + loader, '--memory=emmc'],
                                capture_output=True, text=True, timeout=120)
        with (args.bundle / 'flash.log').open('a') as log:
            log.write(result.stdout + result.stderr)
        require(result.returncode == 0, 'EDL failed; see flash.log')
        return result.stdout + result.stderr
    journal = []
    # Exclusive creation prevents concurrent installers from both passing preflight.
    with (args.bundle / 'flash-journal.json').open('x') as f:
        f.write('[]\n')
    def record(name, state):
        journal.append(dict(operation=name, state=state))
        (args.bundle / 'flash-journal.json').write_text(json.dumps(journal, indent=2) + '\n')
    with tempfile.TemporaryDirectory(prefix='mf68e-readback-') as directory:
        readback = pathlib.Path(directory) / 'read.bin'
        # Match the original GPT AND device-specific radio bytes before any write.
        checks = [(0, 34), (CAPACITY // SECTOR - 33, 33)]
        checks += [(by_name[n]['start'], by_name[n]['sectors'])
                   for n in ('modemst1', 'modemst2', 'fsg', 'persist')]
        for start, count in checks:
            edl('rs', start, count, readback)
            require(readback.read_bytes() == read_at(args.backup, start * SECTOR, count * SECTOR),
                    f'Live device differs from backup at sector {start}; no writes performed')
        for op in m['operations']:
            print('Writing and verifying ' + op['name'], flush=True)
            record(op['name'], 'started')
            edl('ws', op['start'], (args.bundle / op['file']).resolve())
            edl('rs', op['start'], op['sectors'], readback)
            require(sha(readback) == op['sha256'], 'Write verification failed: ' + op['name'])
            record(op['name'], 'verified')
    print('All writes verified. Device remains in EDL; reboot separately for first boot.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('prepare')
    for flag in ('backup', 'images', 'firmware', 'loader', 'output'):
        p.add_argument('--' + flag, type=pathlib.Path, required=True)
    p = sub.add_parser('validate')
    p.add_argument('--bundle', type=pathlib.Path, required=True)
    p.add_argument('--backup', type=pathlib.Path, required=True)
    p = sub.add_parser('flash')
    p.add_argument('--bundle', type=pathlib.Path, required=True)
    p.add_argument('--backup', type=pathlib.Path, required=True)
    p.add_argument('--write', action='store_true', help='Actually write; default is offline validation')
    p.add_argument('--device-serial')
    p.add_argument('--edl', type=pathlib.Path)
    p.add_argument('--python', type=pathlib.Path, default=pathlib.Path(sys.executable))
    args = parser.parse_args()
    if args.command == 'prepare':
        prepare(args)
    else:
        if args.command == 'validate':
            args.write = False
        execute(args)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        sys.exit('ERROR: ' + str(error))
