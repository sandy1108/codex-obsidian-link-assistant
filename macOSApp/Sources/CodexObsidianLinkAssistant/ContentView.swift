import SwiftUI

struct ContentView: View {
    @ObservedObject var model: AppModel

    private var actions: WorkerActionAvailability { model.actionAvailability }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            Divider()
            statusPanel
            if let errorMessage = model.errorMessage {
                Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
            controls
            Divider()
            footer
        }
        .padding(16)
        .frame(width: 320)
        .confirmationDialog(
            model.dialogTitle,
            isPresented: dialogPresentation,
            titleVisibility: .visible
        ) {
            switch model.activeDialog {
            case .restartCodex:
                Button("正常退出并启用", role: .destructive) { model.confirmPendingOperation() }
                Button("取消", role: .cancel) { model.cancelPendingOperation() }
            case .restoreOrdinaryCodex:
                Button("恢复普通 Codex", role: .destructive) { model.confirmPendingOperation() }
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
        HStack(spacing: 9) {
            Image(systemName: "link")
                .font(.system(size: 19, weight: .semibold))
                .foregroundStyle(.tint)
            VStack(alignment: .leading, spacing: 2) {
                Text("Codex 笔记链接助手")
                    .font(.headline)
                Text(statusSummary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 4)
            Button {
                model.perform(.refresh)
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.borderless)
            .help("重新核验状态")
            .disabled(!actions.canRefresh || model.isActionPending)
        }
    }

    private var statusPanel: some View {
        VStack(alignment: .leading, spacing: 9) {
            statusRow("Codex", value: codexDescription, color: codexColor)
            statusRow("CDP", value: cdpDescription, color: cdpColor)
            statusRow("链接增强", value: workerDescription, color: workerColor)
            if let state = model.state, state.pageCount > 0 {
                Text("已验证聊天页：\(state.pageCount)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.leading, 58)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
    }

    private var controls: some View {
        VStack(spacing: 8) {
            Button {
                model.perform(.enable)
            } label: {
                Label("连接并启用", systemImage: "link.badge.plus")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(!actions.canEnable || model.isActionPending || model.isWaitingToExit)

            Button {
                if actions.canPause { model.perform(.pause) }
                else { model.perform(.resume) }
            } label: {
                Label(actions.canPause ? "暂停增强" : "恢复增强",
                      systemImage: actions.canPause ? "pause.fill" : "play.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .disabled(!(actions.canPause || actions.canResume) || model.isActionPending || model.isWaitingToExit)

            Button {
                model.perform(.restoreOrdinary)
            } label: {
                Label("恢复普通 Codex", systemImage: "arrow.uturn.backward")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .disabled(!actions.canRestoreOrdinary || model.isActionPending || model.isWaitingToExit)
        }
    }

    private var footer: some View {
        HStack {
            Button("查看日志") { model.openLog() }
                .buttonStyle(.borderless)
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

    private var dialogPresentation: Binding<Bool> {
        Binding(
            get: { model.activeDialog != nil },
            set: { isPresented in
                if !isPresented { model.dismissDialog() }
            }
        )
    }

    private var statusSummary: String {
        if model.state == nil {
            switch model.connectionState {
            case .starting: return "正在检查本机状态…"
            case .ready: return "状态待核验"
            case .stopping: return "正在清理并退出…"
            case .stopped: return "助手未运行"
            case .failed: return "状态待核验"
            }
        }
        if let code = model.state?.errorCode {
            return WorkerErrorPresentation.message(for: code)
        }
        return model.isActionPending ? "正在核验操作结果…" : "状态已由worker核验"
    }

    private var codexDescription: String {
        guard let state = model.state else { return "状态待核验" }
        switch state.codex {
        case .stopped: return "未运行"
        case .running:
            return state.launchSource == .external ? "运行中 · 外部启动" : "运行中"
        case .unknown: return "状态待核验"
        }
    }

    private var codexColor: Color {
        guard let state = model.state else { return .secondary }
        switch state.codex {
        case .stopped: return .secondary
        case .running: return .green
        case .unknown: return .orange
        }
    }

    private var cdpDescription: String {
        guard let state = model.state else { return "状态待核验" }
        switch state.cdp {
        case .closed: return "未连接"
        case .verified:
            return state.port.map { "回环端点已验证 · \($0)" } ?? "回环端点已验证"
        case .unknown: return "未验证，操作已阻断"
        }
    }

    private var cdpColor: Color {
        guard let state = model.state else { return .secondary }
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
        case .observing: return "仅观察，未启用"
        case .active: return "已启用"
        case .paused: return "已暂停"
        case .stopping: return "正在清理"
        case .error: return "操作受阻"
        }
    }

    private var workerColor: Color {
        guard let state = model.state else { return .secondary }
        switch state.worker {
        case .observing, .paused: return .orange
        case .active: return .green
        case .stopping: return .secondary
        case .error: return .red
        }
    }

    private func statusRow(_ title: String, value: String, color: Color) -> some View {
        HStack(spacing: 8) {
            Text(title)
                .frame(width: 50, alignment: .leading)
                .foregroundStyle(.secondary)
            Circle()
                .fill(color)
                .frame(width: 7, height: 7)
            Text(value)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 0)
        }
        .font(.callout)
    }
}
