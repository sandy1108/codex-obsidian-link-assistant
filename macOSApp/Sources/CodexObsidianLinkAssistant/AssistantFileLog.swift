import Foundation

/// 追加写入与worker共用的assistant.log；日志失败不影响界面操作。
enum AssistantFileLog {
    private static let queue = DispatchQueue(label: "CodexObsidianLinkAssistant.file-log")
    private static let logURL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/CodexObsidianLinkAssistant/assistant.log")

    static func append(_ event: String, _ detail: String = "") {
        let suffix = detail.isEmpty ? "" : " \(detail)"
        let line = "\(Date().ISO8601Format()) \(event)\(suffix)\n"
        queue.async {
            write(line)
        }
    }

    private static func write(_ line: String) {
        guard let data = line.data(using: .utf8) else { return }
        let directory = logURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(
                atPath: logURL.path,
                contents: nil,
                attributes: [.posixPermissions: 0o600]
            )
        }
        guard let handle = try? FileHandle(forWritingTo: logURL) else { return }
        defer { try? handle.close() }
        _ = try? handle.seekToEnd()
        try? handle.write(contentsOf: data)
    }
}
