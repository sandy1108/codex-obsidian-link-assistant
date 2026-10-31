#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
USER_HOME="$(/usr/bin/printenv HOME)"
PRODUCT_NAME="Codex笔记链接助手"
BUNDLE_IDENTIFIER="local.codex-obsidian-link-assistant"
PRODUCT_VERSION="0.1.7"
PRODUCT_BUILD="7"
DIST_DIR="$REPO_ROOT/dist"
APP_OUTPUT="$DIST_DIR/$PRODUCT_NAME.app"
RESOURCE_DIR="$REPO_ROOT/macOSApp/Resources"
COMPATIBILITY_FILE="$RESOURCE_DIR/compatibility.json"
APPICON_SOURCE="$RESOURCE_DIR/AppIcon-source.png"
MENU_TEMPLATE="$RESOURCE_DIR/menu-bar-template.png"
ICONSET_DIR="$RESOURCE_DIR/AppIcon.iconset"

fail() {
  print -u2 -- "构建已停止：$1"
  exit 1
}

[[ "$(/usr/bin/uname -m)" == "arm64" ]] || fail "本脚本只构建Apple Silicon版本。"
[[ -d "$RESOURCE_DIR" ]] || fail "缺少macOS资源目录。"
[[ -f "$COMPATIBILITY_FILE" && -f "$APPICON_SOURCE" && -f "$MENU_TEMPLATE" && -d "$ICONSET_DIR" ]] || fail "缺少图标或兼容性资源。"
[[ -d "$DIST_DIR" || ! -e "$DIST_DIR" ]] || fail "dist路径已存在但不是目录。"
[[ ! -L "$DIST_DIR" ]] || fail "dist不能是符号链接。"
if [[ -e "$APP_OUTPUT" || -L "$APP_OUTPUT" ]]; then
  fail "目标App已存在，拒绝覆盖：$APP_OUTPUT"
fi

for tool in swift sips iconutil codesign plutil lipo shasum; do
  command -v "$tool" >/dev/null 2>&1 || fail "缺少构建工具：$tool"
done

ICON_SOURCE_HASH="$(/usr/bin/shasum -a 256 "$APPICON_SOURCE" | /usr/bin/awk '{print $1}')"
MENU_TEMPLATE_HASH="$(/usr/bin/shasum -a 256 "$MENU_TEMPLATE" | /usr/bin/awk '{print $1}')"
[[ "$ICON_SOURCE_HASH" == "a4bb5a111870d46255e2ad78fc97783bcc6dc79086ca8bf0a4fa0da8a35b9d3d" ]] || fail "AppIcon源图哈希不匹配。"
[[ "$MENU_TEMPLATE_HASH" == "f15a443520b43b867a24ecef452deed9f536e672ac7552f7bf8b3e67e328ceaf" ]] || fail "菜单栏模板图哈希不匹配。"
[[ "$(/usr/bin/sips -g hasAlpha "$MENU_TEMPLATE" | /usr/bin/awk '/hasAlpha:/ {print $2}')" == "yes" ]] || fail "菜单栏模板图缺少alpha通道。"

typeset -a ICON_FILES
ICON_FILES=(
  icon_16x16.png icon_16x16@2x.png
  icon_32x32.png icon_32x32@2x.png
  icon_128x128.png icon_128x128@2x.png
  icon_256x256.png icon_256x256@2x.png
  icon_512x512.png icon_512x512@2x.png
)
[[ "$(find "$ICONSET_DIR" -maxdepth 1 -type f -name '*.png' | wc -l | tr -d ' ')" == "10" ]] || fail "AppIcon图集必须恰好有10个PNG尺寸。"
for icon_file in "${ICON_FILES[@]}"; do
  [[ -f "$ICONSET_DIR/$icon_file" ]] || fail "AppIcon图集缺少文件：$icon_file"
done

CODEX_APP=""
for candidate in "/Applications/Codex.app" "$USER_HOME/Applications/Codex.app"; do
  if [[ -x "$candidate/Contents/Resources/cua_node/bin/node" ]]; then
    CODEX_APP="$candidate"
    break
  fi
done
[[ -n "$CODEX_APP" ]] || fail "找不到含签名内置Node的Codex.app。"
CODEX_NODE="$CODEX_APP/Contents/Resources/cua_node/bin/node"
CODEX_ASAR="$CODEX_APP/Contents/Resources/app.asar"
[[ -f "$CODEX_ASAR" ]] || fail "Codex.app缺少app.asar。"
/usr/bin/codesign --verify --deep --strict "$CODEX_APP" || fail "Codex.app签名校验失败。"

SIGNATURE_DETAILS="$(/usr/bin/codesign --display --verbose=4 "$CODEX_APP" 2>&1)"
INSTALLED_TEAM_ID="$(print -r -- "$SIGNATURE_DETAILS" | /usr/bin/awk -F= '$1 == "TeamIdentifier" {print $2; exit}')"
INSTALLED_BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$CODEX_APP/Contents/Info.plist")"
INSTALLED_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$CODEX_APP/Contents/Info.plist")"
INSTALLED_BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$CODEX_APP/Contents/Info.plist")"
INSTALLED_ASAR_HASH="$(/usr/bin/shasum -a 256 "$CODEX_ASAR" | /usr/bin/awk '{print $1}')"
INSTALLED_NODE_VERSION="$("$CODEX_NODE" --version)"
INSTALLED_NODE_MAJOR="${INSTALLED_NODE_VERSION#v}"
INSTALLED_NODE_MAJOR="${INSTALLED_NODE_MAJOR%%.*}"
COMPATIBILITY_FILE="$COMPATIBILITY_FILE" \
  INSTALLED_BUNDLE_ID="$INSTALLED_BUNDLE_ID" \
  INSTALLED_TEAM_ID="$INSTALLED_TEAM_ID" \
  INSTALLED_VERSION="$INSTALLED_VERSION" \
  INSTALLED_BUILD="$INSTALLED_BUILD" \
  INSTALLED_ASAR_HASH="$INSTALLED_ASAR_HASH" \
  INSTALLED_NODE_MAJOR="$INSTALLED_NODE_MAJOR" \
  "$CODEX_NODE" --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';

