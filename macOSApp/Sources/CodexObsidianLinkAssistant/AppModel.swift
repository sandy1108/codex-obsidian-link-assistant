import Foundation
import AppKit
import Combine

enum CodexProcessState: String, Decodable, Equatable {
    case stopped
    case running
    case unknown
}

enum CDPConnectionState: String, Decodable, Equatable {
    case closed
    case verified
    case unknown
}

enum AssistantWorkerState: String, Decodable, Equatable {
    case observing
    case active
    case paused
    case stopping
    case error
}

enum CodexLaunchSource: String, Decodable, Equatable {
    case none
    case app
    case external
    case unknown
}

struct AssistantState: Decodable, Equatable {
    let version: Int
    let type: String
    let sequence: Int
    let codex: CodexProcessState
    let cdp: CDPConnectionState
    let worker: AssistantWorkerState
    let pageCount: Int
    let codexVersion: String?
    let codexBuild: String?
    let port: Int?
    let launchSource: CodexLaunchSource?
    let errorCode: String?

    private enum CodingKeys: String, CodingKey {
        case version = "v"
        case type
        case sequence = "seq"
        case codex
        case cdp
        case worker
        case pageCount
        case codexVersion
        case codexBuild
        case port
        case launchSource
        case errorCode
    }
}

enum ConfirmationReason: String, Decodable, Equatable {
    case restartOrdinaryCodex
    case restoreOrdinaryCodex
}

struct ConfirmationPrompt: Decodable, Equatable {
    let requestID: String
    let confirmationID: String
    let reason: ConfirmationReason
    let expiresInSeconds: Int

    private enum CodingKeys: String, CodingKey {
        case requestID = "requestId"
        case confirmationID = "confirmationId"
        case reason
        case expiresInSeconds
    }
}

struct WorkerResult: Decodable, Equatable {
    let id: String
    let ok: Bool
    let code: String
}

enum WorkerMessage: Equatable {
    case accepted(id: String)
    case state(AssistantState)
    case confirmationRequired(ConfirmationPrompt)
    case result(WorkerResult)
    case error(code: String)
}

enum WorkerProtocolError: Error, Equatable {
    case invalidJSON
    case invalidMessage
    case unsupportedVersion
    case unsupportedMessage
    case messageTooLarge
}

enum WorkerProtocol {
    static let maximumLineBytes = 16 * 1024

    /// 解析worker的单行JSONL；严格限制版本、字段和长度，避免界面误信未知协议数据。
    static func decode(_ data: Data) throws -> WorkerMessage {
        guard data.count <= maximumLineBytes else { throw WorkerProtocolError.messageTooLarge }

        let object: [String: Any]
        do {
            guard let dictionary = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw WorkerProtocolError.invalidMessage
            }
            object = dictionary
        } catch let error as WorkerProtocolError {
            throw error
        } catch {
            throw WorkerProtocolError.invalidJSON
        }

        guard let version = object["v"] as? Int else { throw WorkerProtocolError.invalidMessage }
        guard version == 1 else { throw WorkerProtocolError.unsupportedVersion }
        guard let type = object["type"] as? String else { throw WorkerProtocolError.invalidMessage }

