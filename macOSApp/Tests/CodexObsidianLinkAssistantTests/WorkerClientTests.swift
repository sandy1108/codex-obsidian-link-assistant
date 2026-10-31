import XCTest
@testable import CodexObsidianLinkAssistant

private func decodedState(
    codex: String,
    cdp: String,
    worker: String,
    launchSource: String,
    errorCode: String? = nil,
    vaultConfigured: Bool = true
) throws -> AssistantState {
    let errorValue = errorCode.map { "\"\($0)\"" } ?? "null"
    let line = #"{"v":1,"type":"state","seq":9,"codex":"\#(codex)","cdp":"\#(cdp)","worker":"\#(worker)","pageCount":0,"launchSource":"\#(launchSource)","errorCode":\#(errorValue),"vaultConfigured":\#(vaultConfigured)}"#
    guard case .state(let state) = try WorkerProtocol.decode(Data(line.utf8)) else {
        throw WorkerProtocolError.invalidMessage
    }
    return state
}

final class WorkerClientTests: XCTestCase {
    func testShutdownRequiresMatchingSuccessfulResultAndCleanProcessExit() {
        var evidence = WorkerShutdownEvidence()
        evidence.recordRequest(id: "request-1")
        evidence.recordResult(id: "request-1", ok: true)

        XCTAssertTrue(evidence.confirmsCleanExit(outputClosed: true, terminationStatus: 0))
        XCTAssertFalse(evidence.confirmsCleanExit(outputClosed: false, terminationStatus: 0))
        XCTAssertFalse(evidence.confirmsCleanExit(outputClosed: true, terminationStatus: 1))
    }

    func testShutdownRejectsMissingFailedOrMismatchedResult() {
        var missing = WorkerShutdownEvidence()
        missing.recordRequest(id: "request-1")
        XCTAssertFalse(missing.confirmsCleanExit(outputClosed: true, terminationStatus: 0))

        var mismatched = WorkerShutdownEvidence()
        mismatched.recordRequest(id: "request-1")
        mismatched.recordResult(id: "request-2", ok: true)
        XCTAssertFalse(mismatched.confirmsCleanExit(outputClosed: true, terminationStatus: 0))

        var failed = WorkerShutdownEvidence()
        failed.recordRequest(id: "request-1")
        failed.recordResult(id: "request-1", ok: false)
        XCTAssertFalse(failed.confirmsCleanExit(outputClosed: true, terminationStatus: 0))
    }

    func testDecodesVerifiedStateAndEnablesOnlySupportedActions() throws {
        let line = #"{"v":1,"type":"state","seq":7,"codex":"running","cdp":"verified","worker":"active","pageCount":2,"codexVersion":"26.1027.30824","codexBuild":"22943","port":9341,"launchSource":"app","errorCode":null}"#

        guard case .state(let state) = try WorkerProtocol.decode(Data(line.utf8)) else {
            return XCTFail("应解码为状态消息")
        }

        XCTAssertEqual(state.codex, .running)
        XCTAssertEqual(state.cdp, .verified)
        XCTAssertEqual(state.worker, .active)
        XCTAssertEqual(state.pageCount, 2)
        let actions = WorkerActionAvailability(state: state)
        XCTAssertTrue(actions.canPause)
        XCTAssertTrue(actions.canRestoreOrdinary)
        XCTAssertFalse(actions.canResume)
    }

