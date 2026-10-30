import AppKit
import WebKit
import UniformTypeIdentifiers
import Darwin

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKUIDelegate, WKNavigationDelegate, WKDownloadDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var webView: WKWebView!
    var worker: Process?
    var timer: Timer?
    var temporary: URL!
    var readyFile: URL!
    var logFile: URL!
    var origin: URL?
    var quitting = false
    var checkingTermination = false
    var started = Date()

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "시안 검수 종료", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        menu.addItem(appItem)
        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "편집")
        editMenu.addItem(withTitle: "실행 취소", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "오려두기", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "복사", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "붙여넣기", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "모두 선택", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        menu.addItem(editItem)
        NSApp.mainMenu = menu

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 940), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "시안 검수"
        window.delegate = self
        window.minSize = NSSize(width: 1000, height: 720)
        window.center()
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: "sourcePicker")
        configuration.websiteDataStore = .nonPersistent()
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.uiDelegate = self
        webView.navigationDelegate = self
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        startWorker()
    }

    func startWorker() {
        do {
            guard let resources = Bundle.main.resourceURL else { throw NSError(domain: "VisualQA", code: 1, userInfo: [NSLocalizedDescriptionKey: "앱 리소스를 찾지 못했습니다."]) }
            temporary = FileManager.default.temporaryDirectory.appendingPathComponent("visualqa-launch-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            readyFile = temporary.appendingPathComponent("ready.json")
            logFile = temporary.appendingPathComponent("launcher.log")
            FileManager.default.createFile(atPath: logFile.path, contents: nil)
            let log = try FileHandle(forWritingTo: logFile)
            let process = Process()
            process.executableURL = resources.appendingPathComponent("run.sh")
            process.arguments = ["--serve", "--ready-file", readyFile.path]
            process.standardOutput = log
            process.standardError = log
            process.terminationHandler = { [weak self] _ in
                DispatchQueue.main.async {
                    guard let self = self, !self.quitting else { return }
                    self.timer?.invalidate()
                    self.showError("검수 서비스가 종료되었습니다.")
                }
            }
            worker = process
            try process.run()
            started = Date()
            timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in self?.checkReady() }
        } catch { showError(error.localizedDescription) }
    }

    func checkReady() {
        if let data = try? Data(contentsOf: readyFile),
           let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let address = value["url"] as? String, let url = URL(string: address) {
            timer?.invalidate()
            origin = url
            webView.load(URLRequest(url: url))
        } else if Date().timeIntervalSince(started) > 30 {
            timer?.invalidate()
            showError("시작 시간이 초과되었습니다.")
        }
    }

    func showError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = message
        let details = logFile.flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
        alert.informativeText = String(details.suffix(1800)) + "\n앱을 다시 실행해 주세요. 기존 검수 이력은 보존됩니다."
        alert.addButton(withTitle: "확인")
        alert.runModal()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func windowShouldClose(_ sender: NSWindow) -> Bool { NSApp.terminate(nil); return false }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if checkingTermination { return .terminateCancel }
        guard webView != nil else { return .terminateNow }
        checkingTermination = true
        webView.evaluateJavaScript("window.SourceEditor ? SourceEditor.canLeave() : true") { [weak self] result, error in
            self?.checkingTermination = false
            sender.reply(toApplicationShouldTerminate: error != nil || (result as? Bool ?? true))
        }
        return .terminateLater
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let base = origin,
              message.frameInfo.securityOrigin.host == base.host,
              message.frameInfo.securityOrigin.port == base.port,
              let value = message.body as? [String: Any], let kind = value["kind"] as? String,
              let requestId = value["requestId"] as? String, ["folder", "html"].contains(kind) else { return }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = kind == "folder"
        panel.canChooseFiles = kind == "html"
        panel.allowsMultipleSelection = false
        if kind == "html" { panel.allowedContentTypes = [.html] }
        panel.beginSheetModal(for: window) { [weak self] response in
            let payload: [String: Any] = ["requestId": requestId, "path": response == .OK ? (panel.url?.path as Any? ?? NSNull()) : NSNull()]
            if let data = try? JSONSerialization.data(withJSONObject: payload), let json = String(data: data, encoding: .utf8) {
                self?.webView.evaluateJavaScript("window.visualqaNativeResult(\(json))", completionHandler: nil)
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        quitting = true
        timer?.invalidate()
        if let process = worker, process.isRunning {
            process.terminate()
            let deadline = Date().addingTimeInterval(4)
            while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }
        if let directory = temporary { try? FileManager.default.removeItem(at: directory) }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.png, .jpeg]
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.beginSheetModal(for: window) { response in completionHandler(response == .OK ? panel.urls : nil) }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert(); alert.messageText = message; alert.addButton(withTitle: "확인")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = message; alert.addButton(withTitle: "계속"); alert.addButton(withTitle: "취소")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert(); alert.messageText = prompt; alert.addButton(withTitle: "확인"); alert.addButton(withTitle: "취소")
        let input = NSTextField(string: defaultText ?? ""); input.frame = NSRect(x: 0, y: 0, width: 260, height: 28)
        alert.accessoryView = input
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn ? input.stringValue : nil) }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url, let base = origin,
              url.host == base.host, url.port == base.port, url.scheme == "http" else { decisionHandler(.cancel); return }
        decisionHandler(navigationAction.shouldPerformDownload ? .download : .allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel(); panel.nameFieldStringValue = suggestedFilename
        panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.url : nil) }
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
