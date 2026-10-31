// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CodexObsidianLinkAssistant",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "Codex笔记链接助手", targets: ["CodexObsidianLinkAssistant"]),
    ],
    targets: [
        .executableTarget(name: "CodexObsidianLinkAssistant"),
        .testTarget(
            name: "CodexObsidianLinkAssistantTests",
            dependencies: ["CodexObsidianLinkAssistant"]
        ),
    ],
    swiftLanguageModes: [.v6]
)
