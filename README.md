# Codex笔记链接助手

本工具通过 Codex 桌面客户端提供的 Chrome DevTools Protocol（CDP），为回复中的本地文件链接加入“在 Obsidian 打开”和紧凑复制按钮。Codex桌面端使用绝对POSIX路径链接；Obsidian URI只显示在按钮悬停提示中。它不修改Codex应用包，也不是官方Codex插件。

## 功能与边界

- 识别Codex原生绝对POSIX路径链接，并兼容历史 `file:` 链接；只处理当前配置Vault内真实存在的普通文件。worker以`realpath`和目录边界校验归属，拒绝缺失目标、目录、Vault外路径及`.obsidian`、`.git`、`.trash`管理目录。
- Vault内的Markdown、Canvas、Base、图片、PDF和其他普通文件都可获得按钮；按钮只把经校验的Obsidian URI交给Obsidian，不保证每种格式都能预览。
- 侧栏额度圆环：左侧窄栏显示5小时与周额度**剩余**百分比，悬停提示额度种类及本地时区的完整重置年月日和时间；无有效数据时显示`—`。使用当前Codex CLI的只读app-server协议，每次只读取两个窗口并丢弃原始账号响应，不保存凭据或额度历史。
- 只在核验签名、进程身份、回环端口和 `app://` 页面后注入隔离世界脚本。
- 打开按钮只通过固定 `/usr/bin/open` 参数打开经校验的 Obsidian URI；复制按钮只通过 `/usr/bin/pbcopy` 写剪贴板，不拼接或执行 shell 命令。
- App启动后只读取本机状态。操作分为两步：先点“启动 Codex（CDP模式）”或“重启 Codex 为 CDP 模式”把 Codex 带到可验证的调试入口，再点“连接 Codex CDP”注入笔记按钮；启动动作本身不注入。连接后若暂无聊天页，会显示“已连接 · 暂无聊天页”，打开对话后自动启用。需要正常退出普通 Codex 时会请求确认；取消、身份变化或超时都不会强制结束进程。
- 暂停或退出只清理本工具的页面增强，不主动退出 Codex。恢复普通 Codex只针对由本助手启动且指纹仍匹配的单一实例，并再次确认；该操作会中断该实例上的其他CDP客户端。
- App不设置登录项或开机自启，不捆绑Codex/Node运行时，不读聊天数据库或从标题猜笔记路径。

## Vault配置

- 菜单浮窗只支持一个Vault。首次使用时通过“选择文件夹…”选择已初始化且含`.obsidian`目录的Vault，再点击“保存并应用”；未配置时不预填维护者的本机路径。
- worker将版本号和规范化后的Vault路径原子保存至`~/Library/Application Support/CodexObsidianLinkAssistant/settings.json`。配置缺失或无效时不会猜测或自动创建Vault，需从浮窗重新选择。
- 额度圆环默认每5分钟更新；菜单栏浮窗“额度圆环”卡片可将刷新间隔配置为1–60分钟，保存于同目录独立的`quota-settings.json`。
- 当前源码包含绝对路径识别、单Vault配置、残留锁自动恢复、启动/连接分步操作和全链路错误日志，并包含worker崩溃后浮窗恢复、Codex退出后的状态降级、零页面警告、兼容性缓存、恢复前二次校验、外部CDP识别和Cmd+Q清理确认；构建脚本不会替换已安装助手。
- 当前版本还包含有上限的日志轮转与worker stderr记录、浮窗版本号和确认倒计时、渲染扫描节流、`#heading`编码回归检查、旧CLI兼容性闸门，以及助手启动的Codex进程指纹持久化。指纹只在可信CDP端点与当前进程完全匹配时用于恢复“本助手启动”身份；退出助手不清除，恢复普通Codex或意外退出时清除。

## 构建本机App与DMG

