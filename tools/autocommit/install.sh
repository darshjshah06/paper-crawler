#!/bin/bash
# Installs (or reinstalls) the auto-commit as a launchd agent. launchd wakes it
# daily at 18:30 (or on the next wake if the Mac is asleep), and autocommit.sh
# only commits when 3 days have passed since its last run.
#   ./tools/autocommit/install.sh            install
#   ./tools/autocommit/install.sh uninstall  remove
set -eu
LABEL="com.darshshah.paper-crawler-autocommit"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SCRIPT="$(cd "$(dirname "$0")" && pwd)/autocommit.sh"
LOG="$HOME/Library/Logs/paper-crawler-autocommit.log"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
if [ "${1:-}" = "uninstall" ]; then
  rm -f "$PLIST"
  echo "removed $LABEL"
  exit 0
fi

chmod +x "$SCRIPT"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$SCRIPT</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>18</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
PL
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL (every 3 days at 18:30, log: $LOG)"
