#!/bin/sh
# Run on the router from the extracted feature bundle. Does not change IMEI.
set -eu
stage=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
[ "$(id -u)" = 0 ] || { echo 'Run this installer as root.' >&2; exit 1; }
(cd "$stage" && sha256sum -c SHA256SUMS) || {
	echo 'Bundle checksum verification failed.' >&2; exit 1;
}
ubus call system board | grep -q '"board_name".*"generic,mf68e"' || {
	echo 'This staged bundle is for the MF68E OpenWrt target.' >&2; exit 1;
}

# Validate the staged tool against the actual modem without writing NV.
"$stage/usr/bin/modem-identity" read >/dev/null
backup="/root/modem-identity-before-install-$(date +%s)-$$"
mkdir -m 700 "$backup"
for target in \
	usr/bin/modem-identity \
	usr/libexec/rpcd/modem-identity \
	etc/init.d/rmtfs \
	etc/config/rmtfs \
	usr/share/luci/menu.d/luci-app-modem-identity.json \
	usr/share/rpcd/acl.d/luci-app-modem-identity.json \
	www/luci-static/resources/view/modem-identity/config.js \
	www/luci-static/resources/view/modem-identity/config.css
do
	if [ -e "/$target" ]; then
		mkdir -p "$backup/$(dirname "$target")"
		cp -p "/$target" "$backup/$target"
	else
		printf '%s\n' "$target" >> "$backup/created-files"
	fi
	# Preserve existing write-mode preference. Installing alone does not restart the modem.
	[ "$target" = etc/config/rmtfs ] && [ -e "/$target" ] && continue
	mkdir -p "/$(dirname "$target")"
	cp "$stage/$target" "/$target"
done
chmod 755 /usr/bin/modem-identity /usr/libexec/rpcd/modem-identity /etc/init.d/rmtfs
chmod 644 /etc/config/rmtfs \
	/usr/share/luci/menu.d/luci-app-modem-identity.json \
	/usr/share/rpcd/acl.d/luci-app-modem-identity.json \
	/www/luci-static/resources/view/modem-identity/config.js \
	/www/luci-static/resources/view/modem-identity/config.css

printf 'Installed. Previous files are saved in %s\n' "$backup"
printf 'IMEI and running modem write mode were not changed.\n'
printf 'Reloading RPC; sign in again if the LuCI session expires.\n'
/etc/init.d/rpcd restart
