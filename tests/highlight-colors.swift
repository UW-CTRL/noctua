// macOS: swift tests/highlight-colors.swift
import Foundation
import JavaScriptCore
let context=JSContext()!
context.exceptionHandler={_,error in print(error?.toString() ?? "JS error");exit(1)}
let pdf=try String(contentsOfFile:"web/pdf.js",encoding:.utf8)
let setup=try String(contentsOfFile:"web/setup.js",encoding:.utf8)
let palette=String(pdf[pdf.range(of:"const pdfCategories=")!.lowerBound..<pdf.range(of:"const pdfAutoHighlights=")!.lowerBound])
let helpers=String(setup[setup.range(of:"function highlightColorOptions(")!.lowerBound..<setup.range(of:"function appearanceSection()")!.lowerBound])
let start=setup.range(of:"card.addEventListener('change', async (e) => {")!.upperBound
let end=setup.range(of:"\n  });",range:start..<setup.endIndex)!.lowerBound
context.evaluateScript(#"""
const nodes=new Map(),hex=new Map(),controls=[];
const group={querySelectorAll:()=>controls},section={querySelectorAll:()=>controls};
const $=selector=>nodes.get(selector)||null;
const document={querySelector:selector=>hex.get(selector)||null,querySelectorAll:()=>[]};
const existing={author:'user',kind:'highlight',color:'#ff6666'},existingAI={author:'assistant',kind:'highlight',category:'method',color:'#5fb236'},PDF={key:'paper',annotations:[existing,existingAI]};let legends=0,filterColor='';
function updatePDFAnnotationControls(){filterColor=pdfCategories.method.color;}
function updatePDFAutoHighlightUI(){legends++;}
const settings={highlight_palette:['#456def','#234bcd','#abcdef','#6789ab','#345cde','#123abc'],highlight_colors:{novelty:'#123abc',method:'#234bcd',results:'#345cde',limitations:'#456def'}};
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
let fail=false,message='',calls=[];
function msg(section,text){message=text;}
async function api(path,patch){calls.push({path,patch});if(fail)throw Error('disk full');if(path.endsWith('highlight-palette')){const old=settings.highlight_palette;return {highlight_palette:patch.colors,highlight_colors:Object.fromEntries(Object.entries(settings.highlight_colors).map(([key,color])=>[key,patch.colors[old.indexOf(color)]]))};}return {highlight_palette:settings.highlight_palette,highlight_colors:{...settings.highlight_colors,...patch}};}
function assert(v,m){if(!v)throw Error(m);}
"""#+palette+helpers+"\nasync function change(e){"+String(setup[start..<end])+"\n}")
context.evaluateScript(#"""
(async()=>{
 for(const key of Object.keys(pdfCategories)){
  const input={value:settings.highlight_colors[key],dataset:{highlightColor:key},disabled:false,closest:s=>s==='section'?section:group};
  nodes.set('#setup-highlight-'+key,input);controls.push(input);hex.set('[data-highlight-hex="'+key+'"]',{textContent:''});
 }
 applyPDFHighlightColors(settings.highlight_colors,settings.highlight_palette);
 const html=highlightColorSettings();assert((html.match(/type="color"/g)||[]).length===6,'palette needs exactly six color pickers');assert((html.match(/<summary /g)||[]).length===4&&(html.match(/data-highlight-color=/g)||[]).length===24&&!html.includes('<select'),'AI categories need round triggers and six palette swatches each');
 assert(html.includes('>Highlight colors</h3>')&&html.includes('settings-highlight-rows')&&!html.includes('<code')&&!html.includes('<p')&&!html.includes('Reset palette'),'palette needs a small heading and shared row width without hex labels, descriptions or reset text');
 applyPDFHighlightColors(settings.highlight_colors);
 const novelty=$('#setup-highlight-novelty');novelty.value='#abcdef';await change({target:novelty});
 assert(calls[0].path==='/api/settings/highlight-colors'&&Object.keys(calls[0].patch).length===1,'save must update only the changed category');
 assert(settings.highlight_colors.novelty==='#abcdef'&&pdfCategories.novelty.color==='#abcdef','custom color not applied');
 assert(pdfCategories.method.color==='#234bcd'&&existing.color==='#ff6666','saving defaults changed another category or existing highlight');
 fail=true;novelty.value='#eeeeee';await change({target:novelty});
 assert(message==='disk full'&&novelty.value==='#abcdef'&&controls.every(c=>!c.disabled),'failed save did not restore saved values and unlock controls');
 fail=false;const changed=[...pdfColors];changed[1]='#112233';await saveHighlightPalette(changed);
 assert(pdfColors[1]==='#112233'&&pdfCategories.method.color==='#112233'&&existingAI.color==='#112233'&&filterColor==='#112233','editing a palette slot must remap existing AI highlights and filter colors immediately');
 assert($('#setup-highlight-method').innerHTML.includes('#112233')&&!$('#setup-highlight-method').innerHTML.includes('#234bcd'),'AI dropdown options did not track the palette');
 await saveHighlightPalette([...pdfDefaultColors]);await saveHighlightColors(pdfDefaultCategoryColors);
 assert(pdfCategories.novelty.color==='#ff6666'&&pdfCategories.method.color==='#5fb236'&&pdfCategories.results.color==='#a28ae5'&&pdfCategories.limitations.color==='#ffd400','reset did not restore all four defaults');
 applyPDFHighlightColors({novelty:'invalid'});assert(pdfCategories.novelty.color==='#ff6666','invalid persisted color needs a safe fallback');
 globalThis.result='PASS: horizontal palette swatches, round AI palette pickers, slot remapping, per-category saves, unchanged user highlights, error recovery and default colors';
})().catch(e=>globalThis.result='FAIL: '+e.stack);
"""#)
let deadline=Date().addingTimeInterval(5)
while context.objectForKeyedSubscript("result").isUndefined&&Date()<deadline {RunLoop.current.run(until:Date().addingTimeInterval(0.01))}
let result=context.objectForKeyedSubscript("result").toString() ?? "FAIL: timeout"
print(result);if !result.hasPrefix("PASS:"){exit(1)}
