#!/bin/sh
# /usr/sbin/display-manager

PID_FILE=${DISPLAY_PID_FILE:-/var/run/display.pid}
BACKLIGHT_PATH=${DISPLAY_BACKLIGHT_PATH:-/sys/class/backlight/backlight}

if [ -f "$PID_FILE" ]; then
    old_pid=$(cat "$PID_FILE" 2>/dev/null)
    if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
        echo "Another display-manager is running (PID: $old_pid). Exiting."
        exit 1
    else
        # Stale PID file, remove it
        logger -t display "Removing stale PID file"
        rm -f "$PID_FILE"
    fi
fi

echo $$ > "$PID_FILE"

# Enabling backlight power on startup
echo 0 > "$BACKLIGHT_PATH/bl_power" 2>/dev/null

. "${DISPLAY_FUNCTIONS_LIB:-/lib/functions.sh}"
config_load display

# Defaults
DEFAULT_TIMEOUT_DIM=5
DEFAULT_TIMEOUT_OFF=3
DEFAULT_BRIGHTNESS_DIM_DIVISOR=8
DEFAULT_FIFO="/var/run/display.fifo"
DEFAULT_ENABLE_LOCKSCREEN=1
DEFAULT_UPDATE_INTERVAL=2

# Load from UCI
config_get TIMEOUT_DIM display timeout_dim "$DEFAULT_TIMEOUT_DIM"
config_get TIMEOUT_OFF display timeout_off "$DEFAULT_TIMEOUT_OFF"
config_get BRIGHTNESS_DIM_DIVISOR display brightness_dim_divisor "$DEFAULT_BRIGHTNESS_DIM_DIVISOR"
config_get FIFO display fifo "$DEFAULT_FIFO"
config_get ENABLE_LOCKSCREEN display enable_lockscreen "$DEFAULT_ENABLE_LOCKSCREEN"
config_get UPDATE_INTERVAL display update_interval "$DEFAULT_UPDATE_INTERVAL"
config_get ACTIVE_PAGE display page status
config_get WIFI_TIMEOUT_DIM display wifi_timeout_dim 30
config_get WIFI_TIMEOUT_OFF display wifi_timeout_off 30
case "$UPDATE_INTERVAL" in ''|*[!0-9]*) UPDATE_INTERVAL=2 ;; esac
[ "$UPDATE_INTERVAL" -ge 1 ] && [ "$UPDATE_INTERVAL" -le 30 ] || UPDATE_INTERVAL=2
SCREEN_STATE=full
UPDATER_PID=""

# Derived or fixed values
BRIGHTNESS_OFF=1
MAX_BRIGHTNESS=$(cat "$BACKLIGHT_PATH/max_brightness" 2>/dev/null || echo 1785)
BRIGHTNESS_FULL=$MAX_BRIGHTNESS
BRIGHTNESS_DIM=$((MAX_BRIGHTNESS / BRIGHTNESS_DIM_DIVISOR))
LOCKSCREEN_FILE="/etc/logos/boot_logo.fb"
POWEROFF_FILE="/etc/logos/poweroff_logo.fb"
UPDATE_DISPLAY_BIN=${DISPLAY_UPDATE_BIN:-/usr/bin/update-display}

render_display() {
    [ ! -x "$UPDATE_DISPLAY_BIN" ] || DISPLAY_PAGE="$ACTIVE_PAGE" "$UPDATE_DISPLAY_BIN"
}

# Timer PIDs
TIMER_DIM_PID=""
TIMER_OFF_PID=""

# Create FIFO if it doesn't exist
[ -e "$FIFO" ] || mkfifo "$FIFO"

# Cleanup function: kills timers, closes FD, removes FIFO
cleanup() {
    logger -t display "Cleaning up..."
    [ -n "$TIMER_DIM_PID" ] && kill "$TIMER_DIM_PID" 2>/dev/null
    [ -n "$TIMER_OFF_PID" ] && kill "$TIMER_OFF_PID" 2>/dev/null
    [ -n "$UPDATER_PID" ] && kill "$UPDATER_PID" 2>/dev/null
    exec 3<&-  # Close file descriptor
    rm -f "$FIFO"
    rm -f "$PID_FILE"
    exit 0
}

