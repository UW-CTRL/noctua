// Exercise the actual startup dialog and focus behavior in WebKit with a fake update API.
import Cocoa
import WebKit
let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let app = NSApplication.shared
class UpdateHandler: NSObject, WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        print(message.body)
        exit(String(describing: message.body).hasPrefix("PASS") ? 0 : 1)
    }
}
let handler = UpdateHandler(), config = WKWebViewConfiguration()
config.websiteDataStore = .nonPersistent()
config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
config.userContentController.add(handler, name: "result")
let source = try String(contentsOf: root.appendingPathComponent("web/setup.js"), encoding: .utf8)
let start = source.range(of: "function updateSummary")!.lowerBound
let end = source.range(of: "// First run stays short")!.lowerBound
config.userContentController.addUserScript(WKUserScript(source: String(source[start..<end]), injectionTime: .atDocumentEnd, forMainFrameOnly: true))
// CI covers the minimum desktop window; optional dimensions exercise other sizes.
let width = Double(CommandLine.arguments.dropFirst().first ?? "") ?? 820
let height = Double(CommandLine.arguments.dropFirst(2).first ?? "") ?? 520
let web = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height), configuration: config)
web.loadFileURL(root.appendingPathComponent("tests/updates-ui.html"), allowingReadAccessTo: root)
let deadline = Date().addingTimeInterval(40)
while Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
print("FAIL: update dialog test timed out"); exit(1)
