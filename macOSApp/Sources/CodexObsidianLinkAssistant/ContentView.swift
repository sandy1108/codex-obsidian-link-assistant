import SwiftUI

struct ContentView: View {
    @ObservedObject var model: AppModel

    private var actions: WorkerActionAvailability { model.actionAvailability }

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            header
            statusCard
            actionCard
            vaultCard
            if let errorMessage = model.errorMessage {
                errorBanner(errorMessage)
            }
            if let hint = nextStepHint {
                Label(hint, systemImage: "info.circle")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Divider()
            footer
        }
        .padding(16)
        .frame(width: 340)
        .onAppear { model.refreshOnPopoverAppear() }
        .confirmationDialog(
            model.dialogTitle,
            isPresented: dialogPresentation,
            titleVisibility: .visible
        ) {
            switch model.activeDialog {
            case .restartCodex:
                Button("正常退出并以 CDP 启动", role: .destructive) { model.confirmPendingOperation() }
                    .disabled(model.isConfirmationExpired)
                Button("取消", role: .cancel) { model.cancelPendingOperation() }
            case .restoreOrdinaryCodex:
                Button("恢复普通 Codex", role: .destructive) { model.confirmPendingOperation() }
                    .disabled(model.isConfirmationExpired)
                Button("取消", role: .cancel) { model.cancelPendingOperation() }
            case .exitAssistant:
                Button("退出助手", role: .destructive) { model.exitAssistant() }
                Button("取消", role: .cancel) { model.dismissDialog() }
            case nil:
                Button("关闭", role: .cancel) { model.dismissDialog() }
            }
        } message: {
            Text(model.dialogMessage)
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "link.circle.fill")
                .font(.system(size: 27, weight: .semibold))
                .foregroundStyle(.tint)
            VStack(alignment: .leading, spacing: 3) {
                Text("Codex 笔记链接助手")
                    .font(.headline)
                HStack(spacing: 6) {
                    Circle()
                        .fill(overallStatusColor)
                        .frame(width: 7, height: 7)
                    Text(overallStatusText)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 4)
            Button {
                model.perform(.refresh)
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.borderless)
            .help("重新检查 Codex、调试入口与增强状态")
            .disabled(!actions.canRefresh || model.isActionPending || model.isWaitingToExit)
        }
    }

    private var statusCard: some View {
        VStack(spacing: 0) {
            statusRow(
                icon: "app",
                title: "Codex",
                value: codexDescription,
                color: codexColor
            )
            Divider().padding(.leading, 26)
            statusRow(
                icon: "point.3.connected.trianglepath.dotted",
                title: "调试入口",
                value: cdpDescription,
                color: cdpColor
            )
            Divider().padding(.leading, 26)
            statusRow(
                icon: "wand.and.stars",
                title: "笔记增强",
                value: workerDescription,
                color: workerColor
            )
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 3)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.quaternary))
    }

    private var actionCard: some View {
        VStack(spacing: 8) {
            actionRow(
                title: launchTitle,
                subtitle: launchSubtitle,
                symbol: launchCompleted ? "checkmark.seal.fill" : "play.circle.fill",
                color: launchCompleted ? .green : .accentColor,
                enabled: actions.canLaunch && !model.isActionPending && !model.isWaitingToExit,
                completed: launchCompleted
            ) {
                model.perform(.launch)
            }

            actionRow(
                title: connectTitle,
                subtitle: connectSubtitle,
                symbol: connectCompleted ? "checkmark.seal.fill" : "bolt.horizontal.circle.fill",
                color: connectCompleted ? (hasChatPages ? .green : .orange) : .blue,
                enabled: actions.canConnect && !model.isActionPending && !model.isWaitingToExit,
                completed: connectCompleted
            ) {
                model.perform(.connect)
            }

            HStack(spacing: 10) {
                Button {
                    if actions.canPause { model.perform(.pause) }
                    else { model.perform(.resume) }
                } label: {
                    Label(
                        actions.canPause ? "暂停增强" : "恢复增强",
                        systemImage: actions.canPause ? "pause.fill" : "play.fill"
                    )
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(
                    !(actions.canPause || actions.canResume)
                        || model.isActionPending || model.isWaitingToExit
                )

                Button {
                    model.perform(.restoreOrdinary)
                } label: {
                    Label("恢复普通 Codex", systemImage: "arrow.uturn.backward")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(
                    !actions.canRestoreOrdinary
                        || model.isActionPending || model.isWaitingToExit
                )

                Spacer(minLength: 0)
            }
            .padding(.top, 2)
        }
    }

    private var vaultCard: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Label("知识库", systemImage: "folder")
                    .font(.callout.weight(.medium))
                Spacer()
                Text(vaultStatus)
                    .font(.caption2)
                    .foregroundStyle(vaultStatusColor)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(vaultStatusColor.opacity(0.12), in: Capsule())
            }
            Text(model.draftVaultRoot.isEmpty ? "请选择 Obsidian Vault 文件夹" : model.draftVaultRoot)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .help(model.draftVaultRoot)
            HStack(spacing: 8) {
                Button("选择文件夹…") { model.chooseVaultFolder() }
                    .buttonStyle(.borderless)
                    .disabled(model.isActionPending || model.isWaitingToExit)
                Spacer()
                Button("保存并应用") { model.saveVaultFolder() }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(!model.canSaveVaultFolder)
            }
        }
        .padding(10)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.quaternary))
    }

    private func errorBanner(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundStyle(.red)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 12) {
                Button("重新检查状态") { model.perform(.refresh) }
                    .disabled(!actions.canRefresh || model.isActionPending || model.isWaitingToExit)
                Button("查看日志") { model.openLog() }
                Spacer(minLength: 0)
            }
            .buttonStyle(.link)
            .font(.caption)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 9))
        .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(Color.red.opacity(0.25)))
    }

    private var footer: some View {
        HStack {
            Button("查看日志") { model.openLog() }
                .buttonStyle(.borderless)
            Text(AppVersionInfo.current)
                .font(.caption)
                .foregroundStyle(.tertiary)
                .help("Codex 笔记链接助手版本")
            Spacer()
            if model.isWaitingToExit {
                ProgressView()
                    .controlSize(.small)
                    .help("正在等待worker清理")
            }
            Button("退出") { model.showExitConfirmation() }
                .buttonStyle(.borderless)
                .disabled(model.isActionPending || model.isWaitingToExit)
        }
        .font(.callout)
    }

    private func statusRow(icon: String, title: String, value: String, color: Color) -> some View {
        HStack(spacing: 7) {
            Image(systemName: icon)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 16)
            Text(title)
                .font(.callout)
                .foregroundStyle(.secondary)
                .frame(width: 58, alignment: .leading)
            Circle()
                .fill(color)
                .frame(width: 7, height: 7)
            Text(value)
                .font(.callout)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 7)
    }

    private func actionRow(
        title: String,
        subtitle: String,
        symbol: String,
        color: Color,
        enabled: Bool,
        completed: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: symbol)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(color)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.callout.weight(.semibold))
                        .foregroundStyle(enabled || completed ? .primary : .secondary)
                    Text(subtitle)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 4)
                if completed {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                } else if !enabled {
                    Image(systemName: "lock.fill")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 9)
                    .fill(enabled ? color.opacity(0.12) : Color.secondary.opacity(0.07))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 9)
                    .strokeBorder(enabled ? color.opacity(0.55) : Color.secondary.opacity(0.18))
            )
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }

    private var dialogPresentation: Binding<Bool> {
        Binding(
            get: { model.activeDialog != nil },
            set: { isPresented in
                if !isPresented { model.dismissDialog() }
            }
        )
    }

    private var overallStatusText: String {
        if model.connectionState == .starting { return "正在检查本机状态…" }
        if model.connectionState == .stopping { return "正在清理并退出…" }
        guard let state = model.state else { return "状态待核验" }
        if state.worker == .error { return "需要处理" }
        if state.worker == .active {
            return state.pageCount > 0 ? "笔记增强已连接" : "已连接，等待聊天页"
        }
        if state.worker == .paused { return "笔记增强已暂停" }
        if state.codex == .running && state.cdp == .verified { return "CDP 就绪，待连接" }
        if state.codex == .running { return "Codex 未开启调试入口" }
        if state.codex == .stopped { return "Codex 未启动" }
        return "状态待核验"
    }

    private var overallStatusColor: Color {
        if model.connectionState == .starting || model.connectionState == .stopping { return .orange }
        guard let state = model.state else { return .orange }
        if state.worker == .error { return .red }
        if state.worker == .active { return state.pageCount > 0 ? .green : .orange }
        if state.worker == .paused { return .orange }
        if state.codex == .running && state.cdp == .verified { return .orange }
        if state.codex == .stopped { return .secondary }
        return .orange
    }

    private var codexDescription: String {
        guard let state = model.state else { return "状态待核验" }
        switch state.codex {
        case .stopped:
            return "未运行"
        case .running:
            let version = state.codexVersion.map { " · \($0)" } ?? ""
            let source = state.launchSource == .external ? " · 外部启动" : ""
            return "运行中\(version)\(source)"
        case .unknown:
            return "状态待核验"
        }
    }

    private var codexColor: Color {
        guard let state = model.state else { return .orange }
        switch state.codex {
        case .stopped: return .secondary
        case .running: return .green
        case .unknown: return .orange
        }
    }

    private var cdpDescription: String {
        guard let state = model.state else { return "状态待核验" }
        switch state.cdp {
        case .closed: return "未开启"
        case .verified:
            return state.port.map { "已验证 · 端口 \($0)" } ?? "已验证"
        case .unknown: return "未验证（操作已阻断）"
        }
    }

    private var cdpColor: Color {
        guard let state = model.state else { return .orange }
        switch state.cdp {
        case .closed: return .secondary
        case .verified: return .green
        case .unknown: return .orange
        }
    }

    private var workerDescription: String {
        guard let state = model.state else {
            return model.connectionState == .starting ? "正在启动观察器" : "状态待核验"
        }
        switch state.worker {
        case .observing:
            return state.cdp == .verified ? "CDP 已就绪，尚未连接" : "仅观察，未连接"
        case .active:
            return state.pageCount > 0 ? "已连接 · \(state.pageCount) 个页面" : "已连接 · 暂无聊天页"
        case .paused: return "已暂停"
        case .stopping: return "正在清理"
        case .error: return "操作受阻"
        }
    }

    private var workerColor: Color {
        guard let state = model.state else { return .orange }
        switch state.worker {
        case .observing: return state.cdp == .verified ? .orange : .secondary
        case .active: return state.pageCount > 0 ? .green : .orange
        case .paused: return .orange
        case .stopping: return .secondary
        case .error: return .red
        }
    }

    private var launchCompleted: Bool {
        model.state?.codex == .running && model.state?.cdp == .verified
    }

    private var launchTitle: String {
        guard let state = model.state else { return "启动 Codex（CDP 模式）" }
        if state.codex == .running && state.cdp == .verified { return "Codex 已启动（CDP）" }
        if state.codex == .running && state.cdp == .closed { return "重启 Codex 为 CDP 模式" }
        return "启动 Codex（CDP 模式）"
    }

    private var launchSubtitle: String {
        guard let state = model.state else { return "状态核验后可启动" }
        if state.codex == .running && state.cdp == .verified {
            return state.launchSource == .external
                ? "外部实例已带调试入口，可直接连接"
                : "调试入口已就绪，无需再次启动"
        }
        if state.codex == .running && state.cdp == .closed {
            return "先正常退出，再以调试模式重新打开"
        }
        if state.codex == .stopped {
            return "以本机调试端口启动，供助手连接"
        }
        return "当前状态不允许启动"
    }

    private var connectCompleted: Bool {
        model.state?.worker == .active
    }

    private var hasChatPages: Bool {
        (model.state?.pageCount ?? 0) > 0
    }

    private var connectTitle: String {
        if connectCompleted { return hasChatPages ? "已连接 Codex CDP" : "已连接 · 暂无聊天页" }
        if model.state?.worker == .paused { return "笔记增强已暂停" }
        return "连接 Codex CDP"
    }

    private var connectSubtitle: String {
        if connectCompleted {
            let count = model.state?.pageCount ?? 0
            return count > 0
                ? "已向 \(count) 个页面注入笔记按钮"
                : "调试入口已保持监听，打开一个对话页后会自动启用"
        }
        if model.state?.worker == .paused {
            return "使用下方「恢复增强」继续"
        }
        if model.state?.cdp == .verified {
            return "在已验证的调试端点上启用笔记按钮"
        }
        if model.state?.codex == .running {
            return "请先以 CDP 模式启动 Codex"
        }
        return "启动 Codex 后即可连接"
    }

    private var vaultStatus: String {
        guard let state = model.state else { return "状态待核验" }
        if state.vaultConfigured != true { return "未配置" }
        return state.vaultRoot == model.draftVaultRoot ? "已应用" : "待保存"
    }

    private var vaultStatusColor: Color {
        guard let state = model.state else { return .orange }
        if state.vaultConfigured != true { return .red }
        return state.vaultRoot == model.draftVaultRoot ? .green : .orange
    }

    private var nextStepHint: String? {
        if model.isWaitingToExit { return "正在等待助手完成清理，请勿重复操作。" }
        guard let state = model.state else { return nil }
        if state.errorCode != nil {
            return "出现错误后请先重新检查状态；具体原因已写入日志。"
        }
        if state.vaultConfigured != true {
            return "请先在下方选择并保存 Obsidian 知识库目录。"
        }
        if state.worker == .active {
            return state.pageCount > 0
                ? "保持 Codex 运行，新打开的聊天页会自动启用按钮。"
                : "已连接调试入口，但暂未发现聊天页；打开一个对话后按钮会自动出现。"
        }
        if state.worker == .paused {
            return "增强已暂停，Codex 与调试入口仍在运行。"
        }
        if state.worker == .stopping {
            return "助手正在清理，请稍候。"
        }
        if state.codex == .running && state.cdp == .verified {
            return "调试入口已就绪，下一步点击「连接 Codex CDP」。"
        }
        if state.codex == .running {
            return "当前 Codex 是普通启动；需重启为 CDP 模式后才能连接。"
        }
        if state.codex == .stopped {
            return "下一步：以 CDP 模式启动 Codex。"
        }
        return nil
    }
}
