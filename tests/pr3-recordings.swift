// macOS: swift tests/pr3-recordings.swift [scene]. Inputs live in ignored target/pr3-recording.
// Render only the specified public paper and approved saved AI results; never load chat history.
import Cocoa
import WebKit
let root=URL(fileURLWithPath:FileManager.default.currentDirectoryPath)
let scene=CommandLine.arguments.count>1 ? CommandLine.arguments[1] : "attachments"
guard ["outline","auto-highlight","attachments"].contains(scene) else{fatalError("Unknown scene")}
let output=root.appendingPathComponent("target/pr3-recording/frames/\(scene)")
try FileManager.default.createDirectory(at:output,withIntermediateDirectories:true)
let app=NSApplication.shared
app.setActivationPolicy(.regular)
let config=WKWebViewConfiguration()
config.preferences.setValue(true,forKey:"allowFileAccessFromFileURLs")
config.websiteDataStore = .nonPersistent()
let web=WKWebView(frame:NSRect(x:0,y:0,width:1400,height:900),configuration:config)
let window=NSWindow(contentRect:web.frame,styleMask:[.titled,.closable],backing:.buffered,defer:false)
window.title="Noctua PR 3 — Reader recording"
window.contentView=web
window.makeKeyAndOrderFront(nil)
web.loadFileURL(root.appendingPathComponent("tests/pr3-recordings.html"),allowingReadAccessTo:root)
var index=0,working=false,finished=false,warmed=false,manifest=[[String:Any]]()
let timer=Timer.scheduledTimer(withTimeInterval:0.3,repeats:true){_ in
 guard !working && !finished else{return}
 working=true
 web.evaluateJavaScript("window.recordingError || (window.recordingReady ? 'ready' : 'loading')"){result,error in
  guard error==nil,let state=result as? String else{working=false;return}
  if state=="loading"{working=false;return}
  if state != "ready"{print("FAIL: \(state)");exit(1)}
  if !warmed{web.takeSnapshot(with:nil){_,_ in warmed=true;working=false};return}
  web.callAsyncJavaScript("return await window.recordingStep(scene,step)",arguments:["scene":scene,"step":index],in:nil,in:.page){result in
   guard case .success(let value)=result,let info=value as? [String:Any] else{print("FAIL: \(result)");exit(1)}
   web.takeSnapshot(with:nil){image,error in
    guard let image=image,let data=image.tiffRepresentation,let bitmap=NSBitmapImageRep(data:data),let png=bitmap.representation(using:.png,properties:[:]) else{print("FAIL: snapshot \(String(describing:error))");exit(1)}
    let file=String(format:"%03d.png",index)
    do{try png.write(to:output.appendingPathComponent(file))}catch{print(error);exit(1)}
    manifest.append(["file":file,"duration":info["duration"] ?? 1400]);print("Saved \(scene)/\(file)")
    index += 1
    let counts=["outline":7,"auto-highlight":9,"attachments":14]
    if index==counts[scene]{
     finished=true
     do{try JSONSerialization.data(withJSONObject:manifest,options:.prettyPrinted).write(to:output.appendingPathComponent("manifest.json"))}catch{print(error);exit(1)}
     print("PASS: \(scene) recording frames");exit(0)
    }
    working=false
   }
  }
 }
}
DispatchQueue.main.asyncAfter(deadline:.now()+120){print("FAIL: recording fixture timed out");exit(1)}
app.run()
