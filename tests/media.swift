// Run from the repository root: swift tests/media.swift
import Foundation
import JavaScriptCore
let js = JSContext()!
var failed = false
js.exceptionHandler = { _, e in print(e?.toString() ?? "JS error"); failed = true }
let figures = try String(contentsOfFile: "web/figures.js", encoding: .utf8)
js.evaluateScript(String(figures.prefix(upTo: figures.range(of: "// ---------------------------------------------------------------- editor UI")!.lowerBound)))
js.evaluateScript(try String(contentsOfFile: "web/latex.js", encoding: .utf8))
js.evaluateScript(#"""
function assert(ok, why) { if (!ok) throw new Error(why); }
const image = {path:'media/photo.png', command:'includegraphics', caption:'Image', label:'fig:image'};
const video = {path:'media/movie.mp4', command:'includevideo', caption:'Movie', label:'fig:movie'};
let src = figureSrc(newFigure([video]));
assert(src.includes('\\includevideo[width=0.6\\textwidth]'), 'single video command');
src = setImageWidth(src, 0, .8);
assert(src.includes('width=0.8\\textwidth'), 'resize video');
let fig = parseFigure(src, figureSpans(src)[0]);
addFigureItems(fig, [image]);
src = figureSrc(fig);
assert(src.includes('\\includevideo') && src.includes('\\includegraphics'), 'mixed commands retained');
assert(imageOffsets(src).length === 2, 'mixed selection indices');
src = setImageWidth(src, 0, .33);
fig = parseFigure(src, figureSpans(src)[0]);
assert(fig.items[0].width === .33 && fig.items[0].command === 'includevideo', 'resize mixed subfigure');
const html = NoctuaLatex.renderDoc([src], {image:p=>'/assets/'+p})[0];
assert(html.includes('<video ') && html.includes('controls playsinline preload="metadata"') && html.includes('<img '), 'mixed renderer');
assert(html.includes('data-img="0"') && html.includes('data-img="1"'), 'matching rendered selection indices');
assert(!html.includes('autoplay'), 'no autoplay');
src = removeImage(src, 1);
assert(src.includes('\\includevideo') && !src.includes('\\includegraphics') && !src.includes('subfigure'), 'remove image keeps video');
assert(removeImage(src,0).trim() === '', 'remove last video');
assert(setImageWidth('\\includevideo{media/movie.mp4}',0,.4) === '\\includevideo[width=0.4\\textwidth]{media/movie.mp4}', 'bare video resize');
assert(removeImage('a \\includevideo{media/movie.mp4} b',0) === 'a  b', 'bare video removal');
assert(imageOffsets('% \\includevideo{ignored}\n\\includegraphics{images/old.png}').length === 1, 'comments ignored');
const legacy = NoctuaLatex.renderDoc(['\\includegraphics{images/old.png}'], {image:p=>p})[0];
assert(legacy.includes('<img '), 'legacy images');
"""#)
if failed { exit(1) }
print("PASS: mixed media rendering, commands, resizing, removal, and legacy images")
