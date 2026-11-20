'use strict';
// Paper files use real TeX. Note cells continue to use the lightweight renderer.
const Paper={generation:0,pollSerial:0,loadSerial:0,editVersion:0,target:null,timer:null,poll:null,doc:null,observer:null,tasks:new Set(),scale:1,fit:true,views:new Map(),loaded:null,requested:null,current:null,busy:false};
const projectPaperURL=target=>`/api/workspaces/${enc(target)}/paper`;
const paperAuto=()=>W.manifest?.paper?.auto_compile??(store.get('noctua.paper.auto')!=='false');
const paperCompiler=()=>W.manifest?.paper?.compiler||'tectonic';
const paperCompilerLabel=()=>paperCompiler()==='pdflatex'?'pdfLaTeX':'Tectonic';
async function showPaperSettings(){
 const target=W.target;if(!target)return;
 const main=paperMain(),files=(W.manifest?.entries||[]).filter(e=>e.kind==='file'&&!e.deleted&&/\.tex$/i.test(e.name));
 const bibs=(W.manifest?.entries||[]).filter(e=>e.kind==='file'&&!e.deleted&&/\.bib$/i.test(e.name)),selection=W.manifest?.paper?.bibliographies;
 const d=workspaceDialog('Project LaTeX settings',`<form><p>These settings apply only to this collection/project.</p><label>Compiler <select data-latex-compiler><option value="tectonic">Tectonic (XeLaTeX)</option><option value="pdflatex">pdfLaTeX</option></select></label><p data-compiler-info role="status">Checking bundled compilers…</p><label>Main document <select data-latex-main><option value="">Choose a .tex file</option>${files.map(e=>`<option value="${esc(e.id)}">${esc(paperPath(e))}</option>`).join('')}</select></label><p>Build paths are relative to the main document’s folder. Only files in that folder and its subfolders are included, including selected bibliographies.</p><label>Bibliographies <select data-latex-bib-mode><option value="all">All in main document directory</option><option value="selected">Selected files</option></select></label><fieldset data-latex-bib-files><legend>Bibliography files</legend>${bibs.map(e=>`<label><input type="checkbox" data-latex-bib value="${esc(e.id)}" ${!Array.isArray(selection)||selection.includes(e.id)?'checked':''}> ${esc(paperPath(e))}</label>`).join('')||'<p>No .bib files in this project.</p>'}</fieldset><label><input type="checkbox" data-latex-auto ${paperAuto()?'checked':''}> Compile automatically after edits</label><p>Both compilers are included with Noctua. Choose pdfLaTeX for templates designed for Overleaf’s default compiler. Output also depends on package versions and fonts.</p><p class="workspace-error" data-error role="alert"></p></form>`);
 const bibMode=d.querySelector('[data-latex-bib-mode]');bibMode.value=Array.isArray(selection)?'selected':'all';const showBibs=()=>{d.querySelector('[data-latex-bib-files]').hidden=bibMode.value==='all';};bibMode.onchange=showBibs;showBibs();
 const select=d.querySelector('[data-latex-compiler]');select.value=paperCompiler();d.querySelector('[data-latex-main]').value=main?.id||'';
 let available=[];const info=()=>{const engine=available.find(e=>e.id===select.value);d.querySelector('[data-compiler-info]').textContent=engine?(engine.available?`Bundled ${engine.version}`:engine.error):'Compiler information unavailable';};select.onchange=info;
 api('/api/paper-compilers').then(r=>{available=r.compilers||[];if(d.isConnected)info();}).catch(e=>{if(d.isConnected)d.querySelector('[data-compiler-info]').textContent=e.message;});
 const form=d.querySelector('form'),close=d.querySelector('[data-close]');
 const settings=()=>{const paper={compiler:select.value,auto_compile:d.querySelector('[data-latex-auto]').checked,bibliographies:bibMode.value==='all'?'all':[...d.querySelectorAll('[data-latex-bib]:checked')].map(e=>e.value)},id=d.querySelector('[data-latex-main]').value;if(id)paper.main_file=id;return paper;};
 const initial=JSON.stringify(settings());let saving=false;
 const saveAndClose=async()=>{
  if(saving)return;
  if(JSON.stringify(settings())===initial){d.close();return;}
  const paper=settings();saving=true;close.disabled=true;form.inert=true;d.setAttribute('aria-busy','true');d.querySelector('[data-error]').textContent='';
  try{
   if(W.target!==target)throw Error('Project changed. Reopen settings for the current project.');
   await workspaceChange({op:'config',paper});
   await api(projectPaperURL(target)+'/cancel',{});
   if(W.target===target)await refreshWorkspaceView(target);
   d.close();
  }catch(err){d.querySelector('[data-error]').textContent=err.message;}
  finally{saving=false;close.disabled=false;form.inert=false;d.removeAttribute('aria-busy');}
 };
 close.title=close.ariaLabel='Save and close';close.onclick=saveAndClose;
 d.addEventListener('cancel',event=>{event.preventDefault();saveAndClose();});
 form.onsubmit=event=>{event.preventDefault();saveAndClose();};
}
function paperMain(){return W.manifest?.entries.find(e=>e.id===W.manifest?.paper?.main_file&&!e.deleted);}
function paperPath(entry){const parts=[entry.name],seen=new Set();let parent=entry.parent;while(parent&&!seen.has(parent)){seen.add(parent);const folder=W.manifest.entries.find(e=>e.id===parent);if(!folder)break;parts.unshift(folder.name);parent=folder.parent;}return parts.join('/');}
function paperBuildPath(entry){
 const main=paperMain(),path=paperPath(entry),mainPath=main?paperPath(main):'';
 const prefix=mainPath.includes('/')?mainPath.slice(0,mainPath.lastIndexOf('/')+1):'';
 return path.startsWith(prefix)?path.slice(prefix.length):null;
}

