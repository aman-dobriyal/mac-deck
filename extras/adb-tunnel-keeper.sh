#!/bin/bash
# Mac Deck — ADB tunnel keeper
# Silently keeps `adb reverse tcp:3333 tcp:3333` alive so the PWA at
# localhost:3333 works on the phone without any manual ADB commands.
#
# Runs as a launchd agent (com.macdeck.adbtunnel) — started at login,
# restarted automatically if it ever crashes.

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

PHONE_IP="192.168.29.223"
PHONE_PORT="5555"          # set by `adb tcpip 5555` over USB once
MAC_DECK_PORT="3333"
POLL=20                     # seconds between checks

was_connected=false

while true; do
  # Try to connect (no-op if already connected, reconnects if dropped)
  result=$(adb connect "${PHONE_IP}:${PHONE_PORT}" 2>&1)

  if echo "$result" | grep -qE "^connected|already connected"; then
    # Make sure the reverse tunnel is up
    adb -s "${PHONE_IP}:${PHONE_PORT}" reverse \
        tcp:${MAC_DECK_PORT} tcp:${MAC_DECK_PORT} >/dev/null 2>&1

    if [ "$was_connected" = false ]; then
      echo "$(date '+%H:%M:%S')  Phone online — tunnel set ✓"
      was_connected=true
    fi
  else
    if [ "$was_connected" = true ]; then
      echo "$(date '+%H:%M:%S')  Phone offline — waiting…"
      was_connected=false
    fi
  fi

  sleep "$POLL"
done
