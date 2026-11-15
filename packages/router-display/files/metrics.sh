#!/bin/sh
# Shared, read-only status collection helpers. No modem configuration commands.

display_value() {
	awk -v wanted="$1" 'index($0, ":") { key=substr($0,1,index($0,":")-1); gsub(/^[ \t]+|[ \t]+$/,"",key); if(key==wanted){v=substr($0,index($0,":")+1);gsub(/^[ \t]+|[ \t]+$/,"",v);print v;exit} }'
}

display_uint() {
	case "$1" in ''|*[!0-9]*) return 1 ;; esac
}

display_battery() {
	BATTERY=-1
	BATTERY_ESTIMATED=0
	CHARGING=0
	for path in "$1"/*; do
		[ "$(cat "$path/type" 2>/dev/null)" = Battery ] || continue
		[ "$(cat "$path/status" 2>/dev/null)" = Charging ] && CHARGING=1
		capacity=$(cat "$path/capacity" 2>/dev/null)
		if display_uint "$capacity" && [ "$capacity" -le 100 ]; then
			BATTERY=$capacity
			return
		fi
		voltage=$(cat "$path/voltage_now" 2>/dev/null)
		minimum=$(cat "$path/voltage_min_design" 2>/dev/null)
		maximum=$(cat "$path/voltage_max_design" 2>/dev/null)
		if display_uint "$voltage" && display_uint "$minimum" && display_uint "$maximum" && [ "$maximum" -gt "$minimum" ]; then
			BATTERY=$(awk -v v="$voltage" -v low="$minimum" -v high="$maximum" 'BEGIN {p=100*(v-low)/(high-low);if(p<0)p=0;if(p>100)p=100;printf "%.0f",p}')
			BATTERY_ESTIMATED=1
		fi
		return
	done
}

display_signal() {
	quality=$(printf '%s\n' "$1" | display_value modem.generic.signal-quality.value)
	recent=$(printf '%s\n' "$1" | display_value modem.generic.signal-quality.recent)
	SIGNAL=-1
	case "$recent" in yes|true|1)
		if display_uint "$quality" && [ "$quality" -le 100 ]; then SIGNAL=$quality; fi
		;;
	esac
}

display_transfer_rates() {
	# Interface, sysfs net root, state file, monotonic seconds.
	iface=$1; netroot=$2; state=$3; now=$4
	case "$iface" in ''|*[!a-zA-Z0-9_.:-]*) printf '%s\t%s\n' -- --; return ;; esac
	rx=$(cat "$netroot/$iface/statistics/rx_bytes" 2>/dev/null)
	tx=$(cat "$netroot/$iface/statistics/tx_bytes" 2>/dev/null)
	if ! display_uint "$rx" || ! display_uint "$tx"; then printf '%s\t%s\n' -- --; return; fi
	old_iface=; old_now=; old_rx=; old_tx=
	if [ -f "$state" ]; then read -r old_iface old_now old_rx old_tx < "$state"; fi
	tmp=$(mktemp "${state}.XXXXXX") || { printf '%s\t%s\n' -- --; return; }
	printf '%s %s %s %s\n' "$iface" "$now" "$rx" "$tx" > "$tmp"
	mv "$tmp" "$state"
	awk -v iface="$iface" -v oldiface="$old_iface" -v now="$now" -v oldnow="$old_now" \
		-v rx="$rx" -v tx="$tx" -v oldrx="$old_rx" -v oldtx="$old_tx" '
	function rate(n) {if(n>=1048576)return sprintf("%.1f MiB/s",n/1048576);if(n>=1024)return sprintf("%.1f KiB/s",n/1024);return sprintf("%.0f B/s",n)}
	BEGIN {dt=now-oldnow;if(iface!=oldiface||oldnow==""||dt<=0||dt>30||rx<oldrx||tx<oldtx){print "--\t--";exit}print rate((rx-oldrx)/dt) "\t" rate((tx-oldtx)/dt)}'
}
