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
const wrappedAlgorithmReference=NoctuaPDFObjects.detect([
 text('The bound depends on model uncertainty when the policy executes using',.176,.59,.647,.013),
 text('Algorithm 1. By Lemma 12, the objective is an optimistic upper bound.',.176,.604,.647,.013),
 text('The following paragraph establishes the performance guarantee.',.176,.618,.647,.013),
 text('Lemma 3. The policy satisfies the lower performance bound.',.176,.64,.647,.013),
 text('Proof. Consider the following cases.',.176,.66,.647,.013)
],[]);
assert(wrappedAlgorithmReference.length===0,'a sentence wrapping before Algorithm 1. must not turn the following proof into an algorithm attachment');
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
const nearTopChart=NoctuaPDFObjects.detect([
 text('A chart title that belongs to the figure',.2,.066,.6,.012),
 text('Figure 8: A plot near the top of the page',.1,.3,.8)
],[[.1,.085,.8,.001],[.3,.15,.4,.1]]);
assert(nearTopChart.length===1&&nearTopChart[0].rect[1]<.075,'a chart title and its top rule below the running-header band must remain inside the figure');
const samePageFigures=NoctuaPDFObjects.detect([
 text('Published as a conference paper at ICLR 2026',.176,.032,.302,.013),
 text('SOOPER SAILR CRPO Primal-Dual Baseline',.26,.104,.48,.009),
 text('(a) Safe online learning from an offline-trained policy.',.182,.229,.317,.011),
 text('(b) Vision control task.',.59,.229,.135,.011),
 text('Figure 5: Learning curves of the objective and constraint.',.176,.254,.647,.013),
 text('Both panels preserve safety while improving the policy.',.176,.268,.647,.013),
 text('SOOPER CRPO Baseline',.18,.316,.22,.009),
 text('Figure 6: Safe exploration on real hardware.',.176,.547,.647,.013),
 text('The caption describes the objective and constraint.',.176,.561,.647,.013),
 text('All seeds and the training video are included.',.176,.575,.647,.013),
 text('The following body paragraph is outside both figures.',.176,.625,.647,.013)
],[[.176,.049,.647,.001],[.26,.103,.48,.015],[.183,.12,.317,.104],[.5,.12,.317,.104],[.18,.33,.24,.2],[.45,.325,.37,.21]]);
const curveFigure=samePageFigures.find(r=>r.label==='Figure 5'),hardwareFigure=samePageFigures.find(r=>r.label==='Figure 6');
assert(samePageFigures.length===2&&curveFigure&&hardwareFigure,'both figures on the page must have independent annotation boxes');
assert(curveFigure.rect[1]>.09&&curveFigure.rect[1]<.105&&curveFigure.rect[0]+curveFigure.rect[2]>.815&&curveFigure.rect[1]+curveFigure.rect[3]>.28,'a content-width running-header rule must not join Figure 5 or lose either pair of plots and the caption');
assert(hardwareFigure.rect[1]>.3&&hardwareFigure.rect[1]+hardwareFigure.rect[3]>.588&&hardwareFigure.rect[1]+hardwareFigure.rect[3]<.61&&!hardwareFigure.text.includes('following body'),'Figure 6 must retain its graph, image and full caption without absorbing Figure 5 or following prose');
// Single-column body text can wrap tightly around a narrow figure.
for(const left of [false,true]){
 const x=left?.176:.59,bodyX=left?.43:.176,bodyWidth=left?.394:.4;
 const wrappedTexts=[text('An earlier full-width body paragraph.',.176,.52,.648,.013)];
 for(let row=0;row<8;row++)wrappedTexts.push(text('Adjacent body prose must remain outside the attachment.',bodyX,.58+row*.018,bodyWidth,.013));
 wrappedTexts.push(text('Figure 16: A floating chart',x,.748,.234,.013),text('The caption continues beside',x,.766,.234,.013),text('the surrounding body paragraph.',x,.784,.234,.013),text('Following full-width body paragraph.',.176,.812,.648,.013));
 const floating=NoctuaPDFObjects.detect(wrappedTexts,[[x+.005,.582,.223,.157]]);
 assert(floating.length===1&&floating[0].label==='Figure 16','a wrapped caption must remain detectable beside body text on either side');
 assert(floating[0].rect[1]>.57&&floating[0].rect[1]<.59&&floating[0].rect[1]+floating[0].rect[3]>.797&&floating[0].rect[1]+floating[0].rect[3]<.812,'floating figure bounds must include the graphic and complete caption without nearby paragraphs');
 assert(floating[0].text.includes('surrounding body paragraph')&&!floating[0].text.includes('Adjacent body')&&!floating[0].text.includes('Following full-width')&&!floating[0].text.includes('earlier full-width'),'attachment text must be collected from the local figure lane');
}
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
// A large vector figure can have separate PDF text above its painted panels.
const diagram=NoctuaPDFObjects.detect([
 text('This preceding paragraph contains enough prose to occupy a complete body line above the diagram.',.147,.219,.706,.0126),
 text('and typical sequences.',.147,.234,.158,.0126),
 text('a)',.147,.265,.013,.0113),text('b)',.413,.263,.014,.0113),
 text('Probability mass',.438,.273,.068,.0072),text('Typical sequence',.572,.273,.072,.0072),
 text('Entropy, redundancy',.748,.273,.085,.0072),
 text('Figure 4: Probability, redundancy, and typicality.',.147,.481,.706,.0126),
 text('The complete caption describes both panels.',.147,.496,.6,.0126)
],[[.153,.32,.209,.04],[.153,.393,.21,.014],[.457,.296,.042,.047],[.457,.386,.042,.047],[.527,.317,.163,.013],[.527,.41,.163,.013],[.716,.312,.136,.026],[.716,.406,.136,.026]]);
assert(diagram.length===1&&diagram[0].rect[1]<.263&&diagram[0].rect[1]>.247&&diagram[0].text.includes('Typical sequence')&&diagram[0].text.includes('a)'),'large vector diagrams must include separate headings and panel markers without preceding body text');
assert(!diagram[0].text.includes('typical sequences.'),'the final short line of a preceding paragraph must stay outside the diagram');
const titledPanels=NoctuaPDFObjects.detect([
 text('a) Independent random sampling',.147,.289,.239,.0117),
 text('c) Information content of different propositions',.411,.29,.34,.0117),
 text('Draw at random',.176,.313,.108,.0117),
 text('Figure 1: Probability and information',.147,.604,.706,.0126)
],[[.147,.325,.706,.25]]);
assert(titledPanels.length===1&&titledPanels[0].rect[1]<.289&&titledPanels[0].text.includes('a) Independent')&&titledPanels[0].text.includes('c) Information'),'panel markers followed by titles must extend the figure bounds even when neighboring headings merge into a long text row');
const headingFigure=NoctuaPDFObjects.detect([
 text('Optimal recording',.288,.201,.129,.0126),text('scheme:',.321,.216,.062,.0126),
 text('Probabilities',.157,.216,.089,.0126),
 text('Figure 2: Entropy and coding',.147,.55,.706,.0126)
],[[.147,.245,.706,.26]]);
assert(headingFigure.length===1&&headingFigure[0].rect[1]<.201&&headingFigure[0].text.includes('Optimal recording'),'figure headings at caption font size must extend bounds above the drawing');
const shortSpanning=NoctuaPDFObjects.detect([...twoColumns,text('Figure 3: Spanning panels',.08,.9,.3)],[[.08,.68,.84,.18]]);
assert(shortSpanning.some(region=>region.label==='Figure 3'&&region.rect[2]>.8),'a short caption must retain a spanning figure even when body text establishes two columns');
// Large illustrations can separate stacked panels by more than ordinary line spacing.
const widelyStacked=NoctuaPDFObjects.detect([
 text('a)',.177,.178,.027,.0236),text('b)',.538,.178,.029,.0236),
 text('Figure 6: Distribution and mapping views',.147,.75,.706,.0126)
],[[.225,.183,.134,.029],[.587,.183,.132,.029],[.198,.264,.327,.267],[.612,.34,.199,.155],[.225,.589,.267,.138],[.589,.628,.264,.099]]);
assert(widelyStacked.length===1&&widelyStacked[0].rect[1]<.178&&widelyStacked[0].text.includes('a)')&&widelyStacked[0].text.includes('b)'),'widely stacked vector panels and oversized panel markers must share their caption box');
const diagramTitle=NoctuaPDFObjects.detect([
 text('a)',.154,.233,.02,.0173),text('b)',.421,.238,.021,.0173),
 text('First draw',.207,.238,.076,.0122),text('A typical sequence',.459,.243,.143,.0122),
 text('c)',.414,.304,.02,.0173),text('Joint and conditional entropy of first 3 draws',.452,.308,.338,.0122),
 text('Figure 8: Entropy rate of a stochastic process',.147,.629,.706,.0126)
],[[.21,.275,.037,.1],[.459,.277,.394,.017],[.458,.33,.308,.086],[.183,.447,.178,.146],[.484,.452,.263,.133]]);
assert(diagramTitle.length===1&&diagramTitle[0].rect[1]<.233&&diagramTitle[0].text.includes('First draw')&&diagramTitle[0].text.includes('a)'),'a panel title within drawing bounds must not be mistaken for preceding full-width prose and trim off upper panels');
const separatedPanels=NoctuaPDFObjects.detect([
 text('Figure 1: Upper figure',.1,.24,.8),
 text('Figure 2: Lower figure',.1,.5,.8)
],[[.1,.12,.8,.08],[.1,.27,.8,.18]]);
assert(separatedPanels.length===2&&separatedPanels[1].rect[1]>.25,'a caption between nearby graphics must prevent stacked-panel expansion into another figure');
const channelGraphics=[[.6667,.3072,.0512,.063],[.2681,.2835,.3724,.1204],[.2264,.632,.034,.0237],[.2918,.4904,.4905,.2179]];
const channelLabels=[
 text('a) A noisy channel',.2176,.2432,.179,.0157),
 text('b) Extended noisy channel formed by 2 channel uses',.2188,.4451,.5112,.0157),
 text('First use',.4518,.4945,.0777,.0157),text('Second use',.4428,.6047,.107,.0157),
 text('Figure 16: An extended noisy channel',.1471,.7239,.706,.0126)
];
const extendedChannel=NoctuaPDFObjects.detect(channelLabels,channelGraphics);
assert(extendedChannel.length===1&&extendedChannel[0].rect[1]<.2432&&extendedChannel[0].text.includes('a) A noisy channel'),'a panel heading between separated drawings must connect the upper and lower panels to their shared caption');
const unconnectedChannel=NoctuaPDFObjects.detect(channelLabels.filter(item=>!item.text.startsWith('b)')),channelGraphics);
assert(unconnectedChannel.length===1&&unconnectedChannel[0].rect[1]>.4,'large gaps without a bridging panel heading must not absorb unrelated graphics');
const interruptedChannel=NoctuaPDFObjects.detect([...channelLabels,text('A full prose paragraph separates these drawings and must prevent them from being combined into one figure.',.147,.42,.706,.0126)],channelGraphics);
assert(interruptedChannel.length===1&&interruptedChannel[0].rect[1]>.43,'a panel heading must not bridge across an intervening body paragraph');
const raster={width:100,height:100,data:new Uint8ClampedArray(40000)};
for(let y=0;y<75;y++)for(let x=10;x<90;x++)raster.data.set([255,255,255,255],(y*100+x)*4);
for(let y=20;y<60;y++)for(let x=20;x<80;x++)raster.data.set([20,30,40,255],(y*100+x)*4);
const tight=NoctuaPDFObjects.tightenRect([.1,0,.8,.75],raster);
assert(tight[0]>.18&&tight[1]>.18&&tight[0]+tight[2]<.82&&tight[1]+tight[3]<.62,'invisible and white container padding must be trimmed to visible figure pixels');
const dark={width:100,height:100,data:new Uint8ClampedArray(40000)};for(let y=20;y<60;y++)for(let x=20;x<80;x++)dark.data.set([232,234,237,255],(y*100+x)*4);
assert(NoctuaPDFObjects.tightenRect([.1,0,.8,.75],dark,[32,33,36])[1]>.18,'light ink on a dark Reader page must retain tight bounds');
const palePanel={width:100,height:100,data:new Uint8ClampedArray(40000)};
for(let y=0;y<90;y++)for(let x=5;x<95;x++)palePanel.data.set([255,255,255,255],(y*100+x)*4);
for(let y=20;y<80;y++)for(let x=20;x<80;x++)palePanel.data.set([248,248,248,255],(y*100+x)*4);
for(let y=30;y<70;y++)for(let x=30;x<70;x++)palePanel.data.set([80,80,80,255],(y*100+x)*4);
const paleBounds=NoctuaPDFObjects.tightenRect([.05,0,.9,.9],palePanel);
assert(paleBounds[1]<.2&&paleBounds[1]+paleBounds[3]>.8&&paleBounds[0]>.18&&paleBounds[0]+paleBounds[2]<.82,'a pale algorithm background must stay inside its box even when code stops above the panel bottom; surrounding white padding must still be removed');
const darkPanel={width:100,height:100,data:new Uint8ClampedArray(40000)};
for(let y=0;y<90;y++)for(let x=5;x<95;x++)darkPanel.data.set([32,33,36,255],(y*100+x)*4);
for(let y=20;y<80;y++)for(let x=20;x<80;x++)darkPanel.data.set([38,39,42,255],(y*100+x)*4);
for(let y=30;y<70;y++)for(let x=30;x<70;x++)darkPanel.data.set([232,234,237,255],(y*100+x)*4);
const darkPanelBounds=NoctuaPDFObjects.tightenRect([.05,0,.9,.9],darkPanel,[32,33,36]);
assert(darkPanelBounds[1]<.2&&darkPanelBounds[1]+darkPanelBounds[3]>.8&&darkPanelBounds[0]>.18,'subtle algorithm backgrounds in dark Reader mode must retain their visible extent without the surrounding page background');
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
