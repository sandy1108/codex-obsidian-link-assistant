#!/bin/zsh
set -eu

HOME_DIR="${HOME:?HOME未设置}"
LAUNCHER="$HOME_DIR/Desktop/Codex笔记链接助手.command"
MANIFEST="$HOME_DIR/Library/Application Support/CodexObsidianLinkAssistant/install-manifest.json"
OWNER='codex-obsidian-link-assistant-owned-v1'

if [[ -L "$LAUNCHER" || ( -e "$LAUNCHER" && ! -f "$LAUNCHER" ) ]] || \
  { [[ -e "$LAUNCHER" ]] && ! /usr/bin/grep -Fq "$OWNER" "$LAUNCHER"; }; then
  print -u2 '桌面同名文件没有本工具所有权标记，未移除。'
  exit 1
fi
if [[ -L "$MANIFEST" || ( -e "$MANIFEST" && ! -f "$MANIFEST" ) ]] || \
  { [[ -e "$MANIFEST" ]] && ! /usr/bin/grep -Fq '"owner": "codex-obsidian-link-assistant-owned-v1"' "$MANIFEST"; }; then
  print -u2 '安装清单没有本工具所有权标记，未移除。'
  exit 1
fi

[[ ! -e "$LAUNCHER" ]] || /bin/rm "$LAUNCHER"
[[ ! -e "$MANIFEST" ]] || /bin/rm "$MANIFEST"

print '桌面入口和本工具安装清单已移除。日志、源码及Codex用户数据均保留。'
