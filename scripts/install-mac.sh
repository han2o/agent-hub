#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: bash scripts/install-mac.sh <mini-ssh-host> [shared-auth-token]"
  exit 2
fi

MINI_SSH_HOST="$1"
SHARED_TOKEN="${2:-}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${HOME}/.agent-hub"
CONFIG_FILE="${CONFIG_DIR}/config.yaml"
COMPANION_PLIST="${HOME}/Library/LaunchAgents/com.agenthub.companion.plist"
TUNNEL_PLIST="${HOME}/Library/LaunchAgents/com.agenthub.tunnel.plist"
NODE_BIN="$(command -v node)"
SSH_BIN="$(command -v ssh)"
CLI_BIN="${ROOT_DIR}/packages/cli/dist/index.js"

echo "==> Building Agent Hub..."
cd "$ROOT_DIR"
pnpm install
pnpm build

mkdir -p "$CONFIG_DIR" "${HOME}/Library/LaunchAgents" "${CONFIG_DIR}/logs"

if [[ ! -f "$CONFIG_FILE" ]]; then
  if [[ -n "$SHARED_TOKEN" ]]; then
    "$NODE_BIN" "$CLI_BIN" init-config --role companion --output "$CONFIG_FILE" --ssh-host "$MINI_SSH_HOST" --token "$SHARED_TOKEN"
  else
    "$NODE_BIN" "$CLI_BIN" init-config --role companion --output "$CONFIG_FILE" --ssh-host "$MINI_SSH_HOST"
  fi
fi

cat > "$COMPANION_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.agenthub.companion</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${CLI_BIN}</string>
    <string>companion</string>
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
  <string>${CONFIG_DIR}/logs/companion.out.log</string>
  <key>StandardErrorPath</key>
  <string>${CONFIG_DIR}/logs/companion.err.log</string>
</dict>
</plist>
PLIST

cat > "$TUNNEL_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.agenthub.tunnel</string>
  <key>ProgramArguments</key>
  <array>
    <string>${SSH_BIN}</string>
    <string>-N</string>
    <string>-o</string>
    <string>ServerAliveInterval=15</string>
    <string>-o</string>
    <string>ServerAliveCountMax=3</string>
    <string>-o</string>
    <string>ExitOnForwardFailure=yes</string>
    <string>-L</string>
    <string>4780:127.0.0.1:4780</string>
    <string>-R</string>
    <string>4781:127.0.0.1:4781</string>
    <string>${MINI_SSH_HOST}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${CONFIG_DIR}/logs/tunnel.out.log</string>
  <key>StandardErrorPath</key>
  <string>${CONFIG_DIR}/logs/tunnel.err.log</string>
</dict>
</plist>
PLIST

launchctl unload "$COMPANION_PLIST" 2>/dev/null || true
launchctl unload "$TUNNEL_PLIST" 2>/dev/null || true
launchctl load -w "$COMPANION_PLIST"
launchctl load -w "$TUNNEL_PLIST"

echo "==> Mac Companion + Bidirectional SSH Tunnel installed!"
echo "    Web Console: http://127.0.0.1:4780"
echo "    (Optional) Run the following to hook local Warp/iTerm commands:"
echo "      $NODE_BIN $CLI_BIN shell-hooks > ${CONFIG_DIR}/shell-hooks.zsh"
echo "      echo 'source ~/.agent-hub/shell-hooks.zsh' >> ~/.zshrc"
"$NODE_BIN" "$CLI_BIN" doctor --mini "$MINI_SSH_HOST"
