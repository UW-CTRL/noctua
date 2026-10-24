// macOS: swift tests/pdf-objects.swift
import Foundation
import JavaScriptCore
let c=JSContext()!
c.exceptionHandler={_,e in print(e!.toString()!);exit(1)}
c.evaluateScript("const window=globalThis;")
c.evaluateScript(try String(contentsOfFile:"web/pdf-objects.js",encoding:.utf8))
c.evaluateScript(#"""
function assert(v,m){if(!v)throw Error(m)}
const text=(text,x,y,w,h=.015)=>({text,rect:[x,y,w,h]});
const figure=NoctuaPDFObjects.detect([text('Figure 2: A model diagram',.1,.4,.8),text('Figure 2 shows the model in prose',.1,.7,.8)],[[.1,.12,.8,.25]]);
assert(figure.length===1&&figure[0].kind==='figure'&&figure[0].rect[1]<.13&&figure[0].text.includes('A model diagram'),'figure region must cover its graphic and caption, not prose references');
const table=NoctuaPDFObjects.detect([text('Table 4: Evaluation',.1,.1,.8),text('Model Accuracy',.1,.16,.5),text('Method 94.5',.1,.19,.5)],[[.1,.14,.8,.12]]);
assert(table.length===1&&table[0].kind==='table'&&table[0].text.includes('94.5'),'table attachment must include available cell text');
const cells=[text('Table 1: Results',.1,.1,.8)];for(let row=0;row<10;row++)for(let col=0;col<4;col++)cells.push(text('Cell '+row+':'+col,.1+col*.2,.15+row*.018,.08));const many=NoctuaPDFObjects.detect(cells,[[.1,.14,.8,.04]]);assert(many.length===1&&many[0].text.includes('Cell 9:3')&&many[0].rect[1]+many[0].rect[3]>.32,'table bounds must count complete rows, not individual cells');
const algorithm=NoctuaPDFObjects.detect([text('Algorithm 1: Training',.1,.1,.8),text('Initialize parameters',.1,.15,.6),text('Repeat until convergence',.1,.18,.6)],[]);
assert(algorithm.length===1&&algorithm[0].kind==='algorithm','unruled algorithm text must form a selectable region');
const split=NoctuaPDFObjects.detect([text('Algorithm 2',.1,.1,.15),text('Learning procedure',.26,.1,.3),text('Initialize parameters',.1,.15,.6),text('Repeat until convergence',.1,.18,.6)],[]);assert(split.length===1&&split[0].label==='Algorithm 2','a separately styled caption label must not require a colon');
const ruled=NoctuaPDFObjects.detect([text('Algorithm 1: Training',.1,.1,.8),text('Initialize parameters',.1,.15,.6),text('Repeat until convergence',.1,.18,.6)],[[.1,.14,.8,.001],[.1,.21,.8,.001]]);assert(ruled.length===1&&ruled[0].rect[3]>.08,'thin horizontal rules must not collapse an algorithm to a single line');
assert(NoctuaPDFObjects.detect([text('Figure 2 shows an improvement.',.1,.4,.8)],[[.1,.12,.8,.25]]).length===0,'in-text figure references must not become object captions');
const trimmed=NoctuaPDFObjects.detect([text('Figure 2: A model diagram',.1,.4,.8),text('This preceding paragraph should stay outside the figure box.',.1,.13,.8)],[[.1,.12,.8,.25]]);assert(trimmed[0].rect[1]>.14,'generous form bounds must not include preceding body text');
assert(NoctuaPDFObjects.detect([text('Figure 2: Missing graphic',.1,.4,.8)],[]).length===0,'do not invent bounds for a missing figure');
const longCaption=[text('Figure 3: A long mathematical caption',.1,.4,.8)];
for(let row=1;row<=10;row++){const y=.4+row*.018;longCaption.push(text('Caption continuation '+row+' describes the mathematical construction.',.1,y,.28));longCaption.push(text('∑',.4,y-.006,.025,.025));longCaption.push(text('with additional explanation for this line.',.435,y,.465));}
longCaption.push(text('This following body paragraph must remain outside the figure.',.1,.65,.8));
const longFigure=NoctuaPDFObjects.detect(longCaption,[[.1,.14,.8,.24]]);
assert(longFigure.length===1&&longFigure[0].text.includes('Caption continuation 10')&&longFigure[0].rect[1]+longFigure[0].rect[3]>.595,'long captions and tall inline math must not be cut off');
assert(!longFigure[0].text.includes('following body paragraph')&&longFigure[0].rect[1]+longFigure[0].rect[3]<.64,'caption extension must stop at the following paragraph');
const stacked=NoctuaPDFObjects.detect([text('Figure 4: Stacked panels',.1,.4,.8)],[[.1,.12,.8,.1],[.1,.26,.8,.1]]);
assert(stacked.length===1&&stacked[0].rect[1]<.13,'a shared caption must include both vertically stacked panels');
const referencedCaption=NoctuaPDFObjects.detect([
  text('Figure 11: Additional predictor rollouts. Same setup as',.1,.4,.8),
  text('Fig. 7: three context frames are encoded into latent representations.',.1,.418,.8),
  text('The predictor generates future states conditioned on actions.',.1,.436,.8),
  text('Both environments use the same decoder during evaluation.',.1,.454,.8)
],[[.1,.1,.8,.12],[.1,.25,.8,.12]]);
assert(referencedCaption.length===1&&referencedCaption[0].label==='Figure 11'&&referencedCaption[0].text.includes('Both environments')&&referencedCaption[0].rect[1]+referencedCaption[0].rect[3]>.469,'references at the start of a caption continuation must not create overlapping figure targets or truncate the real caption');
const tallFigure=NoctuaPDFObjects.detect([text('Figure 19: Training curves',.34,.85,.4)],[[.17,.13,.66,.7]]);
assert(tallFigure.length===1&&tallFigure[0].rect[1]<.14&&tallFigure[0].rect[1]+tallFigure[0].rect[3]>.865,'a figure occupying most of a page must not be discarded by the ordinary region height limit');
const bottomCaption=NoctuaPDFObjects.detect([text('Table 2: Caption below the table',.1,.4,.8),text('Top data row',.1,.28,.7),text('Middle data row',.1,.31,.7),text('Last data row',.1,.34,.7),text('Following body text must not become table rows.',.1,.46,.8)],[[.1,.37,.8,.001]]);
assert(bottomCaption.length===1&&bottomCaption[0].text.includes('Top data row')&&!bottomCaption[0].text.includes('Following body text')&&bottomCaption[0].rect[1]<.285,'bottom captions must collect table rows above them without absorbing body text below');
const ruledCaption=NoctuaPDFObjects.detect([
  text('Table 3: A caption that spans multiple lines.',.1,.2,.8),
  text('The final caption line describes the probing metrics.',.1,.218,.8),
  text('Agent Position',.4,.242,.2),text('Linear',.32,.263,.1),text('MLP',.6,.263,.1),
  text('Model',.2,.284,.1),text('Accuracy',.55,.284,.15),
  text('First method',.2,.305,.15),text('95.5',.55,.305,.1),
  text('Last method',.2,.326,.15),text('98.5',.55,.326,.1),
  text('The following body paragraph explains a different evaluation.',.1,.372,.8)
],[[.19,.24,.55,.001],[.3,.261,.4,.001],[.19,.282,.55,.001],[.19,.348,.55,.001]]);
assert(ruledCaption.length===1&&ruledCaption[0].text.includes('Last method')&&!ruledCaption[0].text.includes('following body')&&ruledCaption[0].rect[1]+ruledCaption[0].rect[3]<.36,'ruled tables must cover every data row and stop before nearby body text');
const centeredBottom=NoctuaPDFObjects.detect([
  text('Loss coefficient Initial value',.39,.6,.22),text('Alpha 18.0',.39,.625,.2),text('Beta 12',.39,.65,.2),
  text('Gamma 0.2',.39,.675,.2),text('Final coefficient 0.0',.39,.7,.2),
  text('Table 2: Coefficients',.34,.735,.32),text('Following section body text',.1,.8,.8)
],[[.38,.595,.24,.001],[.38,.725,.24,.001]]);
assert(centeredBottom.length===1&&centeredBottom[0].text.includes('Final coefficient')&&centeredBottom[0].rect[1]<.6&&centeredBottom[0].rect[1]+centeredBottom[0].rect[3]<.76,'centered tables with bottom captions and widely separated outer rules must retain both columns');
const twoColumns=[
  text('Figure 1: Left column illustration',.08,.3,.4),text('The left caption continues on this line.',.08,.318,.4),
  text('Figure 2: Right column illustration',.52,.3,.4),text('The right caption continues on this line.',.52,.318,.4),
  text('Table 1: Left column measurements',.08,.5,.4),text('Table 2: Right column measurements',.52,.5,.4),
  text('Left header',.08,.54,.35),text('Left result 94.0',.08,.57,.35),
  text('Right header',.52,.54,.35),text('Right result 96.0',.52,.57,.35)
];
const columns=NoctuaPDFObjects.detect(twoColumns,[[.08,.12,.41,.15],[.51,.12,.41,.15],[.08,.535,.4,.001],[.08,.595,.4,.001],[.52,.535,.4,.001],[.52,.595,.4,.001]]);
assert(columns.length===4,'side-by-side figures and tables with narrow gutters must produce four independent attachments');
for(const region of columns){const left=region.label.endsWith('1');assert(left?region.rect[0]+region.rect[2]<.51:region.rect[0]>.50,'column regions must never include the neighboring object');assert(!region.text.includes(left?'Right result':'Left result'),'attachment text must stay in its own column');}
const spanning=NoctuaPDFObjects.detect([...twoColumns,text('Figure 3: A figure spanning both columns',.08,.9,.84)],[[.08,.68,.84,.18]]);
assert(spanning.some(region=>region.label==='Figure 3'&&region.rect[2]>.8),'full-width figures in two-column documents must retain both panels');
const shifted=NoctuaPDFObjects.detect(twoColumns.map(item=>({...item,rect:[item.rect[0]+.025,...item.rect.slice(1)]})),[[.105,.12,.41,.15],[.535,.12,.41,.15]]);
assert(shifted.filter(region=>region.kind==='figure').length===2,'column separation must follow the text gutter rather than a fixed page midpoint');
const runningHeader=NoctuaPDFObjects.detect([
  text('A running paper title across the top of the page',.2,.045,.6),
  text('Figure 1: Left-column graphic',.09,.3,.38),text('The figure caption continues in the left column.',.09,.318,.38),
  text('A paragraph occupying the right column.',.51,.15,.38),text('Another line of the right-column paragraph.',.51,.168,.38)
],[[.09,.07,.8,.001],[.11,.083,.34,.2]]);
assert(runningHeader.length===1&&runningHeader[0].rect[0]+runningHeader[0].rect[2]<.5,'a running-header rule must not merge a column figure into a full-width cluster');
const adjacentTables=NoctuaPDFObjects.detect([
 text('Table 1: First results',.52,.1,.4),text('First metric 94.0',.52,.14,.3),text('Last metric 95.0',.52,.24,.3),
 text('Table 2: Second results',.52,.29,.4),text('Second metric 96.0',.52,.35,.3),text('Final metric 97.0',.52,.38,.3)
],[[.52,.13,.4,.001],[.52,.26,.4,.001],[.52,.34,.4,.001],[.52,.405,.4,.001]]);
assert(adjacentTables.length===2&&adjacentTables[1].rect[1]>.28&&adjacentTables[1].text.includes('Final metric')&&!adjacentTables[1].text.includes('First metric'),'a lower table must not reuse the preceding table rules when its caption is close to the previous bottom border');
const verticalWatermark=NoctuaPDFObjects.detect([
 text('arXiv:0000.00000 journal preprint version',.025,.26,.02,.49),
 text('The abstract occupies the left column of this paper.',.12,.28,.32),
 text('Further abstract text remains beside the graphic.',.12,.298,.32),
 text('Figure 1: Growth of language models',.5,.425,.38),text('The full caption belongs to this figure.',.5,.443,.38),
 text('Right-column body text starts after the figure caption.',.5,.53,.38)
],[[.52,.259,.345,.156]]);
assert(verticalWatermark.length===1&&verticalWatermark[0].rect[1]<.26&&verticalWatermark[0].rect[1]+verticalWatermark[0].rect[3]>.458,'a rotated page watermark must not merge distant body lines or trim the figure down to its caption');
const shortCaption=NoctuaPDFObjects.detect([text('Figure 1: A compact learning pipeline.',.09,.7,.38),text('The complete description extends across the full page.',.09,.72,.75)],[[.1,.58,.75,.08]]);
assert(shortCaption.length===1&&shortCaption[0].rect[2]>.74&&shortCaption[0].text.includes('complete description'),'a short first caption line must not force a full-width figure into one column');
const raster={width:100,height:100,data:new Uint8ClampedArray(40000)};
for(let y=0;y<75;y++)for(let x=10;x<90;x++)raster.data.set([255,255,255,255],(y*100+x)*4);
for(let y=20;y<60;y++)for(let x=20;x<80;x++)raster.data.set([20,30,40,255],(y*100+x)*4);
const tight=NoctuaPDFObjects.tightenRect([.1,0,.8,.75],raster);
assert(tight[0]>.18&&tight[1]>.18&&tight[0]+tight[2]<.82&&tight[1]+tight[3]<.62,'invisible and white container padding must be trimmed to visible figure pixels');
const dark={width:100,height:100,data:new Uint8ClampedArray(40000)};for(let y=20;y<60;y++)for(let x=20;x<80;x++)dark.data.set([232,234,237,255],(y*100+x)*4);
assert(NoctuaPDFObjects.tightenRect([.1,0,.8,.75],dark,[32,33,36])[1]>.18,'light ink on a dark Reader page must retain tight bounds');
let savedRegion=null;const PDF={key:'paper',paper:{title:'Paper'},selection:{}};function updateChatContext(){}window.NoctuaChatSelections={add:passage=>savedRegion=passage};
const directEntry={number:2,objects:[],box:{classList:{remove(){}}}};assert(NoctuaPDFObjects.attach(directEntry,{kind:'figure',label:'Figure 2',rect:[.1,.2,.6,.3],text:'Caption'}),'figure click must attach directly');
assert(savedRegion?.source.region_label==='Figure 2'&&savedRegion.source.page===2&&savedRegion.anchor.pages[0].rects.length===1&&PDF.selection===null,'direct attachment must retain caption, page and region anchoring');
const ops={save:1,transform:2,paintImageXObject:3,restore:4,constructPath:5};
const boxes=NoctuaPDFObjects.graphicRects({fnArray:[1,2,3,4],argsArray:[[],[300,0,0,160,60,500],['image'],[]]},ops,{width:600,height:800,transform:[1,0,0,-1,0,800]});
assert(boxes.length===1&&Math.abs(boxes[0][0]-.1)<1e-9&&Math.abs(boxes[0][1]-.175)<1e-9&&Math.abs(boxes[0][2]-.5)<1e-9,'image bounds must honor PDF graphics transforms and viewport coordinates');
const clips=NoctuaPDFObjects.graphicRects({fnArray:[5,5],argsArray:[[28,[],[60,400,540,800]],[20,[],[100,500,500,700]]]},{...ops,endPath:28},{width:600,height:800,transform:[1,0,0,-1,0,800]});assert(clips.length===1&&Math.abs(clips[0][1]-.125)<1e-9,'unpainted clipping paths must not enlarge figure bounds');
const forms=NoctuaPDFObjects.graphicRects({fnArray:[6,5,7],argsArray:[[[1,0,0,1,0,0],[60,400,540,800]],[0,[],[100,500,500,700]],[]]},{...ops,paintFormXObjectBegin:6,paintFormXObjectEnd:7},{width:600,height:800,transform:[1,0,0,-1,0,800]});assert(forms.length===1&&Math.abs(forms[0][1]-.125)<1e-9&&Math.abs(forms[0][3]-.25)<1e-9,'blank form-container margins must not enlarge actual painted figure bounds');
const clippedOps={...ops,clip:8,eoClip:9,endPath:28,paintFormXObjectBegin:6,paintFormXObjectEnd:7};
const clippedList={fnArray:[1,8,5,1,2,3,4,4,2,3],argsArray:[[],[],[28,[],[60,500,540,700]],[],[480,0,0,500,60,200],['cropped'],[],[],[480,0,0,160,60,100],['next']]};
const clippedImages=NoctuaPDFObjects.graphicRects(clippedList,clippedOps,{width:600,height:800,transform:[1,0,0,-1,0,800]});
assert(clippedImages.length===2&&Math.abs(clippedImages[0][1]-.125)<1e-9&&Math.abs(clippedImages[0][3]-.25)<1e-9,'oversized images must be intersected with transformed clipping bounds');
assert(Math.abs(clippedImages[1][1]-.675)<1e-9&&Math.abs(clippedImages[1][3]-.2)<1e-9,'restoring graphics state must release the previous figure clip');
const separate=NoctuaPDFObjects.detect([text('Figure 8: Cropped images',.1,.4,.8),text('Figure 9: Separate plots',.1,.9,.8)],clippedImages);
assert(separate.length===2&&separate[0].rect[1]+separate[0].rect[3]<separate[1].rect[1],'adjacent figures with oversized clipped images must retain separate boxes');

"""#)
print("PASS: captioned objects, complete long captions, two-column objects and spanning figures, stacked panels, ruled tables, prose exclusion and clipped image bounds")
