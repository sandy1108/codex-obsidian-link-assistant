import Combine
import Foundation

enum WorkerConnectionState: Equatable {
    case starting
    case ready
    case stopping
    case stopped
    case failed
}

/// worker已返回的具体错误优先，进程退出等通用兜底文案不得覆盖它。
enum WorkerErrorRetention {
    static func fallback(_ fallback: String, preserving existing: String?) -> String? {
        existing ?? fallback
    }
}

/// 只有匹配的成功回执、stdout EOF和零退出码同时成立，才算完成清理。
struct WorkerShutdownEvidence {
    private(set) var requestID: String?
    private(set) var requestSucceeded: Bool?

    mutating func recordRequest(id: String) {
        requestID = id
        requestSucceeded = nil
    }

    mutating func recordResult(id: String, ok: Bool) {
        guard id == requestID, requestSucceeded == nil else { return }
        requestSucceeded = ok
    }

    func confirmsCleanExit(outputClosed: Bool, terminationStatus: Int32) -> Bool {
        requestID != nil && requestSucceeded == true && outputClosed && terminationStatus == 0
    }
}

struct WorkerLaunchPaths {
    let node: URL
    let worker: URL
}

@MainActor
final class WorkerClient: ObservableObject {
    @Published private(set) var connectionState: WorkerConnectionState = .stopped
    @Published private(set) var state: AssistantState?
    @Published private(set) var pendingConfirmation: ConfirmationPrompt?
    @Published private(set) var pendingRequestID: String?
    @Published private(set) var lastErrorMessage: String?

    var onUpdate: (() -> Void)?
    var onMessage: ((WorkerMessage) -> Void)?

    private let resolveLaunchPaths: () throws -> WorkerLaunchPaths

    private var process: Process?
    private var inputPipe: Pipe?
    private var outputPipe: Pipe?
    private var outputBuffer = Data()
    private var outputConsumerTask: Task<Void, Never>?
    private var outputStreamFinished = false
    private var pendingTerminationStatus: Int32?
    private var lastSequence = 0
    private var shutdownRequested = false
    private var shutdownEvidence = WorkerShutdownEvidence()
    private var hasStartedWorker = false
    private var terminationWaiter: CheckedContinuation<Bool, Never>?

    init(resolveLaunchPaths: @escaping () throws -> WorkerLaunchPaths = WorkerClient.defaultLaunchPaths) {
        self.resolveLaunchPaths = resolveLaunchPaths
    }

    var isRunning: Bool { process?.isRunning == true }

    /// 只有worker已经退出（崩溃或启动失败）时才允许从界面重启，避免打断正在进行的清理。
    var canRestart: Bool { process == nil && connectionState == .failed }

    func restart() {
        guard canRestart else { return }
        start()
    }

    func start() {
        guard process == nil, connectionState != .stopping else { return }
        connectionState = .starting
        state = nil
        pendingConfirmation = nil
        pendingRequestID = nil
        lastErrorMessage = nil
        // 新worker的seq从1重新开始，旧序列号不能拦截新状态。
        lastSequence = 0
        onUpdate?()

        do {
            let paths = try resolveLaunchPaths()
            let child = Process()
            let stdin = Pipe()
            let stdout = Pipe()

            child.executableURL = paths.node
            child.arguments = [paths.worker.path]
            child.standardInput = stdin
            child.standardOutput = stdout
            child.standardError = FileHandle.nullDevice
            child.environment = [
                "HOME": FileManager.default.homeDirectoryForCurrentUser.path,
                "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
                "TMPDIR": NSTemporaryDirectory(),
                "USER": NSUserName(),
                "LANG": "en_US.UTF-8",
            ]

            process = child
            inputPipe = stdin
            outputPipe = stdout
            outputBuffer = Data()
            outputStreamFinished = false
            pendingTerminationStatus = nil
            shutdownRequested = false
            shutdownEvidence = WorkerShutdownEvidence()

            let outputStreamPair = AsyncStream<Data>.makeStream()
            let outputContinuation = outputStreamPair.continuation
            outputConsumerTask = Task { @MainActor [weak self] in
                for await chunk in outputStreamPair.stream {
                    guard let self else { break }
                    self.consume(chunk)
                }
                self?.handleOutputClosed()
            }

            child.terminationHandler = { [weak self] child in
                let status = child.terminationStatus
                Task { @MainActor [weak self] in self?.handleTermination(status: status) }
            }
            stdout.fileHandleForReading.readabilityHandler = { handle in
                let data = handle.availableData
                if data.isEmpty {
                    handle.readabilityHandler = nil
                    outputContinuation.finish()
                } else {
                    outputContinuation.yield(data)
                }
            }

            try child.run()
            hasStartedWorker = true
            connectionState = .ready
            onUpdate?()
            _ = send(.refresh)
        } catch {
            process = nil
            inputPipe = nil
            outputPipe = nil
            connectionState = .failed
            state = nil
            lastErrorMessage = "无法启动受管助手，请检查App包内worker与Codex安装。"
            AssistantFileLog.append("worker-launch-failed", "reason=runtime-or-worker-missing")
            onUpdate?()
        }
    }

