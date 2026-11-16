#!/bin/sh
# Run on OpenWrt from an extracted bundle. Existing pairing is preserved.
set -eu
stage=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
[ "$(id -u)" = 0 ] || { echo 'Run as root.' >&2; exit 1; }
(cd "$stage" && sha256sum -c SHA256SUMS) >/dev/null
for tool in uclient-fetch ubus uci jsonfilter; do command -v "$tool" >/dev/null || { echo "Install prerequisite: $tool" >&2; exit 1; }; done
[ -f /etc/ssl/certs/ca-certificates.crt ] || { echo 'Install ca-bundle.' >&2; exit 1; }
[ -x /usr/libexec/rpcd/sms ] || { echo 'Install luci-app-sms first.' >&2; exit 1; }
backup="/root/mifi-remote-before-install-$(date +%s)-$$"
mkdir -m 700 "$backup"
for file in \
 usr/bin/mifi-remote-agent usr/libexec/mifi-remote-dispatch usr/libexec/rpcd/mifi-remote \
 etc/init.d/mifi-remote etc/config/mifi-remote \
 usr/share/luci/menu.d/luci-app-mifi-remote.json usr/share/rpcd/acl.d/luci-app-mifi-remote.json \
 www/luci-static/resources/view/mifi-remote/config.js \
 usr/libexec/rpcd/calls usr/share/luci/menu.d/luci-app-calls.json \
 usr/share/rpcd/acl.d/luci-app-calls.json www/luci-static/resources/view/calls/calls.js
do
 if [ -e "/$file" ]; then
  mkdir -p "$backup/$(dirname "$file")"; cp -p "/$file" "$backup/$file"
 else printf '%s\n' "$file" >> "$backup/created-files"; fi
 [ "$file" != etc/config/mifi-remote ] || [ ! -f "/$file" ] || continue
 mkdir -p "/$(dirname "$file")"; cp -p "$stage/$file" "/$file"; chown 0:0 "/$file"
done
chown 0:0 /etc/config/mifi-remote
chmod 600 /etc/config/mifi-remote
/etc/init.d/mifi-remote enable
/etc/init.d/mifi-remote restart
/etc/init.d/rpcd restart
printf 'Installed. Backup: %s\nPair through System → Remote management. Disabled by default.\n' "$backup"