当前构建目标为Apple Silicon，需本机Xcode/Swift、Codex桌面包及其签名Node。Codex新版安装名为`/Applications/ChatGPT.app`（Bundle ID仍是`com.openai.codex`），旧版为`/Applications/Codex.app`，两者及`~/Applications`下的同名包都会被探测。构建脚本先核对Codex Bundle ID、Team ID、版本、build、`app.asar` SHA-256和Node主版本；任一值不匹配即停止。

在Finder中依次打开：

1. `bin/build-menu-app.command`：构建 `dist/Codex笔记链接助手.app`。
2. `bin/build-dmg.command`：生成 `dist/Codex笔记链接助手-0.1.9-arm64.dmg`。

脚本拒绝覆盖已有产物。DMG只包含App、“应用程序”快捷方式和安装/恢复说明；构建不会安装App、替换现有桌面入口或设置登录项。

`build-menu-app.command`在编译前会用兼容清单校验本机Codex身份，不符即停止。只有在你明确知道本机Codex未列入清单、仍要打测试包时，才显式设 `ALLOW_UNLISTED_CODEX=1` 放行这道构建自检；它不改动包内清单，也不放宽运行时校验，安装后仍需用户在浮窗点「强行兼容一次」。

App采用ad-hoc代码签名并启用Hardened Runtime；DMG不签名、不公证。首次打开可能出现macOS对单个App的确认。只在核对来源并信任本机生成的构建时，按Finder或“系统设置 → 隐私与安全性”显示的单应用流程操作。不要关闭Gatekeeper/SIP或清除隔离属性；系统未提供单应用选项时停止。构建与签名核验命令见 `bin/build-menu-app.command`，恢复说明见 [RECOVER.md](RECOVER.md)。

## 开发检查

```sh
"/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" --test
swift test --package-path macOSApp
swift build -c release --package-path macOSApp
```

Node测试必须在仓库根执行（把目录当参数传给`--test`会被解析成模块名）。本机仍安装旧包名时，可改用`/Applications/Codex.app/Contents/Resources/cua_node/bin/node`。

当前兼容性清单位于 `macOSApp/Resources/compatibility.json`。Codex升级后如版本、build或ASAR哈希变化，App会拒绝启动/连接并提示未列入兼容清单；维护者需重新检查页面结构与安全边界后，才可修改清单，构建脚本同样会按清单校验本机Codex身份。

清单未命中时，浮窗提供“强行兼容一次（仅本次会话）”：用户明确允许后，worker只跳过版本、build和`app.asar`哈希这三项与清单的比对，签名校验（Bundle ID、Team ID、codesign requirement）、内置Node主版本下限、CDP端点可信检查和进程身份校验全部照旧。授权身份键由worker按本机实测事实算出，界面无法注入；只存活于当前worker进程内存，不写入任何文件，Codex再次更新后身份键变化即自动失效，退出助手也恢复默认校验。旧CLI入口（`bin/start.command`）没有这个开关，仍然硬拦。

## 日志、恢复与卸载

- 日志：`~/Library/Application Support/CodexObsidianLinkAssistant/assistant.log`及`worker-stderr.log`；各保留当前文件和一个`.1`轮转备份。操作日志不记录聊天正文、笔记路径或Obsidian URI；stderr用于诊断worker异常，查看或分享前请自行检查内容。
- 退出前清理未获确认时，面板保持打开并显示状态待核验；不要强杀worker或删除锁文件来掩盖状态。
- App无法启动时，可从 `/Applications/ChatGPT.app`（旧版为 `/Applications/Codex.app`）手动打开普通Codex；本工具没有修改官方应用或用户数据。
- 卸载时先从助手菜单退出，再由用户手动移除`/Applications/Codex笔记链接助手.app`。日志和源码保留，不自动删除用户级数据。
- 旧源码CLI入口仍保留供维护；构建菜单栏App不会安装或替换它。

使用与恢复说明分别见本文件和[RECOVER.md](RECOVER.md)。

## 许可证

源码与本仓库文档按 [MIT License](LICENSE) 发布。Codex、Obsidian及其名称和标识归各自权利人所有；本项目与其官方无隶属关系。
