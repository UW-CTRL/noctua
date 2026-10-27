// Exercise the actual Scholar settings controls in WebKit with an isolated mock API.
import Cocoa
import WebKit
let root=URL(fileURLWithPath:FileManager.default.currentDirectoryPath)
let app=NSApplication.shared
class ScholarHandler:NSObject,WKScriptMessageHandler {
 func userContentController(_ c:WKUserContentController,didReceive m:WKScriptMessage){print(m.body);exit(String(describing:m.body).hasPrefix("PASS") ? 0 : 1)}
}
let handler=ScholarHandler(),config=WKWebViewConfiguration()
config.websiteDataStore = .nonPersistent()
config.preferences.setValue(true,forKey:"allowFileAccessFromFileURLs")
config.userContentController.add(handler,name:"result")
let source=try String(contentsOfFile:"web/setup.js",encoding:.utf8)
let start=source.range(of:"function scholarSection()")!.lowerBound
let end=source.range(of:"function dataSection(")!.lowerBound
config.userContentController.addUserScript(WKUserScript(source:String(source[start..<end]),injectionTime:.atDocumentEnd,forMainFrameOnly:true))
let web=WKWebView(frame:NSRect(x:0,y:0,width:1000,height:800),configuration:config)
let window=NSWindow(contentRect:web.frame,styleMask:[.titled],backing:.buffered,defer:false)
window.title="Noctua Scholar settings regression"
window.contentView=web
window.ignoresMouseEvents=true
window.orderFront(nil)
web.loadFileURL(root.appendingPathComponent("tests/scholar-settings.html"),allowingReadAccessTo:root)
let deadline=Date().addingTimeInterval(40)
while Date()<deadline {RunLoop.current.run(until:Date().addingTimeInterval(0.05))}
print("FAIL: scholar settings test timed out");exit(1)
