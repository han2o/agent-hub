#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${HOME}/.agent-hub"
CONFIG_FILE="${CONFIG_DIR}/config.yaml"
PLIST_PATH="${HOME}/Library/LaunchAgents/com.agenthub.hub.plist"
NODE_BIN="$(command -v node)"
CLI_BIN="${ROOT_DIR}/packages/cli/dist/index.js"

echo "==> Building Agent Hub..."
cd "$ROOT_DIR"
pnpm install
pnpm build

mkdir -p "$CONFIG_DIR" "${HOME}/Library/LaunchAgents" "${CONFIG_DIR}/logs"

if [[ ! -f "$CONFIG_FILE" ]]; then
  TOKEN="${1:-}"
  if [[ -n "$TOKEN" ]]; then
    "$NODE_BIN" "$CLI_BIN" init-config --role hub --output "$CONFIG_FILE" --token "$TOKEN"
  else
    "$NODE_BIN" "$CLI_BIN" init-config --role hub --output "$CONFIG_FILE"
  fi
fi

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.agenthub.hub</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${CLI_BIN}</string>
    <string>hub</string>
    <string>--config</string>
    <string>${CONFIG_FILE}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${HOME}/.local/bin:${HOME}/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${CONFIG_DIR}/logs/hub.out.log</string>
  <key>StandardErrorPath</key>
  <string>${CONFIG_DIR}/logs/hub.err.log</string>
</dict>
</plist>
PLIST

launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load -w "$PLIST_PATH"

echo "==> Mini Hub installed & started via launchd."
echo "    Config: $CONFIG_FILE"
echo "    Logs:   ${CONFIG_DIR}/logs/hub.*.log"
"$NODE_BIN" "$CLI_BIN" doctor
