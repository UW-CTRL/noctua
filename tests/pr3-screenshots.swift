// macOS: swift tests/pr3-screenshots.swift. Renders isolated, English demo data only.
import Cocoa
import WebKit
let root=URL(fileURLWithPath:FileManager.default.currentDirectoryPath)
let app=NSApplication.shared
app.setActivationPolicy(.regular)
let config=WKWebViewConfiguration()
config.preferences.setValue(true,forKey:"allowFileAccessFromFileURLs")
config.websiteDataStore = .nonPersistent()
let web=WKWebView(frame:NSRect(x:0,y:0,width:1400,height:900),configuration:config)
let window=NSWindow(contentRect:web.frame,styleMask:[.titled,.closable],backing:.buffered,defer:false)
window.title="Noctua PR 3 — isolated demo"
window.contentView=web
window.makeKeyAndOrderFront(nil)
web.loadFileURL(root.appendingPathComponent("tests/pr3-demo.html"),allowingReadAccessTo:root)
let scenes=["outline","annotations","attachments","settings"]
var index=0,working=false,finished=false,warmed=false
let timer=Timer.scheduledTimer(withTimeInterval:0.5,repeats:true){_ in
 guard !working && !finished else{return}
 working=true
 web.evaluateJavaScript("window.demoError || (window.demoReady ? 'ready' : 'loading')"){result,error in
  guard error==nil,let state=result as? String else{working=false;return}
  if state=="loading"{working=false;return}
  if state != "ready"{print("FAIL: \(state)");exit(1)}
  if !warmed{web.takeSnapshot(with:nil){_,_ in warmed=true;working=false};return}
  let scene=scenes[index]
  web.callAsyncJavaScript("return await window.demoScene(scene)",arguments:["scene":scene],in:nil,in:.page){result in
   if case .failure(let error)=result{print("FAIL: \(error)");exit(1)}
   DispatchQueue.main.asyncAfter(deadline:.now()+0.6){
    let snapshot=WKSnapshotConfiguration()
    if scene=="settings"{snapshot.rect=NSRect(x:230,y:80,width:940,height:300)}
    web.takeSnapshot(with:snapshot){image,error in
     guard let image=image,let data=image.tiffRepresentation,let bitmap=NSBitmapImageRep(data:data),let png=bitmap.representation(using:.png,properties:[:]) else{print("FAIL: snapshot \(String(describing:error))");exit(1)}
     do{try png.write(to:root.appendingPathComponent("docs/images/pr-3/\(scene).png"))}catch{print(error);exit(1)}
     print("Saved \(scene).png")
     index += 1;working=false
     if index==scenes.count{finished=true;print("PASS: four isolated Reader demo screenshots");exit(0)}
    }
   }
  }
 }
}
DispatchQueue.main.asyncAfter(deadline:.now()+60){print("FAIL: screenshot fixture timed out");exit(1)}
app.run()
