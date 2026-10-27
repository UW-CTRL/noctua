// macOS: swift tests/research.swift
// Exercise the shipped research UI in WebKit with deterministic local API fixtures.
import Cocoa
import WebKit
let root=URL(fileURLWithPath:FileManager.default.currentDirectoryPath)
let output=root.appendingPathComponent("target/research-regression")
try FileManager.default.createDirectory(at:output,withIntermediateDirectories:true)
var html=try String(contentsOf:root.appendingPathComponent("web/index.html"),encoding:.utf8)
let scripts=try NSRegularExpression(pattern:#"<script src="/([^"]+)"></script>"#)
for match in scripts.matches(in:html,range:NSRange(html.startIndex...,in:html)).reversed(){
 let file=String(html[Range(match.range(at:1),in:html)!])
 let keep=["fonts.js","app.js","lineage.js","library.js","select.js"].contains(file)
 html.replaceSubrange(Range(match.range,in:html)!,with:keep ? "<script src=\"../../web/\(file)\"></script>" : "")
}
html=html.replacingOccurrences(of:"href=\"/",with:"href=\"../../web/")
let fixtures=#"""
<script>
window.testErrors=[];
window.addEventListener('error',e=>testErrors.push(e.message));
window.addEventListener('unhandledrejection',e=>testErrors.push(String(e.reason)));
localStorage.clear();localStorage.setItem('noctua.threadsAuto','0');
const settings={};let openedPDF=[];
function openPaperView(key,where){openedPDF.push([key,where]);}
const fixtureItems=[
 {key:'a',title:'Zebra networks',creators:['Ada Lovelace'],year:2024,venue:'Journal A',has_pdf:true,abstractNote:'Local abstract',s2:'s1'},
 {key:'b',title:'Alpha lineage',creators:['Grace Hopper'],year:2020,venue:'Journal B',has_pdf:false,abstractNote:'Unmatched local paper'}
];
const fixturePaper={paperId:'s1',title:'Zebra networks',authors:[{name:'Ada Lovelace'}],year:2024,citationCount:5,abstract:'Abstract'};
window.requests=[];window.pendingPDF=null;window.pendingSearch=null;window.pendingFolder=null;window.scopeFailure=false;
window.fetch=async(path,opts)=>{
 requests.push(path);let data={};
 if(path==='/api/settings/library'){if(scopeFailure)return {ok:false,status:500,json:async()=>({error:'Save failed'})};return {ok:true,json:async()=>({include_subfolders:JSON.parse(opts.body).include_subfolders})};}
 if(path==='/api/library/add'){window.savedSearchPaper=JSON.parse(opts.body).paper;if(pendingPDF)return await pendingPDF;data={key:'keyboard-paper',paper:{has_pdf:true}};}
 else if(path==='/api/library/collections')data={live:true,targets:[{id:'L1',name:'My Library',count:2,parent:null},{id:'C1',name:'Networks',count:1,level:1,parent:'L1'},{id:'C3',name:'Subfolder',count:0,level:2,parent:'C1'},{id:'C4',name:'Nested',count:0,level:3,parent:'C3'},{id:'C2',name:'Empty',count:0,level:1,parent:'L1'}]};
 else if(path.includes('/api/library/items')){
  if(path.endsWith('C1')&&pendingFolder)return await pendingFolder;
  data=path.endsWith('L1')?fixtureItems:path.endsWith('C1')?[fixtureItems[0]]:[];
 }else if(path.startsWith('/api/project'))data={target:new URL(path,'http://local').searchParams.get('target'),items:2,papers:[fixturePaper],edges:[],shared:[],links:[],clusters:[{id:1,size:1,papers:['s1']}],unresolved:[{title:fixtureItems[1].title}]};
 else if(path.startsWith('/api/match'))data={paperId:'s1',title:new URL(path,'http://local').searchParams.get('title')};
 else if(path.startsWith('/api/search')){if(pendingSearch)return await pendingSearch;data={data:[fixturePaper],total:1,next:null};}
 else if(path.startsWith('/api/paper?'))data=fixturePaper;
 else if(path.startsWith('/api/graph'))data={center:fixturePaper,references:[],citations:[]};
 else if(path.startsWith('/api/similar')||path==='/api/links'||path==='/api/library/check')data=[];
 else if(path==='/api/status')data={pending:0};
 return {ok:true,json:async()=>data};
};
</script>
"""#
html=html.replacingOccurrences(of:"</head>",with:fixtures+"</head>")
let setup=try String(contentsOf:root.appendingPathComponent("web/setup.js"),encoding:.utf8)
let dataStart=setup.range(of:"function threadSummarySettings(")!.lowerBound
let dataEnd=setup.range(of:"function updateSummary(",range:dataStart..<setup.endIndex)!.lowerBound
html=html.replacingOccurrences(of:"</body>",with:"<script>"+String(setup[dataStart..<dataEnd])+"</script></body>")
let searchSettingsStart=setup.range(of:"function searchSettingsSection()")!.lowerBound
let searchSettingsEnd=setup.range(of:"function serverSection()")!.lowerBound
html=html.replacingOccurrences(of:"</body>",with:"<script>"+String(setup[searchSettingsStart..<searchSettingsEnd])+"</script></body>")
let checks=#"""
<script>
openPaperView=(key,where)=>{openedPDF.push([key,where]);};
const assert=(v,m)=>{if(!v)throw Error(m);};
// Mocked requests and MutationObserver callbacks settle in microtasks; avoid offscreen WebKit timer throttling.
const settle=async()=>{for(let i=0;i<80;i++)await Promise.resolve();};
const visible=e=>getComputedStyle(e).display!=='none'&&e.getClientRects().length>0;
(async()=>{
 await collectionsReady;await settle();
 assert(document.querySelector('[data-mode="graph"]').textContent==='Library','top-level mode named Library');
 assert(!document.querySelector('[data-tab="results"]'),'Search tab removed');
 assert(!document.querySelector('[data-tab="projects"], #proj-target, #proj-open'),'redundant Projects navigation removed');
 assert(!$('#clear-graph'),'redundant Close graph button removed');
 assert(!$('[data-tab="library"], [data-tab="nodes"]'),'redundant Folders/Papers tabs removed');
 assert($('[data-layout="network"]').textContent==='Graph','Network renamed Graph');
 assert(!$('#left > .tabs'),'secondary sidebar tabs removed');
 assert($('#left > #layout')&&!$('#stage #layout'),'visualization switch lives at top of left sidebar');
 assert(visible($('#layout')),'visualization switch remains visible in Library');
 for(const mode of ['notes-mode','pdf-mode']){document.body.classList.add(mode);assert(!visible($('#layout')),'visualization switch hides in '+mode);document.body.classList.remove(mode);}
 assert(G.layout==='library'&&visible($('#library-view')),'Library is default');
 assert($('#library-rows').children.length===2&&$('#library-rows').textContent.includes('Alpha lineage'),'unmatched local papers included');
 assert($('#library-title').textContent==='My Library','library heading');
 const scopeMarkup=document.createElement('div');scopeMarkup.innerHTML=dataSection({data_dir:'/data'});assert(scopeMarkup.querySelector('#setup-include-subfolders').checked,'include subfolders defaults on in Settings');
 scopeMarkup.innerHTML=dataSection({data_dir:'/data',include_subfolders:false});assert(!scopeMarkup.querySelector('#setup-include-subfolders').checked,'Settings renders saved off state');
 await setIncludeSubfolders(false);await settle();assert(settings.include_subfolders===false,'subfolder scope saves and refreshes');
 scopeFailure=true;let rejected=false;try{await setIncludeSubfolders(true)}catch{rejected=true}scopeFailure=false;assert(rejected&&settings.include_subfolders===false,'failed scope save preserves previous state');
 await setIncludeSubfolders(true);await settle();

 assert(!$('#queue')&&!$('#collection')&&!$('#refresh-collections'),'header queue/save-folder/refresh controls removed');
 assert(defaultSaveTarget()==='L1','default save folder is library root');
 setDefaultSaveTarget('C1');assert(defaultSaveTarget()==='C1','save folder preference updated');
 setDefaultSaveTarget('unknown');assert(defaultSaveTarget()==='C1','invalid save folder ignored');
 assert(dataSection({data_dir:'/data'}).includes('id="setup-save-target"')&&dataSection({data_dir:'/data'}).includes('value="C1" selected'),'settings show the selected default save folder');
 store.set('noctua.collection','removed');assert(defaultSaveTarget()==='L1','missing save folder falls back to library root');setDefaultSaveTarget('L1');
 notifyProgress('first-task','Importing papers…');notifyProgress('second-task','Preparing outline…');
 assert(!$('#toast').classList.contains('hidden')&&$('#toast').classList.contains('busy'),'active work uses shared notification');
 assert($('#toast').textContent==='Importing papers…'&&$('#toast').dataset.detail.includes('Preparing outline'),'concurrent tasks share one card');
 toast('Could not save.',{error:true});notifyProgress('requests','Semantic Scholar · 2 queued');
 assert($('#toast').textContent==='Could not save.'&&$('#toast').classList.contains('error'),'queue progress cannot overwrite errors');
 toast('Other task finished.');hideToast({keepError:true});assert($('#toast').textContent==='Could not save.','completion messages and automatic dismissal preserve errors');
 notifyProgress('first-task',null);hideToast();assert($('#toast').textContent==='Preparing outline…','pending task remains after notice dismisses');
 const dialog=document.createElement('dialog');document.body.append(dialog);dialog.showModal();toast('Settings saved.');
 assert(!$('#toast').showPopover||$('#toast').matches(':popover-open'),'shared notification remains in top layer for modal settings');dialog.close();dialog.remove();
 toast('Complete.',{duration:0});await new Promise(r=>setTimeout(r,0));await settle();assert($('#toast').textContent==='Preparing outline…','timed notice expiry preserves running tasks');
 notifyProgress('second-task',null);notifyProgress('requests',null);assert($('#toast').classList.contains('hidden'),'card hides when tasks finish');

 assert($('#lib-tree [data-id="L1"] .t-toggle').getAttribute('aria-expanded')==='true','library root starts expanded');
 assert($('#lib-tree [data-id="C1"] .t-toggle').getAttribute('aria-expanded')==='false'&&!$('#lib-tree [data-id="C3"]'),'nested folders start collapsed');
 assert(!$('#lib-tree [data-id="C2"] .t-toggle'),'leaf folders have no disclosure button');
 const requestCount=requests.length,selectedFolder=lib.target;
 $('#lib-tree [data-id="C1"] .t-toggle').click();assert($('#lib-tree [data-id="C3"]')&&!$('#lib-tree [data-id="C4"]'),'opening parent leaves nested child collapsed');
 $('#lib-tree [data-id="C3"] .t-toggle').click();assert($('#lib-tree [data-id="C4"]'),'nested child expands');
 $('#lib-tree [data-id="C3"] .t-toggle').click();assert(!$('#lib-tree [data-id="C4"]'),'collapse nested child');
 $('#lib-tree [data-id="C1"] .t-toggle').click();assert(!$('#lib-tree [data-id="C3"]')&&!$('#lib-tree [data-id="C4"]'),'collapse hides all descendants');
 assert(lib.target===selectedFolder&&requests.length===requestCount,'disclosure does not select folder or fetch graph/items');
 assert(!JSON.parse(store.get('noctua.expandedFolders')).includes('C1'),'explicit expansion state saved');
 renderLibTree();assert(!$('#lib-tree [data-id="C3"]'),'refresh preserves collapsed branch');
 $('#lib-tree [data-id="C1"] .t-toggle').click();assert($('#lib-tree [data-id="C3"]')&&!$('#lib-tree [data-id="C4"]'),'reopening preserves nested collapsed state');
 $('#lib-tree [data-id="C3"] .t-toggle').click();assert($('#lib-tree [data-id="C4"]'),'nested child expands again');
 $('#lib-tree [data-id="L1"] .t-toggle').click();assert($('#lib-tree').children.length===1,'library root can collapse');
 $('#lib-tree [data-id="L1"] .t-toggle').click();

 const row=$('#library-rows tr');row.querySelector('[data-select-paper]').click();
 assert(lib.detail.key==='a'&&row.classList.contains('selected')&&row.isConnected,'selection preserves row for double-click and keyboard');
 assert(openedPDF.length===0,'single title click only shows details');
 row.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));assert(openedPDF.length===1&&openedPDF[0][0]==='a'&&openedPDF[0][1]==='tab','double-click opens Reader in new tab');
 assert(document.querySelectorAll('#library-table th').length===4&&row.children.length===4&&!row.querySelector('.paper-row-actions'),'library table omits Actions column');
 const noPDF=$('#library-rows tr[data-key="b"]');noPDF.querySelector('[data-select-paper]').click();
 noPDF.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));assert(openedPDF.length===1&&lib.detail.key==='b','paper without PDF only shows details');
 $('[data-library-sort="title"]').click();assert($('#library-rows tr').dataset.key==='b','sort by title');
 $('[data-library-sort="year-desc"]').click();assert($('#library-rows tr').dataset.key==='a','sort newest');
 $('[data-library-sort="year-desc"]').click();assert($('#library-rows tr').dataset.key==='b','reverse year sort');
 $('#library-table-filter').value='Hopper';$('#library-table-filter').dispatchEvent(new Event('input'));
 assert($('#library-rows').children.length===1&&$('#library-rows tr').dataset.key==='b','filter by author');
 assert($('header #search-form')&&!$('#stage #search-form'),'global paper search restored to header');
 assert(document.querySelectorAll('#library-table-filter').length===1&&$('.library-heading #library-table-filter'),'single filter shares the library heading');
 const searchRequests=requests.filter(p=>p.startsWith('/api/search')).length;
 $('#library-filter-control').style.transition='none';
 assert($('#library-filter-control').classList.contains('has-query'),'typing keeps filter expanded');
 assert($('#library-filter-control').getBoundingClientRect().width>120,'filter expands horizontally');
 assert($('#library-filter-control').getBoundingClientRect().right<=$('#stage').getBoundingClientRect().right,'filter stays in center pane');
 $('#stage').style.maxWidth='340px';
 assert($('#library-filter-control').getBoundingClientRect().right<=$('#stage').getBoundingClientRect().right,'filter fits narrow center pane');
 $('#stage').style.maxWidth='';
 $('#library-filter-control button').click();assert(document.activeElement===$('#library-table-filter'),'filter icon focuses field');
 $('#library-table-filter').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
 assert($('#library-rows').children.length===2&&!$('#library-filter-control').classList.contains('has-query'),'Escape clears filter and restores all papers');
 assert(requests.filter(p=>p.startsWith('/api/search')).length===searchRequests,'local filter makes no remote searches');

 $('#library-table-filter').value='';$('#library-table-filter').dispatchEvent(new Event('input'));
 $('#lib-tree [data-id="C2"]').click();await settle();assert(!$('#library-table-status').hidden&&$('#library-rows').children.length===0,'empty collection state');
 // A slow request for a previous folder cannot overwrite the current table.
 let resolveFolder;pendingFolder=new Promise(r=>resolveFolder=r);
 $('#lib-tree [data-id="C1"]').click();$('#lib-tree [data-id="L1"]').click();await settle();
 resolveFolder({ok:true,json:async()=>[fixtureItems[0]]});await settle();pendingFolder=null;
 assert(lib.target==='L1'&&$('#library-rows').children.length===2,'ignore stale folder response');
 $('[data-layout="network"]').click();await settle();
 assert(G.layout==='network'&&G.project.target==='L1'&&!visible($('#library-view')),'Network builds whole library');
 assert(!visible($('#library-filter-control'))&&visible($('#search-form')),'library filter hides in Network while global search remains');
 assert(visible($('#graph-filter-control')),'Network shows top-right graph filter');
 const extra=addNode({paperId:'filter-other',title:'Compiler history',authors:[{name:'Grace Hopper'}],year:2020,venue:'Computing',citationCount:12},'exp');
 G.selected='filter-other';
 const setGraphFilter=value=>{const input=$('#graph-filter');input.value=value;input.dispatchEvent(new Event('input'));};
 setGraphFilter('Ada');assert(visibleNodes().length===1&&visibleNodes()[0].id==='s1'&&$('#node-list').children.length===1,'graph and Papers filter together, even for a selected nonmatch');
 assert($('#filter').value==='Ada'&&$('#graph-filter-control').classList.contains('has-query'),'graph and sidebar filters stay in sync');
 setGraphFilter('no such paper');assert(visibleNodes().length===0&&!$('#graph-filter-empty').hidden,'empty graph filter state');
 $('#filter').value='2020';$('#filter').dispatchEvent(new Event('input'));assert(visibleNodes().length===1&&$('#graph-filter').value==='2020','sidebar filter updates graph and top-right field');
 $('#graph-filter').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert(visibleNodes().length===2&&!G.filter&&$('#graph-filter-empty').hidden,'Escape clears graph filter');
 setLayout('lineage');await settle();const beforeFilter=requests.length;
 setGraphFilter('Ada');assert(visibleNodes().length===1&&Number.isFinite(view.k),'Lineage filters and fits');
 setGraphFilter('Grace');assert(visibleNodes().length===1&&Number.isFinite(view.k)&&Number.isFinite(view.x),'equal-sized filtered subsets refresh Lineage targets');
 setGraphFilter('no such paper');assert(visibleNodes().length===0&&!$('#graph-filter-empty').hidden,'Lineage empty filter state');
 setLayout('library');assert(!visible($('#graph-filter-empty'))&&!visible($('#graph-filter-control')),'graph filter and empty state hide in Library');
 setLayout('lineage');setGraphFilter('Grace');
 assert(requests.length===beforeFilter,'Lineage text filtering makes no remote requests');
 setLayout('network');assert(G.filter==='grace'&&visibleNodes().length===1,'graph filter shared across layouts');
 await openProject('L1');await settle();assert(!G.filter&&!$('#graph-filter').value,'opening another graph clears graph filter');

 assert(visible($('#lib-tree'))&&visible($('#tab-nodes')),'Graph shows folder tree and papers together');
 assert(!$('#graph-folders > summary'),'redundant folder heading removed');
 assert($('#sort').dataset.selectIcon==='list-filter'&&$('#sort').closest('.graph-papers-heading'),'icon sort sits before paper filter');
 assert(!$('#graph-papers-title')&&!$('#node-count'),'redundant Papers count heading removed');
 assert($('#filter').placeholder===`Filter ${G.nodes.size} paper${G.nodes.size===1?'':'s'}`,'filter placeholder displays graph paper count');
 assert($('#sort').closest('.web-select').getBoundingClientRect().right<=$('#papers-filter-control').getBoundingClientRect().left,'sort precedes left-aligned filter');
 $('#papers-filter-control button').click();assert(document.activeElement===$('#filter'),'paper magnifier focuses expanding filter');
 $('#filter').value='Ada';$('#filter').dispatchEvent(new Event('input'));assert($('#papers-filter-control').classList.contains('has-query')&&G.filter==='ada','paper filter expands and filters graph');
 $('#filter').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));assert(!G.filter&&!$('#papers-filter-control').classList.contains('has-query'),'Escape clears paper filter');
 const divider=$('#folder-divider');
 const defaultHeight=Math.min(440,Math.floor($('#research-sidebar').clientHeight*.65));
 assert(Math.abs($('#tab-library').getBoundingClientRect().height-defaultHeight)<=1,'folder pane starts at the taller default within sidebar bounds');
 setFolderHeight(180);const splitHeight=$('#tab-library').getBoundingClientRect().height;
 divider.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));assert($('#tab-library').getBoundingClientRect().height>splitHeight&&Number(store.get('noctua.folderHeight'))>180,'split resizes and persists using keyboard');
 setLayout('lineage');assert($('#tab-library').getBoundingClientRect().height>splitHeight,'Lineage shares folder split height');setLayout('network');
 divider.dispatchEvent(new MouseEvent('dblclick'));assert(Number(store.get('noctua.folderHeight'))===defaultHeight,'double-click restores the taller default');
 assert($('#tab-library').getBoundingClientRect().bottom<=$('#tab-nodes').getBoundingClientRect().top+1,'folder tree is above papers');
 assert(!$('#project-overview')&&!$('#proj-info'),'graph summary card removed');
 const rootBuilds=requests.filter(p=>p.startsWith('/api/project')).length;await setIncludeSubfolders(false);await settle();await setIncludeSubfolders(true);await settle();assert(requests.filter(p=>p.startsWith('/api/project')).length===rootBuilds,'subfolder scope does not rebuild the library-root graph');
 showTab('library');$('#lib-tree [data-id="C1"]').click();await settle();
 assert(G.project.target==='C1'&&G.layout==='network'&&!$('#tab-nodes').classList.contains('hidden'),'folder selection opens its graph without a Projects tab');
 const folderBuilds=requests.filter(p=>p.startsWith('/api/project')).length;await setIncludeSubfolders(false);await settle();assert(G.project.target==='C1'&&requests.filter(p=>p.startsWith('/api/project')).length===folderBuilds+1,'scope change refreshes the current collection graph');await setIncludeSubfolders(true);await settle();

 $('[data-layout="lineage"]').click();await settle();assert(document.body.classList.contains('lineage'),'Lineage view');setGraphSidebarList('nodes');assert(visible($('#lib-tree'))&&visible($('#tab-nodes'))&&visible($('#graph-list-switch'))&&!visible($('#tab-threads')),'Lineage defaults to one lower list beside visible folders');
 $('[data-graph-list="threads"]').click();assert(!visible($('#tab-nodes'))&&visible($('#tab-threads'))&&visible($('#lib-tree')),'Threads switch replaces Papers without hiding folders');
 assert($('[data-graph-list="threads"]').getAttribute('aria-pressed')==='true'&&store.get('noctua.graphSidebarList')==='threads','list selection is accessible and remembered');
 setLayout('network');assert(visible($('#tab-nodes'))&&!visible($('#tab-threads'))&&!visible($('#graph-list-switch')),'Graph always shows Papers');
 setLayout('lineage');assert(visible($('#tab-threads'))&&!visible($('#tab-nodes')),'Lineage restores selected Threads list');
 $('[data-graph-list="nodes"]').click();assert(visible($('#tab-nodes'))&&!visible($('#tab-threads')),'Papers switch restores filter and paper list');
 $('[data-layout="library"]').click();assert(visible($('#library-view'))&&$('#tab-library').classList.contains('hidden')===false,'return to Library');

 assert(searchEngine==='arxiv'&&$('#search-engine').value==='arxiv','arXiv is the initial default engine');
 assert(normalizeSearchEngineOrder(['openalex','bad','openalex']).join(',')==='openalex,arxiv,semantic-scholar,google-scholar','saved engine order filters unknown/duplicate engines and restores missing choices');
 const orderHost=document.createElement('div');orderHost.innerHTML=searchSettingsSection();document.body.append(orderHost);mountSearchEngineOrder(orderHost.querySelector('section'));
 const orderRows=()=>[...orderHost.querySelectorAll('[data-search-engine]')];
 const engineRequestsBefore=requests.length;
 const transfer=new DataTransfer(),drag=engine=>new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:transfer});
 orderRows()[2].dispatchEvent(drag());
 const firstRect=orderRows()[0].getBoundingClientRect();
 const over=new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer,clientY:firstRect.top+1});orderRows()[0].dispatchEvent(over);assert(over.defaultPrevented,'settings accepts local engine drag');
 orderRows()[0].dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer,clientY:firstRect.top+1}));
 assert(searchEngines[0]==='openalex'&&[...$('#search-engine').options][0].value==='openalex','drag reorders menu immediately');
 assert(orderHost.querySelectorAll('.search-order-default').length===1&&orderHost.querySelector('.search-order-default').closest('li').dataset.searchEngine==='openalex','Default badge follows the first engine after dragging');
 assert(JSON.parse(store.get('noctua.searchEngineOrder'))[0]==='openalex'&&searchEngine==='openalex'&&$('#search-engine').value==='openalex','moving an engine to the top saves and selects the new default');
 assert(requests.length===engineRequestsBefore,'reordering does not launch a search');
 $('#search').dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));assert(searchEngine==='arxiv','Tab follows the reordered array from its default');
 $('#search').dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));assert(searchEngine==='semantic-scholar','Tab keeps following the reordered positions');
 assert(!orderHost.querySelector('button'),'engine order is adjusted by dragging without arrow buttons');
 const savedOrder=[...searchEngines];orderRows()[1].dispatchEvent(drag());orderRows()[1].dispatchEvent(new DragEvent('dragend',{bubbles:true}));
 assert(searchEngines.join(',')===savedOrder.join(',')&&!orderHost.querySelector('.dragging'),'cancelled drag preserves saved order');
 orderHost.remove();$('#search').value='';setSearchEngineOrder(defaultSearchEngines);setSearchEngine('arxiv');

 const initialOpen=window.open,externalSearches=[];
 window.open=(...args)=>{externalSearches.push(args);};
 $('#search').value='graph networks';$('#search').dispatchEvent(new Event('input'));
 await search('graph networks');await settle();
 assert(requests.some(p=>p.includes('engine=arxiv')),'arXiv uses its own provider');
 assert(!$('#tab-results .hint').textContent.includes('arXiv')&&!$('#tab-results .hint').textContent.includes('or click')&&$('#tab-results .hint').textContent.includes('Shift+Enter: graph'),'result hint omits engine and describes keyboard graph shortcut');
 assert($('#tab-results .search-graph')&&$('#tab-results .search-pdf'),'every result has explicit Graph and PDF buttons');
 const engineTab=new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true});
 $('#search').dispatchEvent(engineTab);await settle();
 assert(engineTab.defaultPrevented&&searchEngine==='semantic-scholar'&&$('#search').value==='graph networks','Tab switches engine and preserves query');
 assert(JSON.parse(store.get('noctua.searchEngineOrder'))[0]==='arxiv'&&searchEngine==='semantic-scholar','temporary engine selection does not change the saved default');
 $('#search').dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));await settle();
 assert(searchEngine==='openalex'&&requests.some(p=>p.includes('engine=openalex')),'Tab searches OpenAlex');
 $('#search').dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));await settle();
 assert(searchEngine==='google-scholar'&&externalSearches.length===0,'Tab selects Google without launching a tab');
 $('#search-form').requestSubmit();await settle();
 assert(externalSearches.length===1&&externalSearches[0][0]==='https://scholar.google.com/scholar?q=graph%20networks'&&externalSearches[0][1]==='_blank','Google submit opens encoded query in a new tab');
 $('#search').dispatchEvent(new Event('input'));await settle();assert(externalSearches.length===1,'Google typing never opens popups');
 const exitSearch=new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true});$('#search').dispatchEvent(exitSearch);assert(!exitSearch.defaultPrevented,'Shift+Tab retains focus navigation');
 $('#search').dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));await settle();assert(searchEngine==='arxiv','Tab wraps back to arXiv');
 let resolveEngine;pendingSearch=new Promise(r=>resolveEngine=r);const staleEngine=search('old provider');
 $('#search').value='';setSearchEngine('openalex');
 resolveEngine({ok:true,json:async()=>({data:[{...fixturePaper,title:'Wrong provider'}],total:1})});await staleEngine;pendingSearch=null;
 assert(!$('#tab-results').textContent.includes('Wrong provider'),'engine switch rejects stale provider response');
 searchState={q:'unidentified',total:1,next:null};results=[{paperId:null,title:'Unidentified paper',searchProvider:'openalex',url:'https://openalex.org/W1'}];renderResults();
 assert(!$('#tab-results li').textContent.includes('0 citations')&&$('#tab-results .search-source'),'unknown citation counts stay unknown and source link remains available');
 const savedSelection=G.selected;G.selected=null;renderDetails();assert(!$('#details').textContent.includes('Unidentified paper'),'missing provider identifier does not select an unrelated paper');G.selected=savedSelection;
 $('#tab-results .search-graph').click();await settle();assert(requests.some(p=>p.startsWith('/api/match?title=Unidentified')),'papers without DOI resolve by title before graph');
 window.open=initialOpen;$('#search').value='';setSearchEngine('semantic-scholar');
 $('#search').value='keyboard';searchState={q:'keyboard',total:2,next:null};
 results=[fixturePaper,{...fixturePaper,paperId:'s2',title:'Second result',url:'https://arxiv.org/abs/1706.03762'}];searchActiveIndex=-1;renderResults();
 const pressSearch=(key,options={})=>{const event=new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...options});$('#search').dispatchEvent(event);return event;};
 assert(searchActiveIndex===0&&$('#search-result-0').getAttribute('aria-selected')==='true','first result starts selected');
 assert(pressSearch('ArrowDown').defaultPrevented&&searchActiveIndex===1,'Down selects next result without moving input caret');
 assert($('#search').getAttribute('aria-activedescendant')==='search-result-1'&&$('#search-result-1').classList.contains('selected'),'keyboard selection is visible and announced');
 pressSearch('ArrowDown');assert(searchActiveIndex===1,'Down stops at last result');
 pressSearch('ArrowUp');pressSearch('ArrowUp');assert(searchActiveIndex===0,'Up stops at first result');
 renderResults();assert(searchActiveIndex===0&&$('#search-result-0').classList.contains('selected'),'background result rendering keeps selection');
 pressSearch('ArrowDown');
 const pdfBefore=openedPDF.length,searchBeforePDF=requests.filter(p=>p.startsWith('/api/search')).length,addsBefore=requests.filter(p=>p==='/api/library/add').length;
 let releasePDF;pendingPDF=new Promise(r=>releasePDF=r);
 assert(pressSearch('Enter').defaultPrevented,'Enter handles selected PDF instead of submitting another search');
 assert(pressSearch('Enter',{repeat:true}).defaultPrevented&&pressSearch('Enter').defaultPrevented,'Enter stays suppressed while PDF is opening');await settle();
 assert(requests.filter(p=>p==='/api/library/add').length===addsBefore+1,'held Enter does not open the paper repeatedly');
 assert(savedSearchPaper.title==='Second result'&&savedSearchPaper.externalIds.ArXiv==='1706.03762','Enter uses the selected row and preserves arXiv PDF access from provider source links');
 releasePDF({ok:true,json:async()=>({key:'keyboard-paper',paper:{has_pdf:true}})});pendingPDF=null;await settle();
 assert(openedPDF.length===pdfBefore+1&&openedPDF.at(-1)[0]==='keyboard-paper','Enter saves/downloads and opens the selected PDF');
 assert(requests.filter(p=>p.startsWith('/api/search')).length===searchBeforePDF,'Enter on a selected result does not search again');
 assert($('#tab-results').classList.contains('hidden')&&!$('#search').hasAttribute('aria-activedescendant'),'opening PDF closes list and clears active descendant');
 $('#search').dispatchEvent(new FocusEvent('focus'));pressSearch('ArrowUp');
 const graphsBefore=requests.filter(p=>p.startsWith('/api/graph')).length;
 assert(pressSearch('Enter',{shiftKey:true}).defaultPrevented,'Shift+Enter is handled');await settle();
 assert(requests.filter(p=>p.startsWith('/api/graph')).length===graphsBefore+1&&openedPDF.length===pdfBefore+1,'Shift+Enter opens graph without opening PDF');
 $('#search').dispatchEvent(new FocusEvent('focus'));
 const pdfBeforeRow=openedPDF.length,graphsBeforeRow=requests.filter(p=>p.startsWith('/api/graph')).length;
 $('#tab-results li').click();await settle();
 assert(openedPDF.length===pdfBeforeRow+1&&requests.filter(p=>p.startsWith('/api/graph')).length===graphsBeforeRow,'clicking paper row opens PDF without building graph');
 $('#search').dispatchEvent(new FocusEvent('focus'));
 const pdfBeforeButton=openedPDF.length,graphsBeforeButton=requests.filter(p=>p.startsWith('/api/graph')).length;
 $('#tab-results .search-graph').click();await settle();
 assert(openedPDF.length===pdfBeforeButton&&requests.filter(p=>p.startsWith('/api/graph')).length===graphsBeforeButton+1,'Graph button builds graph without triggering row PDF action');
 $('#search').dispatchEvent(new FocusEvent('focus'));
 const pdfBeforePDFButton=openedPDF.length,graphsBeforePDFButton=requests.filter(p=>p.startsWith('/api/graph')).length;
 $('#tab-results .search-pdf').click();await settle();
 assert(openedPDF.length===pdfBeforePDFButton+1&&openedPDF.at(-1)[1]===undefined&&requests.filter(p=>p.startsWith('/api/graph')).length===graphsBeforePDFButton,'PDF button opens Reader here exactly once without building a graph');

 $('#search').value='';$('#search').dispatchEvent(new Event('input'));
 assert(searchActiveIndex===-1&&$('#search').getAttribute('aria-expanded')==='false','editing query resets keyboard selection');

 $('#search-form > button[type="submit"]').click();assert(document.activeElement===$('#search'),'search icon focuses field');
 const pause=ms=>new Promise(r=>setTimeout(r,ms));
 const beforeLive=requests.filter(p=>p.startsWith('/api/search')).length;
 const originalCenter=G.centerId,originalLayout=G.layout;
 $('#search').value='network';$('#search').dispatchEvent(new Event('input'));
 $('#search').value='networks';$('#search').dispatchEvent(new Event('input'));
 await pause(450);await settle();
 assert(requests.filter(p=>p.startsWith('/api/search')).length===beforeLive+1,'typing debounces into one search without Enter');
 assert($('#tab-results li').textContent.includes('Zebra networks'),'live search lists papers');
 assert(G.centerId===originalCenter&&G.layout===originalLayout,'typing preserves current graph and view');
 $('#search').value='1706.03762';$('#search').dispatchEvent(new Event('input'));await pause(450);await settle();
 assert(requests.includes('/api/paper?id=ARXIV%3A1706.03762')&&$('#tab-results li'),'identifier lookup shows a paper result');
 assert(G.centerId===originalCenter,'identifier lookup waits for selection');
 const beforeClear=requests.length;
 $('#search').value='cancelled';$('#search').dispatchEvent(new Event('input'));
 $('#search').value='';$('#search').dispatchEvent(new Event('input'));await pause(450);
 assert(requests.length===beforeClear&&$('#tab-results').classList.contains('hidden'),'clearing cancels pending search');
 $('#search').value='dismissed';$('#search').dispatchEvent(new Event('input'));
 $('#search').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await pause(450);
 assert(requests.length===beforeClear&&$('#tab-results').classList.contains('hidden'),'Escape cancels pending search');

 $('#search').value='networks';$('#search').dispatchEvent(new Event('input'));$('#search-form').requestSubmit();await settle();
 assert(!$('#tab-results').classList.contains('hidden'),'header search opens results');
 $('#search').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert($('#tab-results').classList.contains('hidden'),'Escape dismisses results');
 $('#search').focus();$('#search').dispatchEvent(new FocusEvent('focus'));assert(!$('#tab-results').classList.contains('hidden'),'focus restores matching results');
 $('#library-title').dispatchEvent(new Event('pointerdown',{bubbles:true}));assert($('#tab-results').classList.contains('hidden'),'outside click dismisses results');
 // A response to an edited query must not replace newer results.
 let resolveSearch;pendingSearch=new Promise(r=>resolveSearch=r);const old=search('old');
 $('#search').value='new';$('#search').dispatchEvent(new Event('input'));
 resolveSearch({ok:true,json:async()=>({data:[{...fixturePaper,title:'Stale result'}],total:1})});await old;pendingSearch=null;
 assert(!$('#tab-results').textContent.includes('Stale result'),'ignore stale query response');
 $('#search').value='networks';$('#search').dispatchEvent(new Event('input'));await search('networks');
 $('#tab-results .search-graph').click();await settle();assert(G.layout==='network'&&G.centerId==='s1'&&$('#tab-results').classList.contains('hidden'),'search result opens paper network');
 $('[data-layout="library"]').click();$('#lib-tree [data-id="C1"]').click();await settle();
 $('[data-layout="lineage"]').click();await settle();assert(G.project.target==='C1'&&G.layout==='lineage','collection carries into visualization');

 // Exercise the actual Fit button with a wide, multi-lane timeline and stale targets.
 resetGraph();G.project={target:'C1'};
 for(let i=0;i<18;i++){
  const id='fit-'+i;
  addNode({...fixturePaper,paperId:id,title:'Fit paper '+i,year:i===17?null:1990+i*2,citationCount:1000+i*500},'proj');
  if(i>0&&i<15&&i%5!==0)addEdge(id,'fit-'+(i-1));
 }
 LIN.sig='';
 for(const n of G.nodes.values()){n.tx=999999;n.ty=-999999;}
 const assertTimelineFits=()=>{
  const w=canvas.clientWidth,h=canvas.clientHeight,epsilon=.01;
  assert(Number.isFinite(view.k)&&view.k>0,'finite positive fit scale');
  for(const n of visibleNodes()){
   const x=w/2+view.x+n.tx*view.k,y=h/2+view.y+n.ty*view.k,r=radius(n)*view.k;
   assert(x-r>=-epsilon&&x+r<=w+epsilon,'paper fits horizontally');
   assert(y-r>=lineageAxisY()+16-epsilon&&y+r<=$('#stage .legend').offsetTop+epsilon,'paper clears axis and legend');
  }
  for(const b of LIN.lay.bands){
   assert(h/2+view.y+b.y0*view.k>=lineageAxisY()+32-epsilon,'lane clears wrapped controls and axis');
   assert(h/2+view.y+b.y1*view.k<=$('#stage .legend').offsetTop-24+epsilon,'lane clears legend');
  }
 };
 view.x=4000;view.y=-4000;view.k=4;G.autoFit=true;
 $('#fit').click();assertTimelineFits();assert(!G.autoFit,'manual fit cancels pending automatic fit');
 const fitted=[view.x,view.y,view.k];$('#fit').click();
 assert(fitted.every((v,i)=>Math.abs(v-[view.x,view.y,view.k][i])<.0001),'repeated Fit is stable');
 $('#stage').style.maxWidth='340px';view.x=4000;view.y=-4000;$('#fit').click();assertTimelineFits();
 $('#stage').style.maxWidth='';$('#fit').click();assertTimelineFits();

 const originalMax=LIN.max;
 for(const max of [12,16,24]){
  assert([...$('#thread-count').options].some(option=>Number(option.value)===max),'larger thread limit is selectable');
  $('#thread-count').value=String(max);$('#thread-count').dispatchEvent(new Event('change'));
  assert(LIN.max===max&&store.get('noctua.threadCount')===String(max),'larger thread limit persists');
 }
 const testIds=[],testTimes=new Map(),testEdges=[];
 for(let i=0;i<24;i++){const chain=[`test-${i}-a`,`test-${i}-b`,`test-${i}-c`];testIds.push(...chain);chain.forEach((id,j)=>testTimes.set(id,2000+j));testEdges.push([chain[1],chain[0]],[chain[2],chain[1]]);}
 assert(computeThreads(testIds,testTimes,testEdges,24).threads.length===24,'thread discovery supports more than eight paths');
 assert(computeThreads(testIds,testTimes,testEdges,12).threads.length===12,'larger limit remains an upper bound');
 $('#thread-count').value=String(originalMax);$('#thread-count').dispatchEvent(new Event('change'));
 const cards=()=>[...document.querySelectorAll('#thread-list .thread-card[data-thread]')];
 assert(cards().length>0&&cards().every(card=>card.classList.contains('collapsed')),'new Lineage cards default to collapsed');
 assert(!$('#threads-collapse')&&!$('#threads-auto'),'bulk expansion and automatic summary controls removed from Threads');
 assert(!$('#threads-explain')&&$('#explain-threads').textContent==='Summarize threads','one toolbar summary button replaces duplicate Summarize again action');
 assert(!$('#thread-list').textContent.includes('citation links in time order')&&!$('#thread-list').textContent.includes('A thread is the citation chain'),'redundant thread count and help copy removed');
 const summarySettings=document.createElement('div');summarySettings.innerHTML=threadSummarySettings();assert(summarySettings.querySelector('#setup-threads-auto').checked===LIN.auto,'Settings reflects saved automatic summary preference');
 setThreadsAuto(false);assert(!LIN.auto&&store.get('noctua.threadsAuto')==='0','Settings preference disables and persists automatic summaries');
 summarySettings.innerHTML=threadSummarySettings();assert(!summarySettings.querySelector('#setup-threads-auto').checked,'Settings renders persisted off state');
 setThreadsAuto(true);assert(LIN.auto&&store.get('noctua.threadsAuto')==='1','Settings preference enables and persists automatic summaries');
 clearTimeout(LIN.autoTimer);
 cards()[0].querySelector('[data-toggle]').click();
 assert(cards()[0].querySelector('[data-toggle]').getAttribute('aria-expanded')==='true'&&visible(cards()[0].querySelector('.thread-body')),'click expands card details');
 renderThreads();assert(!cards()[0].classList.contains('collapsed'),'refresh preserves manually expanded card');
 cards()[0].querySelector('[data-toggle]').click();assert(cards().every(card=>card.classList.contains('collapsed')),'click collapses again');
 const thread=LIN.res.threads[0];
 if(thread){focusThread(0);assert(Number.isFinite(view.k)&&view.k>0,'thread fit remains usable');}
 setLayout('network');view.x=4000;$('#fit').click();assert(Math.abs(view.x)<4000,'Network Fit button also executes');
 G.project=null;
 assert(testErrors.length===0,'runtime errors: '+testErrors.join('; '));
 // Leave a populated table for visual inspection.
 $('[data-layout="library"]').click();$('#lib-tree [data-id="L1"]').click();await settle();
 $('#search').value='';$('#search').dispatchEvent(new Event('input'));$('#search').blur();
 window.webkit.messageHandlers.result.postMessage('PASS: Compact Library/Papers navigation, default folder expansion, subfolder scope, complete library table, sorting/filtering, selection/PDF actions, stale folder/query protection, all three visualizations, header search/results and expanding local filter, Fit button/Lineage bounds, default save folder, and shared notifications');
})().catch(e=>window.webkit.messageHandlers.result.postMessage('FAIL: '+e.message+'\n'+e.stack+'\nRuntime: '+testErrors.join('; ')));
</script>
"""#
html=html.replacingOccurrences(of:"</body>",with:checks+"</body>")
let fixture=output.appendingPathComponent("index.html")
try html.write(to:fixture,atomically:true,encoding:.utf8)
let app=NSApplication.shared
class Handler:NSObject,WKScriptMessageHandler,WKNavigationDelegate {
 var result:String?
 func userContentController(_ c:WKUserContentController,didReceive m:WKScriptMessage){result=String(describing:m.body)}
 func webView(_ webView:WKWebView,didFailProvisionalNavigation navigation:WKNavigation!,withError error:Error){result="FAIL: \(error)"}
}
let handler=Handler(),config=WKWebViewConfiguration()
config.websiteDataStore = .nonPersistent()
config.preferences.setValue(true,forKey:"allowFileAccessFromFileURLs")
config.userContentController.add(handler,name:"result")
let web=WKWebView(frame:NSRect(x:0,y:0,width:1440,height:900),configuration:config)
web.navigationDelegate=handler
web.loadFileURL(fixture,allowingReadAccessTo:root)
let deadline=Date().addingTimeInterval(35)
while handler.result==nil && Date()<deadline {RunLoop.current.run(until:Date().addingTimeInterval(0.05))}
let result=handler.result ?? "FAIL: WebKit research test timed out"
print(result)
if !result.hasPrefix("PASS:"){exit(1)}
var captured=false
web.takeSnapshot(with:nil){image,error in
 if let image=image,let tiff=image.tiffRepresentation,let rep=NSBitmapImageRep(data:tiff),let png=rep.representation(using:.png,properties:[:]){try? png.write(to:output.appendingPathComponent("library.png"))}
 captured=true
}
while !captured && Date()<deadline {RunLoop.current.run(until:Date().addingTimeInterval(0.05))}
