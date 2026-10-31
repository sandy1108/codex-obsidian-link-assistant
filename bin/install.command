#!/bin/zsh
set -eu
umask 077

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
HOME_DIR="${HOME:?HOME未设置}"
DESKTOP="$HOME_DIR/Desktop"
STATE_ROOT="$HOME_DIR/Library/Application Support/CodexObsidianLinkAssistant"
LAUNCHER="$DESKTOP/Codex笔记链接助手.command"
MANIFEST="$STATE_ROOT/install-manifest.json"
OWNER='codex-obsidian-link-assistant-owned-v1'

# 当前清单用小型shell模板生成；拒绝会改变shell/JSON语义的罕见路径字符。
case "$PROJECT_ROOT" in
  *'"'*|*'\'*|*'$'*|*'`'*|*$'\n'*)
    print -u2 '源码路径含不支持的引号、转义或控制字符，未安装。'
    exit 1
    ;;
esac

if [[ ! -d "$DESKTOP" ]]; then
  print -u2 "桌面目录不存在：$DESKTOP"
  exit 1
fi

if [[ -L "$LAUNCHER" || ( -e "$LAUNCHER" && ! -f "$LAUNCHER" ) ]]; then
  print -u2 '桌面入口同名目标不是普通文件，停止安装。'
  exit 1
fi
if [[ -e "$LAUNCHER" ]] && ! /usr/bin/grep -Fq "$OWNER" "$LAUNCHER"; then
  print -u2 '桌面已有同名且非本工具创建的文件，未覆盖。'
  exit 1
fi
if [[ -L "$MANIFEST" || ( -e "$MANIFEST" && ! -f "$MANIFEST" ) ]]; then
  print -u2 '安装清单不是普通文件，未覆盖。'
  exit 1
fi
if [[ -e "$MANIFEST" ]] && ! /usr/bin/grep -Fq '"owner": "codex-obsidian-link-assistant-owned-v1"' "$MANIFEST"; then
  print -u2 '安装清单已存在但不属于本工具，未覆盖。'
  exit 1
fi

/bin/mkdir -p "$STATE_ROOT"
TEMP_LAUNCHER="$DESKTOP/.Codex笔记链接助手.command.$$"
TEMP_MANIFEST="$STATE_ROOT/.install-manifest.json.$$"
trap 'rm -f "$TEMP_LAUNCHER" "$TEMP_MANIFEST"' EXIT HUP INT TERM

cat > "$TEMP_LAUNCHER" <<EOF
#!/bin/zsh
# $OWNER
set -eu
exec "$PROJECT_ROOT/bin/start.command"
EOF
/bin/chmod 700 "$TEMP_LAUNCHER"
/bin/mv -f "$TEMP_LAUNCHER" "$LAUNCHER"

cat > "$TEMP_MANIFEST" <<EOF
{
  "owner": "$OWNER",
  "source": "$PROJECT_ROOT",
  "desktopLauncher": "$LAUNCHER",
  "log": "$STATE_ROOT/assistant.log",
  "updatedAt": "$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
/bin/chmod 600 "$TEMP_MANIFEST"
/bin/mv -f "$TEMP_MANIFEST" "$MANIFEST"
trap - EXIT HUP INT TERM

/usr/bin/osascript -e 'display notification "桌面入口已安装。首次启用可能会提示你先正常退出已打开的Codex。" with title "Codex笔记链接助手"'
print "安装完成：$LAUNCHER"
print "源码位置：$PROJECT_ROOT"
print "安装清单：$MANIFEST"
