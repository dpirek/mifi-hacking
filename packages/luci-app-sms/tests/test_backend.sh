#!/bin/sh
# Run on OpenWrt: sh tests/test_backend.sh /path/to/rpcd/sms
set -eu
backend=$1
work=$(mktemp -d /tmp/sms-test.XXXXXX)
trap 'rm -rf "$work"' EXIT
export SMS_TEST_DIR=$work
export PATH="$work:$PATH"
cat > "$work/mmcli" <<'MOCK'
#!/bin/sh
printf '%s\n' "$*" >> "$SMS_TEST_DIR/calls"
case "$*" in
 *--messaging-list-sms*)
  if [ -f "$SMS_TEST_DIR/offline" ]; then echo 'error: modem not enabled yet' >&2; exit 1; fi
  echo '{"modem.messaging.sms":["/org/freedesktop/ModemManager1/SMS/7"]}' ;;
 *--messaging-create-sms=*)
  for arg do case "$arg" in --messaging-create-sms-with-text=*) cat "${arg#*=}" > "$SMS_TEST_DIR/actual" ;; esac; done
  echo '{"modem":{"messaging":{"created-sms":"/org/freedesktop/ModemManager1/SMS/8"}}}' ;;
 *--send*)
  if [ -f "$SMS_TEST_DIR/fail" ]; then echo 'network timeout' >&2; exit 1; fi
  echo 'successfully sent the SMS' ;;
 *) echo '{"sms":{"content":{"text":"hello"},"properties":{"state":"received"}}}' ;;
esac
MOCK
chmod 755 "$work/mmcli"
call() { printf '%s\n' "$2" | sh "$backend" call "$1"; }
contains() { case "$1" in *"$2"*) ;; *) echo "FAIL: expected $2 in $1"; exit 1 ;; esac; }
contains "$(sh "$backend" list)" '"send"'
contains "$(call list '{}')" '/SMS/7'
contains "$(call read '{"id":"7"}')" 'received'
contains "$(call read '{"id":"7;touch /tmp/injected"}')" 'Invalid message ID'
contains "$(call send '{"number":"1,number=2","text":"hello"}')" 'optional leading'
contains "$(call send '{"number":123,"text":"hello"}')" 'must be a string'
contains "$(call send '{"number":"123","text":""}')" 'Enter a message'
contains "$(call send '{"number":"123","text":true}')" 'must be a string'
contains "$(call send '{"number":"+15551234","text":"你好, \"quotes\", '\''apostrophe'\'' $(touch /tmp/SHOULD_NOT_EXIST)\nlast line\n"}')" '"ok": true'
printf '你好, "quotes", '\''apostrophe'\'' $(touch /tmp/SHOULD_NOT_EXIST)\nlast line\n' > "$work/expected"
cmp "$work/actual" "$work/expected"
[ ! -e /tmp/SHOULD_NOT_EXIST ]
touch "$work/fail"
contains "$(call send '{"number":"123","text":"hello"}')" 'Refresh and check its state'
[ "$(grep -c -- --send "$work/calls")" = 2 ]
touch "$work/offline"
contains "$(call list '{}')" 'modem not enabled yet'
contains "$(call send 'not json')" 'Invalid JSON'
echo 'PASS: backend list/read/send, quoting, Unicode, validation, failures and no retry'
