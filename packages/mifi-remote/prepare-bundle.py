#!/usr/bin/env python3
"""Prepare files and checksums for installing on an existing OpenWrt router."""
from pathlib import Path
import hashlib
import shutil
import sys
import tarfile
import tempfile
repo = Path(__file__).resolve().parents[2]
output = Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/mifi-remote-bundle.tar.gz').resolve()
files = {
 'packages/mifi-remote/files/mifi-remote-agent': 'usr/bin/mifi-remote-agent',
 'packages/mifi-remote/files/mifi-remote-dispatch': 'usr/libexec/mifi-remote-dispatch',
 'packages/mifi-remote/files/mifi-remote.rpc': 'usr/libexec/rpcd/mifi-remote',
 'packages/mifi-remote/files/mifi-remote.init': 'etc/init.d/mifi-remote',
 'packages/mifi-remote/files/mifi-remote.config': 'etc/config/mifi-remote',
 'packages/luci-app-mifi-remote/root/usr/share/luci/menu.d/luci-app-mifi-remote.json': 'usr/share/luci/menu.d/luci-app-mifi-remote.json',
 'packages/luci-app-mifi-remote/root/usr/share/rpcd/acl.d/luci-app-mifi-remote.json': 'usr/share/rpcd/acl.d/luci-app-mifi-remote.json',
 'packages/luci-app-mifi-remote/htdocs/luci-static/resources/view/mifi-remote/config.js': 'www/luci-static/resources/view/mifi-remote/config.js',
 'packages/luci-app-calls/root/usr/libexec/rpcd/calls': 'usr/libexec/rpcd/calls',
 'packages/luci-app-calls/root/usr/share/luci/menu.d/luci-app-calls.json': 'usr/share/luci/menu.d/luci-app-calls.json',
 'packages/luci-app-calls/root/usr/share/rpcd/acl.d/luci-app-calls.json': 'usr/share/rpcd/acl.d/luci-app-calls.json',
 'packages/luci-app-calls/htdocs/luci-static/resources/view/calls/calls.js': 'www/luci-static/resources/view/calls/calls.js',
 'packages/mifi-remote/install-staged.sh': 'install-staged.sh',
}
with tempfile.TemporaryDirectory() as directory:
 stage = Path(directory)
 checksums = []
 for src, dst in files.items():
  target = stage / dst
  target.parent.mkdir(parents=True, exist_ok=True)
  shutil.copy2(repo / src, target)
  if dst.startswith(('usr/bin/', 'usr/libexec/', 'etc/init.d/')) or dst == 'install-staged.sh': target.chmod(0o755)
  else: target.chmod(0o600 if dst == 'etc/config/mifi-remote' else 0o644)
  checksums.append(f'{hashlib.sha256(target.read_bytes()).hexdigest()}  {dst}\n')
 (stage / 'SHA256SUMS').write_text(''.join(checksums))
 def root_owner(info):
  info.uid = info.gid = 0
  info.uname = info.gname = 'root'
  return info
 with tarfile.open(output, 'w:gz') as archive:
  for target in sorted(stage.rglob('*')):
   if target.is_file(): archive.add(target, arcname=str(target.relative_to(stage)), filter=root_owner)
print(output)
