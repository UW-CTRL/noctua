// Run from the repository root: swift tests/note-references.swift
import Foundation
import JavaScriptCore
let js = JSContext()!
js.exceptionHandler = { _, error in print(error?.toString() ?? "JavaScript error"); exit(1) }
js.evaluateScript(try String(contentsOfFile: "web/latex.js", encoding: .utf8))
let notes = try String(contentsOfFile: "web/notes.js", encoding: .utf8)
let start = notes.range(of: "function followNoteReference(key)")!.lowerBound
let end = notes.range(of: "$('#notes-stage').addEventListener('click'", range: start..<notes.endIndex)!.lowerBound
js.evaluateScript(String(notes[start..<end]))
js.evaluateScript(#"""
function assert(ok, message) { if (!ok) throw Error(message); }
const katex = {renderToString:source=>'<span class="math">'+NoctuaLatex.esc(source)+'</span>'};
const html=NoctuaLatex.renderDoc([
  String.raw`See \ref{sec:intro}, \eqref{eq:first}, \ref{eq:second}, \ref{fig:one}, and \ref{thm:one}.`,
  String.raw`\section{Introduction}\label{sec:intro}
\begin{align}a&=b\label{eq:first}\\c&=d\label{eq:second}\end{align}
\begin{figure}\includegraphics{media/plot.png}\caption{Plot}\label{fig:one}\end{figure}
\begin{theorem}\label{thm:one}A statement.\end{theorem}`
], {image:path=>'/assets/'+path});
for(const key of ['sec:intro','eq:first','eq:second','fig:one','thm:one']) {
  assert(html[0].includes('data-tex-ref="'+key+'"'), 'forward reference not linked: '+key);
  assert(html[1].includes('data-tex-label="'+key+'"'), 'target missing: '+key);
}
assert(html[0].includes('data-tex-ref="eq:first">(1)</a>'), 'equation number or parentheses changed');
assert(html[0].includes('data-tex-ref="eq:second">2</a>'), 'align numbering changed');
const missing=NoctuaLatex.renderDoc([String.raw`\ref{missing} \ref{constructor}`])[0];
assert(!missing.includes('tex-ref') && missing.includes('??'), 'missing/prototype key became a link');
const escaped=NoctuaLatex.renderDoc([String.raw`\section{Safe}\label{x"<tag>}\ref{x"<tag>}`])[0];
assert(escaped.includes('data-tex-label="x&quot;&lt;tag&gt;"')&&!escaped.includes('<tag>'), 'label attribute injection');
let stopped=false, focused=false, scroll=null, reduced=false, notices=[];
const target={dataset:{texLabel:'eq:[first]'},setAttribute:(key,value)=>assert(key==='tabindex'&&value==='-1','focus target'),focus:options=>{focused=options.preventScroll},closest:()=>({scrollIntoView:options=>{scroll=options}})};
const $=()=>({querySelectorAll:()=>{assert(stopped,'lookup ran before edit finished');return [target]}});
const stopEdit=()=>{stopped=true};
const matchMedia=()=>({matches:reduced});
const toast=message=>notices.push(message);
followNoteReference('eq:[first]');
assert(focused&&scroll.block==='center'&&scroll.behavior==='smooth','reference did not focus and scroll to equation');
reduced=true; followNoteReference('eq:[first]');
assert(scroll.behavior==='instant','reduced motion ignored');
followNoteReference('missing'); assert(notices.length===1,'missing target not reported');
"""#)
print("PASS: forward references, equation/figure/theorem anchors, escaping, and reference navigation")
