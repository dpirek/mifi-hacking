#!/bin/sh
# OpenWrt-only isolated tests; no real interface, radio or SMS action is invoked.
set -eu
dispatch=$1
work=$(mktemp -d /tmp/mifi-dispatch-test.XXXXXX)
trap 'rm -rf "$work"' EXIT
export MIFI_TEST_LOG="$work/log"
export PATH="$work:$PATH"
cat > "$work/ubus" <<'MOCK'
#!/bin/sh
printf '%s\n' "$*" >> "$MIFI_TEST_LOG"
echo '{"ok":true}'
MOCK
cat > "$work/uci" <<'MOCK'
#!/bin/sh
case "$*" in *network.lan) echo interface ;; *wireless.radio0) echo wifi-device ;; *) exit 1 ;; esac
MOCK
cat > "$work/ifup" <<'MOCK'
#!/bin/sh
printf 'ifup %s\n' "$*" >> "$MIFI_TEST_LOG"
MOCK
chmod 755 "$work/ubus" "$work/uci" "$work/ifup"
call() { printf '%s\n' "$1" | sh "$dispatch"; }
contains() { case "$1" in *"$2"*) ;; *) echo "FAIL: expected $2 in $1"; exit 1 ;; esac; }
contains "$(call '{"action":"status","args":{}}')" 'board'
contains "$(call '{"action":"interfaces","args":{}}')" 'true'
contains "$(call '{"action":"wireless","args":{}}')" 'true'
contains "$(call '{"action":"interface.restart","args":{"name":"lan"}}')" 'true'
contains "$(call '{"action":"wireless.down","args":{"name":"radio0"}}')" 'true'
contains "$(call '{"action":"wireless.up","args":{"name":"radio0"}}')" 'true'
contains "$(call '{"action":"shell","args":{"command":"reboot"}}')" 'Unsupported'
contains "$(call '{"action":"interface.restart","args":{"name":"lan;reboot"}}')" 'Invalid name'
contains "$(call '{"action":"wireless.down","args":{"name":"unknown"}}')" 'Unknown radio'
contains "$(call '{"action":"interface.restart","args":{"name":123}}')" 'Invalid name'
contains "$(call 'bad json')" 'Invalid request'
[ "$(grep -c '^ifup' "$work/log")" = 1 ]
[ "$(grep -c 'network.wireless down' "$work/log")" = 1 ]
echo 'PASS: dispatcher allowlist, status, interfaces, radios, type validation and injection rejection'
