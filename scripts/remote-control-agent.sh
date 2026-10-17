#!/bin/zsh
# Сервер Remote Control как LaunchAgent: из приложения Claude на телефоне (вкладка Code) можно создавать сессии
# на этом Mac в папке проекта, каждую в своём git worktree, в режиме auto. Переживает перезагрузку и падения.
# Папка должна быть git-репозиторием, и доверие к ней должно быть принято один раз (запустить `claude` в ней вручную).
# Подробности: docs/mac-agent-hub.md, 3.5.
#
# Usage: scripts/remote-control-agent.sh install [folder] [name] | uninstall | status
set -euo pipefail

LABEL="dev.prototype.wave.remote-control"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/WaveRemoteControl.log"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

case "${1:-status}" in
  install)
    FOLDER="$(cd "${2:-$ROOT}" && pwd)"
    NAME="${3:-$(basename "$FOLDER")}"
    git -C "$FOLDER" rev-parse --verify HEAD >/dev/null 2>&1 || { echo "not a git repository with a commit: $FOLDER" >&2; exit 1; }
    CLAUDE="$(command -v claude)" || { echo "claude not found in PATH" >&2; exit 1; }
    # Без терминала на stdin сервер выходит сразу: держим stdin открытым и даём ему псевдотерминал через script.
    # exec: когда сервер выходит, выходит и задание, и launchd его перезапускает. Путь к claude абсолютный: PATH у launchd другой.
    COMMAND="cd ${(qq)FOLDER} && exec script -q /dev/null ${(qq)CLAUDE} remote-control --name ${(qq)NAME} --spawn worktree --permission-mode auto --no-create-session-in-dir < <(tail -f /dev/null)"
    XML_COMMAND="${${${COMMAND//&/&amp;}//</&lt;}//>/&gt;}"
    mkdir -p "$(dirname "$PLIST")"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>-lc</string><string>$XML_COMMAND</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "installed: $NAME in $FOLDER (log $LOG)"
    ;;
  uninstall)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "removed"
    ;;
  status)
    launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "state =|pid =|last exit" || echo "not installed"
    [[ -f "$LOG" ]] && sed $'s/\x1b\\[[0-9;?]*[a-zA-Z]//g' "$LOG" | tr -s ' \r' | grep -E "Ready|Connected|Capacity|Error" | tail -3 || true
    ;;
  *) echo "usage: $0 install [folder] [name] | uninstall | status" >&2; exit 1 ;;
esac
