// Exercise the actual Settings Skills tab and imports in WebKit.
import Cocoa
import WebKit
let root=URL(fileURLWithPath:FileManager.default.currentDirectoryPath)
let app=NSApplication.shared
class SkillsHandler:NSObject,WKScriptMessageHandler {
 func userContentController(_ c:WKUserContentController,didReceive m:WKScriptMessage){print(m.body);exit(String(describing:m.body).hasPrefix("PASS") ? 0 : 1)}
}
let handler=SkillsHandler(),config=WKWebViewConfiguration()
config.websiteDataStore = .nonPersistent()
config.preferences.setValue(true,forKey:"allowFileAccessFromFileURLs")
config.userContentController.add(handler,name:"result")
let source=try String(contentsOfFile:"web/setup.js",encoding:.utf8)
let start=source.range(of:"const SETTINGS_TABS")!.lowerBound
let end=source.range(of:"function fontSizeSetting")!.lowerBound
let setupStart=source.range(of:"function openSetup(")!.lowerBound
let setupEnd=source.range(of:"\nfunction afterSetup()")!.lowerBound
config.userContentController.addUserScript(WKUserScript(source:String(source[start..<end])+String(source[setupStart..<setupEnd]),injectionTime:.atDocumentEnd,forMainFrameOnly:true))
let web=WKWebView(frame:NSRect(x:0,y:0,width:1000,height:800),configuration:config)
web.loadFileURL(root.appendingPathComponent("tests/skill-settings.html"),allowingReadAccessTo:root)
let deadline=Date().addingTimeInterval(40)
while Date()<deadline {RunLoop.current.run(until:Date().addingTimeInterval(0.05))}
print("FAIL: skill settings test timed out");exit(1)