    func testDecodesVaultConfigurationStateAndRejectsRelativeVaultPaths() {
        let valid = #"{"v":1,"type":"state","seq":10,"codex":"stopped","cdp":"closed","worker":"observing","pageCount":0,"launchSource":"none","errorCode":null,"vaultConfigured":true,"vaultRoot":"/Users/example/Notes","vaultName":"Notes","recommendedVaultRoot":null}"#
        do {
            guard case .state(let state) = try WorkerProtocol.decode(Data(valid.utf8)) else {
                return XCTFail("应解码为Vault配置状态")
            }
            XCTAssertEqual(state.vaultConfigured, true)
            XCTAssertEqual(state.vaultRoot, "/Users/example/Notes")
            XCTAssertEqual(state.vaultName, "Notes")
        } catch {
            XCTFail("有效Vault状态应通过协议校验：\(error)")
        }

        let invalid = #"{"v":1,"type":"state","seq":10,"codex":"stopped","cdp":"closed","worker":"observing","pageCount":0,"launchSource":"none","errorCode":null,"vaultConfigured":true,"vaultRoot":"relative/Notes","vaultName":"Notes","recommendedVaultRoot":null}"#
        XCTAssertThrowsError(try WorkerProtocol.decode(Data(invalid.utf8)))
    }

    func testRejectsUnknownProtocolVersionAndMessageType() {
        let unknownVersion = #"{"v":2,"type":"state"}"#
        XCTAssertThrowsError(try WorkerProtocol.decode(Data(unknownVersion.utf8))) {
            XCTAssertEqual($0 as? WorkerProtocolError, .unsupportedVersion)
        }

        let unknownType = #"{"v":1,"type":"futureMessage"}"#
        XCTAssertThrowsError(try WorkerProtocol.decode(Data(unknownType.utf8))) {
            XCTAssertEqual($0 as? WorkerProtocolError, .unsupportedMessage)
        }
    }

    func testRejectsUnknownFieldsAndOversizedMessages() {
        let extraField = #"{"v":1,"type":"state","seq":1,"codex":"running","cdp":"closed","worker":"observing","pageCount":0,"arbitrary":"value"}"#
        XCTAssertThrowsError(try WorkerProtocol.decode(Data(extraField.utf8))) {
            XCTAssertEqual($0 as? WorkerProtocolError, .invalidMessage)
        }

        let oversized = Data(repeating: 0x61, count: 16 * 1024 + 1)
        XCTAssertThrowsError(try WorkerProtocol.decode(oversized)) {
            XCTAssertEqual($0 as? WorkerProtocolError, .messageTooLarge)
        }
    }

    func testMapsFixedWorkerErrorsToChineseMessages() {
        XCTAssertTrue(WorkerErrorPresentation.message(for: "VERSION_UNSUPPORTED").contains("未列入兼容清单"))
        XCTAssertTrue(WorkerErrorPresentation.message(for: "PROCESS_EXIT_TIMEOUT").contains("未强制结束"))
        XCTAssertEqual(WorkerErrorPresentation.message(for: "FUTURE_FIXED_CODE"), "操作未完成，状态待核验。")
    }

    func testLaunchFailureMessagePointsToLog() {
        XCTAssertTrue(WorkerErrorPresentation.message(for: "CODEX_LAUNCH_FAILED").contains("查看日志"))
    }

    func testWorkerFallbackMessageDoesNotOverwriteSpecificError() {
        let specific = WorkerErrorPresentation.message(for: "ASSISTANT_LOCK_HELD")
        XCTAssertEqual(
            WorkerErrorRetention.fallback("助手进程已退出，状态待核验。", preserving: specific),
            specific
        )
        XCTAssertEqual(
            WorkerErrorRetention.fallback("助手进程已退出，状态待核验。", preserving: nil),
            "助手进程已退出，状态待核验。"
        )
    }

    func testLockHeldErrorExplainsHowToRecover() {
        XCTAssertTrue(WorkerErrorPresentation.message(for: "ASSISTANT_LOCK_HELD").contains("退出并重新打开"))
    }

    func testExternalAndStartupErrorsHaveSpecificMessages() {
        XCTAssertTrue(WorkerErrorPresentation.message(for: "EXTERNAL_PROCESS").contains("不是由本助手启动"))
        XCTAssertTrue(WorkerErrorPresentation.message(for: "INVALID_LOCK_DATA").contains("锁数据无效"))
        XCTAssertTrue(WorkerErrorPresentation.message(for: "INVALID_STATE_DIRECTORY").contains("状态目录"))
        XCTAssertFalse(WorkerErrorPresentation.message(for: "EXTERNAL_PROCESS").contains("状态待核验"))
    }

