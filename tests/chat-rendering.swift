// macOS: swift tests/chat-rendering.swift
import Cocoa
import WebKit
let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let app = NSApplication.shared
class Handler: NSObject, WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        print(message.body)
        exit(String(describing: message.body).hasPrefix("PASS") ? 0 : 1)
    }
}
let handler = Handler(), config = WKWebViewConfiguration()
config.websiteDataStore = .nonPersistent()
config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
config.userContentController.add(handler, name: "result")
let source = try String(contentsOf: root.appendingPathComponent("web/app.js"), encoding: .utf8)
let start = source.range(of: "function extractMath(")!.lowerBound
let end = source.range(of: "function appendMsg(", range: start..<source.endIndex)!.lowerBound
let definitions = #"""
const esc = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
"""# + "\n"
config.userContentController.addUserScript(WKUserScript(source: definitions + String(source[start..<end]), injectionTime: .atDocumentEnd, forMainFrameOnly: true))
let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 900, height: 800), configuration: config)
let window = NSWindow(contentRect: web.frame, styleMask: [.titled], backing: .buffered, defer: false)
window.title = "Chat rendering checks"
window.contentView = web
window.orderFront(nil)
web.loadFileURL(root.appendingPathComponent("tests/chat-rendering.html"), allowingReadAccessTo: root)
let deadline = Date().addingTimeInterval(45)
while Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
print("FAIL: chat renderer test timed out"); exit(1)
