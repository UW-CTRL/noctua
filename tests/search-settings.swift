// macOS: swift tests/search-settings.swift
// Exercise the shipped search engine preferences and drag/drop settings in WebKit.
import Cocoa
import WebKit
let root=URL(fileURLWithPath:FileManager.default.currentDirectoryPath)
let app=NSApplication.shared
class SearchSettingsHandler:NSObject,WKScriptMessageHandler {
 func userContentController(_ c:WKUserContentController,didReceive m:WKScriptMessage){print(m.body);exit(String(describing:m.body).hasPrefix("PASS") ? 0 : 1)}
}
let handler=SearchSettingsHandler(),config=WKWebViewConfiguration()
config.websiteDataStore = .nonPersistent()
config.preferences.setValue(true,forKey:"allowFileAccessFromFileURLs")
config.userContentController.add(handler,name:"result")
let source=try String(contentsOfFile:"web/app.js",encoding:.utf8)
let setup=try String(contentsOfFile:"web/setup.js",encoding:.utf8)
let prefs=source[source.range(of:"const defaultSearchEngines")!.lowerBound..<source.range(of:"function updateSearchPlaceholder")!.lowerBound]
let controls=setup[setup.range(of:"function searchSettingsSection()")!.lowerBound..<setup.range(of:"function serverSection()")!.lowerBound]
config.userContentController.addUserScript(WKUserScript(source:String(prefs)+String(controls),injectionTime:.atDocumentEnd,forMainFrameOnly:true))
let web=WKWebView(frame:NSRect(x:0,y:0,width:1000,height:800),configuration:config)
web.loadFileURL(root.appendingPathComponent("tests/search-settings.html"),allowingReadAccessTo:root)
let deadline=Date().addingTimeInterval(40)
while Date()<deadline {RunLoop.current.run(until:Date().addingTimeInterval(0.05))}
print("FAIL: search settings test timed out");exit(1)
