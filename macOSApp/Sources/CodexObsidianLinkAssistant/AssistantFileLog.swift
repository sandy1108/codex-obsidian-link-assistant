import Foundation

/// 追加写入与worker共用的日志；日志失败不影响界面操作。日志按1 MiB轮转，保留一个`.1`备份。
enum AssistantFileLog {
    private static let queue = DispatchQueue(label: "CodexObsidianLinkAssistant.file-log")
    private static let directory = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/CodexObsidianLinkAssistant")
    private static let appWriter = FileLogWriter(directory: directory, fileName: "assistant.log")
    private static let workerStderrWriter = FileLogWriter(directory: directory, fileName: "worker-stderr.log")

    static var logURL: URL { appWriter.fileURL }
    static var workerStderrURL: URL { workerStderrWriter.fileURL }

    static func append(_ event: String, _ detail: String = "") {
        let suffix = detail.isEmpty ? "" : " \(detail)"
        let line = "\(Date().ISO8601Format()) \(event)\(suffix)\n"
        queue.async {
            appWriter.append(line)
        }
    }

    static func appendWorkerStderr(_ text: String) {
        guard !text.isEmpty else { return }
        queue.async {
            workerStderrWriter.append(text)
        }
    }
}