    @discardableResult
    func send(_ action: WorkerAction, confirmationID: String? = nil, vaultRoot: String? = nil) -> String? {
        guard connectionState == .ready,
              let child = process, child.isRunning,
              let inputPipe,
              pendingRequestID == nil else {
            lastErrorMessage = WorkerErrorRetention.fallback(
                "助手未就绪或仍在处理上一个请求。状态待核验。",
                preserving: lastErrorMessage
            )
            AssistantFileLog.append("ui-action-blocked", "action=\(action.rawValue) reason=worker-not-ready-or-busy")
            onUpdate?()
            return nil
        }

        let confirmationActions: Set<WorkerAction> = [.confirmRestart, .cancelConfirmation]
        let vaultConfigurationActions: Set<WorkerAction> = [.configureVault]
        let validVaultRoot = vaultRoot.map { root -> Bool in
            root.hasPrefix("/")
                && root.utf8.count <= 8192
                && !root.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
        } ?? false
        guard confirmationActions.contains(action) == (confirmationID != nil),
              vaultConfigurationActions.contains(action) == (vaultRoot != nil),
              vaultRoot == nil || validVaultRoot else {
            lastErrorMessage = "请求参数不符合助手协议。"
            AssistantFileLog.append("ui-action-blocked", "action=\(action.rawValue) reason=invalid-parameters")
            onUpdate?()
            return nil
        }

        var request: [String: Any] = [
            "v": 1,
            "type": "request",
            "id": UUID().uuidString.lowercased(),
            "action": action.rawValue,
        ]
        if let confirmationID { request["confirmationId"] = confirmationID }
        if let vaultRoot { request["vaultRoot"] = vaultRoot }

        do {
            var line = try JSONSerialization.data(withJSONObject: request)
            guard line.count <= WorkerProtocol.maximumLineBytes else {
                lastErrorMessage = "请求超过协议长度限制。"
                AssistantFileLog.append("ui-action-blocked", "action=\(action.rawValue) reason=request-too-large")
                onUpdate?()
                return nil
            }
            line.append(0x0A)
            try inputPipe.fileHandleForWriting.write(contentsOf: line)
            let requestID = request["id"] as? String
            pendingRequestID = requestID
            if confirmationActions.contains(action) { pendingConfirmation = nil }
            if action == .shutdown {
                if let requestID { shutdownEvidence.recordRequest(id: requestID) }
                shutdownRequested = true
                connectionState = .stopping
                try? inputPipe.fileHandleForWriting.close()
            }
            AssistantFileLog.append("ui-action-sent", "action=\(action.rawValue)")
            onUpdate?()
            return requestID
        } catch {
            state = nil
            connectionState = .failed
            lastErrorMessage = "无法向助手发送请求，状态待核验。"
            AssistantFileLog.append("worker-request-write-failed", "action=\(action.rawValue)")
            onUpdate?()
            return nil
        }
    }

