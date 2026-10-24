// Visible WebKit capture of the production app against an isolated local backend.
// Run from the repository root; see docs/note-qol-recording.md.
import Cocoa
import WebKit
let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let config = WKWebViewConfiguration()
config.websiteDataStore = .nonPersistent()
let web = WKWebView(frame: NSRect(x:0,y:0,width:1440,height:940), configuration:config)
class CaptureWindow:NSWindow { override var canBecomeKey:Bool { false }; override var canBecomeMain:Bool { false } }
let window = CaptureWindow(contentRect:web.frame, styleMask:[.titled,.closable], backing:.buffered, defer:false)
window.title = "Noctua — isolated feature demonstration"
window.contentView = web
window.ignoresMouseEvents = true
window.orderFront(nil)
let scene = CommandLine.arguments.dropFirst().first ?? "workspace"
let script = try String(contentsOf:root.appendingPathComponent("tests/note-qol-recordings.js"),encoding:.utf8)
let output = root.appendingPathComponent("target/note-qol-recording/frames/\(scene)")
try FileManager.default.createDirectory(at:output,withIntermediateDirectories:true)
var busy=false, injected=false, step=0, frames=[[String:Any]]()
web.load(URLRequest(url: URL(string:"http://127.0.0.1:47891")!))
let timer = Timer.scheduledTimer(withTimeInterval:0.4,repeats:true){ _ in
 guard !busy else{return}; busy=true
 web.evaluateJavaScript("typeof W !== 'undefined' && typeof N !== 'undefined' && typeof settings !== 'undefined' && !!settings"){value,error in
  guard (value as? Bool)==true else{busy=false;return}
  if !injected {
   web.evaluateJavaScript(script){_,error in
    if let error=error {print("FAIL: \(error)");exit(1)}
    print("Loaded recording script");fflush(stdout);injected=true;busy=false
   };return
  }
  print("Running step \(step)");fflush(stdout)
  web.callAsyncJavaScript("return await window.captureStep(scene, step)",arguments:["scene":scene,"step":step],in:nil,in:.page){result in
   guard case .success(let value)=result,let info=value as? [String:Any] else{print("FAIL: \(result)");exit(1)}
   if info["done"] as? Bool == true {
    do {try JSONSerialization.data(withJSONObject:frames,options:.prettyPrinted).write(to:output.appendingPathComponent("manifest.json"))}catch{print(error);exit(1)}
    print("PASS: \(scene), \(frames.count) frames");exit(0)
   }
   web.takeSnapshot(with:nil){image,error in
    guard let image=image,let data=image.tiffRepresentation,let bitmap=NSBitmapImageRep(data:data),let png=bitmap.representation(using:.png,properties:[:]) else{print("FAIL: snapshot \(String(describing:error))");exit(1)}
    let file=String(format:"%03d.png",step)
    do {try png.write(to:output.appendingPathComponent(file))}catch{print(error);exit(1)}
    frames.append(["file":file,"duration":info["duration"] ?? 1600]);print("Saved \(scene)/\(file)");fflush(stdout)
    step+=1;busy=false
   }
  }
 }
}
DispatchQueue.main.asyncAfter(deadline:.now()+90){print("FAIL: capture timeout; \(step) frames");exit(1)}
app.run()
