// Compiled with the production AppDelegate; only the save destination is automated.
final class DownloadProbe: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKDownloadDelegate {
    let policy = AppDelegate()
    var view: WKWebView!
    var testWindow: NSWindow!
    var destination: URL!
    var clicked = false
    var finished = false
    var boundaryStage = 0
    var viewChecks = ""

    func finish(_ status: String, _ message: String) {
        guard !finished else { return }
        finished = true
        let value = ["status": status, "message": message]
        let data = try! JSONSerialization.data(withJSONObject: value)
        print(String(data: data, encoding: .utf8)!)
        fflush(stdout)
        exit(status == "PASS" ? 0 : 1)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
            let config = try JSONSerialization.jsonObject(with: data) as! [String: String]
            let address = URL(string: config["url"]!)!
            destination = URL(fileURLWithPath: config["destination"]!)
            viewChecks = try String(contentsOfFile: config["checks"]!, encoding: .utf8)
            policy.origin = address
            let configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = .nonPersistent()
            view = WKWebView(frame: NSRect(x: 0, y: 0, width: 1440, height: 940), configuration: configuration)
            view.navigationDelegate = self
            testWindow = NSWindow(contentRect: view.frame, styleMask: [.titled], backing: .buffered, defer: false)
            testWindow.contentView = view
            view.load(URLRequest(url: address))
            DispatchQueue.main.asyncAfter(deadline: .now() + 45) { self.finish("FAIL", "WebKit download timed out") }
        } catch { finish("FAIL", error.localizedDescription) }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        policy.webView(webView, decidePolicyFor: action) { decision in
            decisionHandler(decision)
            if self.boundaryStage == 1 && action.request.url?.host == "example.invalid" {
                guard decision == .cancel else { self.finish("FAIL", "External navigation was allowed"); return }
                self.boundaryStage = 2
                DispatchQueue.main.async {
                    webView.evaluateJavaScript("location.href = URL.createObjectURL(new Blob(['navigation probe'], {type: 'text/plain'}))", completionHandler: nil)
                }
                return
            }
            if self.boundaryStage == 2 && action.request.url?.scheme == "blob" {
                guard decision == .cancel && !action.shouldPerformDownload else { self.finish("FAIL", "Blob navigation without a download was allowed"); return }
                self.boundaryStage = 3
                DispatchQueue.main.async { self.clickExport(webView) }
                return
            }
            if action.request.url?.scheme == "blob" && decision == .cancel {
                self.finish("FAIL", "Production navigation policy cancelled its own JSON blob download")
            }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !clicked else { return }
        clicked = true
        boundaryStage = 1
        webView.load(URLRequest(url: URL(string: "https://example.invalid/")!))
    }

    func clickExport(_ webView: WKWebView) {
        webView.callAsyncJavaScript(viewChecks, arguments: [:], in: nil, in: .page) { result in
            switch result {
            case .success:
                webView.evaluateJavaScript("document.querySelector('#chrome-review').click()", completionHandler: nil)
            case .failure(let error):
                self.finish("FAIL", error.localizedDescription)
            }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        policy.webView(webView, decidePolicyFor: response, decisionHandler: decisionHandler)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        guard suggestedFilename == "visualqa-review.json" else { finish("FAIL", "Unexpected download filename"); completionHandler(nil); return }
        completionHandler(destination)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard boundaryStage == 3 else { finish("FAIL", "Navigation boundaries were not verified"); return }
        finish("PASS", "Production WebKit policy saved the integrated JSON")
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) { finish("FAIL", error.localizedDescription) }
}

let probeApplication = NSApplication.shared
let probe = DownloadProbe()
probeApplication.delegate = probe
probeApplication.setActivationPolicy(.prohibited)
probeApplication.run()
