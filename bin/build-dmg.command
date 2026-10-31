#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
PRODUCT_NAME="Codex笔记链接助手"
DIST_DIR="$REPO_ROOT/dist"
APP_BUNDLE="$DIST_DIR/$PRODUCT_NAME.app"
DMG_OUTPUT="$DIST_DIR/$PRODUCT_NAME-0.1.7-arm64.dmg"
WORK_DIR=""
MOUNT_POINT=""
MOUNTED=0

fail() {
  print -u2 -- "DMG构建已停止：$1"
  exit 1
}

cleanup() {
  if [[ "$MOUNTED" == "1" ]]; then
    /usr/bin/hdiutil detach -quiet "$MOUNT_POINT" || true
  fi
  if [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]]; then
    /bin/rm -rf -- "$WORK_DIR"
  fi
}

[[ -d "$DIST_DIR" && ! -L "$DIST_DIR" ]] || fail "缺少普通dist目录；请先运行build-menu-app.command。"
[[ -d "$APP_BUNDLE" && ! -L "$APP_BUNDLE" ]] || fail "找不到已构建的App bundle。"
if [[ -e "$DMG_OUTPUT" || -L "$DMG_OUTPUT" ]]; then
  fail "目标DMG已存在，拒绝覆盖：$DMG_OUTPUT"
fi
for tool in codesign hdiutil shasum; do
  command -v "$tool" >/dev/null 2>&1 || fail "缺少打包工具：$tool"
done

/usr/bin/codesign --verify --deep --strict "$APP_BUNDLE" || fail "App签名校验失败。"
[[ -f "$APP_BUNDLE/Contents/Info.plist" && -f "$APP_BUNDLE/Contents/Resources/AppIcon.icns" ]] || fail "App bundle结构不完整。"

WORK_DIR="$(/usr/bin/mktemp -d "$DIST_DIR/.dmg-build.XXXXXX")"
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

STAGING="$WORK_DIR/staging"
MOUNT_POINT="$WORK_DIR/mount"
TEMP_DMG="$WORK_DIR/$PRODUCT_NAME.dmg"
mkdir -p "$STAGING" "$MOUNT_POINT"
/usr/bin/ditto "$APP_BUNDLE" "$STAGING/$PRODUCT_NAME.app"
/bin/ln -s /Applications "$STAGING/应用程序"

cat > "$STAGING/安装与恢复说明.txt" <<'NOTES'
Codex笔记链接助手 · 安装与恢复
版本：0.1.7（build 7），Apple Silicon测试包。

安装
1. 将“Codex笔记链接助手.app”拖到右侧“应用程序”快捷方式。
2. 首次启动可能出现macOS针对本应用的安全确认。本App是本机自用ad-hoc签名且未公证；只在你核对来源并信任此构建时，按Finder或“系统设置 → 隐私与安全性”的单应用提示继续。
3. 不要关闭Gatekeeper/SIP，不要清除隔离属性。如果系统没有提供单应用打开选项，请停止并联系维护者。

使用
- 启动后先显示本机状态。操作分两步：先点“启动Codex（CDP模式）”或“重启Codex为CDP模式”，再点“连接Codex CDP”启用链接增强；启动本身不注入。
- 连接后若显示“已连接·暂无聊天页”，表示调试入口已连上但当前没有可注入页面，打开一个对话后会自动启用。
- 如果需要正常退出正在运行的普通Codex，助手会先显示确认；请先保存未完成任务。取消不会退出Codex。
- “暂停增强”会移除本工具注入的按钮；“退出”或Cmd+Q会先请求清理，Codex继续运行。
- “恢复普通Codex”只处理本助手启动且身份仍可验证的Codex，并再次要求确认；身份不明或超时会停止，不会强杀。
- 本版包含worker异常退出后恢复、确认倒计时、进程指纹持久化及日志轮转。若恢复按钮不可用，先查看状态与日志，不手工修改指纹文件。

恢复与卸载
- 助手无法启动时，可从“应用程序”打开标准Codex.app。此工具不会修改Codex.app或Codex用户数据。
- 从助手菜单退出后，可由用户手动将“应用程序”中的助手移到废纸篓。它不设置登录项；日志保留在“~/Library/Application Support/CodexObsidianLinkAssistant/”。
- 不要为了修复状态而删除锁文件、改动Codex签名、关闭系统安全功能或清除隔离属性。

本包只针对Apple Silicon自用，不含Codex运行时，不签名/公证DMG，也不自动安装或设置开机启动。
NOTES

/usr/bin/hdiutil create \
  -format UDZO \
  -fs HFS+ \
  -volname "$PRODUCT_NAME" \
  -srcfolder "$STAGING" \
  "$TEMP_DMG"
/usr/bin/hdiutil verify "$TEMP_DMG"
/usr/bin/hdiutil attach -readonly -nobrowse -mountpoint "$MOUNT_POINT" "$TEMP_DMG" >/dev/null
MOUNTED=1
[[ -d "$MOUNT_POINT/$PRODUCT_NAME.app" ]] || fail "DMG内缺少App bundle。"
[[ -L "$MOUNT_POINT/应用程序" ]] || fail "DMG内缺少应用程序快捷方式。"
[[ -f "$MOUNT_POINT/安装与恢复说明.txt" ]] || fail "DMG内缺少恢复说明。"
/usr/bin/codesign --verify --deep --strict "$MOUNT_POINT/$PRODUCT_NAME.app" || fail "DMG内App签名校验失败。"
/usr/bin/hdiutil detach -quiet "$MOUNT_POINT"
MOUNTED=0
/usr/bin/hdiutil verify "$TEMP_DMG"

if [[ -e "$DMG_OUTPUT" || -L "$DMG_OUTPUT" ]]; then
  fail "目标DMG在构建期间出现，拒绝覆盖：$DMG_OUTPUT"
fi
/bin/mv "$TEMP_DMG" "$DMG_OUTPUT"
print -- "DMG构建完成：$DMG_OUTPUT"
print -- "SHA-256：$(/usr/bin/shasum -a 256 "$DMG_OUTPUT" | /usr/bin/awk '{print $1}')"
print -- "DMG未签名、未公证；App未安装或启动。"
