#!/bin/sh
# A private display snapshot of the newest received message. Never sends/deletes SMS.
mm() { mmcli --timeout=3 "$@"; }
list=$(mm -m any --messaging-list-sms -J 2>/dev/null) || {
 printf 'SMS unavailable\nThe modem is not ready.\n'; exit 0
}
paths=$(jsonfilter -s "$list" -e '@["modem.messaging.sms"][*]')
best=; best_time=-1; best_id=-1
started=$(date +%s)
for path in $paths; do
 [ "$(( $(date +%s) - started ))" -lt 20 ] || {
  printf 'SMS unavailable\nThe inbox is taking too long to read. Please retry.\n'; exit 0
 }
 id=${path##*/}
 case "$id" in ''|*[!0-9]*) continue ;; esac
 message=$(mm -s "$id" -J 2>/dev/null) || {
  printf 'SMS unavailable\nCould not read the inbox.\n'; exit 0
 }
 state=$(jsonfilter -s "$message" -e '@.sms.properties.state')
 [ "$state" = received ] || continue
 stamp=$(jsonfilter -s "$message" -e '@.sms.properties.timestamp')
 base=$(printf '%s' "$stamp" | cut -c1-19 | tr T ' ')
 epoch=$(TZ=UTC date -d "$base" +%s 2>/dev/null) || epoch=0
 zone=$(printf '%s' "$stamp" | cut -c20-)
 case "$zone" in
  +??:??|-??:??)
   hours=$(printf '%s' "$zone" | cut -c2-3)
   minutes=$(printf '%s' "$zone" | cut -c5-6)
   epoch=$(awk -v t="$epoch" -v h="$hours" -v m="$minutes" -v z="$zone" 'BEGIN {o=(h*60+m)*60; printf "%.0f",t+(substr(z,1,1)=="+"?-o:o)}') ;;
 esac
 if [ "$epoch" -gt "$best_time" ] || { [ "$epoch" -eq "$best_time" ] && [ "$id" -gt "$best_id" ]; }; then
  best=$message; best_time=$epoch; best_id=$id
 fi
done
if [ -z "$best" ]; then
 printf 'Inbox empty\nNo received SMS messages.\n'
else
 sender=$(jsonfilter -s "$best" -e '@.sms.content.number' | tr '\r\n' '  ')
 text=$(jsonfilter -s "$best" -e '@.sms.content.text')
 case "$sender" in ''|'-- ') sender='Unknown sender' ;; esac
 case "$text" in ''|--) text='Message has no text.' ;; esac
 printf '%s\n%s\n' "$sender" "$text"
fi
