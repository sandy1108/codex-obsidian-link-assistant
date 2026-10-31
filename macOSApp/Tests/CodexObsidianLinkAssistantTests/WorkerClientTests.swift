import XCTest
@testable import CodexObsidianLinkAssistant

private func decodedState(
    codex: String,
    cdp: String,
    worker: String,
    launchSource: String,
    errorCode: String? = nil
) throws -> AssistantState {
    let errorValue = errorCode.map { "\"\($0)\"" } ?? "null"
    let line = #"{"v":1,"type":"state","seq":9,"codex":"\#(codex)","cdp":"\#(cdp)","worker":"\#(worker)","pageCount":0,"launchSource":"\#(launchSource)","errorCode":\#(errorValue)}"#
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

    func testActionAvailabilityFailsClosedForUnknownOrExternalState() throws {
        let unknown = WorkerActionAvailability(state: nil)
        XCTAssertFalse(unknown.canEnable)
        XCTAssertFalse(unknown.canPause)
        XCTAssertFalse(unknown.canRestoreOrdinary)

        let externalLine = #"{"v":1,"type":"state","seq":8,"codex":"running","cdp":"verified","worker":"active","pageCount":1,"launchSource":"external","errorCode":null}"#
        guard case .state(let externalState) = try WorkerProtocol.decode(Data(externalLine.utf8)) else {
            return XCTFail("应解码为状态消息")
        }
        let external = WorkerActionAvailability(state: externalState)
        XCTAssertTrue(external.canPause)
        XCTAssertFalse(external.canRestoreOrdinary)
    }

    func testActionsRequireInternallyConsistentVerifiedProcessState() throws {
        let activeWithoutCDP = WorkerActionAvailability(state: try decodedState(
            codex: "running", cdp: "closed", worker: "active", launchSource: "app"
        ))
        XCTAssertFalse(activeWithoutCDP.canPause)
        XCTAssertFalse(activeWithoutCDP.canRestoreOrdinary)

        let pausedWithoutCDP = WorkerActionAvailability(state: try decodedState(
            codex: "running", cdp: "unknown", worker: "paused", launchSource: "app"
        ))
        XCTAssertFalse(pausedWithoutCDP.canResume)

        let stoppedWithUnknownCDP = WorkerActionAvailability(state: try decodedState(
            codex: "stopped", cdp: "unknown", worker: "observing", launchSource: "none"
        ))
        XCTAssertFalse(stoppedWithUnknownCDP.canEnable)

        let pausedButVerified = WorkerActionAvailability(state: try decodedState(
            codex: "running", cdp: "verified", worker: "paused", launchSource: "app"
        ))
        XCTAssertTrue(pausedButVerified.canRestoreOrdinary)
    }
}
