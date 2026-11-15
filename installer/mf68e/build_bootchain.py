#!/usr/bin/env python3
"""Build a pinned, experimental MF68E lk1st + qhypstub firmware set."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request
import zipfile

COMMITS = {
    'lk2nd': 'cf45aefd22d744b2bf9b39455afae697ce430063',
    'qhypstub': 'fca3c513b6fb5e5b8fabae21dac1f4a5c0b51bc6',
    'qtestsign': '0eef3b552b1ada848f22bad38ab2e40407307c5b',
}
BASE_URL = ('https://raw.githubusercontent.com/Mio-sha512/openstick-stuff/'
            'refs/heads/main/builder-stuff/dragonboard-410c-bootloader-emmc-linux-176.zip')
BASE_SHA = 'a37c4e82a970ae2350fcfc7180559caf1dc3928e7c169316fe4ab899b7d305ad'


def run(*args, **kwargs):
    subprocess.run(list(map(str, args)), check=True, **kwargs)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--work', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--source-root', type=Path, help='Existing pinned sources: lk2nd/, qhypstub/, qtestsign/')
    p.add_argument('--base-firmware', type=Path)
    p.add_argument('--arm-prefix', default='arm-none-eabi-')
    p.add_argument('--aarch64-prefix', default='aarch64-linux-gnu-')
    p.add_argument('--make', default='make')
    p.add_argument('--jobs', type=int, default=4)
    args = p.parse_args()
    args.work = args.work.resolve()
    args.work.mkdir(parents=True, exist_ok=True)
    sources = {}
    for name, commit in COMMITS.items():
        dest = (args.source_root / name if args.source_root else args.work / name).resolve()
        if not dest.exists():
            run('git', 'clone', 'https://github.com/msm8916-mainline/' + name + '.git', dest)
            run('git', '-C', dest, 'checkout', '--detach', commit)
        actual = subprocess.check_output(['git', '-C', str(dest), 'rev-parse', 'HEAD'], text=True).strip()
        if actual != commit:
            raise ValueError('Unexpected source revision: ' + name)
        # A cache is allowed only with this script's exact two lk2nd modifications.
        changed = subprocess.check_output(['git', '-C', str(dest), 'diff', '--name-only', 'HEAD'], text=True).splitlines()
        allowed = {'project/lk1st-msm8916.mk', 'lk2nd/device/dts/msm8916/msm8916-512mb-mtp.dts'} if name == 'lk2nd' else set()
        if set(changed) - allowed:
            raise ValueError('Unexpected source modifications: ' + name)
        sources[name] = dest
    lk = sources['lk2nd']
    rel = 'lk2nd/device/dts/msm8916/msm8916-512mb-mtp.dts'
    original = subprocess.check_output(['git', '-C', str(lk), 'show', 'HEAD:' + rel], text=True)
    node = ('&lk2nd {\n\tgeneric-mf68e {\n\t\tmodel = "MF68E experimental";\n'
            '\t\tcompatible = "generic,mf68e";\n'
            '\t\tlk2nd,dtb-files = "msm8916-generic-mf68e";\n\t};')
    (lk / rel).write_text(original.replace('&lk2nd {', node, 1))
    rel = 'project/lk1st-msm8916.mk'
    original = subprocess.check_output(['git', '-C', str(lk), 'show', 'HEAD:' + rel], text=True)
    (lk / rel).write_text(original + '\nDEFINES += USE_TARGET_HS200_CAPS=1\n')
    env = dict(os.environ)
    env.pop('MAKEFLAGS', None)
    run(args.make, '-C', lk, '-j' + str(args.jobs), 'TOOLCHAIN_PREFIX=' + args.arm_prefix,
        'LK2ND_BUNDLE_DTB=msm8916-512mb-mtp.dtb', 'LK2ND_COMPATIBLE=generic,mf68e',
        'lk1st-msm8916', env=env)
    run(args.make, '-C', sources['qhypstub'], 'CROSS_COMPILE=' + args.aarch64_prefix, env=env)
    archive = args.base_firmware or args.work / 'db410c.zip'
    if not archive.exists():
        urllib.request.urlretrieve(BASE_URL, archive)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != BASE_SHA:
        raise ValueError('Base firmware archive checksum mismatch')
    args.output.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as z:
        for name in ('rpm', 'sbl1', 'tz'):
            data = z.read('dragonboard-410c-bootloader-emmc-linux-176/' + name + '.mbn')
            (args.output / (name + '.mbn')).write_bytes(data)
    signer = sources['qtestsign'] / 'qtestsign.py'
    run(sys.executable, signer, 'hyp', sources['qhypstub'] / 'qhypstub.elf',
        '-o', args.output / 'hyp.mbn')
    run(sys.executable, signer, 'aboot', lk / 'build-lk1st-msm8916/emmc_appsboot.mbn',
        '-o', args.output / 'aboot.mbn')
    info = dict(experimental=True, commits=COMMITS, base_firmware_sha256=BASE_SHA,
                compatible='generic,mf68e', board_dtb='msm8916-512mb-mtp.dtb',
                hardware_boot_validated=False,
                files={p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                       for p in sorted(args.output.glob('*.mbn'))})
    (args.output / 'build-info.json').write_text(json.dumps(info, indent=2) + '\n')
    print('Built experimental firmware in ' + str(args.output))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        sys.exit('ERROR: ' + str(error))
