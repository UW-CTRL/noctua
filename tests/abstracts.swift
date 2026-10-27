import Foundation
import JavaScriptCore
let c=JSContext()!
c.exceptionHandler={_,e in print(e?.toString() ?? "JS error");exit(1)}
let source=try String(contentsOfFile:"web/app.js",encoding:.utf8)
let start=source.range(of:"function abstractHTML(")!.lowerBound
let end=source.range(of:"function renderDetails()",range:start..<source.endIndex)!.lowerBound
let code=#"""
const esc=s=>String(s).replace(/</g,'&lt;');
function assert(v,m){if(!v)throw Error(m);}
assert(abstractHTML({abstract:'<remote>'}).includes('&lt;remote>'),'remote abstract missing or unescaped');
assert(abstractHTML({}).includes('No abstract available'),'missing remote abstract');
assert(abstractHTML({abstractNote:'Local'},true).includes('Local'),'saved abstract missing');
assert(abstractHTML({},true).includes('No abstract saved'),'missing local abstract');
"""#
c.evaluateScript(String(source[start..<end])+code)
print("PASS: available and missing abstracts render without a lookup")
