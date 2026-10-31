#!/bin/zsh
set -eu

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
HOME_DIR="${HOME:?HOME未设置}"

for APP in \
  "/Applications/Codex.app" \
  "$HOME_DIR/Applications/Codex.app" \
  "/Applications/ChatGPT.app" \
  "$HOME_DIR/Applications/ChatGPT.app"; do
  NODE="$APP/Contents/Resources/cua_node/bin/node"
  if [[ -x "$NODE" ]]; then
    exec "$NODE" "$PROJECT_ROOT/src/main.mjs"
  fi
done

/usr/bin/osascript -e 'display alert "找不到Codex签名版内置Node。请确认Codex已安装，再重新运行桌面入口。" as warning'
exit 1