    func testTerminationPolicyAsksOnceThenWaitsOrExits() {
        XCTAssertEqual(
            AppTerminationPolicy.decide(approved: false, waitingToExit: false, workerRunning: true),
            .askUser
        )
        XCTAssertEqual(
            AppTerminationPolicy.decide(approved: false, waitingToExit: true, workerRunning: true),
            .waitForCleanup
        )
        XCTAssertEqual(
            AppTerminationPolicy.decide(approved: false, waitingToExit: false, workerRunning: false),
            .terminateNow
        )
        XCTAssertEqual(
            AppTerminationPolicy.decide(approved: true, waitingToExit: false, workerRunning: true),
            .terminateNow
        )
    }

    func testRecoverableWorkerKeepsRefreshAvailableWithoutState() {
        let recoverable = WorkerActionAvailability(state: nil, workerRecoverable: true)
        XCTAssertTrue(recoverable.canRefresh)
        XCTAssertFalse(recoverable.canLaunch)
        XCTAssertFalse(recoverable.canConnect)
        XCTAssertFalse(recoverable.canPause)
        XCTAssertFalse(recoverable.canRestoreOrdinary)

        let unrecoverable = WorkerActionAvailability(state: nil)
        XCTAssertFalse(unrecoverable.canRefresh)
    }

