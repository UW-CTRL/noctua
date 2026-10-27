// macOS integration smoke test: real WebKit, bundled PDF.js, canvas and text layer.
import Cocoa
import WebKit
let root=URL(fileURLWithPath:FileManager.default.currentDirectoryPath)
let app=NSApplication.shared
class Handler:NSObject,WKScriptMessageHandler,WKNavigationDelegate {
 var finished=false
 func userContentController(_ c:WKUserContentController,didReceive m:WKScriptMessage){print(m.body);finished=true;exit(String(describing:m.body).hasPrefix("PASS") ? 0 : 1)}
 func webView(_ webView:WKWebView,didFailProvisionalNavigation navigation:WKNavigation!,withError error:Error){print(error);exit(1)}
}
let handler=Handler(),config=WKWebViewConfiguration()
config.websiteDataStore = .nonPersistent()
config.preferences.setValue(true,forKey:"allowFileAccessFromFileURLs")
config.userContentController.add(handler,name:"result")
let web=WKWebView(frame:NSRect(x:0,y:0,width:1100,height:800),configuration:config)
// Dialogs and PDF-to-image attachment checks need an attached window to avoid
// background WebKit canvas and timer throttling.
var fixtureWindow:NSWindow?
if ["tests/collection-research.html", "tests/workspace.html", "tests/note-drafts.html", "tests/connection.html", "tests/client-updates.html", "tests/connection-theme.html", "tests/server-maintenance.html", "tests/chat-files.html", "tests/paper.html", "tests/paper-source.html", "tests/document-tools.html", "tests/mentions.html", "tests/panes.html", "tests/library-import.html"].contains(CommandLine.arguments.dropFirst().first ?? "") {
 let window=NSWindow(contentRect:web.frame,styleMask:[.titled],backing:.buffered,defer:false)
 window.title="Noctua browser regression"
 window.contentView=web
 window.ignoresMouseEvents=true
 window.orderFront(nil)
 fixtureWindow=window
}
web.navigationDelegate=handler
web.loadFileURL(root.appendingPathComponent(CommandLine.arguments.dropFirst().first ?? "tests/reader.html"),allowingReadAccessTo:root)
let deadline=Date().addingTimeInterval(35)
while !handler.finished && Date()<deadline {RunLoop.current.run(until:Date().addingTimeInterval(0.05))}
print("FAIL: WebKit test timed out");exit(1)
