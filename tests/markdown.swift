// macOS: swift tests/markdown.swift
// Chat tables must survive streaming while preserving escaping, code and math.
import Foundation
import JavaScriptCore
let context = JSContext()!
context.exceptionHandler = { _, error in print(error?.toString() ?? "JavaScript error"); exit(1) }
let source = try String(contentsOfFile: "web/app.js", encoding: .utf8)
let start = source.range(of: "function extractMath(")!.lowerBound
let end = source.range(of: "function appendMsg(", range: start..<source.endIndex)!.lowerBound
let mocks = #"""
const esc = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const katex = {renderToString:(tex,options)=>'<span class="math">'+esc(tex)+'</span>'};
function assert(value,message){if(!value)throw Error(message);}
"""#
let checks = #"""
const text='Success rates from page 8 of the paper.\n\n| Environment | LeWM | PLDM | DINO-WM |\n| :--- | ---: | :---: | ---: |\n| Two-Room | 87% | 97% | **100%** |\n| Reacher | **86%** | 78% | 79% |\n\nSource: [page 8](pdf:paper#page=8)';
const html=renderMd(text);
assert(html.includes('<table>')&&html.includes('<thead>')&&html.includes('<tbody>'),'table structure missing');
assert((html.match(/<th scope="col"/g)||[]).length===4&&(html.match(/<td /g)||[]).length===8,'wrong row or column count');
assert(html.includes('text-align:right">87%')&&html.includes('text-align:center">97%'),'column alignment lost');
assert(html.includes('<b>100%</b>')&&html.includes('class="pdf-link"'),'inline formatting or source link lost');
assert(html.indexOf('<p>Success rates')<html.indexOf('<table>')&&html.indexOf('</table>')<html.indexOf('Source:'),'surrounding paragraphs lost');
const escaped=renderMd('Name | Value\n--- | ---\nA\\|B | `x|y`\nMath | $|z|$');
assert(escaped.includes('A|B')&&escaped.includes('<code>x|y</code>'),'escaped or code pipe split cells');
assert(escaped.includes('<span class="math">|z|</span>'),'math pipe was split or lost');
const ragged=renderMd('| A | B |\n| --- | --- |\n| one |\n| two | three | extra |');
assert((ragged.match(/<td /g)||[]).length===4&&!ragged.includes('extra'),'ragged rows were not padded/truncated');
assert(!renderMd('A | B\n--- | --- | ---\n1 | 2').includes('<table>'),'mismatched delimiter accepted');
assert(!renderMd('ordinary | prose').includes('<table>'),'ordinary pipe became a table');
const code=renderMd('```\n| A | B |\n| --- | --- |\n| 1 | 2 |\n```');
assert(code.includes('<pre><code>')&&!code.includes('<table>'),'code fence became a table');
const unsafe=renderMd('| A | B |\n| --- | --- |\n| <img src=x onerror=alert(1)> | [bad](javascript:alert) |');
assert(!unsafe.includes('<img')&&!unsafe.includes('href="javascript:'),'unsafe HTML or URL rendered');
assert(renderMd('# Heading\n\n- one\n- two\n\nparagraph').includes('<ul><li>one</li><li>two</li></ul>'),'existing blocks regressed');
const quote=renderMd('> Original **result**\n>\n> [page 8](pdf:paper#page=8)');
assert(quote.includes('<blockquote>')&&quote.includes('<b>result</b>')&&quote.includes('class="pdf-link"'),'quote formatting/source lost');
const details=renderMd('<details>\n<summary>Derivation</summary>\n\nStep $x^2$.\n\n<details>\n<summary>Nested</summary>\nMore\n</details>\n</details>\nAfter');
assert((details.match(/<details /g)||[]).length===2&&details.includes('<summary>Derivation</summary>')&&details.includes('<span class="math">x^2</span>')&&details.endsWith('<p>After</p>'),'collapsible content lost nesting, math, or following text');
const literal=renderMd('<details>\n<summary>Source</summary>\n```html\n</details>\n```\n</details>');
assert(literal.includes('&lt;/details&gt;')&&(literal.match(/<details /g)||[]).length===1,'literal closing tag ended details');
const tasks=renderMd('- [ ] Read the paper\n- [x] Find its PDF');
assert((tasks.match(/class="chat-task"/g)||[]).length===2&&tasks.includes('disabled checked'),'checklist status lost');
assert(renderMd('```python\nprint("hello")\n```').includes('class="chat-copy"'),'code copy control missing');
assert(renderMd('```mermaid\nflowchart LR\nA-->B\n```').includes('data-diagram'),'completed diagram missing');
assert(!renderMd('```mermaid\nflowchart LR\nA-->').includes('data-diagram'),'unfinished diagram rendered');
assert(!renderMd('<details onclick="alert(1)">\n<script>alert(1)</script>').includes('<script>'),'unsafe details attributes or HTML rendered');
for(const sample of ['<details>\n<summary>Proof</summary>\n$x^2$\n</details>','> Quote\n> More','```python\nprint(1)\n```']) {
  for(let i=1;i<=sample.length;i++) {
    const partial=renderMd(sample.slice(0,i));
    assert((partial.match(/<details /g)||[]).length===(partial.match(/<\/details>/g)||[]).length,'streaming details unbalanced');
    assert((partial.match(/<pre>/g)||[]).length===(partial.match(/<\/pre>/g)||[]).length,'streaming code unbalanced');
  }
}
for(let i=1;i<=text.length;i++){const partial=renderMd(text.slice(0,i));assert((partial.match(/<table>/g)||[]).length===(partial.match(/<\/table>/g)||[]).length,'streaming left an unclosed table');}
globalThis.result='PASS: chat tables, alignment, inline markup, math, escaped pipes, ragged rows, code fences, HTML safety and streaming';
"""#
context.evaluateScript(mocks + String(source[start..<end]) + checks)
print(context.objectForKeyedSubscript("result").toString() ?? "FAIL: no result")
