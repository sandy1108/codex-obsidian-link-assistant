# 恢复与故障处理

## App无法启动

1. 从`~/Library/Application Support/CodexObsidianLinkAssistant/assistant.log`查看错误时间和固定错误码；日志不应出现聊天正文、笔记路径或URI。
2. 若macOS因本机自用App未公证而阻止首次打开，只按系统提供的单应用提示操作；不关闭Gatekeeper/SIP、不清除隔离属性。系统没有提供单应用选项时停止。
3. 如果助手不可用，从`/Applications/Codex.app`手动打开普通Codex。构建和运行助手不会修改Codex应用包、Codex用户数据或登录项。
4. 如果用户点击“连接并启用”后Codex仍是普通模式，取消确认会保持现状；身份不清、多实例、签名或兼容性不符时不注入。

## 退出或清理未确认

- App只有在本次shutdown请求收到匹配的成功回执、观察到worker stdout EOF且退出码为0时，才报告清理完成并退出。
- 回执失败/缺失、worker意外消失、stdout关闭异常或等待超时都会让面板保持打开并显示状态待核验；App不会强杀worker或Codex。
- 超时后先重新读取面板状态。不要删除`assistant.lock`、手工结束Codex/worker或立即启动第二个助手；锁冲突时助手会拒绝接管。
- 若App已正常退出但Codex仍运行，这是设计行为；退出助手不会退出Codex，CDP调试端口可能继续存在。

## 恢复普通Codex

- 使用助手面板里的“恢复普通Codex”并完成二次确认。仅限由助手启动且进程指纹仍匹配的唯一Codex实例。
- 该操作会正常退出该Codex实例并以普通方式重开，因此其他CDP客户端也会断开。身份变化、多实例或超时则停止，不强制结束进程。
- 若助手不能工作，由用户先从Codex自己的菜单正常退出，再从`/Applications/Codex.app`打开普通实例。不要清除隔离属性、改写代码签名或关闭系统安全功能。

## 卸载

1. 从助手面板选择“退出”，等待清理确认。
2. 用户手动把`/Applications/Codex笔记链接助手.app`移到废纸篓。
3. 应用支持目录中的日志不会随App自动删除；核对后由用户决定是否清理。该App不创建登录项。

旧的源码CLI入口由`bin/uninstall.command`单独管理。除非用户明确使用并要求卸载该入口，否则不要运行它；它不会移除App本身。

## 构建产物恢复

- `bin/build-menu-app.command`与`bin/build-dmg.command`只在`dist/`生成本地文件，遇到已有目标会停止而不覆盖。
- 构建失败时保留源码和检查点；可将失败的临时目录留待检查，不需要回滚或改动Codex。
- 当前阶段没有安装App，不需要回滚应用包。Task 4源码修改前的归档、SHA-256和恢复步骤见项目日志OP-036。
