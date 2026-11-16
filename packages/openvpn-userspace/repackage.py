#!/usr/bin/env python3
"""Package the pinned upstream OpenVPN binary for the MF68E's TUN-only kernel."""
import argparse
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--apk', required=True, help='apk-tools 3 binary with mkpkg support')
parser.add_argument('--source', required=True, help='upstream openvpn-openssl-2.7.8-r1.apk')
parser.add_argument('--sign-key', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
source = Path(args.source).resolve()
EXPECTED_SHA256 = 'e524ae85bbad695db2b550fdbc64876530d7b82fa6ea3e7b577ffa27dc6ca9ed'
if hashlib.sha256(source.read_bytes()).hexdigest() != EXPECTED_SHA256:
    parser.error('Upstream package checksum differs from the pinned OpenWrt 25.12.6 package')
apk = str(Path(args.apk).resolve())
with tempfile.TemporaryDirectory() as work:
    root = Path(work) / 'root'
    root.mkdir(mode=0o755)
    ids = Path(work) / 'ids/etc'
    ids.mkdir(parents=True)
    (ids / 'passwd').write_text(f'root:x:{os.getuid()}:{os.getgid()}:root:/root:/bin/sh\n')
    (ids / 'group').write_text(f'root:x:{os.getgid()}:\n')
    # Upstream APK payloads are authenticated by their signed repository index.
    # The input is pinned above; extraction does not trust a new arbitrary payload.
    subprocess.run([apk, 'extract', '--allow-untrusted', '--destination', str(root), str(source)], check=True)
    init = root / 'etc/init.d/openvpn'
    text = init.read_text()
    old = 'procd_set_param command "$PROG"'
    if text.count(old) != 1:
        raise SystemExit('Unexpected upstream init script')
    init.write_text(text.replace(old, old + ' --disable-dco'))
    dump = subprocess.check_output([apk, 'adbdump', str(source)], text=True)
    scripts = {}
    inside = False
    current = None
    for line in dump.splitlines():
        if line == 'scripts:':
            inside = True
        elif inside and line.startswith('  ') and not line.startswith('    ') and line.endswith(': |'):
            current = line.strip()[:-3]
            scripts[current] = []
        elif inside and current and line.startswith('    '):
            scripts[current].append(line[4:])
        elif inside and line and not line.startswith(' '):
            break
    command = [apk, '--root', str(ids.parent), 'mkpkg', '--files', str(root), '--output', str(Path(args.output).resolve()), '--sign-key', str(Path(args.sign_key).resolve())]
    for key, value in {
        'name': 'openvpn-openssl', 'version': '2.7.8-r2', 'arch': 'aarch64_generic',
        'description': 'OpenVPN using OpenSSL, MF68E TUN mode (DCO disabled)',
        'license': 'GPL-2.0', 'url': 'https://openvpn.net/',
        'depends': 'kmod-tun libc libcap-ng liblz4-1 liblzo2 libnl-genl200 libopenssl3',
        'provides': 'openvpn=2.7.8-r2 openvpn-crypto=2.7.8-r2 openvpn-openssl-any',
    }.items():
        command += ['--info', key + ':' + value]
    for name, lines in scripts.items():
        path = Path(work) / name
        path.write_text('\n'.join(lines) + '\n')
        command += ['--script', name + ':' + str(path)]
    subprocess.run(command, check=True)
