// Run from the repository root: swift tests/youtube.swift
import Foundation
import JavaScriptCore
let js = JSContext()!
js.exceptionHandler = { _, error in print(error?.toString() ?? "JavaScript error"); exit(1) }
js.evaluateScript(try String(contentsOfFile: "web/latex.js", encoding: .utf8))
js.evaluateScript(#"""
function assert(ok, message) { if (!ok) throw Error(message); }
const render = source => NoctuaLatex.renderDoc([source])[0];
for (const link of [
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=share',
  'https://youtu.be/dQw4w9WgXcQ',
  'https://m.youtube.com/shorts/dQw4w9WgXcQ',
  'https://youtube.com/live/dQw4w9WgXcQ',
  'https://youtube.com/embed/dQw4w9WgXcQ'
]) {
  const html=render('Before\n'+link+'\nAfter');
  assert(html.includes('src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"'), 'valid link did not embed: '+link);
  assert(html.includes('Before') && html.includes('After'), 'surrounding text lost');
  assert(html.includes('Open on YouTube') && html.includes('referrerpolicy="strict-origin-when-cross-origin"'), 'fallback or referrer missing');
  assert(!html.includes('autoplay'), 'autoplay enabled');
}
assert(render('https://youtu.be/dQw4w9WgXcQ?t=1h2m3s').includes('?start=3723'), 'timestamp lost');
assert(render('https://youtube.com/watch?v=dQw4w9WgXcQ&start=90').includes('?start=90'), 'numeric timestamp lost');
for (const source of [
  'Text https://youtu.be/dQw4w9WgXcQ',
  'https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ',
  'https://evil.test/youtube.com/watch?v=dQw4w9WgXcQ',
  'https://youtube.com/watch?v=invalid',
  'javascript:alert(1)',
  '\\begin{verbatim}\nhttps://youtu.be/dQw4w9WgXcQ\n\\end{verbatim}',
  'https://youtu.be/dQw4w9WgXcQ"><script>alert(1)</script>'
]) assert(!render(source).includes('<iframe'), 'unsafe or non-standalone link embedded');
"""#)
print("PASS: YouTube URL formats, timestamps, surrounding text, fallback, and unsafe URLs")
