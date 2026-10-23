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
config.preferences.setValue(true,forKey:"allowFileAccessFromFileURLs")
config.userContentController.add(handler,name:"result")
let web=WKWebView(frame:NSRect(x:0,y:0,width:1100,height:800),configuration:config)
web.navigationDelegate=handler
web.loadFileURL(root.appendingPathComponent(CommandLine.arguments.dropFirst().first ?? "tests/reader.html"),allowingReadAccessTo:root)
let deadline=Date().addingTimeInterval(35)
while !handler.finished && Date()<deadline {RunLoop.current.run(until:Date().addingTimeInterval(0.05))}
print("FAIL: WebKit test timed out");exit(1)