    func testFileLogWriterRotatesAndRestrictsPermissions() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("file-log-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let writer = FileLogWriter(directory: directory, fileName: "assistant.log", maxBytes: 15)
        writer.append("1234567890\n")
        writer.append("abcdefghij\n")
        writer.append("ABCDEFGHIJ\n")

        XCTAssertEqual(try String(contentsOf: writer.fileURL, encoding: .utf8), "ABCDEFGHIJ\n")
        XCTAssertEqual(try String(contentsOf: writer.backupURL, encoding: .utf8), "abcdefghij\n")
        let fileAttributes = try FileManager.default.attributesOfItem(atPath: writer.fileURL.path)
        XCTAssertEqual((fileAttributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        let directoryAttributes = try FileManager.default.attributesOfItem(atPath: directory.path)
        XCTAssertEqual((directoryAttributes[.posixPermissions] as? NSNumber)?.intValue, 0o700)
    }

    func testWorkerStderrBudgetStopsLoggingAfterLimit() {
        let budget = WorkerStderrBudget(limit: 5)
        XCTAssertEqual(budget.consume(Data([1, 2, 3, 4])), Data([1, 2, 3, 4]))
        XCTAssertEqual(budget.consume(Data([5, 6, 7])), Data([5]))
        XCTAssertNil(budget.consume(Data([8])))

        let zero = WorkerStderrBudget(limit: 0)
        XCTAssertNil(zero.consume(Data([1])))
    }

    func testVersionDisplayFallsBackSafely() {
        XCTAssertEqual(AppVersionInfo.display(shortVersion: "0.1.6", build: "6"), "v0.1.6 (6)")
        XCTAssertEqual(AppVersionInfo.display(shortVersion: "0.1.6", build: " "), "v0.1.6")
        XCTAssertEqual(AppVersionInfo.display(shortVersion: nil, build: "6"), "版本未知")
        XCTAssertEqual(AppVersionInfo.display(shortVersion: "", build: "6"), "版本未知")
    }

    func testConfirmationCountdownExpiresAndFormatsMessage() {
        let start = Date(timeIntervalSince1970: 1000)
        let countdown = ConfirmationCountdown(seconds: 5, startedAt: start)
        XCTAssertEqual(countdown.secondsRemaining(now: start), 5)
        XCTAssertEqual(countdown.secondsRemaining(now: start.addingTimeInterval(0.2)), 5)
        XCTAssertEqual(countdown.secondsRemaining(now: start.addingTimeInterval(4.2)), 1)
        XCTAssertEqual(countdown.secondsRemaining(now: start.addingTimeInterval(5)), 0)
        XCTAssertEqual(countdown.secondsRemaining(now: start.addingTimeInterval(6)), 0)
        XCTAssertTrue(countdown.isExpired(now: start.addingTimeInterval(5)))
        XCTAssertFalse(countdown.isExpired(now: start.addingTimeInterval(4.9)))

        XCTAssertEqual(
            ConfirmationMessage.text(base: "base", secondsRemaining: 3),
            "base\n\n确认剩余 3 秒。"
        )
        XCTAssertTrue(ConfirmationMessage.text(base: "base", secondsRemaining: 0).contains("已过期"))
        XCTAssertEqual(ConfirmationMessage.text(base: "base", secondsRemaining: nil), "base")
    }

    func testActionAvailabilityFailsClosedForUnknownOrExternalState() throws {
        let unknown = WorkerActionAvailability(state: nil)
        XCTAssertFalse(unknown.canLaunch)
        XCTAssertFalse(unknown.canConnect)
        XCTAssertFalse(unknown.canPause)
        XCTAssertFalse(unknown.canRestoreOrdinary)

        let externalLine = #"{"v":1,"type":"state","seq":8,"codex":"running","cdp":"verified","worker":"active","pageCount":1,"launchSource":"external","errorCode":null}"#
        guard case .state(let externalState) = try WorkerProtocol.decode(Data(externalLine.utf8)) else {
            return XCTFail("应解码为状态消息")
        }
        let external = WorkerActionAvailability(state: externalState)
        XCTAssertTrue(external.canPause)
        XCTAssertFalse(external.canRestoreOrdinary)
        XCTAssertFalse(external.canLaunch)
        XCTAssertFalse(external.canConnect)
    }

    func testActionsRequireInternallyConsistentVerifiedProcessState() throws {
        let activeWithoutCDP = WorkerActionAvailability(state: try decodedState(
            codex: "running", cdp: "closed", worker: "active", launchSource: "app"
        ))
        XCTAssertFalse(activeWithoutCDP.canPause)
        XCTAssertFalse(activeWithoutCDP.canRestoreOrdinary)
        XCTAssertFalse(activeWithoutCDP.canLaunch)
        XCTAssertFalse(activeWithoutCDP.canConnect)

        let pausedWithoutCDP = WorkerActionAvailability(state: try decodedState(
            codex: "running", cdp: "unknown", worker: "paused", launchSource: "app"
        ))
        XCTAssertFalse(pausedWithoutCDP.canResume)

        let stoppedWithUnknownCDP = WorkerActionAvailability(state: try decodedState(
            codex: "stopped", cdp: "unknown", worker: "observing", launchSource: "none"
        ))
        XCTAssertFalse(stoppedWithUnknownCDP.canLaunch)
        XCTAssertFalse(stoppedWithUnknownCDP.canConnect)

        let pausedButVerified = WorkerActionAvailability(state: try decodedState(
            codex: "running", cdp: "verified", worker: "paused", launchSource: "app"
        ))
        XCTAssertTrue(pausedButVerified.canRestoreOrdinary)
        XCTAssertFalse(pausedButVerified.canLaunch)
        XCTAssertFalse(pausedButVerified.canConnect)
    }

    func testLaunchAndConnectSplitByProcessAndWorkerState() throws {
        let stopped = WorkerActionAvailability(state: try decodedState(
            codex: "stopped", cdp: "closed", worker: "observing", launchSource: "none"
        ))
        XCTAssertTrue(stopped.canLaunch)
        XCTAssertFalse(stopped.canConnect)

        let ordinary = WorkerActionAvailability(state: try decodedState(
            codex: "running", cdp: "closed", worker: "observing", launchSource: "external"
        ))
        XCTAssertTrue(ordinary.canLaunch)
        XCTAssertFalse(ordinary.canConnect)

        let cdpReady = WorkerActionAvailability(state: try decodedState(
            codex: "running", cdp: "verified", worker: "observing", launchSource: "app"
        ))
        XCTAssertFalse(cdpReady.canLaunch)
        XCTAssertTrue(cdpReady.canConnect)
        XCTAssertTrue(cdpReady.canRestoreOrdinary)

        let connected = WorkerActionAvailability(state: try decodedState(
            codex: "running", cdp: "verified", worker: "active", launchSource: "app"
        ))
        XCTAssertFalse(connected.canLaunch)
        XCTAssertFalse(connected.canConnect)
        XCTAssertTrue(connected.canPause)
    }

    func testErrorsDisableBothLaunchAndConnectUntilRefresh() throws {
        let failed = WorkerActionAvailability(state: try decodedState(
            codex: "running", cdp: "closed", worker: "error", launchSource: "external",
            errorCode: "CODEX_LAUNCH_FAILED"
        ))
        XCTAssertFalse(failed.canLaunch)
        XCTAssertFalse(failed.canConnect)
        XCTAssertTrue(failed.canRefresh)

        let vaultMissing = WorkerActionAvailability(state: try decodedState(
            codex: "stopped", cdp: "closed", worker: "observing", launchSource: "none",
            errorCode: "VAULT_NOT_CONFIGURED", vaultConfigured: false
        ))
        XCTAssertFalse(vaultMissing.canLaunch)
        XCTAssertFalse(vaultMissing.canConnect)
    }

    @MainActor
    func testWorkerRestartsAfterUnexpectedExitAndResetsSequence() async throws {
        guard let node = Self.availableNode() else {
            throw XCTSkip("本机没有可用于worker生命周期测试的node")
        }
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("worker-restart-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let script = directory.appendingPathComponent("worker.mjs")
        let source = """
        let seq = 0;
        setInterval(() => {
          seq += 1;
          process.stdout.write(JSON.stringify({
            v: 1, type: 'state', seq, codex: 'stopped', cdp: 'closed', worker: 'observing',
            pageCount: 0, launchSource: 'none', errorCode: null, vaultConfigured: true,
          }) + '\\n');
        }, 100);
        setTimeout(() => process.exit(1), 1200);
        """
        try source.write(to: script, atomically: true, encoding: .utf8)

        let client = WorkerClient(resolveLaunchPaths: {
            WorkerLaunchPaths(node: node, worker: script)
        })
        client.start()
        try await waitUntil(timeout: 3) { client.state != nil }
        try await waitUntil(timeout: 3) { (client.state?.sequence ?? 0) > 3 }
        try await waitUntil(timeout: 4) { client.connectionState == .failed && client.canRestart }

        client.restart()
        // 新worker从seq 1重新开始；未重置lastSequence时旧序号会拒绝这些状态。
        try await waitUntil(timeout: 2) { client.state?.sequence == 1 }
        XCTAssertEqual(client.connectionState, .ready)
        try await waitUntil(timeout: 2) { (client.state?.sequence ?? 0) > 1 }
        try await waitUntil(timeout: 4) { client.connectionState == .failed && client.canRestart }
    }

    private static func availableNode() -> URL? {
        [
            "/Applications/Codex.app/Contents/Resources/cua_node/bin/node",
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
        ].first(where: FileManager.default.isExecutableFile(atPath:))
            .map { URL(fileURLWithPath: $0) }
    }
}

@MainActor
private func waitUntil(
    timeout: TimeInterval,
    condition: () -> Bool
) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if condition() { return }
        try await Task.sleep(for: .milliseconds(20))
    }
    XCTFail("等待条件超时")
}