        switch type {
        case "accepted":
            guard exactKeys(object, required: ["v", "type", "id"]),
                  let id = object["id"] as? String, isUUID(id) else {
                throw WorkerProtocolError.invalidMessage
            }
            return .accepted(id: id)
        case "state":
            let required: Set<String> = ["v", "type", "seq", "codex", "cdp", "worker", "pageCount"]
            let optional: Set<String> = ["codexVersion", "codexBuild", "port", "launchSource", "errorCode"]
            guard exactKeys(object, required: required, optional: optional) else {
                throw WorkerProtocolError.invalidMessage
            }
            let state: AssistantState
            do { state = try JSONDecoder().decode(AssistantState.self, from: data) }
            catch { throw WorkerProtocolError.invalidMessage }
            guard state.type == "state", state.sequence >= 0, (0...1000).contains(state.pageCount),
                  state.port.map({ (1024...65535).contains($0) }) ?? true,
                  state.codexVersion.map({ matches($0, pattern: #"^\d+(?:\.\d+){1,4}$"#) }) ?? true,
                  state.codexBuild.map({ matches($0, pattern: #"^\d{1,20}$"#) }) ?? true,
                  state.errorCode.map({ isErrorCode($0) }) ?? true else {
                throw WorkerProtocolError.invalidMessage
            }
            return .state(state)
        case "confirmationRequired":
            let keys: Set<String> = ["v", "type", "requestId", "confirmationId", "reason", "expiresInSeconds"]
            guard exactKeys(object, required: keys),
                  let requestID = object["requestId"] as? String, isUUID(requestID),
                  let confirmationID = object["confirmationId"] as? String, isConfirmationID(confirmationID),
                  let reason = object["reason"] as? String,
                  let expiry = object["expiresInSeconds"] as? Int,
                  (1...60).contains(expiry) else {
                throw WorkerProtocolError.invalidMessage
            }
            guard let reasonValue = ConfirmationReason(rawValue: reason) else {
                throw WorkerProtocolError.invalidMessage
            }
            return .confirmationRequired(ConfirmationPrompt(
                requestID: requestID,
                confirmationID: confirmationID,
                reason: reasonValue,
                expiresInSeconds: expiry
            ))
        case "result":
            let keys: Set<String> = ["v", "type", "id", "ok", "code"]
            guard exactKeys(object, required: keys),
                  let id = object["id"] as? String, isUUID(id),
                  let ok = object["ok"] as? Bool,
                  let code = object["code"] as? String, matches(code, pattern: #"^[a-z][A-Za-z0-9-]{0,63}$"#) else {
                throw WorkerProtocolError.invalidMessage
            }
            return .result(WorkerResult(id: id, ok: ok, code: code))
        case "error":
            let keys: Set<String> = ["v", "type", "code"]
            guard exactKeys(object, required: keys),
                  let code = object["code"] as? String, isErrorCode(code) else {
                throw WorkerProtocolError.invalidMessage
            }
            return .error(code: code)
        default:
            throw WorkerProtocolError.unsupportedMessage
        }
    }

    private static func exactKeys(
        _ object: [String: Any],
        required: Set<String>,
        optional: Set<String> = []
    ) -> Bool {
        let keys = Set(object.keys)
        return required.isSubset(of: keys) && keys.isSubset(of: required.union(optional))
    }

    private static func isUUID(_ value: String) -> Bool {
        matches(value, pattern: #"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"#)
    }

    private static func isConfirmationID(_ value: String) -> Bool {
        matches(value, pattern: #"^[A-Za-z0-9_-]{32,128}$"#)
    }

    private static func isErrorCode(_ value: String) -> Bool {
        matches(value, pattern: #"^[A-Z][A-Z0-9_]{0,63}$"#)
    }

    private static func matches(_ value: String, pattern: String) -> Bool {
        value.range(of: pattern, options: .regularExpression) != nil
    }
}

enum WorkerAction: String {
    case refresh
    case enable
    case confirmRestart
    case cancelConfirmation
    case pause
    case resume
    case restoreOrdinary
    case shutdown
}

struct WorkerActionAvailability: Equatable {
    let canRefresh: Bool
    let canEnable: Bool
    let canPause: Bool
    let canResume: Bool
    let canRestoreOrdinary: Bool

    init(state: AssistantState?) {
        guard let state else {
            canRefresh = false
            canEnable = false
            canPause = false
            canResume = false
            canRestoreOrdinary = false
            return
        }

        let statusIsSafe = state.errorCode == nil && state.worker != .error && state.worker != .stopping
        canRefresh = state.worker != .stopping
        let endpointIsVerified = state.codex == .running && state.cdp == .verified
        let stoppedStateIsConsistent = state.codex == .stopped && state.cdp == .closed
        let runningStateCanBeEnabled = state.codex == .running
            && (state.cdp == .closed || state.cdp == .verified)
        canEnable = statusIsSafe && state.worker == .observing
            && (stoppedStateIsConsistent || runningStateCanBeEnabled)
        canPause = statusIsSafe && endpointIsVerified && state.worker == .active
        canResume = statusIsSafe && endpointIsVerified && state.worker == .paused
        canRestoreOrdinary = statusIsSafe && endpointIsVerified
            && (state.worker == .active || state.worker == .paused)
            && state.launchSource == .app
    }
}

enum WorkerErrorPresentation {
    static func message(for code: String) -> String {
        switch code {
        case "ASSISTANT_LOCK_HELD": return "已有一个助手实例正在运行。"
        case "CODEX_NOT_FOUND": return "找不到受支持的 Codex 安装。"
        case "SIGNATURE_MISMATCH": return "Codex 签名校验失败。"
        case "VERSION_UNSUPPORTED": return "当前 Codex 版本未列入兼容清单。"
        case "COMPATIBILITY_MISSING": return "缺少兼容性清单，已停止操作。"
        case "PROCESS_AMBIGUOUS": return "检测到多个 Codex 进程，无法安全操作。"
        case "CDP_UNTRUSTED": return "无法验证 Codex 调试端点，已停止操作。"
        case "CDP_TIMEOUT": return "等待 Codex 调试端点超时。"
        case "PROCESS_CHANGED": return "Codex 进程身份发生变化，操作已停止。"
        case "PROCESS_IDENTITY_UNAVAILABLE": return "无法确认 Codex 进程身份。"
        case "CONFIRMATION_EXPIRED": return "确认已过期，请重新发起操作。"
        case "PROCESS_EXIT_TIMEOUT": return "Codex 未按期正常退出；未强制结束。"
        case "CODEX_LAUNCH_FAILED": return "Codex 未能正常启动。"
        case "INJECTION_FAILED": return "页面增强未能完成。"
        case "STATE_UNAVAILABLE": return "当前状态不足以安全执行此操作。"
        case "WORKER_STOPPING": return "助手正在退出。"
        case "INVALID_CONFIRMATION", "NO_PENDING_CONFIRMATION": return "确认已失效，请重新发起操作。"
        default: return "操作未完成，状态待核验。"
        }
    }
}

enum AppConfirmationDialog: Equatable {
    case restartCodex
    case restoreOrdinaryCodex
    case exitAssistant
}

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var state: AssistantState?
    @Published private(set) var connectionState: WorkerConnectionState = .stopped
    @Published private(set) var pendingConfirmation: ConfirmationPrompt?
    @Published private(set) var activeDialog: AppConfirmationDialog?
    @Published private(set) var errorMessage: String?
    @Published private(set) var isActionPending = false
    @Published private(set) var isWaitingToExit = false

    private let workerClient: WorkerClient

    var actionAvailability: WorkerActionAvailability {
        WorkerActionAvailability(state: state)
    }

    var dialogTitle: String {
        switch activeDialog {
        case .restartCodex: return "需要正常重启 Codex"
        case .restoreOrdinaryCodex: return "恢复普通 Codex"
        case .exitAssistant: return "退出笔记链接助手"
        case nil: return "确认操作"
        }
    }

    var dialogMessage: String {
        switch activeDialog {
        case .restartCodex:
            return "当前 Codex 没有本助手可验证的调试入口。确认后会请求 Codex 正常退出，再由助手重新打开。取消不会改变当前 Codex。"
        case .restoreOrdinaryCodex:
            return "这会正常退出由助手启动的 Codex，再以普通方式打开。该进程上的其他 CDP 工具也会断开；身份变化或超时会停止，绝不强制结束。"
        case .exitAssistant:
            return "助手会先清理自身注入并退出。Codex 会继续运行，CDP 调试入口也可能继续保留。"
        case nil:
            return ""
        }
    }

    init(workerClient: WorkerClient = WorkerClient()) {
        self.workerClient = workerClient
        workerClient.onUpdate = { [weak self] in self?.synchronizeFromWorker() }
        workerClient.onMessage = { [weak self] message in self?.handle(message) }
        // 应用启动只启动观察worker；不会发送enable或启动Codex。
        workerClient.start()
    }

    func perform(_ action: WorkerAction) {
        guard !isActionPending else { return }
        let availability = actionAvailability
        let allowed: Bool
        switch action {
        case .refresh: allowed = availability.canRefresh
        case .enable: allowed = availability.canEnable
        case .pause: allowed = availability.canPause
        case .resume: allowed = availability.canResume
        case .restoreOrdinary: allowed = availability.canRestoreOrdinary
        case .confirmRestart, .cancelConfirmation, .shutdown: allowed = false
        }
        guard allowed, workerClient.send(action) != nil else { return }
        synchronizeFromWorker()
    }

    func confirmPendingOperation() {
        guard let prompt = pendingConfirmation, !isActionPending else { return }
        guard workerClient.send(.confirmRestart, confirmationID: prompt.confirmationID) != nil else { return }
        activeDialog = nil
        synchronizeFromWorker()
    }

    func cancelPendingOperation() {
        guard let prompt = pendingConfirmation, !isActionPending else {
            if activeDialog == .exitAssistant { activeDialog = nil }
            return
        }
        guard workerClient.send(.cancelConfirmation, confirmationID: prompt.confirmationID) != nil else { return }
        activeDialog = nil
        synchronizeFromWorker()
    }

    func showExitConfirmation() {
        guard !isActionPending, pendingConfirmation == nil else { return }
        activeDialog = .exitAssistant
    }

    func dismissDialog() {
        switch activeDialog {
        case .restartCodex, .restoreOrdinaryCodex:
            cancelPendingOperation()
        case .exitAssistant:
            activeDialog = nil
        case nil:
            break
        }
    }

    func openLog() {
        let logURL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/CodexObsidianLinkAssistant/assistant.log")
        guard FileManager.default.fileExists(atPath: logURL.path), NSWorkspace.shared.open(logURL) else {
            errorMessage = "当前还没有助手日志。"
            return
        }
    }

    func exitAssistant() {
        guard activeDialog == .exitAssistant, !isActionPending else { return }
        activeDialog = nil
        isWaitingToExit = true
        Task { @MainActor in
            let stopped = await workerClient.shutdownAndWait()
            isWaitingToExit = false
            if stopped {
                NSApplication.shared.terminate(nil)
            } else {
                errorMessage = "助手未能在限定时间内完成清理；应用保持打开，未强制结束进程。"
            }
        }
    }

    private func handle(_ message: WorkerMessage) {
        switch message {
        case .state(let nextState):
            state = nextState
            if nextState.errorCode != nil {
                errorMessage = WorkerErrorPresentation.message(for: nextState.errorCode ?? "RUNTIME_ERROR")
            }
        case .confirmationRequired(let prompt):
            pendingConfirmation = prompt
            activeDialog = prompt.reason == .restartOrdinaryCodex ? .restartCodex : .restoreOrdinaryCodex
        case .result(let result):
            if !result.ok {
                let code = result.code.uppercased().replacingOccurrences(of: "-", with: "_")
                errorMessage = WorkerErrorPresentation.message(for: code)
            } else if workerClient.state?.errorCode == nil {
                errorMessage = nil
            }
        case .error(let code):
            errorMessage = WorkerErrorPresentation.message(for: code)
        case .accepted:
            break
        }
        synchronizeFromWorker()
    }

    private func synchronizeFromWorker() {
        state = workerClient.state
        connectionState = workerClient.connectionState
        pendingConfirmation = workerClient.pendingConfirmation
        isActionPending = workerClient.pendingRequestID != nil
        if let clientError = workerClient.lastErrorMessage {
            errorMessage = clientError
        }
        if pendingConfirmation == nil,
           activeDialog == .restartCodex || activeDialog == .restoreOrdinaryCodex {
            activeDialog = nil
        }
    }
}
