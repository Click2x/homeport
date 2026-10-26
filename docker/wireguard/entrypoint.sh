#!/bin/sh
# Waits for Homeport to write /config/wg0.conf, brings the tunnel up, then keeps the firewall rules
# (/config/rules.sh, also written by Homeport) applied. The rules script resolves the apps' addresses
# each time, so it is run on a timer to follow apps that restart; it does nothing if nothing changed.
set -eu

CONF=/config/wg0.conf
RULES=/config/rules.sh

n=0
until [ -s "$CONF" ]; do
  n=$((n + 1))
  [ "$n" -gt 1800 ] && { echo "homeport-wireguard: no configuration after 30 minutes, giving up" >&2; exit 1; }
  sleep 1
done

wg-quick up "$CONF"
# A restart recreates the firewall but keeps this file system, so forget what was applied before.
rm -f /tmp/hp-rules-state
trap 'wg-quick down "$CONF" 2>/dev/null; exit 0' TERM INT

while :; do
  [ -f "$RULES" ] && sh "$RULES" || true
  sleep 20 &
  wait $!
done
