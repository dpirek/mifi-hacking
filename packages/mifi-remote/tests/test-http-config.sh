#!/bin/sh
# Isolated OpenWrt RPC tests. Configuration and services are stubbed.
set -eu
rpc=$1
work=$(mktemp -d /tmp/mifi-http-test.XXXXXX)
trap 'rm -rf "$work"' EXIT
export PATH="$work:$PATH"
printf '#!/bin/sh\nexit 0\n' > "$work/uci"
printf '#!/bin/sh\nexit 0\n' > "$work/service"
chmod 755 "$work/uci" "$work/service"
touch "$work/config"
sed -e "s|/etc/init.d/mifi-remote|$work/service|g" -e "s|/etc/config/mifi-remote|$work/config|g" "$rpc" > "$work/rpc"
for server in http://localhost:3000 http://127.0.0.1:3000 http://192.168.1.183:3000 https://mifi.bohoosh.com; do
 result=$(printf '{"server":"%s","token":"","enabled":false}\n' "$server" | sh "$work/rpc" call configure)
 case "$result" in *'"ok":true'*) ;; *) echo "FAIL $server: $result"; exit 1 ;; esac
done
for server in ftp://localhost:3000 http://localhost:3000/path http://localhost:3000/ http://user@localhost:3000; do
 result=$(printf '{"server":"%s","token":"","enabled":false}\n' "$server" | sh "$work/rpc" call configure)
 case "$result" in *'HTTP or HTTPS server origin'*) ;; *) echo "FAIL rejected URL: $result"; exit 1 ;; esac
done
echo 'PASS: HTTP, HTTPS, localhost, loopback and LAN origins; invalid origins rejected'