# Register cleanup on exit/termination/interrupt
trap cleanup EXIT TERM INT

# Display image file to framebuffer
fb_show_file() {
    [ -c /dev/fb0 ] && [ -f "$1" ] && cat "$1" > /dev/fb0 2>/dev/null
}

# Set backlight brightness
set_brightness() {
    echo "$1" > "$BACKLIGHT_PATH/brightness" 2>/dev/null
}

# Cancel running timers
cancel_timers() {
    [ -n "$TIMER_DIM_PID" ] && kill "$TIMER_DIM_PID" 2>/dev/null
    [ -n "$TIMER_OFF_PID" ] && kill "$TIMER_OFF_PID" 2>/dev/null
    TIMER_DIM_PID=""
    TIMER_OFF_PID=""
}

# Send command to FIFO queue
enqueue() {
    [ -p "$FIFO" ] && echo "$1" > "$FIFO" 2>/dev/null
}

# Start dim and off timers
start_timers() {
    cancel_timers
    dim_timeout=$TIMEOUT_DIM
    off_timeout=$TIMEOUT_OFF
    if [ "$ACTIVE_PAGE" = wifi ]; then
        dim_timeout=$WIFI_TIMEOUT_DIM
        off_timeout=$WIFI_TIMEOUT_OFF
    fi

    # Timer for DIM state
    (
        sleep "$dim_timeout"
        logger -t display "Timer: DIM"
        enqueue "dim"
    ) &
    TIMER_DIM_PID=$!

    # Timer for OFF state
    TOTAL_TIMEOUT=$((dim_timeout + off_timeout))
    (
        sleep $TOTAL_TIMEOUT
        logger -t display "Timer: OFF"
        enqueue "off"
    ) & 
    TIMER_OFF_PID=$!
}

logger -t display "Display manager started (dim:${TIMEOUT_DIM}s off:${TIMEOUT_OFF}s)"
start_timers

# Open FIFO once with persistent file descriptor
exec 3<> "$FIFO"

# Refresh only while awake; sampling never resets the dim/off timers.
(
    while sleep "$UPDATE_INTERVAL"; do enqueue "tick"; done
) &
UPDATER_PID=$!
render_display

# Main FIFO command loop
while read -r cmd <&3; do
    [ -z "$cmd" ] && continue  # Skip empty lines
    
    case "$cmd" in
        full|wifi)
            if [ "$cmd" = wifi ]; then ACTIVE_PAGE=wifi; else ACTIVE_PAGE=status; fi
            SCREEN_STATE=full
            logger -t display "Backlight: FULL"
            set_brightness $BRIGHTNESS_FULL
            start_timers
            enqueue "update"
            ;;
        dim)
            SCREEN_STATE=dim
            logger -t display "Backlight: DIM"
            set_brightness $BRIGHTNESS_DIM
            [ "$ENABLE_LOCKSCREEN" = "1" ] && enqueue "lockscreen"
            ;;
        off)
            SCREEN_STATE=off
            logger -t display "Backlight: OFF"
            cancel_timers
            set_brightness $BRIGHTNESS_OFF
            ;;
        lockscreen)
            logger -t display "Show lockscreen"
            render_display
            ;;
        tick)
            if [ "$SCREEN_STATE" != off ]; then
                render_display
            fi
            ;;
        update)
            logger -t display "Update display"
            render_display
            ;;
        shutdown)
            logger -t display "Shutdown sequence"
            cancel_timers
            fb_show_file "$POWEROFF_FILE"
            echo 0 > "$BACKLIGHT_PATH/brightness" 2>/dev/null
            # echo 4 > /sys/class/graphics/fb0/blank 2>/dev/null
            break  # Exit while loop
            ;;
        *)
            logger -t display "Unknown command: '$cmd'"
            ;;
    esac
done

# Cleanup runs automatically via trap EXIT
