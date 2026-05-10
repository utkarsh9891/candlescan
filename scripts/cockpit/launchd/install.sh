#!/usr/bin/env bash
# Install the cockpit launchd plist into ~/Library/LaunchAgents/.
#
# What this does:
#   1. Renders the template plist with your username and repo path.
#   2. Writes it to ~/Library/LaunchAgents/com.candlescan.cockpit.plist
#   3. Loads it via `launchctl bootstrap`
#   4. Schedules pmset wake-from-sleep at 09:06 IST on weekdays
#      (Mac must be plugged in for wake schedules to honor — Apple's restriction).
#
# Run from the repo root:  bash scripts/cockpit/launchd/install.sh
#
# To uninstall:
#   launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.candlescan.cockpit.plist
#   rm ~/Library/LaunchAgents/com.candlescan.cockpit.plist
#   sudo pmset repeat cancel

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TEMPLATE="$REPO/scripts/cockpit/launchd/com.candlescan.cockpit.plist"
TARGET="$HOME/Library/LaunchAgents/com.candlescan.cockpit.plist"
NODE_PATH="$(command -v node || true)"

if [[ -z "$NODE_PATH" ]]; then
  echo "error: 'node' not found in PATH. Install Node and rerun." >&2
  exit 1
fi

if [[ ! -f "$TEMPLATE" ]]; then
  echo "error: template not found at $TEMPLATE" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$HOME/.candlescan/cockpit/logs"

# Render the template — substitute USERNAME, REPO, and node path.
sed \
  -e "s|USERNAME|$USER|g" \
  -e "s|REPO|$REPO|g" \
  -e "s|/usr/local/bin/node|$NODE_PATH|g" \
  "$TEMPLATE" > "$TARGET"

echo "wrote $TARGET"

# Load it. `launchctl bootstrap` is the modern (macOS 10.10+) way.
DOMAIN="gui/$(id -u)"
if launchctl print "$DOMAIN/com.candlescan.cockpit" >/dev/null 2>&1; then
  echo "agent already loaded — reloading"
  launchctl bootout "$DOMAIN" "$TARGET" 2>/dev/null || true
fi
launchctl bootstrap "$DOMAIN" "$TARGET"
echo "loaded launchd agent (will fire 09:08 IST Mon–Fri)"

# Schedule wake-from-sleep at 09:06 IST weekdays. pmset wake schedules
# only fire when the Mac is on AC power; for laptops on battery use
# Energy Saver "prevent sleep" during 09:00–16:00 instead.
echo
echo "scheduling pmset wake at 09:06 IST weekdays (requires sudo, plugged-in only)..."
if sudo pmset repeat wakeorpoweron MTWRF 09:06:00 2>/dev/null; then
  echo "pmset wake scheduled"
else
  echo "pmset failed — wake-from-sleep will not fire automatically."
  echo "If the Mac is asleep at 09:08 the launchd job will be missed."
  echo "Workaround: System Settings → Battery → Schedule wake/sleep, or just"
  echo "leave the Mac awake during market hours."
fi

echo
echo "installed. check status:"
echo "  launchctl print $DOMAIN/com.candlescan.cockpit"
echo "  tail -f ~/.candlescan/cockpit/logs/launchd-out.log"