function paperUnmount(){
 Paper.colors?.destroy();Paper.colors=null;
 Paper.sourceMarkers?.destroy();Paper.sourceMarkers=null;
 Paper.labelFiles?.clear();
 Paper.completionCleanup?.();Paper.completionCleanup=null;
 const pane=$('#paper-pages');if(pane&&Paper.target)Paper.views.set(Paper.target,{scroll:pane.scrollTop,scale:Paper.scale,fit:Paper.fit,width:$('#paper-split')?.style.getPropertyValue('--paper-source-width')||'50%'});
 if(Paper.resizeEnd)window.removeEventListener('noctua-pane-resize-end',Paper.resizeEnd);Paper.resizeEnd=null;Paper.resizeObserver?.disconnect();clearTimeout(Paper.resizeTimer);
 Paper.generation++;clearTimeout(Paper.timer);clearTimeout(Paper.poll);Paper.observer?.disconnect();Paper.observer=null;
 for(const task of Paper.tasks)task.cancel();Paper.tasks.clear();Paper.doc?.destroy();Paper.doc=null;Paper.target=null;Paper.loaded=null;Paper.displayed=null;Paper.requested=null;Paper.current=null;Paper.busy=false;
}
async function setPaperMain(id){await workspaceChange({op:'config',paper:{main_file:id}});await openWorkspaceFile(id);}
// A small, offline catalog: suggestions do not imply that a package is loaded.
const PAPER_TEX_COMMANDS=[
 ['documentclass','documentclass{¦}','Document class'],['usepackage','usepackage{¦}','Load package'],
 ['title','title{¦}','Document title'],['author','author{¦}','Author'],['date','date{¦}','Date'],['maketitle','maketitle','Print title'],['tableofcontents','tableofcontents','Table of contents'],
 ['part','part{¦}','Part'],['chapter','chapter{¦}','Chapter (book/report)'],['section','section{¦}','Section'],['subsection','subsection{¦}','Subsection'],['subsubsection','subsubsection{¦}','Subsubsection'],['paragraph','paragraph{¦}','Paragraph heading'],
 ['textbf','textbf{¦}','Bold text'],['textit','textit{¦}','Italic text'],['texttt','texttt{¦}','Monospace text'],['emph','emph{¦}','Emphasis'],['underline','underline{¦}','Underline'],['footnote','footnote{¦}','Footnote'],['href','href{¦}{}','Link (hyperref)'],['url','url{¦}','URL (hyperref)'],
 ['label','label{¦}','Label'],['ref','ref{¦}','Cross-reference'],['eqref','eqref{¦}','Equation reference (amsmath)'],['pageref','pageref{¦}','Page reference'],['cite','cite{¦}','Citation'],['citep','citep{¦}','Parenthetical citation (natbib)'],['citet','citet{¦}','Textual citation (natbib)'],['bibliography','bibliography{¦}','Bibliography files'],['bibliographystyle','bibliographystyle{¦}','Bibliography style'],
 ['item','item ¦','List item'],['caption','caption{¦}','Caption'],['includegraphics','includegraphics[width=\\linewidth]{¦}','Image (graphicx)'],['input','input{¦}','Include source'],['include','include{¦}','Include chapter'],['newcommand','newcommand{\\¦}{}','Define command'],['renewcommand','renewcommand{\\¦}{}','Redefine command'],['newtheorem','newtheorem{¦}{}','Theorem environment'],['newpage','newpage','Page break'],['clearpage','clearpage','Flush floats and break page'],['noindent','noindent','No paragraph indent'],['hspace','hspace{¦}','Horizontal space'],['vspace','vspace{¦}','Vertical space'],
 ['frac','frac{¦}{}','Fraction'],['dfrac','dfrac{¦}{}','Display fraction (amsmath)'],['tfrac','tfrac{¦}{}','Inline fraction (amsmath)'],['sqrt','sqrt{¦}','Square root'],['sum','sum_{¦}^{}','Sum'],['prod','prod_{¦}^{}','Product'],['int','int_{¦}^{}','Integral'],['lim','lim_{¦}','Limit'],['binom','binom{¦}{}','Binomial coefficient (amsmath)'],['left','left(¦\\right)','Paired delimiters'],
 ['text','text{¦}','Text in math (amsmath)'],['mathrm','mathrm{¦}','Upright math'],['mathbf','mathbf{¦}','Bold math'],['mathbb','mathbb{¦}','Blackboard bold (amsfonts)'],['mathcal','mathcal{¦}','Calligraphic math'],['operatorname','operatorname{¦}','Math operator (amsmath)'],['overset','overset{¦}{}','Symbol above (amsmath)'],['underset','underset{¦}{}','Symbol below (amsmath)'],
 ...['alpha','beta','gamma','delta','epsilon','varepsilon','zeta','eta','theta','vartheta','iota','kappa','lambda','mu','nu','xi','pi','rho','sigma','tau','upsilon','phi','varphi','chi','psi','omega','Gamma','Delta','Theta','Lambda','Xi','Pi','Sigma','Upsilon','Phi','Psi','Omega'].map(name=>[name,name,'Greek letter']),
 ...['infty','partial','nabla','forall','exists','in','notin','subset','subseteq','supseteq','cup','cap','emptyset','times','cdot','pm','mp','leq','geq','neq','approx','equiv','to','rightarrow','leftarrow','Rightarrow','Leftarrow','Leftrightarrow','mapsto','ldots','cdots','vdots','ddots','sin','cos','tan','log','ln','exp','min','max','det'].map(name=>[name,name,'Math symbol or operator']),
 ...['hat','widehat','bar','overline','vec','dot','ddot','tilde','widetilde','underbrace','overbrace'].map(name=>[name,name+'{¦}','Math accent or brace'])
];
const PAPER_TEX_ENVIRONMENTS=['document','abstract','equation','equation*','align','align*','gather','gather*','multline','split','aligned','cases','matrix','pmatrix','bmatrix','itemize','enumerate','description','figure','table','tabular','center','quote','verbatim','theorem','lemma','proof'];
const PAPER_TEX_CLASSES=[
 ['article','Articles and short documents'],['report','Reports and theses'],['book','Books'],['letter','Letters'],['slides','Basic slides'],['minimal','Minimal document'],
 ['beamer','Presentation slides'],['scrartcl','KOMA-Script article'],['scrreprt','KOMA-Script report'],['scrbook','KOMA-Script book'],['scrlttr2','KOMA-Script letter'],['memoir','Books and long documents'],
 ['amsart','AMS mathematics article'],['amsproc','AMS proceedings'],['amsbook','AMS mathematics book'],['IEEEtran','IEEE papers'],['acmart','ACM papers'],['elsarticle','Elsevier articles'],['revtex4-2','APS and AIP papers'],['llncs','Springer computer science proceedings'],
 ['standalone','Standalone figures'],['exam','Exams and question sheets'],['extarticle','Article with additional font sizes'],['extreport','Report with additional font sizes'],['extbook','Book with additional font sizes']
];
// Common packages, complemented by live .sty files from the current project.
const PAPER_TEX_PACKAGES=[
 ['amsmath','Math environments'],['amssymb','Math symbols'],['amsfonts','Math fonts'],['amsthm','Theorems and proofs'],['mathtools','Extended math tools'],['bm','Bold math'],['mathrsfs','Script math font'],['dsfont','Double-stroke font'],['cancel','Cancel math terms'],['empheq','Grouped equations'],['cases','Numbered equation cases'],['physics','Physics notation'],['siunitx','Units and numbers'],['xfrac','Split fractions'],
 ['graphicx','Images'],['graphics','Basic graphics'],['xcolor','Colors'],['tikz','Vector diagrams'],['pgfplots','Plots'],['adjustbox','Resize and trim boxes'],['pdfpages','Include PDF pages'],['wrapfig','Wrap text around figures'],['subcaption','Subfigure captions'],['subfig','Subfigures'],['caption','Caption formatting'],['float','Float placement'],['placeins','Float barriers'],['rotating','Rotated floats'],
 ['booktabs','Table rules'],['array','Table columns'],['tabularx','Flexible-width tables'],['longtable','Multipage tables'],['multirow','Merged table rows'],['makecell','Table cell formatting'],['colortbl','Colored tables'],['threeparttable','Table notes'],['dcolumn','Decimal-aligned columns'],
 ['geometry','Page margins'],['fullpage','Page layout'],['fancyhdr','Headers and footers'],['lastpage','Last-page reference'],['setspace','Line spacing'],['parskip','Paragraph spacing'],['titlesec','Section headings'],['sectsty','Section styles'],['titling','Title formatting'],['enumitem','List formatting'],['multicol','Multiple columns'],['changepage','Adjust page layout'],['pdflscape','Landscape pages'],['microtype','Typography'],['ragged2e','Text alignment'],['needspace','Keep content together'],
 ['hyperref','Links and PDF metadata'],['cleveref','Automatic reference names'],['url','URL formatting'],['natbib','Author-year and numeric citations'],['cite','Numeric citation formatting'],['csquotes','Quotation formatting'],['babel','Language support'],['polyglossia','Languages (XeLaTeX)'],['kotex','Korean text'],['inputenc','Input encoding'],['fontenc','Font encoding'],['fontspec','System fonts (XeLaTeX)'],['unicode-math','Unicode math (XeLaTeX)'],['lmodern','Latin Modern fonts'],['newtxtext','Times-style text'],['newtxmath','Times-style math'],['textcomp','Text symbols'],['upquote','Verbatim quotation marks'],
 ['listings','Source code listings'],['fancyvrb','Verbatim formatting'],['fvextra','Extended verbatim'],['algorithm','Algorithm floats'],['algorithmic','Algorithm pseudocode'],['algorithmicx','Pseudocode framework'],['algpseudocode','Pseudocode notation'],['algorithm2e','Algorithms'],['tcolorbox','Colored boxes'],['mdframed','Framed environments'],['framed','Text frames'],
 ['subfiles','Subdocuments'],['import','Import source paths'],['standalone','Standalone figures'],['appendix','Appendices'],['etoolbox','Programming helpers'],['xparse','Command definitions'],['xspace','Command spacing'],['iftex','Compiler detection'],['calc','Length arithmetic'],['comment','Comment environments'],['verbatim','Verbatim text'],['accsupp','PDF accessibility'],['transparent','Transparency']
];
function paperTexContext(source){
 const end=source.selectionStart;if(end!==source.selectionEnd)return null;
 const before=source.value.slice(0,end),line=before.slice(before.lastIndexOf('\n')+1);
 if(/(^|[^\\])(?:\\\\)*%/.test(line))return null;
 const documentClass=/\\(?:documentclass|LoadClass|LoadClassWithOptions)\s*(?:\[[^\]]*\]\s*)?\{([^{}]*)$/.exec(before);
 if(documentClass){
  let slashes=0;for(let i=documentClass.index-1;i>=0&&before[i]==='\\';i--)slashes++;
  if(slashes%2)return null;
  const token=documentClass[1],leading=token.length-token.trimStart().length;
  return {start:end-token.length+leading,end,anchor:documentClass.index,query:token.trim(),documentClass:true};
 }
 const packages=/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\]\s*)?\{([^{}]*)$/.exec(before);
 if(packages){
  let slashes=0;for(let i=packages.index-1;i>=0&&before[i]==='\\';i--)slashes++;
  if(slashes%2)return null;
  const tokens=packages[1].split(','),token=tokens.pop(),leading=token.length-token.trimStart().length;
  const after=source.value.slice(end).split('}')[0].split(',').slice(1);
  return {start:end-token.length+leading,end,anchor:packages.index,query:token.trim(),packages:true,selectedPackages:[...tokens,...after].map(name=>name.trim())};
 }
 const file=/\\(input|include|subfile|includegraphics)\*?\s*(?:\[[^\]]*\]\s*)?\{([^{}]*)$/.exec(before);
 if(file){
  let slashes=0;for(let i=file.index-1;i>=0&&before[i]==='\\';i--)slashes++;
  if(slashes%2)return null;
  const token=file[2],leading=token.length-token.trimStart().length;
  return {start:end-token.length+leading,end,anchor:file.index,query:token.trim(),fileCommand:file[1]};
 }
 const reference=/\\(?:eqref|ref|pageref|autoref)\*?\s*\{([^{}]*)$/.exec(before);
 if(reference){
  let slashes=0;for(let i=reference.index-1;i>=0&&before[i]==='\\';i--)slashes++;
  if(slashes%2)return null;
  const token=reference[1],leading=token.length-token.trimStart().length;
  return {start:end-token.length+leading,end,anchor:reference.index,query:token.trim(),reference:true};
 }
 const cite=/\\cite[a-zA-Z]*\*?(?:\[[^\]]*\])*\{([^{}]*)$/.exec(before);
 if(cite){
  let slashes=0;for(let i=cite.index-1;i>=0&&before[i]==='\\';i--)slashes++;
  if(slashes%2)return null;
  const token=cite[1].split(',').pop(),leading=token.length-token.trimStart().length;
  return {start:end-token.length+leading,end,anchor:cite.index,query:token.trim(),citation:true};
 }
 const match=/\\(?:begin\{([a-zA-Z*]*)|([a-zA-Z]*))$/.exec(before);if(!match)return null;
 const start=match.index;let slashes=0;for(let i=start-1;i>=0&&before[i]==='\\';i--)slashes++;
 if(slashes%2)return null; // A line break (\\) is not a command prefix.
 return {start,end,query:match[1]??match[2],environment:match[1]!==undefined};
}
function paperClassSuggestions(context){
 const classes=new Map(PAPER_TEX_CLASSES.map(([name,description])=>[name,[name,name,description]]));
 for(const entry of W.manifest?.entries||[]){
  if(entry.kind!=='file'||entry.deleted||!/\.cls$/i.test(entry.name))continue;
  const path=paperBuildPath(entry);if(path===null)continue;const name=path.replace(/\.cls$/i,'');classes.set(name,[name,name,'Project class']);
 }
 const q=context.query.toLowerCase();
 return [...classes.values()].filter(item=>!q||item[0].toLowerCase().includes(q)).sort((a,b)=>a[0].localeCompare(b[0])).slice(0,50);
}
function paperPackageSuggestions(context){
 const packages=new Map(PAPER_TEX_PACKAGES.map(([name,description])=>[name,[name,name,description]]));
 for(const entry of W.manifest?.entries||[]){
  if(entry.kind!=='file'||entry.deleted||!/\.sty$/i.test(entry.name))continue;
  const path=paperBuildPath(entry);if(path===null)continue;const name=path.replace(/\.sty$/i,'');packages.set(name,[name,name,'Project package']);
 }
 const q=context.query.toLowerCase(),selected=new Set(context.selectedPackages);
 return [...packages.values()].filter(item=>!selected.has(item[0])&&(!q||item[0].toLowerCase().includes(q))).sort((a,b)=>a[0].localeCompare(b[0])).slice(0,50);
}
function paperFileSuggestions(context){
 const graphics=context.fileCommand==='includegraphics',q=context.query.toLowerCase().replace(/^\.\//,'');
 const extensions=graphics?/\.(pdf|png|jpe?g|eps|ps|mps)$/i:context.fileCommand==='input'?/\.(tex|txt|tikz|pgf|def|sty|cls)$/i:/\.tex$/i;
 return (W.manifest?.entries||[]).filter(entry=>entry.kind==='file'&&!entry.deleted&&extensions.test(entry.name)&&paperBuildPath(entry)!==null)
  .map(entry=>{const path=paperBuildPath(entry),insert=context.fileCommand==='include'?path.replace(/\.tex$/i,''):path;return [path,insert,graphics?'Image':/\.tex$/i.test(path)?'TeX source':'Text source'];})
  .filter(item=>!q||item[0].toLowerCase().includes(q))
  .sort((a,b)=>a[0].localeCompare(b[0])).slice(0,50);
}
// Literal labels from the working source and its main document's include tree.
function paperLabelSource(text){
 return text.replace(/\\begin\{(verbatim\*?|Verbatim|lstlisting|minted)\}[\s\S]*?\\end\{\1\}/g,match=>match.replace(/[^\n]/g,' '))
  .replace(/\\verb\*?([^\sA-Za-z])(?:(?!\1)[^\n])*\1/g,match=>match.replace(/[^\n]/g,' '))
  .replace(/(^|[^\\])((?:\\\\)*)%[^\n]*/gm,(_,prefix,pairs)=>prefix+pairs);
}
async function paperLabels(source){
 const target=W.target,current=W.file,entries=(W.manifest?.entries||[]).filter(e=>e.kind==='file'&&!e.deleted&&/\.tex$/i.test(e.name)&&paperBuildPath(e)!==null);
 const paths=new Map(entries.map(e=>[e.id,paperBuildPath(e)])),byPath=new Map(entries.map(e=>[paperBuildPath(e),e]));
 const revision=W.manifest?.revision,main=W.manifest?.paper?.main_file,queue=[...new Set([current,main].filter(id=>paths.has(id)))],seen=new Set(),labels=new Map(),errors=[];
 const working=source.value,cache=Paper.labelFiles??=new Map();
 const normalize=path=>{const parts=[];for(const part of path.split('/')){if(part==='..')parts.pop();else if(part&&part!=='.')parts.push(part);}return parts.join('/');};
 while(queue.length){
  const batch=[...new Set(queue.splice(0))].filter(id=>!seen.has(id));batch.forEach(id=>seen.add(id));
  const files=await Promise.all(batch.map(async id=>{
   const entry=entries.find(e=>e.id===id),path=paths.get(id);
   if(id===current)return {path,text:working};
   const stamp=JSON.stringify([target,id,entry.blob??revision]);let request=cache.get(stamp);
   if(!request){request=api('/api/workspaces/'+enc(target)+'/files/'+enc(id));cache.set(stamp,request);}
   try{const result=await request;return {path,text:result.text||''};}catch(error){cache.delete(stamp);errors.push(path+': '+error.message);return {path,text:''};}
  }));
  for(const file of files){
   const text=paperLabelSource(file.text);
   for(const match of text.matchAll(/\\label\s*\{([^{}\\\s#]+)\}/g)){
    let slashes=0;for(let i=match.index-1;i>=0&&text[i]==='\\';i--)slashes++;if(slashes%2)continue;
    const key=match[1],line=text.slice(0,match.index).split('\n').length;
    if(!labels.has(key))labels.set(key,{key,file:file.path,line});
   }
   for(const match of text.matchAll(/\\(?:input|include|subfile)\s*\{([^{}\\]+)\}/g)){
    let slashes=0;for(let i=match.index-1;i>=0&&text[i]==='\\';i--)slashes++;if(slashes%2)continue;
    const name=match[1].trim(),path=/\.tex$/i.test(name)?name:name+'.tex',parent=file.path.includes('/')?file.path.slice(0,file.path.lastIndexOf('/')+1):'';
    const child=byPath.get(normalize(path))||byPath.get(normalize(parent+path));
    if(child&&!seen.has(child.id))queue.push(child.id);
   }
  }
 }
 return {entries:[...labels.values()].sort((a,b)=>a.key.localeCompare(b.key)),errors};
}
function paperTexSuggestions(source,context){
 const q=context.query.toLowerCase(),environments=PAPER_TEX_ENVIRONMENTS.map(name=>['begin{'+name+'}','begin{'+name+'}\n¦\n\\end{'+name+'}','Environment']);
 if(context.environment)return environments.filter(item=>item[0].slice(6).toLowerCase().startsWith(q));
 const commands=[...PAPER_TEX_COMMANDS,['begin','begin{¦}\n\\end{}','Begin environment'],['end','end{¦}','End environment']];
 const seen=new Set(commands.map(item=>item[0]));
 for(const match of source.value.matchAll(/\\(?:newcommand|renewcommand|providecommand|DeclareMathOperator)\*?\s*\{?\\([A-Za-z]+)\}?\s*(?:\[(\d)\])?/g)){
  const name=match[1];if(seen.has(name))continue;seen.add(name);const count=Number(match[2]||0);
  commands.push([name,name+(count?'{¦}'+'{}'.repeat(count-1):''),'Defined in this file']);
 }
 return [...commands,...environments].filter(item=>item[0].toLowerCase().startsWith(q)).sort((a,b)=>(b[0]===context.query)-(a[0]===context.query)||a[0].localeCompare(b[0]));
}
function paperAttachCompletion(source){
 const menu=document.createElement('div');menu.id='paper-tex-completion';menu.className='paper-tex-completion';menu.role='listbox';menu.ariaLabel='LaTeX commands';menu.hidden=true;document.body.append(menu);
 const controller=new AbortController(),signal=controller.signal;let context=null,items=[],active=0,accepting=false,composing=false,sequence=0;
 source.dataset.paperCompletion='true';
 source.setAttribute('aria-autocomplete','list');source.setAttribute('aria-controls',menu.id);source.setAttribute('aria-expanded','false');
 const close=()=>{sequence++;menu.hidden=true;context=null;source.setAttribute('aria-expanded','false');source.removeAttribute('aria-activedescendant');};
 const position=()=>{
  if(menu.hidden)return;
  const rect=source.getBoundingClientRect(),style=getComputedStyle(source),mirror=document.createElement('div');
  for(const key of ['fontFamily','fontSize','fontWeight','fontStyle','letterSpacing','lineHeight','paddingTop','paddingRight','paddingBottom','paddingLeft','borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth','boxSizing','tabSize','wordBreak','overflowWrap'])mirror.style[key]=style[key];
  Object.assign(mirror.style,{position:'fixed',visibility:'hidden',whiteSpace:source.wrap==='off'?'pre':'pre-wrap',width:source.clientWidth+'px',borderStyle:'solid'});
  mirror.textContent=source.value.slice(0,context.anchor??context.start);const marker=document.createElement('span');marker.textContent='\u200b';mirror.append(marker);document.body.append(mirror);
  const lineHeight=parseFloat(style.lineHeight)||parseFloat(style.fontSize)*1.5;
  const x=rect.left+marker.offsetLeft-source.scrollLeft,y=rect.top+marker.offsetTop-source.scrollTop;mirror.remove();
  if(y<rect.top||y>rect.bottom-lineHeight){close();return;}
  const width=Math.min(360,window.innerWidth-16);menu.style.width=width+'px';menu.style.left=Math.max(8,Math.min(x,window.innerWidth-width-8))+'px';
  const height=menu.offsetHeight;menu.style.top=Math.max(8,Math.min(y+lineHeight+4+height>window.innerHeight-8?y-height-4:y+lineHeight+4,window.innerHeight-height-8))+'px';
 };
 const select=index=>{active=index;[...menu.children].forEach((row,i)=>row.setAttribute('aria-selected',String(i===active)));source.setAttribute('aria-activedescendant',menu.children[active].id);const row=menu.children[active];if(row.offsetTop<menu.scrollTop)menu.scrollTop=row.offsetTop;else if(row.offsetTop+row.offsetHeight>menu.scrollTop+menu.clientHeight)menu.scrollTop=row.offsetTop+row.offsetHeight-menu.clientHeight;};
 const render=()=>{
  menu.innerHTML=items.map((item,i)=>`<div role="option" id="paper-tex-option-${i}" aria-selected="${i===0}" data-completion="${i}">${context.citation?`<div class="paper-citation-title">${citationTitle(item[3])}</div><div class="paper-citation-meta">${esc((item[3].creators||[]).slice(0,3).join(', '))}${item[3].year?' · '+esc(item[3].year):''}</div><div class="paper-citation-meta"><code>${esc(item[0])}</code> · ${esc(item[3].file_name||'Bibliography')}</div>`:`<code>${context.reference||context.fileCommand||context.packages||context.documentClass?'':'\\'}${esc(item[0])}</code><span>${esc(item[2])}</span>`}</div>`).join('');
  menu.classList.toggle('paper-citation-completion',!!context.citation);menu.classList.toggle('paper-file-completion',!!context.fileCommand);menu.ariaLabel=context.citation?'Project bibliography citations':context.reference?'Document labels':context.fileCommand?'Project files':context.packages?'LaTeX packages':context.documentClass?'Document classes':'LaTeX commands';menu.scrollTop=0;menu.hidden=false;source.setAttribute('aria-expanded','true');
  if(items.length)source.setAttribute('aria-activedescendant','paper-tex-option-0');else source.removeAttribute('aria-activedescendant');position();
 };
 const update=async()=>{
  if(accepting||composing)return;if(document.activeElement!==source){close();return;}
  const next=paperTexContext(source);if(!next){close();return;}
  const request=++sequence,target=W.target;context=next;active=0;
  if(next.citation||next.reference){
   items=[];render();menu.innerHTML='<div class="paper-completion-empty">Loading references…</div>';
   let result;try{result=await (next.reference?paperLabels(source):paperCitations());}catch(error){result={entries:[],errors:[error.message]};}
   if(request!==sequence||signal.aborted||!source.isConnected||target!==W.target||document.activeElement!==source)return;
   const q=next.query.toLowerCase();items=next.reference?(result.entries||[]).filter(item=>!q||item.key.toLowerCase().includes(q)).slice(0,50).map(item=>[item.key,item.key,item.file+':'+item.line]):(result.entries||[]).filter(item=>!q||[item.key,item.title,(item.creators||[]).join(' '),item.year].join(' ').toLowerCase().includes(q)).slice(0,50).map(item=>[item.key,item.key,'',item]);
   render();if(!items.length){menu.innerHTML=`<div class="paper-completion-empty">${esc(result.errors?.length?result.errors.join('; '):next.reference?((result.entries||[]).length?'No matching labels':'No labels found in this document.'):(result.entries||[]).length?'No matching references':'No references found. Import a .bib file into this project.')}</div>`;position();}
  }else if(next.documentClass){
   items=paperClassSuggestions(next);render();if(!items.length){menu.innerHTML='<div class="paper-completion-empty">No matching document classes. You can also type a class name directly.</div>';position();}
  }else if(next.packages){
   items=paperPackageSuggestions(next);render();if(!items.length){menu.innerHTML='<div class="paper-completion-empty">No matching packages. You can also type a package name directly.</div>';position();}
  }else if(next.fileCommand){
   items=paperFileSuggestions(next);render();if(!items.length){menu.innerHTML='<div class="paper-completion-empty">No matching project files.</div>';position();}
  }else{
   items=paperTexSuggestions(source,next);if(!items.length){close();return;}render();
  }
 };
 const accept=()=>{
  if(!context||!items[active])return;
  const wasArgument=context.citation||context.reference||context.fileCommand||context.packages||context.documentClass,item=items[active],snippet=(wasArgument?'':'\\')+item[1],offset=wasArgument?-1:snippet.indexOf('¦');let text=wasArgument?snippet:snippet.replace('¦',''),start=context.start,end=context.end;
  if(wasArgument){
   const after=source.value.slice(end),closed=/^[^{}\n]*\}/.test(after);
   if(closed)end+=(context.fileCommand||context.documentClass?/^[^}\n]*/:/^[^,}\n]*/).exec(after)[0].length;else text+='}';
  }else if(context.environment&&source.value[end]==='}')end++;
  accepting=true;source.setRangeText(text,start,end,'end');source.setSelectionRange(start+(offset<0?text.length:offset),start+(offset<0?text.length:offset));close();source.dispatchEvent(new Event('input',{bubbles:true}));accepting=false;source.focus();
  const next=paperTexContext(source);if(!wasArgument&&(next?.citation||next?.reference||next?.fileCommand||next?.packages||next?.documentClass))update();
 };
 source.addEventListener('input',update,{signal});source.addEventListener('click',update,{signal});source.addEventListener('blur',close,{signal});source.addEventListener('scroll',close,{signal});
 source.addEventListener('compositionstart',()=>{composing=true;close();},{signal});source.addEventListener('compositionend',()=>{composing=false;update();},{signal});
 source.addEventListener('keydown',event=>{
  if(event.isComposing||composing||menu.hidden||event.metaKey||event.ctrlKey||event.altKey)return;
  if(['ArrowDown','ArrowUp','Enter','Tab','Escape'].includes(event.key)){
   event.preventDefault();event.stopPropagation();if(event.key==='Escape')close();else if((event.key==='ArrowDown'||event.key==='ArrowUp')&&items.length)select((active+(event.key==='ArrowDown'?1:items.length-1))%items.length);else if(!event.shiftKey)accept();else close();
  }else if(['ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'].includes(event.key))close();
 },{signal});
 menu.addEventListener('mousedown',event=>event.preventDefault(),{signal});menu.addEventListener('click',event=>{const row=event.target.closest('[data-completion]');if(row){active=Number(row.dataset.completion);accept();}},{signal});
 window.addEventListener('resize',close,{signal});document.addEventListener('scroll',event=>{if(!menu.contains(event.target))close();},{signal,capture:true});
 return ()=>{controller.abort();menu.remove();delete source.dataset.paperCompletion;for(const attribute of ['aria-autocomplete','aria-controls','aria-expanded','aria-activedescendant'])source.removeAttribute(attribute);};
}

function paperMount(entry){
 const source=$('#workspace-editor textarea');if(!source||!(/\.(tex|cls|sty|bst|bib)$/i.test(entry.name)))return;
 const main=paperMain();if(!main&&!/\.tex$/i.test(entry.name))return;
 Paper.target=W.target;const generation=Paper.generation,target=Paper.target,view=Paper.views.get(target);Paper.scale=view?.scale||1;Paper.fit=view?.fit??true;
 const host=$('#workspace-editor'),toolbar=document.createElement('div');toolbar.className='pdf-toolbar paper-toolbar';toolbar.setAttribute('role','toolbar');toolbar.setAttribute('aria-label','LaTeX editor');
 toolbar.innerHTML=`<div class="pdf-document-heading paper-document-heading"><span class="pdf-title" title="${esc(entry.name)}">${esc(entry.name)}</span></div><div class="pdf-reader-tools paper-reader-tools"><div class="pdf-tool-group" role="group" aria-label="Compilation"><button data-paper-compile data-icon="play" data-icon-only title="Compile" aria-label="Compile"></button><button data-paper-stop data-icon="square" data-icon-only title="Stop compilation" aria-label="Stop compilation" disabled></button><label class="paper-auto-toggle" data-icon="refresh-cw" title="Compile automatically"><input type="checkbox" data-paper-auto aria-label="Compile automatically" ${paperAuto()?'checked':''}></label></div><span class="pdf-tool-divider" aria-hidden="true"></span><div class="pdf-tool-group" role="group" aria-label="PDF zoom"><button data-paper-minus data-icon="zoom-out" title="Zoom out" aria-label="Zoom out" data-icon-only></button><span class="pdf-zoom-level" data-paper-zoom></span><button data-paper-plus data-icon="zoom-in" title="Zoom in" aria-label="Zoom in" data-icon-only></button><button data-paper-fit data-icon="maximize" data-icon-only title="Fit PDF to width" aria-label="Fit PDF to width"></button></div><a class="pdf-standalone-tool" data-paper-download data-icon="download" data-icon-only title="Download PDF" aria-label="Download PDF" hidden download="paper.pdf"></a></div>`;
 const fileHeader=host.querySelector('header');
 if(fileHeader){fileHeader.classList.add('paper-file-actions');const title=fileHeader.querySelector('strong');if(title)title.hidden=true;const download=fileHeader.querySelector('.workspace-download');if(download){download.textContent='';download.dataset.icon='download';download.dataset.iconOnly='';download.title=download.ariaLabel='Download source';}toolbar.querySelector('.paper-document-heading').append(fileHeader);}
 host.prepend(toolbar);
 if(/\.tex$/i.test(entry.name)&&main?.id!==entry.id){const button=document.createElement('button');button.dataset.icon='file-text';button.dataset.iconOnly='';button.title=button.ariaLabel='Set as main document';button.onclick=()=>setPaperMain(entry.id).catch(e=>toast(e.message,{error:true}));toolbar.querySelector('[aria-label="Compilation"]').prepend(button);}
 const split=document.createElement('div');split.id='paper-split';split.style.setProperty('--paper-source-width',view?.width||store.get('noctua.paper.source-width')||'50%');
 const editor=document.createElement('div');editor.className='paper-source';editor.appendChild(source);
 const divider=document.createElement('div');divider.className='paper-divider';divider.tabIndex=0;divider.setAttribute('role','separator');divider.setAttribute('aria-label','Resize source and PDF');divider.setAttribute('aria-orientation','vertical');divider.setAttribute('aria-valuemin','20');divider.setAttribute('aria-valuemax','80');divider.setAttribute('aria-valuenow',String(parseFloat(view?.width||store.get('noctua.paper.source-width')||'50%')));
 const preview=document.createElement('div');preview.id='paper-pages';preview.innerHTML='<p class="paper-empty">The compiled PDF appears here. First-time builds can take longer while TeX support files download.</p>';
 split.append(editor,divider,preview);host.appendChild(split);
 Paper.colors=paperAttachColors(source,editor);
 const sourceToggle=document.createElement('button'),previewToggle=document.createElement('button');
 for(const [button,side] of [[sourceToggle,'source'],[previewToggle,'preview']]){button.className='pane-toggle paper-pane-toggle';button.dataset.paperPane=side;button.dataset.iconOnly='';button.setAttribute('aria-controls',side==='source'?'paper-source':'paper-pages');divider.appendChild(button);}
 editor.id='paper-source';
 Paper.sourceMarkers=paperAttachSourceDiagnostics(source,editor);
 // Keep typing free of completion scans, lookups, and native text predictions.
 for(const [name,value]of Object.entries({autocomplete:'off',autocorrect:'off',autocapitalize:'off',spellcheck:'false',writingsuggestions:'false'}))source.setAttribute(name,value);
 const collapse=(side,save=true)=>{
  const hidden=split.dataset.hiddenPane===side?'':side;
  if(hidden==='preview')Paper.views.set(target,{...Paper.views.get(target),scroll:preview.scrollTop,scale:Paper.scale,fit:Paper.fit,width:split.style.getPropertyValue('--paper-source-width')});
  split.dataset.hiddenPane=hidden;editor.hidden=hidden==='source';preview.hidden=hidden==='preview';
  // Keep at least one working pane visible; switches never discard source or PDF state.
  for(const [button,name,label] of [[sourceToggle,'source','source editor'],[previewToggle,'preview','PDF preview']]){
   const closed=hidden===name;button.setAttribute('aria-expanded',String(!closed));button.title=button.ariaLabel=`${closed?'Show':'Hide'} ${label}`;button.dataset.icon=(name==='source')!==closed?'chevron-left':'chevron-right';
  }
  if(hidden==='preview')editor.style.flex='1';else editor.style.flex='';
  if(save)store.set('noctua.paper.hidden-pane',hidden);
  if(hidden!=='preview'&&Paper.doc)paperDraw(generation).catch(e=>paperMessage(e.message));
 };
 sourceToggle.onclick=()=>collapse('source');previewToggle.onclick=()=>collapse('preview');
 collapse(['source','preview'].includes(store.get('noctua.paper.hidden-pane'))?store.get('noctua.paper.hidden-pane'):'',false);
 let previewWidth=preview.clientWidth;
 const resizePreview=()=>{clearTimeout(Paper.resizeTimer);if(document.body.classList.contains('resizing'))return;if(preview.clientWidth>0&&Paper.fit)Paper.resizeTimer=setTimeout(()=>{if(generation===Paper.generation)paperDraw(generation).catch(e=>paperMessage(e.message));},120);};
 Paper.resizeEnd=resizePreview;window.addEventListener('noctua-pane-resize-end',resizePreview);
 Paper.resizeObserver=new ResizeObserver(()=>{const width=preview.clientWidth;if(width===previewWidth)return;previewWidth=width;resizePreview();});
 Paper.resizeObserver.observe(preview);
 const logs=document.createElement('details');logs.className='paper-logs';logs.innerHTML=`<summary><span>Compiler log</span><span data-paper-status role="status">${main?'Loading preview…':'Choose a main .tex document'}</span><span data-paper-diagnostics role="status" hidden></span></summary><div data-paper-errors></div><pre data-paper-log></pre>`;host.appendChild(logs);
 const resize=(pct,save=true)=>{pct=Math.min(80,Math.max(20,pct));split.style.setProperty('--paper-source-width',pct+'%');if(save)store.set('noctua.paper.source-width',pct+'%');divider.setAttribute('aria-valuenow',String(Math.round(pct)));};
 let dividerFrame=null,dividerPoint=null,dividerBounds=null;
 const applyDivider=()=>{dividerFrame=null;if(dividerBounds&&dividerPoint!==null)resize((dividerPoint-dividerBounds.left)/dividerBounds.width*100,false);};
 divider.onpointerdown=e=>{if(e.target.closest('button')||split.dataset.hiddenPane)return;dividerBounds=split.getBoundingClientRect();divider.setPointerCapture(e.pointerId);document.body.classList.add('resizing');};
 divider.onpointermove=e=>{if(divider.hasPointerCapture(e.pointerId)){dividerPoint=e.clientX;if(dividerFrame===null)dividerFrame=requestAnimationFrame(applyDivider);}};
 const endDivider=()=>{if(!dividerBounds)return;if(dividerFrame!==null)cancelAnimationFrame(dividerFrame);applyDivider();dividerBounds=null;dividerPoint=null;store.set('noctua.paper.source-width',split.style.getPropertyValue('--paper-source-width'));document.body.classList.remove('resizing');window.dispatchEvent(new Event('noctua-pane-resize-end'));};
 divider.onpointerup=endDivider;divider.onpointercancel=endDivider;divider.onlostpointercapture=endDivider;
 divider.onkeydown=e=>{if(e.target.closest('button')||split.dataset.hiddenPane)return;if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();resize(parseFloat(split.style.getPropertyValue('--paper-source-width'))+(e.key==='ArrowLeft'?-2:2));if(Paper.fit)paperDraw(generation).catch(e=>paperMessage(e.message));}};
 toolbar.querySelector('[data-paper-compile]').onclick=()=>paperCompile(true);
 toolbar.querySelector('[data-paper-stop]').onclick=async()=>{clearTimeout(Paper.timer);Paper.requested='stopped';try{await api(projectPaperURL(target)+'/cancel',{});await paperPoll(generation);}catch(e){paperMessage(e.message);}};
 toolbar.querySelector('[data-paper-auto]').onchange=async e=>{const value=e.target.checked;e.target.disabled=true;clearTimeout(Paper.timer);try{await workspaceChange({op:'config',paper:{auto_compile:value}});if(generation!==Paper.generation)return;if(value){Paper.requested=null;paperEdited();}}catch(err){paperMessage(err.message);e.target.checked=paperAuto();}finally{e.target.disabled=false;}};
 const zoom=delta=>{Paper.fit=false;Paper.scale=Math.max(.35,Math.min(3,Paper.scale+delta));paperDraw(generation).catch(e=>paperMessage(e.message));};
 toolbar.querySelector('[data-paper-fit]').onclick=()=>{Paper.fit=true;paperDraw(generation).catch(e=>paperMessage(e.message));};
 toolbar.querySelector('[data-paper-minus]').onclick=()=>zoom(-.15);toolbar.querySelector('[data-paper-plus]').onclick=()=>zoom(.15);toolbar.querySelector('[data-paper-zoom]').textContent=Math.round(Paper.scale*100)+'%';
 source.addEventListener('input',paperEdited);paperPoll(generation);
}
function paperMessage(message){const node=$('[data-paper-status]');if(node)node.textContent=message;}
function paperEdited(){
 if(!Paper.target||Paper.target!==W.target)return;Paper.editVersion++;Paper.requested=null;paperMessage('Preview out of date');clearTimeout(Paper.timer);
 if(paperAuto())Paper.timer=setTimeout(()=>paperCompile(false),1000);
}
async function paperCompile(force=false){
 const target=Paper.target,generation=Paper.generation,editVersion=Paper.editVersion;if(!target||Paper.busy||!paperMain())return;
 Paper.busy=true;clearTimeout(Paper.timer);
 try{await saveWorkspaceFile();if(generation!==Paper.generation||W.target!==target)return;
  const result=await api(projectPaperURL(target),{revision:W.manifest.revision,force});if(generation!==Paper.generation)return;
  Paper.requested=result.fingerprint||'queued';paperMessage('Compiling…');await paperPoll(generation);
 }catch(e){if(generation===Paper.generation){Paper.requested='failed';paperMessage(e.message);}}finally{if(generation===Paper.generation){Paper.busy=false;if(editVersion!==Paper.editVersion&&paperAuto())paperEdited();}}
}
async function paperPoll(generation){
 if(generation!==Paper.generation||!Paper.target)return;clearTimeout(Paper.poll);
 const target=Paper.target,poll=++Paper.pollSerial;let pollAgain=false;
 const typing=()=>typeof workspaceTyping==='function'&&workspaceTyping();
 try{
  if(document.hidden)return;
  if(document.body.classList.contains('resizing')||typing()){pollAgain=true;return;}
  const s=await api(projectPaperURL(target),undefined,{background:true});pollAgain=['queued','building','cancelling'].includes(s.state);if(generation!==Paper.generation||poll!==Paper.pollSerial)return;if(typing()||document.body.classList.contains('resizing')){pollAgain=true;return;}
  if(s.current_revision!==undefined&&s.current_revision!==W.manifest.revision&&!W.dirty){await refreshWorkspaceView(target);return;}
  if(Paper.current&&Paper.current!==s.current_fingerprint)Paper.requested=null;Paper.current=s.current_fingerprint;
  const building=['queued','building','cancelling'].includes(s.state);

  $('[data-paper-auto]').checked=paperAuto();
  $('[data-paper-stop]').disabled=!building;$('[data-paper-compile]').disabled=!paperMain();
  const stale=s.stale||W.dirty;
  if(!building&&Paper.requested==='queued')Paper.requested=s.fingerprint||s.current_fingerprint||'done';
  paperMessage(s.configuration_error||(building?(s.queued?'Compiling; newer changes queued…':'Compiling…') : s.state==='error'?`Build failed${s.last_success?' — showing last successful PDF':''}`:s.state==='cancelled'?'Compilation stopped':stale?'Preview out of date':`PDF up to date${s.last_success?.elapsed_ms!=null?' · '+(s.last_success.elapsed_ms/1000).toFixed(1)+' s':''}`));
  $('[data-paper-log]').textContent=s.message?[s.message,s.log].filter(Boolean).join('\n'):s.log||'';
  paperDiagnostics(s.log||'');paperDiagnosticSummary(s);
  const last=s.last_success;if(last&&last.main_file===W.manifest?.paper?.main_file){
   const artifact=last.artifact||last.fingerprint,url=projectPaperURL(target)+'/pdf/'+artifact;const link=$('[data-paper-download]');link.href=url;link.hidden=false;link.title=stale?'Download last successful build':'Download PDF';
   if(Paper.loaded!==artifact){Paper.loaded=artifact;await paperLoadPDF(url,generation);}
   if(generation===Paper.generation&&Paper.loaded===artifact&&Paper.doc)Paper.displayed=last;
  }
  if(generation!==Paper.generation||poll!==Paper.pollSerial)return;if(typing()||document.body.classList.contains('resizing')){pollAgain=true;return;}
  // Retry only after another edit or an explicit request, not on every failed poll.
  if(paperAuto()&&!building&&!s.configuration_error&&stale&&!W.dirty&&!Paper.busy&&Paper.requested===null){Paper.requested=s.current_fingerprint;await paperCompile(false);}
 }catch(e){pollAgain=true;if(generation===Paper.generation&&poll===Paper.pollSerial)paperMessage(e.message);}
 finally{if(generation===Paper.generation&&poll===Paper.pollSerial){clearTimeout(Paper.poll);Paper.poll=pollAgain?setTimeout(()=>paperPoll(generation),1500):null;}}
}
function paperParseDiagnostics(status){
 const entries=(W.manifest?.entries||[]).filter(e=>!e.deleted&&e.kind==='file'),main=paperMain();
 const resolve=path=>{
  path=path.replace(/^\.\/|^["']|["']$/g,'');
  if(path==='.noctua-paper.tex')return main;
  return entries.find(e=>paperBuildPath(e)===path);
 };
 const found=[],stack=[];let current=main?paperBuildPath(main):null,pending=null;
 for(const raw of (status.log||'').split('\n')){
  const line=raw.trim();if(!line)continue;
  for(const token of line.matchAll(/\((?:(?:\.\/)?([^\s()]+\.(?:tex|cls|sty|bib|bst)))?|\)/g)){
   if(token[0]===')'){if(stack.length)current=stack.pop();}else{stack.push(current);if(token[1])current=token[1];}
  }
  // Find the suffix first: an unanchored filename wildcard retries every
  // prefix of long compiler lines, causing quadratic main-thread stalls.
  const location=/\.(tex|cls|sty|bib|bst):(\d+):/.exec(line);
  let path=null,number=null;
  if(location){path=line.slice(0,location.index+location[1].length+1).replace(/^(?:error|warning):\s*/i,'').replace(/^\.\//,'');number=Number(location[2]);}
  const level=/\bwarning\b/i.test(line)?'warning':/^!|\berror:|fatal error|emergency stop/i.test(line)||location?'error':null;
  if(level){
   const input=/\bon input line\s+(\d+)/i.exec(line);
   const diagnostic={level,message:line,path:path||current,line:number||(input?Number(input[1]):null)};
   found.push(diagnostic);pending=diagnostic.line?null:diagnostic;
  }else if(pending){
   const source=/^l\.(\d+)\b|\bon input line\s+(\d+)/i.exec(line);
   if(source){pending.line=Number(source[1]||source[2]);pending=null;}
  }
 }
 if((status.state==='error'||status.configuration_error)&&!found.some(d=>d.level==='error'))found.push({level:'error',message:status.configuration_error||status.message||'Build failed',path:null,line:null});
 const seen=new Set();return found.filter(d=>{const key=JSON.stringify([d.level,d.message,d.path,d.line]);if(seen.has(key))return false;seen.add(key);d.file=d.path?resolve(d.path)?.id:null;return true;});
}
function paperAttachSourceDiagnostics(source,editor){
 const overlay=document.createElement('div');overlay.className='paper-source-diagnostics';editor.append(overlay);
 const target=W.target,file=W.file,controller=new AbortController(),signal=controller.signal;
 let items=[],signature=null,invalid=false,geometry=null;
 const paint=()=>{
  if(document.body.classList.contains('resizing'))return;overlay.replaceChildren();if(invalid||!items.length||!source.clientWidth)return;
  const style=getComputedStyle(source),height=parseFloat(style.lineHeight)||20;
  if(!geometry&&source.wrap==='off'){
   const count=source.value.split('\n').length,padding=parseFloat(style.paddingTop)||0;
   geometry=new Map(items.filter(item=>item.line>0&&item.line<=count).map(item=>[item.line,{top:padding+(item.line-1)*height,height}]));
  }
  if(!geometry){
   const mirror=document.createElement('div');
   for(const key of ['fontFamily','fontSize','fontWeight','fontStyle','letterSpacing','lineHeight','paddingTop','paddingRight','paddingBottom','paddingLeft','boxSizing','tabSize','wordBreak','overflowWrap'])mirror.style[key]=style[key];
   Object.assign(mirror.style,{position:'fixed',top:'0',left:'0',visibility:'hidden',width:source.clientWidth+'px',whiteSpace:source.wrap==='off'?'pre':'pre-wrap',overflowWrap:'break-word'});
   const wanted=new Set(items.map(item=>item.line));geometry=new Map();
   source.value.split('\n').forEach((text,i)=>{const row=document.createElement('div');row.style.minHeight=height+'px';row.textContent=text||'\u200b';if(wanted.has(i+1))row.dataset.diagnosticLine=i+1;mirror.append(row);});
   document.body.append(mirror);
   mirror.querySelectorAll('[data-diagnostic-line]').forEach(row=>geometry.set(Number(row.dataset.diagnosticLine),{top:row.offsetTop,height:row.offsetHeight}));mirror.remove();
  }
  const grouped=new Map();for(const item of items){if(!grouped.has(item.line))grouped.set(item.line,[]);grouped.get(item.line).push(item);}
  for(const [line,diagnostics]of grouped){
   const box=geometry.get(line);if(!box)continue;
   const top=box.top-source.scrollTop;if(top+box.height<0||top>source.clientHeight)continue;
   const mark=document.createElement('div'),button=document.createElement('button'),level=diagnostics.some(d=>d.level==='error')?'error':'warning';
   mark.className='paper-source-diagnostic';mark.dataset.line=line;mark.dataset.level=level;mark.style.top=top+'px';mark.style.height=box.height+'px';
   button.type='button';button.dataset.icon='info';button.dataset.iconOnly='';button.title=diagnostics.map(d=>d.message).join('\n');button.ariaLabel=level+' on line '+line;button.setAttribute('aria-haspopup','dialog');
   button.onclick=()=>paperShowDiagnostics(diagnostics,'all',target);mark.append(button);overlay.append(mark);
  }
 };
 const schedule=()=>{if(!document.body.classList.contains('resizing'))paint();};
 window.addEventListener('noctua-pane-resize-end',schedule,{signal});
 source.addEventListener('scroll',schedule,{signal});
 source.addEventListener('input',()=>{invalid=true;geometry=null;overlay.replaceChildren();},{signal});
 const observer=new ResizeObserver(()=>{geometry=null;schedule();});observer.observe(source);
 return {
  update(all,status){
   const next=JSON.stringify([status.fingerprint,status.state,status.log,status.configuration_error]),changed=next!==signature;
   if(changed){signature=next;invalid=false;geometry=null;}
   items=['queued','building','cancelling'].includes(status.state)?[]:all.filter(item=>item.file===file&&item.line);
   if(changed||!geometry)paint();
  },
  destroy(){controller.abort();observer.disconnect();overlay.remove();}
 };
}
async function paperGoToDiagnostic(item,target){
 if(W.target!==target)throw Error('Project changed. Reopen the diagnostic list.');
 if(!item.file||!item.line)throw Error('This diagnostic has no project source location.');
 await openWorkspaceFile(item.file);if(W.target!==target||W.file!==item.file)return;
 if($('.paper-source')?.hidden)$('[data-paper-pane="source"]')?.click();
 const source=$('#workspace-editor textarea');if(!source)return;
 const lines=source.value.split('\n'),line=Math.max(0,Math.min(item.line-1,lines.length-1)),start=lines.slice(0,line).reduce((sum,text)=>sum+text.length+1,0);
 source.focus();source.setSelectionRange(start,start+lines[line].length);source.scrollTop=Math.max(0,(line-3)*(parseFloat(getComputedStyle(source).lineHeight)||20));
}
function paperShowDiagnostics(items,level,target){
 const d=workspaceDialog(level==='all'?'Diagnostics':level==='error'?'Errors':'Warnings','<div class="paper-diagnostic-list"></div><p data-diagnostic-error class="workspace-error" role="alert"></p>');
 d.classList.add('paper-diagnostic-dialog');
 for(const item of items.filter(d=>level==='all'||d.level===level)){
  const linked=item.file&&item.line,row=document.createElement(linked?'button':'div'),message=document.createElement('span'),location=document.createElement('small');
  row.className='paper-diagnostic-row';message.textContent=item.message;location.textContent=item.line&&item.path?item.path+':'+item.line:'No project source location';row.append(message,location);
  if(linked){row.type='button';row.dataset.diagnosticFile=item.file;row.onclick=async()=>{row.disabled=true;try{await paperGoToDiagnostic(item,target);d.close();$('#workspace-editor textarea')?.focus();}catch(error){d.querySelector('[data-diagnostic-error]').textContent=error.message;row.disabled=false;}};}
  d.querySelector('.paper-diagnostic-list').append(row);
 }
}
function paperDiagnosticSummary(status){
 const node=$('[data-paper-diagnostics]');if(!node)return;
 const cache=Paper.diagnosticsCache,entries=W.manifest?.entries;
 const same=cache&&cache.target===W.target&&cache.entries===entries&&cache.main===W.manifest?.paper?.main_file&&['log','state','configuration_error','message'].every(key=>cache[key]===status[key]);
 const items=same?cache.items:paperParseDiagnostics(status);
 if(!same)Paper.diagnosticsCache={target:W.target,entries,main:W.manifest?.paper?.main_file,log:status.log,state:status.state,configuration_error:status.configuration_error,message:status.message,items};
 const target=W.target,errors=items.filter(d=>d.level==='error').length,warnings=items.filter(d=>d.level==='warning').length;
 Paper.sourceMarkers?.update(items,status);
 node._diagnostics=items;node.hidden=!items.length;
 const counts=errors+':'+warnings;
 if(node.dataset.counts!==counts){
  node.dataset.counts=counts;node.replaceChildren();
  for(const [level,count]of [['error',errors],['warning',warnings]]){
   if(!count)continue;if(node.childNodes.length)node.append(' · ');
   const button=document.createElement('button');button.type='button';button.dataset.diagnosticLevel=level;button.textContent=count+' '+level+(count===1?'':'s');button.title='Show '+level+'s';button.setAttribute('aria-haspopup','dialog');
   button.onclick=event=>{event.preventDefault();event.stopPropagation();paperShowDiagnostics(node._diagnostics,level,target);};node.append(button);
  }
 }
}
function paperDiagnostics(log){
 const container=$('[data-paper-errors]');if(!container)return;container.replaceChildren();const seen=new Set();
 for(const line of log.split('\n')){const m=/(?:^|\s)(?:\.\/)?([^\s:]+\.(?:tex|cls|sty|bib|bst)):(\d+):/.exec(line);if(!m)continue;
  const path=m[1],number=Number(m[2]);const entry=W.manifest.entries.find(e=>!e.deleted&&e.kind==='file'&&paperBuildPath(e)===path);if(!entry||seen.has(path+':'+number))continue;seen.add(path+':'+number);
  const button=document.createElement('button');button.textContent=path+':'+number;button.onclick=async()=>{try{await openWorkspaceFile(entry.id);const ta=$('#workspace-editor textarea');if(!ta)return;const pos=ta.value.split('\n').slice(0,number-1).join('\n').length+(number>1?1:0);ta.focus();ta.setSelectionRange(pos,pos);ta.scrollTop=(number-3)*parseFloat(getComputedStyle(ta).lineHeight);}catch(e){toast(e.message,{error:true});}};container.appendChild(button);
 }
}
async function paperLoadPDF(url,generation){
 const serial=++Paper.loadSerial,engine=await pdfjs();if(generation!==Paper.generation||serial!==Paper.loadSerial)return;
 const task=engine.getDocument({url,cMapUrl:'/vendor/pdfjs/web/cmaps/',cMapPacked:true,standardFontDataUrl:'/vendor/pdfjs/web/standard_fonts/',wasmUrl:'/vendor/pdfjs/web/wasm/',isEvalSupported:false});
 let doc;try{doc=await task.promise;}catch(e){if(generation!==Paper.generation||serial!==Paper.loadSerial)return;Paper.loaded=null;throw e;}
 if(generation!==Paper.generation||serial!==Paper.loadSerial){await doc.destroy();return;}
 const old=Paper.doc;Paper.doc=doc;await paperDraw(generation);await old?.destroy();
}
async function paperDraw(generation){
 const doc=Paper.doc,pane=$('#paper-pages');if(!doc||!pane||pane.hidden)return;
 const scroll=pane.scrollTop||Paper.views.get(Paper.target)?.scroll||0;Paper.observer?.disconnect();for(const task of Paper.tasks)task.cancel();Paper.tasks.clear();
 const draw=Symbol();Paper.draw=draw;const active=()=>generation===Paper.generation&&Paper.draw===draw;
 const engine=await pdfjs();if(!active())return;
 const first=await doc.getPage(1);if(!active())return;if(Paper.fit)Paper.scale=Math.max(.1,(pane.clientWidth-40)/first.getViewport({scale:1}).width);const scale=Paper.scale,base=first.getViewport({scale});pane.replaceChildren();
 $('[data-paper-zoom]').textContent=Math.round(scale*100)+'%';
 const render=async node=>{if(node.dataset.rendered||!active())return;node.dataset.rendered='true';const version=Symbol();node.renderVersion=version;const pageActive=()=>active()&&node.renderVersion===version;
  try{const page=await doc.getPage(Number(node.dataset.page));if(!pageActive())return;const viewport=page.getViewport({scale}),ratio=Math.min(devicePixelRatio||1,3);
   node.style.width=viewport.width+'px';node.style.height=viewport.height+'px';const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width*ratio);canvas.height=Math.ceil(viewport.height*ratio);canvas.style.width=viewport.width+'px';canvas.style.height=viewport.height+'px';node.appendChild(canvas);
   const task=page.render({canvasContext:canvas.getContext('2d'),viewport,transform:[ratio,0,0,ratio,0,0]});node.renderTask=task;Paper.tasks.add(task);try{await task.promise;}finally{Paper.tasks.delete(task);if(node.renderTask===task)node.renderTask=null;}if(!pageActive())return;
   const layer=document.createElement('div');layer.className='textLayer';layer.style.setProperty('--total-scale-factor',scale);node.appendChild(layer);await new engine.TextLayer({textContentSource:await page.getTextContent(),container:layer,viewport}).render();
   layer.addEventListener('dblclick',event=>{if(pageActive()){event.preventDefault();paperSourceAt(event,page,viewport,node,generation);}});
  }catch(e){if(pageActive()&&e.name!=='RenderingCancelledException')paperMessage('PDF preview: '+e.message);}
 };
 Paper.observer=new IntersectionObserver(entries=>{for(const entry of entries){const node=entry.target;if(entry.isIntersecting)render(node);else{node.renderVersion=null;node.renderTask?.cancel();node.replaceChildren();delete node.dataset.rendered;}}},{root:pane,rootMargin:'600px'});
 for(let i=1;i<=doc.numPages;i++){const node=document.createElement('div');node.className='paper-page';node.dataset.page=i;node.style.width=base.width+'px';node.style.height=base.height+'px';pane.appendChild(node);Paper.observer.observe(node);}
 pane.scrollTop=scroll;
}

// Coordinates come from PDF.js's viewport transform, not device pixels. This
// keeps reverse lookup accurate at any zoom, Retina scale, or page rotation.
async function paperSourceAt(event,page,viewport,node,generation){
 const displayed=Paper.displayed,target=Paper.target;
 if(!displayed||generation!==Paper.generation)return;
 if(W.dirty){toast('Recompile after saving your changes before navigating to source.',{error:true});return;}
 const rect=node.getBoundingClientRect();
 const [px,py]=viewport.convertToPdfPoint((event.clientX-rect.left)*viewport.width/rect.width,(event.clientY-rect.top)*viewport.height/rect.height);
 const unit=page.userUnit||1;
 try{
  const found=await api(projectPaperURL(target)+'/source',{fingerprint:displayed.fingerprint,page:page.pageNumber,x:(px-page.view[0])*unit,y:(page.view[3]-py)*unit});
  if(generation!==Paper.generation||target!==W.target||Paper.displayed?.fingerprint!==displayed.fingerprint||W.dirty)return;
  const entry=W.manifest.entries.find(e=>e.id===found.file_id&&!e.deleted);
  if(!entry||entry.blob!==found.blob){toast('Source changed; recompile before navigating.',{error:true});return;}
  if(W.file!==entry.id)await openWorkspaceFile(entry.id);
  if(target!==W.target||W.file!==entry.id||W.dirty)return;
  if($('#paper-split')?.dataset.hiddenPane==='source')$('[data-paper-pane="source"]').click();
  const ta=$('#workspace-editor textarea');if(!ta)return;
  paperCenterLine(ta,found.line);
 }catch(e){if(generation===Paper.generation)toast(e.message,{error:true});}
}
function paperCenterLine(ta,line){
 const lines=ta.value.split('\n'),index=Math.max(0,Math.min(lines.length-1,line-1));
 const start=lines.slice(0,index).reduce((n,s)=>n+s.length+1,0),end=start+lines[index].length;
 ta.focus({preventScroll:true});ta.setSelectionRange(start,end);
 // A mirror accounts for wrapped source lines, tabs, font size, and padding.
 // Counting newline characters alone fails when a paragraph wraps in the editor.
 const mirror=document.createElement('div'),style=getComputedStyle(ta);
 for(const property of ['font','lineHeight','letterSpacing','padding','tabSize','wordBreak','overflowWrap'])mirror.style[property]=style[property];
 Object.assign(mirror.style,{position:'absolute',visibility:'hidden',pointerEvents:'none',whiteSpace:'pre-wrap',overflowWrap:'break-word',boxSizing:'border-box',width:ta.clientWidth+'px'});
 mirror.append(document.createTextNode(ta.value.slice(0,start)));const marker=document.createElement('span');marker.textContent=lines[index]||'\u200b';mirror.append(marker);document.body.append(mirror);
 const top=marker.getBoundingClientRect().top-mirror.getBoundingClientRect().top;
 ta.scrollTop=Math.max(0,top-ta.clientHeight/2+(parseFloat(style.lineHeight)||20)/2);ta.scrollLeft=0;mirror.remove();
}

document.addEventListener('visibilitychange',()=>{if(!document.hidden&&Paper.target)paperPoll(Paper.generation);});

// Lexical coloring only: no completion, TeX execution, or document-wide DOM.
function paperColorLine(line,state={math:''},emit=true){
 const tokens=/\\(?:begin|end)\s*\{[^}\n]*\}|\\(?:[a-zA-Z@]+\*?|[^\n])|%[^\n]*|\$\$?|[{}\[\]_^&=+<>-]|\b\d+(?:\.\d+)?\b/g;
 let html='',at=0,match;
 const add=(text,kind)=>{if(emit&&text)html+=kind?`<span class="tex-${kind}">${esc(text)}</span>`:esc(text);};
 while((match=tokens.exec(line))){
  add(line.slice(at,match.index),state.math?'math-content':'');const token=match[0];let kind='';
  const environment=/^\\(begin|end)\s*\{([^}]+)\}$/.exec(token);
  if(token[0]==='%')kind='comment';
  else if(environment){
   kind='environment';const name=environment[2];
   if(/^(?:equation|align|alignat|gather|multline|flalign|displaymath|math|eqnarray)\*?$/.test(name))state.math=environment[1]==='begin'?'env:'+name:'';
  }else if(token[0]==='$'){
   kind='math';if(!state.math)state.math=token;else if(state.math===token)state.math='';
  }else if(['\\(','\\[','\\)','\\]'].includes(token)){
   kind='math';if(token==='\\('||token==='\\[')state.math=token;else if(state.math===(token==='\\)'?'\\(':'\\['))state.math='';
  }else if(token[0]==='\\'){
   const name=token.slice(1).replace(/\*$/,'');
   kind=/^(?:cite\w*|ref|eqref|autoref|cref|Cref|label)$/.test(name)?'reference':/^(?:textit|textbf|emph|textsc|texttt)$/.test(name)?'format':/^(?:section|subsection|subsubsection|chapter|part|documentclass|usepackage|newcommand|renewcommand|def|title|author|item)$/.test(name)?'structure':state.math||/^(?:alpha|beta|gamma|delta|epsilon|theta|lambda|mu|pi|rho|sigma|tau|phi|psi|omega|Gamma|Delta|Theta|Lambda|Pi|Sigma|Phi|Psi|Omega|sum|int|infty|prod|partial|nabla)$/.test(name)?'symbol':'command';
  }else kind=/^[{}\[\]]$/.test(token)?'delimiter':/^\d/.test(token)?'number':state.math?'operator':'';
  add(token,kind);at=tokens.lastIndex;
 }
 add(line.slice(at),state.math?'math-content':'');return html;
}
function paperAttachColors(source,host){
 const layer=document.createElement('pre');layer.className='paper-source-colors';layer.setAttribute('aria-hidden','true');host.prepend(layer);
 const controller=new AbortController(),{signal}=controller;let timer=null,frame=null,lines=null,version=null,composing=false,states=[''],paintKey=null,geometry=null;
 source.wrap='soft';source.classList.add('paper-code-source');
 const paint=()=>{
  frame=null;if(composing||document.body.classList.contains('resizing'))return;
  // Very large sources retain the plain native editor rather than delaying input.
  if(source.value.length>200000){source.classList.remove('syntax-colored');layer.hidden=true;return;}
  if(version!==source.value){
   version=source.value;const next=version.split('\n');let unchanged=0;
   while(lines&&unchanged<lines.length&&unchanged<next.length&&lines[unchanged]===next[unchanged])unchanged++;
   states.length=Math.min(states.length,unchanged+1);lines=next;geometry=null;
  }
  if(lines.length>10000){source.classList.remove('syntax-colored');layer.hidden=true;return;}
  const style=getComputedStyle(source),height=parseFloat(style.lineHeight),top=parseFloat(style.paddingTop),left=parseFloat(style.paddingLeft);
  if(!height||!source.clientHeight)return;
  const width=source.clientWidth-left-parseFloat(style.paddingRight);
  const layout=[width,style.font,style.lineHeight,style.letterSpacing,style.tabSize].join('\u0000');
  // Measure plain wrapped lines only when text or width changes; scrolling reuses offsets.
  if(!geometry||geometry.layout!==layout){
   const mirror=document.createElement('div');Object.assign(mirror.style,{position:'fixed',visibility:'hidden',pointerEvents:'none',left:'0',top:'0',width:width+'px',font:style.font,lineHeight:style.lineHeight,letterSpacing:style.letterSpacing,tabSize:style.tabSize,whiteSpace:'pre-wrap',overflowWrap:'break-word'});
   for(const text of lines){const row=document.createElement('div');row.textContent=text||'\u200b';mirror.append(row);}
   document.body.append(mirror);const origin=mirror.getBoundingClientRect().top;
   geometry={layout,offsets:Array.from(mirror.children,row=>row.getBoundingClientRect().top-origin)};mirror.remove();
  }
  const offsets=geometry.offsets;let low=0,high=offsets.length;
  while(low+1<high){const mid=(low+high)>>1;if(offsets[mid]<=source.scrollTop-top)low=mid;else high=mid;}
  const first=low,count=Math.min(150,Math.ceil(source.clientHeight/height)+2);
  const visible=lines.slice(first,first+count);
  for(let i=states.length-1;i<first;i++){const state={math:states[i]};paperColorLine(lines[i],state,false);states[i+1]=state.math;}
  const state={math:states[first]||''};
  // Bound token work even for generated single-line files.
  if(visible.some(line=>line.length>20000)){source.classList.remove('syntax-colored');layer.hidden=true;return;}
  const nextKey=[first,source.scrollTop,source.scrollLeft,source.clientWidth,source.clientHeight,style.font,style.letterSpacing].join('\u0000');
  if(paintKey?.value===version&&paintKey.layout===nextKey&&!layer.hidden&&source.classList.contains('syntax-colored'))return;paintKey={value:version,layout:nextKey};
  layer.hidden=false;layer.style.font=style.font;layer.style.lineHeight=style.lineHeight;layer.style.letterSpacing=style.letterSpacing;layer.style.tabSize=style.tabSize;
  layer.style.width=source.clientWidth+'px';layer.style.height=source.clientHeight+'px';
  layer.innerHTML=`<div style="width:${width}px;transform:translate(${left}px,${top+offsets[first]-source.scrollTop}px)">${visible.map((line,index)=>{const html=paperColorLine(line,state);states[first+index+1]=state.math;return `<div>${html||'\u200b'}</div>`;}).join('')}</div>`;
  source.classList.add('syntax-colored');
 };
 const schedule=()=>{if(!document.body.classList.contains('resizing')&&frame===null)frame=requestAnimationFrame(paint);};
 const edited=()=>{source.classList.remove('syntax-colored');layer.hidden=true;clearTimeout(timer);timer=setTimeout(paint,80);};
 source.addEventListener('input',edited,{signal});source.addEventListener('scroll',schedule,{signal,passive:true});
 source.addEventListener('compositionstart',()=>{composing=true;edited();},{signal});source.addEventListener('compositionend',()=>{composing=false;edited();},{signal});
 window.addEventListener('noctua-pane-resize-end',schedule,{signal});
 const observer=new ResizeObserver(schedule);observer.observe(source);paint();
 return {destroy(){controller.abort();observer.disconnect();clearTimeout(timer);if(frame!==null)cancelAnimationFrame(frame);source.classList.remove('syntax-colored','paper-code-source');layer.remove();}};
}