const fail = () => {
  process.stderr.write('构建已停止：当前Codex身份、版本、build、ASAR或Node不符合兼容清单。\n');
  process.exit(1);
};

let approved;
try {
  approved = JSON.parse(readFileSync(process.env.COMPATIBILITY_FILE, 'utf8'));
} catch {
  fail();
}

const exactValues = {
  bundleId: process.env.INSTALLED_BUNDLE_ID,
  teamId: process.env.INSTALLED_TEAM_ID,
  version: process.env.INSTALLED_VERSION,
  build: process.env.INSTALLED_BUILD,
  appAsarSha256: process.env.INSTALLED_ASAR_HASH,
};
for (const [key, actual] of Object.entries(exactValues)) {
  if (approved?.[key] !== actual) fail();
}
const nodeMajor = Number(process.env.INSTALLED_NODE_MAJOR);
if (!Number.isInteger(approved?.minimumNodeMajor)
  || !Number.isInteger(nodeMajor)
  || nodeMajor < approved.minimumNodeMajor) fail();
NODE

mkdir -p "$DIST_DIR"
BUILD_WORKDIR="$(/usr/bin/mktemp -d "$DIST_DIR/.app-build.XXXXXX")"
cleanup() {
  /bin/rm -rf -- "$BUILD_WORKDIR"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

/usr/bin/swift build -c release --package-path "$REPO_ROOT/macOSApp"
BIN_DIR="$(/usr/bin/swift build --show-bin-path -c release --package-path "$REPO_ROOT/macOSApp")"
BUILT_EXECUTABLE="$BIN_DIR/$PRODUCT_NAME"
[[ -x "$BUILT_EXECUTABLE" ]] || fail "Swift Release产物不存在。"
BUILT_ARCHS="$(/usr/bin/lipo -archs "$BUILT_EXECUTABLE")"
[[ "$BUILT_ARCHS" == "arm64" ]] || fail "Swift产物架构异常：$BUILT_ARCHS"

APP_BUNDLE="$BUILD_WORKDIR/$PRODUCT_NAME.app"
CONTENTS="$APP_BUNDLE/Contents"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources/worker"
cp "$BUILT_EXECUTABLE" "$CONTENTS/MacOS/$PRODUCT_NAME"
chmod 755 "$CONTENTS/MacOS/$PRODUCT_NAME"
ditto "$REPO_ROOT/src" "$CONTENTS/Resources/worker/src"
cp "$COMPATIBILITY_FILE" "$CONTENTS/Resources/worker/compatibility.json"
cp "$MENU_TEMPLATE" "$CONTENTS/Resources/menu-bar-template.png"
/usr/bin/iconutil --convert icns --output "$CONTENTS/Resources/AppIcon.icns" "$ICONSET_DIR"

cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>CFBundleDisplayName</key><string>$PRODUCT_NAME</string>
  <key>CFBundleExecutable</key><string>$PRODUCT_NAME</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_IDENTIFIER</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$PRODUCT_NAME</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$PRODUCT_VERSION</string>
  <key>CFBundleVersion</key><string>$PRODUCT_BUILD</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><false/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
PLIST

/usr/bin/plutil -lint "$CONTENTS/Info.plist"
[[ "$(/usr/libexec/PlistBuddy -c 'Print :LSUIElement' "$CONTENTS/Info.plist")" == "false" ]] || fail "App身份未配置为普通Dock应用。"
[[ -x "$CONTENTS/Resources/worker/src/ui-worker.mjs" || -f "$CONTENTS/Resources/worker/src/ui-worker.mjs" ]] || fail "App包内缺少受管worker。"
[[ -f "$CONTENTS/Resources/worker/compatibility.json" ]] || fail "App包内缺少兼容清单。"

/usr/bin/codesign --force --deep --sign - --options runtime --timestamp=none "$APP_BUNDLE"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE"
APP_SIGNATURE="$(/usr/bin/codesign --display --verbose=4 "$APP_BUNDLE" 2>&1)"
print -r -- "$APP_SIGNATURE" | /usr/bin/grep -q 'Signature=adhoc' || fail "App不是ad-hoc签名。"
print -r -- "$APP_SIGNATURE" | /usr/bin/grep -Eiq 'flags=.*runtime' || fail "App未启用Hardened Runtime。"

if [[ -e "$APP_OUTPUT" || -L "$APP_OUTPUT" ]]; then
  fail "目标App在构建期间出现，拒绝覆盖：$APP_OUTPUT"
fi
/bin/mv "$APP_BUNDLE" "$APP_OUTPUT"
/usr/bin/codesign --verify --deep --strict "$APP_OUTPUT"
print -- "App构建完成：$APP_OUTPUT"
print -- "架构：$BUILT_ARCHS；签名：ad-hoc + Hardened Runtime；未启动或安装。"