    /// 请求worker清理本工具注入并退出；超时只返回失败，不强制结束任何进程。
    func shutdownAndWait(timeoutSeconds: UInt64 = 5) async -> Bool {
        guard process != nil else {
            // worker从未成功启动时没有可能留下本工具注入；已启动后意外丢失则不能推定清理完成。
            return !hasStartedWorker || connectionState == .stopped
        }
        if !shutdownRequested {
            guard send(.shutdown) != nil else { return false }
        }
        if process == nil {
            return connectionState == .stopped
                && shutdownEvidence.confirmsCleanExit(
                    outputClosed: outputStreamFinished,
                    terminationStatus: pendingTerminationStatus ?? -1
                )
        }

        return await withCheckedContinuation { continuation in
            terminationWaiter = continuation
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(timeoutSeconds))
                guard let self, let waiter = self.terminationWaiter else { return }
                self.terminationWaiter = nil
                waiter.resume(returning: false)
            }
        }
    }

    nonisolated static func defaultLaunchPaths() throws -> WorkerLaunchPaths {
        WorkerLaunchPaths(node: try codexNodeURL(), worker: try bundledWorkerURL())
    }

    private nonisolated static func codexNodeURL() throws -> URL {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let bundles = [
            URL(fileURLWithPath: "/Applications/Codex.app"),
            home.appendingPathComponent("Applications/Codex.app"),
        ]
        for bundle in bundles {
            let candidate = bundle.appendingPathComponent("Contents/Resources/cua_node/bin/node")
            if FileManager.default.isExecutableFile(atPath: candidate.path) { return candidate }
        }
        throw WorkerClientFailure.runtimeNotFound
    }

    private nonisolated static func bundledWorkerURL() throws -> URL {
        guard let resources = Bundle.main.resourceURL else { throw WorkerClientFailure.workerNotFound }
        let worker = resources.appendingPathComponent("worker/src/ui-worker.mjs")
        guard FileManager.default.isReadableFile(atPath: worker.path) else {
            throw WorkerClientFailure.workerNotFound
        }
        return worker
    }

    private func consume(_ data: Data) {
        outputBuffer.append(data)
        guard outputBuffer.count <= WorkerProtocol.maximumLineBytes || outputBuffer.contains(0x0A) else {
            rejectProtocolOutput()
            return
        }

        while let newline = outputBuffer.firstIndex(of: 0x0A) {
            let line = Data(outputBuffer[..<newline])
            outputBuffer.removeSubrange(...newline)
            do { receive(try WorkerProtocol.decode(line)) }
            catch { rejectProtocolOutput() ; return }
        }

        if outputBuffer.count > WorkerProtocol.maximumLineBytes { rejectProtocolOutput() }
    }

    private func receive(_ message: WorkerMessage) {
        switch message {
        case .accepted:
            break
        case .state(let nextState):
            guard nextState.sequence > lastSequence else {
                rejectProtocolOutput()
                return
            }
            lastSequence = nextState.sequence
            state = nextState
            AssistantFileLog.append(
                "state",
                "worker=\(nextState.worker.rawValue) codex=\(nextState.codex.rawValue)"
                    + " cdp=\(nextState.cdp.rawValue) error=\(nextState.errorCode ?? "none")"
            )
            if nextState.worker == .error {
                lastErrorMessage = WorkerErrorPresentation.message(for: nextState.errorCode ?? "RUNTIME_ERROR")
            }
        case .confirmationRequired(let prompt):
            pendingConfirmation = prompt
        case .result(let result):
            shutdownEvidence.recordResult(id: result.id, ok: result.ok)
            if pendingRequestID == result.id { pendingRequestID = nil }
            if !result.ok { lastErrorMessage = WorkerErrorPresentation.message(for: result.code.uppercased().replacingOccurrences(of: "-", with: "_")) }
            else { lastErrorMessage = nil }
        case .error(let code):
            connectionState = .failed
            state = nil
            lastErrorMessage = WorkerErrorPresentation.message(for: code)
        }
        onMessage?(message)
        onUpdate?()
    }

    private func rejectProtocolOutput() {
        state = nil
        pendingConfirmation = nil
        connectionState = .failed
        lastErrorMessage = "助手返回了不受支持的协议数据，已停止显示状态。"
        AssistantFileLog.append("worker-protocol-rejected", "reason=unsupported-output")
        inputPipe?.fileHandleForWriting.closeFile()
        onUpdate?()
    }

    private func handleOutputClosed() {
        outputStreamFinished = true
        if process?.isRunning == true, !shutdownRequested {
            state = nil
            connectionState = .failed
            lastErrorMessage = WorkerErrorRetention.fallback(
                "助手输出通道已关闭，状态待核验。",
                preserving: lastErrorMessage
            )
            AssistantFileLog.append("worker-output-closed", "reason=unexpected-eof")
            inputPipe?.fileHandleForWriting.closeFile()
        }
        finishWorkerIfTerminated()
        onUpdate?()
    }

    private func handleTermination(status: Int32) {
        pendingTerminationStatus = status
        finishWorkerIfTerminated()
    }

    private func finishWorkerIfTerminated() {
        guard outputStreamFinished, let status = pendingTerminationStatus else { return }
        let shutdownSucceeded = shutdownRequested
            && shutdownEvidence.confirmsCleanExit(outputClosed: true, terminationStatus: status)
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        process = nil
        inputPipe = nil
        outputPipe = nil
        outputConsumerTask = nil
        state = nil
        pendingConfirmation = nil
        pendingRequestID = nil
        if shutdownSucceeded {
            connectionState = .stopped
            lastErrorMessage = nil
        } else {
            connectionState = .failed
            lastErrorMessage = WorkerErrorRetention.fallback(
                "助手进程已退出，状态待核验。",
                preserving: lastErrorMessage
            )
        }
        AssistantFileLog.append(
            "worker-exited",
            "status=\(status) clean=\(shutdownSucceeded)"
        )
        shutdownRequested = false
        if let waiter = terminationWaiter {
            terminationWaiter = nil
            waiter.resume(returning: shutdownSucceeded)
        }
        onUpdate?()
    }
}

private enum WorkerClientFailure: Error {
    case runtimeNotFound
    case workerNotFound
}
