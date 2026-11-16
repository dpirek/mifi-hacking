#!/bin/sh
# OpenWrt test with a fake mmcli. No real call is created or controlled.
set -eu
backend=$1
work=$(mktemp -d /tmp/mifi-calls-test.XXXXXX)
trap 'rm -rf "$work"' EXIT
export CALLS_TEST_DIR=$work
export PATH="$work:$PATH"
printf ringing-in > "$work/state"
printf incoming > "$work/direction"
cat > "$work/mmcli" <<'MOCK'
#!/bin/sh
printf '%s\n' "$*" >> "$CALLS_TEST_DIR/log"
case "$*" in
 *--voice-list-calls*)
  if [ -f "$CALLS_TEST_DIR/offline" ]; then echo 'modem has no voice capabilities' >&2; exit 1; fi
  if [ -f "$CALLS_TEST_DIR/empty" ]; then echo '{"modem.voice.call":[]}'; else echo '{"modem.voice.call":["/org/freedesktop/ModemManager1/Call/7"]}'; fi ;;
 *--voice-create-call=*) echo 'Successfully created new call: /org/freedesktop/ModemManager1/Call/8' ;;
 *--start*)
  if [ -f "$CALLS_TEST_DIR/fail" ]; then echo 'timeout' >&2; exit 1; fi
  echo 'successfully started call' ;;
 *--accept*|*--hangup*) echo 'operation successful' ;;
 *-J*) printf '{"call":{"dbus-path":"/org/freedesktop/ModemManager1/Call/7","properties":{"number":"<script>caller</script>","direction":"%s","state":"%s","state-reason":"--"}}}\n' "$(cat "$CALLS_TEST_DIR/direction")" "$(cat "$CALLS_TEST_DIR/state")" ;;
 *) echo unexpected >&2; exit 1 ;;
esac
MOCK
chmod 755 "$work/mmcli"
call() { printf '%s\n' "$2" | sh "$backend" call "$1"; }
contains() { case "$1" in *"$2"*) ;; *) echo "FAIL: expected $2 in $1"; exit 1 ;; esac; }
contains "$(sh "$backend" list)" '"answer"'
list=$(call list '{}')
[ "$(jsonfilter -s "$list" -e '@.calls[0].state')" = ringing-in ]
[ "$(jsonfilter -s "$list" -e '@.calls[0].number')" = '<script>caller</script>' ]
[ "$(jsonfilter -s "$list" -e '@.browser_audio')" = false ]
contains "$(call answer '{"id":"7","expected":"ringing-in"}')" '"ok": true'
contains "$(call reject '{"id":"7","expected":"ringing-in"}')" '"ok": true'
printf outgoing > "$work/direction"
contains "$(call answer '{"id":"7","expected":"ringing-in"}')" 'not an incoming'
printf incoming > "$work/direction"
printf active > "$work/state"
contains "$(call answer '{"id":"7","expected":"ringing-in"}')" 'state changed'
contains "$(call reject '{"id":"7","expected":"active"}')" 'no longer ringing'
contains "$(call hangup '{"id":"7","expected":"active"}')" '"ok": true'
printf terminated > "$work/state"
contains "$(call hangup '{"id":"7","expected":"terminated"}')" 'cannot be hung up'
contains "$(call hangup '{"id":"7;reboot","expected":"active"}')" 'Invalid call ID'
contains "$(call answer '{"id":7,"expected":"ringing-in"}')" 'must be a string'
contains "$(call dial '{"number":"1,number=2"}')" 'optional leading'
contains "$(call dial '{"number":123}')" 'must be a string'
contains "$(call dial '{"number":"+15551234"}')" '"id": "8"'
touch "$work/fail"
contains "$(call dial '{"number":"+15551234"}')" 'Refresh before trying again'
[ "$(grep -c -- --start "$work/log")" = 2 ]
[ "$(grep -c -- --accept "$work/log")" = 1 ]
[ "$(grep -c -- --hangup "$work/log")" = 2 ]
touch "$work/empty"
[ "$(jsonfilter -s "$(call list '{}')" -e '@.calls')" = '[ ]' ] || contains "$(call list '{}')" '"calls": [ ]'
touch "$work/offline"
contains "$(call list '{}')" 'no voice capabilities'
contains "$(call dial 'not-json')" 'Invalid JSON'
echo 'PASS: call list, private caller text, dial, answer, reject, hangup, stale states, invalid input, offline and no retries'
