import Foundation

/// 单文件追加日志；写前按大小轮转，只保留一个`.1`备份。调用方负责串行化。
struct FileLogWriter {
    let directory: URL
    let fileName: String
    let maxBytes: Int

    init(directory: URL, fileName: String, maxBytes: Int = 1 << 20) {
        precondition(maxBytes > 0)
        self.directory = directory
        self.fileName = fileName
        self.maxBytes = maxBytes
    }

    var fileURL: URL { directory.appendingPathComponent(fileName) }
    var backupURL: URL { directory.appendingPathComponent("\(fileName).1") }

    func append(_ text: String) {
        guard let data = text.data(using: .utf8), !data.isEmpty else { return }
        let manager = FileManager.default
        try? manager.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        if let attributes = try? manager.attributesOfItem(atPath: fileURL.path),
           let size = attributes[.size] as? NSNumber,
           size.intValue > 0,
           size.intValue + data.count > maxBytes {
            try? manager.removeItem(at: backupURL)
            try? manager.moveItem(at: fileURL, to: backupURL)
        }
        if !manager.fileExists(atPath: fileURL.path) {
            manager.createFile(
                atPath: fileURL.path,
                contents: nil,
                attributes: [.posixPermissions: 0o600]
            )
        }
        guard let handle = try? FileHandle(forWritingTo: fileURL) else { return }
        defer { try? handle.close() }
        _ = try? handle.seekToEnd()
        try? handle.write(contentsOf: data)
    }
}

/// 每个worker进程独立计数；超限后继续排空stderr但不落盘，避免管道反压阻塞worker。
final class WorkerStderrBudget: @unchecked Sendable {
    private let lock = NSLock()
    private let limit: Int
    private var written = 0

    init(limit: Int = 256 * 1024) {
        precondition(limit >= 0)
        self.limit = limit
    }

    func consume(_ data: Data) -> Data? {
        lock.lock()
        defer { lock.unlock() }
        guard written < limit else { return nil }
        let count = min(data.count, limit - written)
        written += count
        return Data(data.prefix(count))
    }
}

/// 版本展示只读取Info.plist；缺失时显示“版本未知”，不回退到源码里的硬编码值。
enum AppVersionInfo {
    static var current: String {
        display(
            shortVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
            build: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        )
    }

    static func display(shortVersion: String?, build: String?) -> String {
        guard let version = shortVersion?.trimmingCharacters(in: .whitespacesAndNewlines),
              !version.isEmpty else { return "版本未知" }
        guard let build = build?.trimmingCharacters(in: .whitespacesAndNewlines),
              !build.isEmpty else { return "v\(version)" }
        return "v\(version) (\(build))"
    }
}

/// 确认倒计时只依赖worker给出的秒数和开始时间；过期后由界面禁用确认，等待用户取消重试。
struct ConfirmationCountdown: Equatable {
    let deadline: Date

    init(seconds: Int, startedAt: Date = Date()) {
        deadline = startedAt.addingTimeInterval(TimeInterval(max(0, seconds)))
    }

    func secondsRemaining(now: Date = Date()) -> Int {
        max(0, Int(ceil(deadline.timeIntervalSince(now))))
    }

    func isExpired(now: Date = Date()) -> Bool {
        secondsRemaining(now: now) == 0
    }
}

enum ConfirmationMessage {
    static func text(base: String, secondsRemaining: Int?) -> String {
        guard let secondsRemaining else { return base }
        if secondsRemaining <= 0 { return "\(base)\n\n确认已过期，请取消后重新发起。" }
        return "\(base)\n\n确认剩余 \(secondsRemaining) 秒。"
    }
}
