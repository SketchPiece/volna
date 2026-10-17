#!/bin/zsh
# «Узел» как LaunchAgent (docs/relay.md): стартует при входе в систему, перезапускается при падении, держит связь ядра со «Штурвалом».
# Нужен relay/.env (см. .env.example). Путь к node абсолютный: PATH у launchd другой.
#
# Usage: relay/launchd.sh install | uninstall | status
set -euo pipefail

LABEL="dev.prototype.wave.relay"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/WaveRelay.log"
DIR="$(cd "$(dirname "$0")" && pwd)"

case "${1:-status}" in
  install)
    [[ -f "$DIR/.env" ]] || { echo "no $DIR/.env: copy .env.example and fill it" >&2; exit 1; }
    NODE="$(command -v node)" || { echo "node not found in PATH" >&2; exit 1; }
    mkdir -p "$(dirname "$PLIST")"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>--env-file=.env</string><string>src/main.ts</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    # bootout возвращается раньше, чем launchd отпустит сервис: сразу после него bootstrap падает
    # «5: Input/output error», и «Узел» остаётся выгруженным. Ждём выгрузки и повторяем.
    for _ in {1..20}; do launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break; sleep 0.5; done
    for attempt in 1 2 3 4 5; do
      launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null && break
      [[ $attempt == 5 ]] && { echo "bootstrap failed; run ./launchd.sh install again" >&2; exit 1; }
      sleep 2
    done
    echo "installed (log $LOG)"
    ;;
  uninstall)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "removed"
    ;;
  status)
    launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "state =|pid =|last exit" || echo "not installed"
    [[ -f "$LOG" ]] && tail -3 "$LOG" || true
    ;;
  *) echo "usage: $0 install | uninstall | status" >&2; exit 1 ;;
esac
