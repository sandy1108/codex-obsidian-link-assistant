import SwiftUI
import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        AppModel.current?.handleTerminationRequest() ?? .terminateNow
    }
}

@main
struct CodexObsidianLinkAssistantApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model = AppModel()

    var body: some Scene {
        MenuBarExtra {
            ContentView(model: model)
        } label: {
            MenuBarIcon()
        }
        .menuBarExtraStyle(.window)
    }
}

private struct MenuBarIcon: View {
    var body: some View {
        if let image = templateImage() {
            Image(nsImage: image)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: 16, height: 16)
                .accessibilityLabel("Codex笔记链接助手")
        } else {
            Image(systemName: "link")
                .accessibilityLabel("Codex笔记链接助手")
        }
    }

    private func templateImage() -> NSImage? {
        guard let url = Bundle.main.url(forResource: "menu-bar-template", withExtension: "png"),
              let image = NSImage(contentsOf: url) else { return nil }
        // PNG像素尺寸不是菜单栏点尺寸；先限制NSImage逻辑尺寸，避免宿主按原图尺寸布局。
        image.size = NSSize(width: 16, height: 16)
        // 将用户选定的透明黑色图标作为模板图交给macOS按当前菜单栏外观着色。
        image.isTemplate = true
        return image
    }
}
