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
// Random-paper audit: short captions can belong to a spanning table even
// when the surrounding body establishes two text columns.
const spanningShortTable=NoctuaPDFObjects.detect([...twoColumns.filter(t=>!/^Figure|^Table/.test(t.text)),
 text('Table 1',.0857,.7243,.045,.0107),text('Return trip effect per condition',.135,.7243,.249,.0107),text('Initial trip',.369,.751,.13,.0107),text('Return trip',.541,.751,.14,.0107),...Array.from({length:6},(_,i)=>text('4.34',.4,.77+i*.017,.04,.0107)),text('Final right-hand result',.719,.855,.19,.0107)
],[[.0857,.742,.8286,.001],[.0857,.884,.8286,.001]]);
assert(spanningShortTable.length===1&&spanningShortTable[0].rect[2]>.82&&spanningShortTable[0].text.includes('Final right-hand result'),'a short left-aligned caption must retain every column of a spanning table');
const unnumberedHeader=NoctuaPDFObjects.detect([
 text('Planning with Diffusion for Flexible Behavior Synthesis',.314,.057,.347,.0113),
 text('Figure 6. Guided sampling of complete trajectories.',.09,.33,.383,.0113),text('The left caption continues here.',.09,.345,.38,.0113),
 text('Figure 7. Fast planning performance.',.502,.308,.383,.0113),text('The right caption continues here.',.502,.323,.38,.0113),
 text('A body paragraph in the left column.',.09,.43,.38,.0126),text('Another left-column body line.',.09,.45,.38,.0126),
 text('A body paragraph in the right column.',.502,.43,.38,.0126),text('Another right-column body line.',.502,.45,.38,.0126)
],[[.09,.0727,.794,.001],[.09,.084,.38,.21],[.502,.084,.38,.19]]);
assert(unnumberedHeader.length===2&&unnumberedHeader.every(r=>r.rect[1]>.075&&!r.text.includes('Planning with Diffusion'))&&unnumberedHeader.find(r=>r.label==='Figure 6').rect[0]+unnumberedHeader.find(r=>r.label==='Figure 6').rect[2]<.49,'a small running title without a top page number must not merge neighboring figures');
const topOfPageTable=NoctuaPDFObjects.detect([
 text('Planning Horizon Method Safety Rate Average Distance and Planning Time',.088,.067,.87,.0088),text('Trial 1 80% 0.32 33.8',.088,.086,.87,.0088),text('Trial 2 90% 0.42 44.2',.088,.12,.87,.0088),text('TABLE II',.473,.269,.054,.0101)
],[[.088,.0637,.8695,.001],[.088,.0806,.8695,.001],[.088,.15,.8695,.001],[.088,.2646,.8695,.001]]);
assert(topOfPageTable.length===1&&topOfPageTable[0].rect[1]<.064&&topOfPageTable[0].text.includes('Planning Horizon'),'a small table header between two top-of-page rules is content, not a running title');
const floatedPictureTexts=[text('Figure 1:',.424,.655,.07,.0138),text('A robot reasons about traversability.',.501,.656,.381,.0126),text('The caption continues across the image lane.',.424,.6715,.459,.0126),text('and finishes here.',.424,.6866,.30,.0126)];
for(let i=0;i<14;i++)floatedPictureTexts.push(text('The surrounding prose must remain outside this picture.',.117,.39+i*.02,.28,.0138));
const floatedPicture=NoctuaPDFObjects.detect(floatedPictureTexts,[[.117,.345,.766,.294]]);
assert(floatedPicture.length===1&&floatedPicture[0].rect[0]>.41&&floatedPicture[0].rect[1]+floatedPicture[0].rect[3]>.699&&floatedPicture[0].text.includes('finishes here')&&!floatedPicture[0].text.includes('surrounding prose'),'a floating picture crossing the page midpoint must keep its caption separate from adjacent body text');
const besideCaptionTexts=[text('Figure 1: A policy avoids the obstacles.',.533,.105,.291,.0126),text('The policy changes when the safety criterion triggers.',.533,.12,.291,.0126),text('This caption describes the first diagram.',.533,.135,.291,.0126),text('Figure 2: Exploration and expansion sets.',.176,.433,.647,.0126)];
const besideCaption=NoctuaPDFObjects.detect(besideCaptionTexts,[[.193,.133,.326,.156],[.205,.303,.58,.115]]);
assert(besideCaption.length===2&&besideCaption[0].label==='Figure 1'&&besideCaption[0].rect[0]<.2&&besideCaption[0].rect[1]+besideCaption[0].rect[3]<.31&&besideCaption[1].rect[1]>.29,'a side caption must attach its neighboring drawing without consuming the next figure, even when their graphics cluster together');
const vectorTable=NoctuaPDFObjects.detect([
 text('TABLE I',.693,.08,.05,.01),text('NOMENCLATURE',.673,.091,.09,.01)
],[[.5075,.1167,.4206,.001],[.5075,.135,.4206,.001],[.5075,.3417,.4206,.001],[.5075,.4251,.4206,.001],...Array.from({length:25},(_,i)=>[.648,.137+i*.0113,.24,.009])]);
assert(vectorTable.length===1&&vectorTable[0].rect[1]+vectorTable[0].rect[3]>.425,'outlined lettering must bridge wide gaps between table rules even without selectable cell text');
const vectorTableWithProse=NoctuaPDFObjects.detect([
 text('TABLE II',.691,.08,.054,.01),text('CALIBRATION LEVELS',.528,.091,.37,.01),
 text('N',.783,.1702,.0106,.0088),text('Compute the conformal scores as prediction errors.',.5066,.171,.4226,.0126)
],[[.5058,.1186,.4227,.001],[.5058,.1487,.4227,.001]]);
assert(vectorTableWithProse.length===1&&vectorTableWithProse[0].rect[1]+vectorTableWithProse[0].rect[3]<.16&&!vectorTableWithProse[0].text.includes('Compute'),'a superscript before a larger-font paragraph must not pull the paragraph into a table');
const descriptiveHeaderRows=[text('Table I: Generalization benchmark results.',.088,.061,.824,.0126)];
for(const y of [.124,.19])for(let i=0;i<6;i++)descriptiveHeaderRows.push(text('Descriptive method heading '+i,.12+i*.125,y,.10,y<.15?.0126:.0088));
descriptiveHeaderRows.push(text('Model score 92.5',.12,.235,.75,.0088),text('Figure 6: Separate learning curves.',.088,.52,.824,.0126));
const descriptiveHeaderTable=NoctuaPDFObjects.detect(descriptiveHeaderRows,[[.117,.113,.757,.001],[.117,.142,.757,.001],[.117,.259,.757,.001],[.105,.27,.8,.23]]);
assert(descriptiveHeaderTable.length===2&&descriptiveHeaderTable[0].rect[1]+descriptiveHeaderTable[0].rect[3]<.27&&descriptiveHeaderTable[1].label==='Figure 6','long text-only table headings in separate cells must not be mistaken for prose and merge the following plot');
const authorSuperscript=NoctuaPDFObjects.detect([
 text('A broad paper title on the first page',.1,.087,.8,.0201),text('First Author, Second Author',.369,.133,.254,.0138),text('∗',.623,.132,.007,.0101),
 text('Figure 1. Generalization in reinforcement learning.',.512,.412,.4,.0126),text('The complete caption stays with the images.',.512,.427,.4,.0126),
 text('An abstract paragraph in the left column.',.088,.2,.4,.0113),text('Another abstract paragraph in the left column.',.088,.22,.4,.0113),text('Right-column body text below the figure.',.512,.6,.4,.0126),text('Another right-column body line.',.512,.62,.4,.0126)
],[[.53,.184,.36,.21]]);
assert(authorSuperscript.length===1&&authorSuperscript[0].rect[1]>.17&&!authorSuperscript[0].text.includes('Author'),'an isolated author superscript must not extend the figure into the author row');
const journalHeader=NoctuaPDFObjects.detect([text('IEEE TRANSACTIONS ON ROBOTICS, VOL. 42, 2026',.4,.04,.53,.0088),text('554',.065,.04,.018,.0088),text('Figure 4: A robot trajectory.',.07,.19,.86,.01)],[[.07,.085,.86,.09]]);
assert(journalHeader.length===1&&journalHeader[0].rect[1]>.07&&!journalHeader[0].text.includes('IEEE TRANSACTIONS')&&!journalHeader[0].text.includes('554'),'a running title with a left page number must be excluded even without a header rule');
const captionThenBody=NoctuaPDFObjects.detect([
 text('Figure 2. A complete multi-line caption.',.1,.3,.8,.0113),text('The caption ends with this description.',.1,.315,.8,.0113),text('A larger-font body paragraph must be excluded.',.1,.34,.8,.0126)
],[[.1,.1,.8,.18]]);
assert(captionThenBody.length===1&&!captionThenBody[0].text.includes('larger-font body')&&captionThenBody[0].rect[1]+captionThenBody[0].rect[3]<.34,'a slightly larger body font must end caption continuation');
// FlashAttention: tables often end without a bottom rule; internal dividers
// must not truncate later row groups or the final model scores.
const openTableRows=[text('Preceding prose must stay outside the box.',.117,.1244,.765,.0126),text('Table 2: Training time for small and medium models.',.117,.139,.765,.0113),text('Implementation',.214,.182,.23,.0113),text('Time',.64,.182,.1,.0113)];
for(let i=0;i<6;i++)openTableRows.push(text('GPT model group '+i,.214,.194+i*.014,.23,.0113),text('14.3 6.9 days',.52,.194+i*.014,.23,.0113));
openTableRows.push(text('Long-range Arena. Following body paragraph outside the table.',.117,.293,.765,.0126));
const openTable=NoctuaPDFObjects.detect(openTableRows,[[.214,.1953,.563,.001],[.214,.2373,.563,.001]]);
assert(openTable.length===1&&openTable[0].rect[1]>.137&&openTable[0].rect[1]+openTable[0].rect[3]>.275&&openTable[0].text.includes('model group 5')&&!openTable[0].text.includes('Following body'),'tables without bottom borders must continue past internal separators through their final rows');
// A table of pointers contains bare Table N labels in its cells, followed by
// the actual Table 9 caption. References cannot steal its label or drawings.
const pointerRows=[text('Table 8: Pointers to results tables.',.377,.09,.246,.0126),text('Dropout',.273,.122,.07,.0126),text('Pass',.531,.122,.036,.0126),text('Table',.674,.122,.045,.0126)];
for(let i=0;i<13;i++)pointerRows.push(text('Yes',.295,.138+i*.0151,.025,.0126),text('Forward',.519,.138+i*.0151,.06,.0126),text('Table '+(9+i),.666,.138+i*.0151,.061,.0126));
pointerRows.push(text('Table 9: Forward pass runtime for attention mechanisms.',.117,.354,.765,.0113),text('Attention method',.22,.40,.14,.009),text('First score 0.36',.36,.416,.4,.009),text('Final score 13.34',.36,.523,.4,.009));
const pointerTables=NoctuaPDFObjects.detect(pointerRows,[[.263,.1202,.474,.001],[.263,.1395,.474,.001],[.263,.3365,.474,.001],[.143,.3964,.71,.001],[.143,.4107,.71,.001],[.143,.5359,.71,.001]]);
assert(pointerTables.length===2&&pointerTables[0].label==='Table 8'&&pointerTables[1].label==='Table 9'&&pointerTables[1].rect[1]>.34&&pointerTables[1].text.includes('Final score 13.34'),'table-cell references must not create phantom tables or replace the real caption below');
// Ruled algorithms stop at the listing border, before following theorems;
// long code must not be discarded by the generic text-only height cap.
for(const [number,top,bottom,count] of [[1,.416,.7584,16],[4,.138,.7333,26]]){
 const codeRows=[text('Algorithm '+number,.117,top,.1,.0126),text('FlashAttention',.222,top,.13,.01),text('Require: matrices and on-chip memory.',.117,top+.022,.765,.0126)];
 for(let i=1;i<=count;i++)codeRows.push(text(i+': '+(i===count?'Return the final output.':'Compute the next block using the input matrices.'),.125,top+.045+(i-1)*(bottom-top-.061)/(count-1),.75,.0126));
 codeRows.push(text('We show correctness and memory requirements in the following theorem.',.14,bottom+.013,.74,.0126),text('Theorem 1. Following proof must stay outside the algorithm.',.117,bottom+.04,.765,.0126));
 const listing=NoctuaPDFObjects.detect(codeRows,[[.1176,top+.001,.7647,.001],[.1176,top+.0178,.7647,.001],[.1176,bottom,.7647,.001]]);
 assert(listing.length===1&&listing[0].label==='Algorithm '+number&&listing[0].rect[1]+listing[0].rect[3]<bottom+.01&&listing[0].text.includes('Return the final output.')&&!listing[0].text.includes('Following proof')&&!listing[0].text.includes('We show correctness'),'framed algorithms must include every step and stop at their closing border');
}
// LpWM: Figure 3 follows a captioned table, then contains stacked panels.
const tableThenFigure=NoctuaPDFObjects.detect([
 text('Table 2: Predictor parameter counts.',.176,.097,.648,.0126),
 text('Predictor',.245,.143,.08,.0126),text('25.8M 62.2M 166.9M',.405,.163,.35,.0126),
 text('0.30M 1.18M 4.72M',.405,.232,.35,.0126),
 text('Open-Loop',.329,.275,.07,.0097),text('Open-Loop',.661,.272,.074,.0104),
 text('Closed-Loop',.329,.363,.08,.0097),text('Closed-Loop',.661,.371,.084,.0104),
 text('(a) Wall Environment. LeWM vs. LpWM',.218,.502,.28,.0113),
 text('(b) PushT Environment. VICReg vs. LpWM',.54,.502,.29,.0113),
 text('Figure 3: Linear predictor is sufficient for the wall environment.',.176,.521,.648,.0126),
 text('Both open-loop and closed-loop results are reported.',.176,.535,.648,.0126)
],[[.235,.1415,.53,.001],[.235,.1621,.53,.001],[.235,.2515,.53,.001],[.1765,.2744,.3308,.2191],[.525,.272,.3,.222]]);
const predictorTable=tableThenFigure.find(r=>r.label==='Table 2'),wallFigure=tableThenFigure.find(r=>r.label==='Figure 3');
assert(tableThenFigure.length===2&&wallFigure.rect[1]>predictorTable.rect[1]+predictorTable.rect[3]&&wallFigure.rect[1]<.272,'a stacked figure must not expand upward into the preceding captioned table');
assert(wallFigure.text.includes('Open-Loop')&&wallFigure.text.includes('Closed-Loop')&&wallFigure.text.includes('(a)')&&wallFigure.text.includes('(b)')&&!/25.8M|0.30M/.test(wallFigure.text),'figure labels and both panels must remain without the preceding table values');
const configRows=[text('Table 5: Experimental configurations for Section 3 and Section 4.',.176,.097,.648,.0126),text('Pipelines in the following table.',.176,.1106,.21,.0126),text('Section 3',.417,.1294,.057,.0113),text('Section 4',.671,.1294,.057,.0113),text('Wall',.331,.1483,.03,.0113),text('OGBench-Cube',.69,.1483,.10,.0113)];
const configLabels=['Encoder','Predictor','Dimension','History','Frameskip','Batch size','Epochs','Optimizer','Base LR','Grad. clip','Reg. weight','Number of projections','Parameter','Temporal Jaccard'];
for(let i=0;i<configLabels.length;i++){
 const y=.1675+i*.0126;
 configRows.push(text(configLabels[i],.184,y,.14,.0113),text(i===0?'from-scratch ViT, 12 layers, width 384':'128',.34,y,.22,.0113),text(i===0?'from-scratch ViT-Tiny, width 192':'0.01',.60,y,.20,.0113));
}
configRows.push(text('Experimental Details for Section 4. Following body paragraph.',.176,.383,.648,.0126));
const configTable=NoctuaPDFObjects.detect(configRows,[[.1765,.1278,.6553,.001],[.332,.147,.2265,.001],[.5747,.147,.2489,.001],[.1765,.166,.6553,.001],[.1765,.3497,.6553,.001]]);
assert(configTable.length===1&&configTable[0].rect[1]+configTable[0].rect[3]>.35&&configTable[0].text.includes('Frameskip')&&configTable[0].text.includes('Temporal Jaccard')&&!configTable[0].text.includes('Following body'),'configuration tables with a long span between rules must include their final row and exclude the following paragraph');
// CLIP: a numbered running header sits lower than the usual header band.
const clipHeader=[text('Learning Transferable Visual Models From Natural Language Supervision',.0906,.0579,.4678,.0113),text('10',.8684,.0566,.0163,.0126)];
const clipPlots=NoctuaPDFObjects.detect([...clipHeader,
 text('Figure 7. Data efficiency of zero-shot transfer.',.0906,.355,.3824,.0113),
 text('Figure 8. Zero-shot and linear-probe performance.',.5024,.36,.3824,.0113),
 text('Left-column body paragraph below the figure.',.0906,.51,.3824,.0126),text('Another line of the left-column paragraph.',.0906,.528,.3824,.0126),
 text('Right-column body paragraph below the figure.',.5024,.47,.3824,.0126),text('Another line of the right-column paragraph.',.5024,.488,.3824,.0126)
],[[.0906,.074,.7941,.001],[.0906,.0847,.3824,.2517],[.5024,.0847,.3824,.2563]]);
assert(clipPlots.length===2&&clipPlots[0].rect[0]+clipPlots[0].rect[2]<.49&&clipPlots[1].rect[0]>.49,'a lower running-header rule must not join side-by-side CLIP plots');
assert(clipPlots.every(r=>r.rect[1]>.07&&!r.text.includes('Learning Transferable')&&!r.text.includes('body paragraph')),'running titles and adjacent prose must stay outside plot attachments');
const headerAndChartRule=NoctuaPDFObjects.detect([...clipHeader,text('Figure 23. A full-width plot below the header.',.09,.31,.79,.0113)],[[.09,.074,.794,.001],[.09,.085,.794,.001],[.1,.105,.78,.18]]);
assert(headerAndChartRule.length===1&&headerAndChartRule[0].rect[1]<.085&&headerAndChartRule[0].rect[1]>.075,'only the nearest rule below the running title is a header; the plot top border must remain');
const clipCodeTexts=[...clipHeader,
 text('Figure 3. Numpy-like pseudocode for the implementation.',.09,.373,.3856,.0113),text('of CLIP.',.09,.387,.07,.0113),
 text('# image_encoder - ResNet or Vision Transformer',.09,.085,.35,.0095),text('logits = scale * image_features @ text_features.T',.09,.285,.38,.0095)
];
for(let i=0;i<9;i++)clipCodeTexts.push(text('An ordinary body paragraph in the neighboring column.',.5024,.085+i*.018,.3824,.0126));
const clipCode=NoctuaPDFObjects.detect(clipCodeTexts,[[.0906,.074,.7941,.001],[.0852,.0791,.6447,.2802]]);
assert(clipCode.length===1&&clipCode[0].rect[1]>.076&&clipCode[0].rect[0]+clipCode[0].rect[2]<.5&&clipCode[0].text.includes('logits =')&&clipCode[0].text.includes('of CLIP.')&&!clipCode[0].text.includes('neighboring column'),'blank embedded-image bounds must not pull adjacent prose into a code figure');
// Dense, page-height tables and rotated headers must remain separate from plots.
const denseRows=[...clipHeader,text('Dataset headers',.2,.09,.6,.04),text('Table 10. Linear probe performance over all datasets.',.09,.90,.8,.0113)];
for(let i=0;i<65;i++)denseRows.push(text('RN50 '+Array.from({length:27},(_,j)=>String(70+(i+j)%20)+'.5').join(' '),.11,.15+i*.0113,.75,.008));
const denseTable=NoctuaPDFObjects.detect(denseRows,[[.09,.074,.794,.001],[.197,.078,.001,.055],...[.1366,.1523,.35,.588,.88].map(y=>[.104,y,.765,.001])]);
assert(denseTable.length===1&&denseTable[0].rect[1]<.079&&denseTable[0].rect[1]+denseTable[0].rect[3]>.91&&denseTable[0].text.includes('Dataset headers'),'page-height numeric tables must retain their rotated headers and all rule groups');
const rotatedTable=NoctuaPDFObjects.detect([
 text('Food101',.211,.13,.008,.05),text('CIFAR10',.239,.13,.008,.05),
 text('RN50 '+Array(28).fill('81.5').join(' '),.14,.2,.72,.008),
 text('ViT '+Array(28).fill('85.5').join(' '),.14,.26,.72,.008),
 text('Table 11. Model performance over datasets.',.29,.302,.39,.0113),
 text('Figure 22. Performance compared to linear probes.',.23,.841,.52,.0113)
],[[.197,.127,.001,.059],...[.1888,.2448,.2909].map(y=>[.104,y,.765,.001]),[.09,.339,.794,.477]]);
assert(rotatedTable.length===2&&rotatedTable[0].rect[1]<.13&&rotatedTable[0].rect[1]+rotatedTable[0].rect[3]<.33&&rotatedTable[1].rect[1]>.33,'a dense table with rotated headings must not attach the following figure');
// Flow Policy Gradients: the teaser image follows smaller affiliation notes.
const teaser=NoctuaPDFObjects.detect([
 text('1',.2732,.189,.0065,.0101),text('Amazon FAR',.2809,.191,.1005,.0138),
 text('2',.3993,.189,.0065,.0101),text('UC Berkeley',.407,.191,.0954,.0138),
 text('*Equal Contribution',.2135,.2129,.1229,.0113),text('†',.351,.2109,.0054,.0075),
 text('Work done as an intern at Amazon FAR',.3574,.2129,.2413,.0113),
 text('‡',.6133,.2109,.0054,.0075),text('Amazon FAR team co-lead',.6197,.2129,.1602,.0113),
 text('Fig. 1: Flow policies for robot control.',.08,.4718,.84,.0126),
 text('The caption continues below the robot photographs.',.08,.4869,.56,.0126)
],[[.08,.2367,.84,.2264]]);
assert(teaser.length===1&&teaser[0].rect[1]>.23&&teaser[0].rect[1]<.237&&teaser[0].rect[1]+teaser[0].rect[3]>.499,'a teaser box must cover the image and caption without the smaller author notes above it');
assert(!/Amazon|Berkeley|Contribution|co-lead/.test(teaser[0].text),'front-matter text must not become figure attachment text');
// DOM font bounds put the bottom caption closer to the following table than
// PDF text-item bounds do. Neither representation may swap the two tables.
for(const shift of [0,-.003]){
 const rows=[];
 for(const [label,x,width,y] of [['A.1',.2356,.5288,.0687],['A.2',.2564,.4872,.3152]]){
  rows.push(text('Hyperparameter category',x,y+.002,.1338,.0101),text('Used value',.4752,y+.002,.0592,.0101));
  rows.push(text('Flow integration steps for '+label,x,y+.038,.18,.0101),text(label==='A.1'?'64':'50',.4979,y+.038,.02,.0101));
  rows.push(text('Running observation normalization',x,y+.179,.19,.0101));
  rows.push(text('TABLE '+label+': FPO++ and training hyperparameters.',.08,y+.2015+shift,.84,.0126),text('Experiments and the values we performed sweeps over.',.08,y+.2166+shift,.37,.0126));
 }
 const rules=[...[[.2356,.5288,.0687],[.2564,.4872,.3152]].flatMap(([x,w,y])=>[0,.0181,.036,.0765,.0944,.1927].map(offset=>[x,y+offset,w,.001]))];
 const tables=NoctuaPDFObjects.detect(rows,rules),first=tables.find(r=>r.label==='Table A.1'),second=tables.find(r=>r.label==='Table A.2');
 assert(tables.length===2&&first.rect[1]<.069&&first.rect[1]+first.rect[3]<.31&&second.rect[1]>.30&&second.rect[1]<.316,'adjacent bottom-captioned appendix tables must retain their own complete rule groups');
 assert(first.text.includes('steps for A.1')&&!first.text.includes('steps for A.2')&&second.text.includes('steps for A.2')&&!second.text.includes('steps for A.1'),'each table attachment must contain only its own data');
}
const raster={width:100,height:100,data:new Uint8ClampedArray(40000)};
for(let y=0;y<75;y++)for(let x=10;x<90;x++)raster.data.set([255,255,255,255],(y*100+x)*4);
for(let y=20;y<60;y++)for(let x=20;x<80;x++)raster.data.set([20,30,40,255],(y*100+x)*4);
const tight=NoctuaPDFObjects.tightenRect([.1,0,.8,.75],raster);
assert(tight[0]>.18&&tight[1]>.18&&tight[0]+tight[2]<.82&&tight[1]+tight[3]<.62,'invisible and white container padding must be trimmed to visible figure pixels');
const constrained=NoctuaPDFObjects.tightenRect([.2,.2,.6,.4],raster);
assert(constrained[0]>=.2&&constrained[1]>=.2&&constrained[0]+constrained[2]<=.8&&constrained[1]+constrained[3]<=.6+.00001,'raster padding must stay inside the geometric box so excluded headers and columns cannot return');
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
const alphaOps={...ops,setGState:10,fill:23,stroke:20};
const transparent=NoctuaPDFObjects.graphicRects({fnArray:[1,10,5,3,4,5],argsArray:[[],[[['ca',0],['CA',0]]],[23,[],[0,0,600,800]],['hidden'],[],[23,[],[100,500,500,700]]]},alphaOps,{width:600,height:800,transform:[1,0,0,-1,0,800]});
assert(transparent.length===1&&Math.abs(transparent[0][1]-.125)<1e-9,'fully transparent paths and images must not enlarge drawing bounds; restoring state must restore opacity');
const separateAlpha=NoctuaPDFObjects.graphicRects({fnArray:[10,5,5,5],argsArray:[[[['ca',0],['CA',1]]],[23,[],[0,0,600,800]],[20,[],[100,500,500,700]],[20,[],[NaN,0,100,100]]]},alphaOps,{width:600,height:800,transform:[1,0,0,-1,0,800]});
assert(separateAlpha.length===1&&separateAlpha[0].every(Number.isFinite),'invisible fills must not hide visible strokes, and malformed bounds must be ignored');
const clippedOps={...ops,clip:8,eoClip:9,endPath:28,paintFormXObjectBegin:6,paintFormXObjectEnd:7};
const clippedList={fnArray:[1,8,5,1,2,3,4,4,2,3],argsArray:[[],[],[28,[],[60,500,540,700]],[],[480,0,0,500,60,200],['cropped'],[],[],[480,0,0,160,60,100],['next']]};
const clippedImages=NoctuaPDFObjects.graphicRects(clippedList,clippedOps,{width:600,height:800,transform:[1,0,0,-1,0,800]});
assert(clippedImages.length===2&&Math.abs(clippedImages[0][1]-.125)<1e-9&&Math.abs(clippedImages[0][3]-.25)<1e-9,'oversized images must be intersected with transformed clipping bounds');
assert(Math.abs(clippedImages[1][1]-.675)<1e-9&&Math.abs(clippedImages[1][3]-.2)<1e-9,'restoring graphics state must release the previous figure clip');
const separate=NoctuaPDFObjects.detect([text('Figure 8: Cropped images',.1,.4,.8),text('Figure 9: Separate plots',.1,.9,.8)],clippedImages);
assert(separate.length===2&&separate[0].rect[1]+separate[0].rect[3]<separate[1].rect[1],'adjacent figures with oversized clipped images must retain separate boxes');

"""#)
print("PASS: captioned objects, long captions, column separation, numbered headers, padded code images, dense tables, rotated headings, prose exclusion and clipped image bounds")
