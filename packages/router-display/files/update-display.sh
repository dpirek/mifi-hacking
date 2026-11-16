#!/bin/sh
# One status snapshot. Produces the complete frame before touching /dev/fb0.
. "${DISPLAY_METRICS_LIB:-/usr/lib/router-display/metrics.sh}"

PAGE=${DISPLAY_PAGE:-$(uci -q get display.display.page)}
FRAME=$(mktemp /tmp/router-display-frame.XXXXXX) || exit 1
trap 'rm -f "$FRAME"' EXIT HUP INT TERM
write_frame() {
 "${ROUTER_DISPLAY_BIN:-/usr/bin/router-display}" "$@" > "$FRAME" || return 1
 [ "$(wc -c < "$FRAME")" -eq 32768 ] || return 1
 cat "$FRAME" > "${DISPLAY_FRAMEBUFFER:-/dev/fb0}"
}
if [ "$PAGE" = sms ]; then
 SMS_FILE=${DISPLAY_SMS_FILE:-/var/run/display-sms.txt}
 if [ "${DISPLAY_SMS_REFRESH:-0}" = 1 ] || [ ! -s "$SMS_FILE" ]; then
  umask 077
  snapshot=$(mktemp "${SMS_FILE}.XXXXXX") || exit 1
  if "${DISPLAY_SMS_HELPER:-/usr/lib/router-display/latest-sms.sh}" > "$snapshot"; then
   mv "$snapshot" "$SMS_FILE"
  else
   rm -f "$snapshot"
   printf 'SMS unavailable\nPlease try again later.\n' > "$SMS_FILE"
  fi
 fi
 write_frame -m -j "${DISPLAY_SMS_PAGE:-0}" < "$SMS_FILE"
 exit $?
fi
if [ "$PAGE" = ping ]; then
 PING_FILE=${DISPLAY_PING_FILE:-/var/run/mifi-ping/history}
 if [ -r "$PING_FILE" ]; then write_frame -P < "$PING_FILE"; else write_frame -P < /dev/null; fi
 exit $?
fi
if [ "$PAGE" = clock ]; then
 timezone=$(uci -q get system.@system[0].timezone)
 [ -z "$timezone" ] || { TZ=$timezone; export TZ; }
 write_frame -a
 exit $?
fi
[ "$PAGE" = wifi ] || PAGE=status
display_battery "${DISPLAY_POWER_ROOT:-/sys/class/power_supply}"
MODEM_IDX=$(mmcli -L 2>/dev/null | sed -n 's|.*/Modem/\([0-9][0-9]*\).*|\1|p' | head -1)
MODEM_DATA=
[ -z "$MODEM_IDX" ] || MODEM_DATA=$(mmcli -m "$MODEM_IDX" -K 2>/dev/null)
IMEI=$(printf '%s\n' "$MODEM_DATA" | display_value modem.generic.equipment-identifier)
printf '%s' "$IMEI" | grep -Eq '^[0-9]{15}$' || IMEI=
PHONE=$(printf '%s\n' "$MODEM_DATA" | display_value 'modem.generic.own-numbers.value[1]')
[ -n "$PHONE" ] || PHONE=$(printf '%s\n' "$MODEM_DATA" | display_value modem.generic.own-numbers)
case "$PHONE" in +*) phone_digits=${PHONE#+} ;; *) phone_digits=$PHONE ;; esac
case "$phone_digits" in ''|*[!0-9]*) PHONE= ;; esac
[ "${#phone_digits}" -le 20 ] || PHONE=
display_signal "$MODEM_DATA"
REGISTRATION=$(printf '%s\n' "$MODEM_DATA" | display_value modem.3gpp.registration-state)
OPERATOR=$(printf '%s\n' "$MODEM_DATA" | display_value modem.3gpp.operator-name)
case "$REGISTRATION" in
	home|roaming) [ "$OPERATOR" = -- ] && OPERATOR='Connected' ;;
	searching) OPERATOR='Searching' ;;
	*) OPERATOR='Not registered' ;;
esac
[ -n "$MODEM_IDX" ] || OPERATOR='No modem'
ACCESS=$(printf '%s\n' "$MODEM_DATA" | display_value modem.generic.access-technologies)
case "$ACCESS" in
	*lte*) NETWORK=4G ;;
	*umts*|*hspa*) NETWORK=3G ;;
	*edge*|*gprs*|*gsm*) NETWORK=2G ;;
	*) NETWORK=-- ;;
esac

NETROOT=${DISPLAY_NET_ROOT:-/sys/class/net}
INTERFACE=$(uci -q get display.display.traffic_interface)
if [ -z "$INTERFACE" ] || [ "$INTERFACE" = auto ]; then
	INTERFACE=$(ubus call network.interface.modem status 2>/dev/null | jsonfilter -e '@.l3_device')
	if [ -z "$INTERFACE" ] && [ -d "$NETROOT/wwan0" ]; then INTERFACE=wwan0; fi
	if [ -z "$INTERFACE" ]; then INTERFACE=$(ubus call network.interface.wan status 2>/dev/null | jsonfilter -e '@.l3_device'); fi
	[ -n "$INTERFACE" ] || INTERFACE=br-lan
fi
case "$INTERFACE" in *[!a-zA-Z0-9_.:-]*|'') INTERFACE=unknown ;; esac
NOW=$(cut -d' ' -f1 /proc/uptime)
RATES=$(display_transfer_rates "$INTERFACE" "$NETROOT" "${DISPLAY_TRAFFIC_STATE:-/var/run/display-traffic.state}" "$NOW" raw)
DOWNLOAD=$(printf '%s\n' "$RATES" | cut -f1)
FLOW_BYTES=$(printf '%s\n' "$RATES" | cut -f3)
FLOW_SCALE=$(uci -q get display.display.traffic_scale_mbps)
case "$FLOW_SCALE" in ''|*[!0-9]*|0) FLOW_SCALE=10 ;; esac
FLOW=$(display_flow_percent "$FLOW_BYTES" "$FLOW_SCALE")
UPLOAD=$(printf '%s\n' "$RATES" | cut -f2)
case "$INTERFACE" in wwan*) INTERFACE_LABEL="CELL $INTERFACE" ;; *) INTERFACE_LABEL="$INTERFACE" ;; esac

set -- -b "$BATTERY" -n "$OPERATOR" -t "$NETWORK"
[ "$CHARGING" = 0 ] || set -- "$@" -c
[ "$BATTERY_ESTIMATED" = 0 ] || set -- "$@" -e
if [ "$PAGE" = wifi ]; then
	SSID=$(uci -q get wireless.@wifi-iface[0].ssid)
	PASSWORD=$(uci -q get wireless.@wifi-iface[0].key)
	HOSTNAME=$(uci -q get system.@system[0].hostname)
	set -- "$@" -q -s "$SSID" -p "$PASSWORD" -h "$HOSTNAME"
else
	set -- "$@" -d -g "$SIGNAL" -i "$IMEI" -N "$PHONE" -v "$FLOW" -r "$DOWNLOAD" -x "$UPLOAD" -f "$INTERFACE_LABEL"
fi
write_frame "$@"
