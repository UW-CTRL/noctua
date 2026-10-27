'use strict';
// Detect captioned objects locally; only nearby rendered pages need hit targets.
window.NoctuaPDFObjects=(()=>{
  const union=(a,b)=>{const x=Math.min(a[0],b[0]),y=Math.min(a[1],b[1]);return [x,y,Math.max(a[0]+a[2],b[0]+b[2])-x,Math.max(a[1]+a[3],b[1]+b[3])-y];};
  const overlap=(a,b)=>Math.max(0,Math.min(a[0]+a[2],b[0]+b[2])-Math.max(a[0],b[0]));
  const gap=(a,b)=>Math.max(0,a[1]-b[1]-b[3],b[1]-a[1]-a[3]);
  const caption=/^(Figure|Fig\.?|Table|Algorithm)\s+((?:[A-Z]\.?\d+|\d+)(?:\.\d+)*|[IVX]+)(?:\s*[:.]\s*|\s*$)/i;
  function columnGutter(texts){
    const broad=texts.filter(item=>item.text.length>20&&item.rect[2]>.18),median=values=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)];
    const estimate=items=>{
      const left=items.map(item=>item.rect[0]+item.rect[2]).filter(x=>x>.38&&x<.54),right=items.map(item=>item.rect[0]).filter(x=>x>.46&&x<.62);
      if(left.length<2||right.length<2)return null;
      const a=median(left),b=median(right);return b-a>=.012&&b-a<.12?(a+b)/2:null;
    };
    const initial=estimate(broad);if(initial===null)return null;
    // Bold and inline-math runs can split a full-width line near its midpoint.
    const separated=broad.filter(item=>!texts.some(other=>other.rect[0]<initial&&other.rect[0]+other.rect[2]>initial&&Math.abs(other.rect[1]+other.rect[3]/2-item.rect[1]-item.rect[3]/2)<Math.max(other.rect[3],item.rect[3])*.7));
    return estimate(separated);
  }

  const startsCaption=text=>caption.test(text.trim())||/^(?:Figure|Fig\.?|Table|Algorithm)\s*$/i.test(text.trim());
  function linesOf(texts,gutter=null){
    const rows=[];
    for(const item of texts.filter(item=>!(item.rect[3]>.04&&item.rect[3]>item.rect[2]*2)).sort((a,b)=>a.rect[1]-b.rect[1]||a.rect[0]-b.rect[0])){
      const r=item.rect,center=r[1]+r[3]/2;
      const matches=rows.filter(row=>(!gutter||!((r[0]>=gutter&&row.rect[0]+row.rect[2]<=gutter)||(row.rect[0]>=gutter&&r[0]+r[2]<=gutter)))&&Math.abs(row.guide.rect[1]+row.guide.rect[3]/2-center)<Math.max(row.guide.rect[3],r[3])*.7&&Math.max(0,r[0]-row.rect[0]-row.rect[2],row.rect[0]-r[0]-r[2])<.035&&!(startsCaption(item.text)&&r[0]>row.rect[0]+row.rect[2]+.008&&!row.parts.some(part=>startsCaption(part.text)))&&!(r[2]>.18&&row.rect[2]>.18&&Math.max(0,r[0]-row.rect[0]-row.rect[2],row.rect[0]-r[0]-r[2])>.008&&(startsCaption(item.text)||row.parts.some(part=>startsCaption(part.text))))).sort((a,b)=>Math.abs(a.guide.rect[1]+a.guide.rect[3]/2-center)-Math.abs(b.guide.rect[1]+b.guide.rect[3]/2-center));
      const row=matches[0];
      if(row){row.parts.push(item);row.rect=union(row.rect,r);if(item.text.length>row.guide.text.length)row.guide=item;}else rows.push({rect:[...r],parts:[item],guide:item});
    }
    return rows.map(row=>({...row,fontHeight:row.guide.rect[3],text:row.parts.sort((a,b)=>a.rect[0]-b.rect[0]).map(item=>item.text).join(' ').replace(/\s+/g,' ').trim()})).sort((a,b)=>a.guide.rect[1]-b.guide.rect[1]||a.rect[0]-b.rect[0]);
  }
  function captionMatch(line){
    const strict=line.text.match(caption);if(strict)return strict;
    const label=/^(Figure|Fig\.?|Table|Algorithm)\s+((?:[A-Z]\.?\d+|\d+)(?:\.\d+)*|[IVX]+)\s*$/i;
    for(const count of [1,2])if(line.parts.length>count){const match=line.parts.slice(0,count).map(part=>part.text).join(' ').trim().match(label);if(match)return match;}
    return null;
  }
  const hasCellGaps=row=>row.parts.some((part,i)=>i>0&&part.rect[0]-row.parts[i-1].rect[0]-row.parts[i-1].rect[2]>.012);
  const panelHeading=row=>row.parts.some(part=>/^(?:[a-z]\)|\([a-z]\))(?:\s|$)/i.test(part.text));
  function detect(texts,graphics){
    const gutter=columnGutter(texts),clusters=[],headerRows=new Set();let lines=linesOf(texts,gutter),headerFloor=0;
    const captionAt=row=>{
      const match=captionMatch(row);if(!match)return null;
      // A bare reference in a right-hand table cell is not a new caption.
      if(match[0].trim()===row.text.trim()&&lines.some(other=>other!==row&&other.rect[0]+other.rect[2]<=row.rect[0]&&(!gutter||!(row.rect[0]>=gutter&&other.rect[0]+other.rect[2]<=gutter))&&Math.abs(other.guide.rect[1]-row.guide.rect[1])<Math.min(other.fontHeight,row.fontHeight)*.5))return null;
      return match;
    };
    // Journals can use a running title and an edge page number without a rule.
    for(const row of lines)if(row.rect[1]<.055&&row.text.length>20&&row.rect[2]>.25&&row.fontHeight<.014){
      const numbers=lines.filter(other=>/^\d+$/.test(other.text)&&Math.abs(other.rect[1]-row.rect[1])<row.fontHeight&&(other.rect[0]<.15||other.rect[0]+other.rect[2]>.85)&&Math.max(row.rect[0]-other.rect[0]-other.rect[2],other.rect[0]-row.rect[0]-row.rect[2])>.1);
      if(numbers.length)for(const header of [row,...numbers])headerRows.add(header);
    }
    // Running-header rules can touch a top figure but are not part of its content.
    graphics=graphics.filter(r=>{
      if(r[3]>=.003||r[2]<=.5||r[1]>=.09||lines.some(row=>captionAt(row)&&row.rect[1]<r[1]))return true;
      const titles=lines.filter(row=>!captionAt(row)&&row.rect[1]<.07&&row.rect[1]+row.rect[3]<=r[1]&&r[1]-row.rect[1]-row.rect[3]<.025&&row.rect[2]>Math.max(.2,r[2]*.4)&&!graphics.some(other=>other!==r&&other[3]<.003&&other[2]>.5&&((other[1]>=row.rect[1]+row.rect[3]&&other[1]<r[1])||(other[1]<row.rect[1]&&other[1]>row.rect[1]-.04))&&overlap(other,row.rect)>row.rect[2]*.5));
      const numbers=lines.filter(row=>/^\d+$/.test(row.text)&&titles.some(title=>row.rect[0]>title.rect[0]+title.rect[2]+.1&&Math.abs(row.rect[1]-title.rect[1])<title.fontHeight));
      if(!titles.some(row=>row.rect[1]<.055||row.fontHeight<.012)&&!numbers.length)return true;
      for(const row of [...titles,...numbers])headerRows.add(row);
      headerFloor=Math.max(headerFloor,r[1]+r[3]+.002);
      return false;
    });
    lines=lines.filter(row=>!headerRows.has(row));
    // Some embedded code images have blank bounds extending into the body
    // column. A column caption and several prose lines there identify the edge.
    if(gutter)graphics=graphics.map(r=>{
      if(r[0]>=gutter||r[0]+r[2]<=gutter||r[3]<.015)return r;
      for(const row of lines){
        const match=captionAt(row);if(!match||!/^fig/i.test(match[1])||gap(row.rect,r)>.13||row.rect[1]<=r[1])continue;
        const left=row.rect[0]+row.rect[2]<=gutter,right=row.rect[0]>=gutter;if(!left&&!right)continue;
        const prose=lines.filter(other=>other.text.length>45&&other.rect[2]>.25&&other.fontHeight>=row.fontHeight*.95&&other.rect[1]>=r[1]&&other.rect[1]+other.rect[3]<=r[1]+r[3]&&(left?other.rect[0]>=gutter:other.rect[0]+other.rect[2]<=gutter));
        if(prose.length>=3)return left?[r[0],r[1],gutter-r[0],r[3]]:[gutter,r[1],r[0]+r[2]-gutter,r[3]];
      }
      return r;
    });
    for(const rect of graphics){
      if(rect[2]>.94||rect[3]>.8||rect[2]*rect[3]>.65)continue;
      let joined=[...rect];
      for(let i=0;i<clusters.length;){const c=clusters[i];if((!gutter||!((joined[0]>=gutter&&c[0]+c[2]<=gutter)||(c[0]>=gutter&&joined[0]+joined[2]<=gutter)))&&gap(joined,c)<.018&&Math.max(0,joined[0]-c[0]-c[2],c[0]-joined[0]-joined[2])<.025){joined=union(joined,c);clusters.splice(i,1);i=0;}else i++;}
      clusters.push(joined);
    }
    const regions=[],captionRows=new Set(),captionParts=new Set();
    const isCaptionRow=row=>captionRows.has(row)||row.parts.some(part=>captionParts.has(part));
    const claimed=r=>regions.some(region=>r[1]>=region.rect[1]&&r[1]+r[3]<=region.rect[1]+region.rect[3]+.002&&overlap(r,region.rect)>Math.min(r[2],region.rect[2])*.5);
    for(const line of lines){
      if(isCaptionRow(line)||claimed(line.rect))continue;
      const match=captionAt(line);if(!match)continue;
      const kind=/^(?:fig)/i.test(match[1])?'figure':match[1].toLowerCase(),label=`${kind[0].toUpperCase()+kind.slice(1)} ${match[2]}`;
      // A wrapped prose reference such as "using Algorithm 1. By Lemma ..."
      // is part of the preceding sentence, not an algorithm heading.
      if(kind==='algorithm'&&/\.\s*$/.test(match[0])&&lines.some(previous=>previous!==line&&previous.rect[1]<line.rect[1]&&Math.abs(previous.rect[0]-line.rect[0])<.012&&previous.rect[2]>line.rect[2]*.75&&Math.abs(previous.fontHeight-line.fontHeight)<line.fontHeight*.15&&line.guide.rect[1]-previous.guide.rect[1]-previous.fontHeight>=0&&line.guide.rect[1]-previous.guide.rect[1]-previous.fontHeight<line.fontHeight*.6&&!/[.!?:;]$/.test(previous.text)&&!captionAt(previous)))continue;
      for(const part of line.parts)captionParts.add(part);
      const c=line.rect,mid=gutter??.5;
      const nearbyProse=kind==='figure'&&!gutter&&c[2]<.5?lines.filter(row=>row.text.length>20&&row.fontHeight>=line.fontHeight*.95&&clusters.some(r=>gap(r,c)<.13&&row.rect[1]>=r[1]&&row.rect[1]+row.rect[3]<=Math.min(c[1],r[1]+r[3]))):[];
      const wrapRight=c[0]>.25&&nearbyProse.filter(row=>row.rect[0]+row.rect[2]<=c[0]-.008).length>=3,wrapLeft=c[0]+c[2]<.75&&nearbyProse.filter(row=>row.rect[0]>=c[0]+c[2]+.015).length>=3;
      const sideObject=kind==='figure'&&c[2]>.15&&c[2]<.45?graphics.filter(r=>!claimed(r)&&r[2]>.1&&r[3]>.04&&r[1]<=c[1]+.04&&r[1]+r[3]>c[1]+.03&&Math.max(0,c[0]-r[0]-r[2],r[0]-c[0]-c[2])<.04&&overlap(r,c)<.005).sort((a,b)=>b[2]*b[3]-a[2]*a[3])[0]:null;
      // A short caption can belong to a graphic spanning the page gutter.
      const wideFigure=kind==='figure'&&clusters.some(r=>r[2]>.5&&r[0]<mid-.03&&r[0]+r[2]>mid+.03&&overlap(r,c)>Math.min(r[2],c[2])*.5&&gap(r,c)<.13&&r[1]+r[3]<=c[1]+c[3]);
      const centeredTable=kind==='table'&&graphics.some(r=>r[3]<.003&&r[0]<mid&&r[0]+r[2]>mid+.06&&overlap(r,c)>.01&&gap(r,c)<.13),full=!!sideObject||!wrapRight&&!wrapLeft&&(wideFigure||centeredTable||(gutter?c[0]<mid&&c[0]+c[2]>mid:centeredTable||c[0]<.45&&(c[0]+c[2]>.56||kind!=='figure'&&lines.some(row=>row.rect[1]>c[1]&&row.rect[1]<c[1]+.09&&Math.abs(row.rect[0]-c[0])<.03&&row.rect[0]+row.rect[2]>.56)))),left=wrapLeft?0:wrapRight?c[0]-.004:full?0:c[0]>=mid?mid:0,right=wrapRight?1:wrapLeft?c[0]+c[2]+.012:full?1:c[0]>=mid?1:mid;
      const objectClusters=wrapRight||wrapLeft?clusters.filter(r=>r[0]<right&&r[0]+r[2]>left).map(r=>[Math.max(left,r[0]),r[1],Math.min(right,r[0]+r[2])-Math.max(left,r[0]),r[3]]):clusters;
      const inLane=r=>full||r[0]>=left-.005&&r[0]+r[2]<=right+.005;

      let ruledTable=null,ruledAlgorithm=null;
      if(kind==='algorithm'){
        // Algorithm headings sit between full-width rules; the last matching
        // rule closes the listing even when the code spans most of the page.
        const rules=graphics.filter(r=>inLane(r)&&r[3]<.003&&r[2]>.2&&Math.abs(r[0]-c[0])<.025).sort((a,b)=>a[1]-b[1]);
        const first=rules.find(r=>Math.abs(r[1]-c[1])<.015);
        if(first){
          let frame=[...first],count=1;
          for(const rule of rules){
            if(rule[1]<=first[1]||Math.abs(rule[2]-first[2])>.025)continue;
            if(lines.some(row=>row!==line&&row.rect[1]>c[1]+line.fontHeight&&row.rect[1]<rule[1]+.002&&captionAt(row)))break;
            frame=union(frame,rule);count++;
          }
          if(count>=2&&frame[3]>.025)ruledAlgorithm=frame;
        }
      }
      if(kind==='table'){
        const rules=graphics.filter(r=>!regions.some(region=>region.kind==='table'&&r[0]>=region.rect[0]&&r[0]+r[2]<=region.rect[0]+region.rect[2]&&r[1]>=region.rect[1]&&r[1]<=region.rect[1]+region.rect[3])&&inLane(r)&&r[3]<.003&&r[2]>.07&&overlap(r,c)>.01);
        // Bottom captions can sit between two tables. Prefer the closest rule
        // without a downward bias that can attach the following table instead.
        const nearest=[...rules].filter(r=>gap(r,c)<.13).sort((a,b)=>gap(a,c)-gap(b,c))[0];
        if(nearest){
          const below=nearest[1]>=c[1],ordered=rules.filter(r=>below?r[1]>=nearest[1]:r[1]<=nearest[1]).sort((a,b)=>below?a[1]-b[1]:b[1]-a[1]);
          let joined=[...nearest],count=0;
          for(const rule of ordered){
            if(Math.abs(rule[0]-nearest[0])>.025||Math.abs(rule[2]-nearest[2])>.04)continue;
            const top=Math.min(rule[1],joined[1]+joined[3]),bottom=Math.max(rule[1],joined[1]);
            const between=lines.filter(row=>overlap(row.rect,nearest)>Math.min(row.rect[2],nearest[2])*.5&&row.rect[1]>top&&row.rect[1]+row.rect[3]<bottom);
            if(gap(rule,joined)>.13){
              let edge=top;
              // Outlined table lettering has painted bounds but no text items.
              const spans=[...between.map(row=>row.rect),...graphics.filter(r=>r[0]>=nearest[0]-.005&&r[0]+r[2]<=nearest[0]+nearest[2]+.005&&r[1]>top&&r[1]+r[3]<bottom&&r[3]<.025)].sort((a,b)=>a[1]-b[1]);
              for(const r of spans){if(r[1]-edge>.035)break;edge=Math.max(edge,r[1]+r[3]);}
              if(bottom-edge>.035)break;
            }
            if(between.some(row=>captionAt(row)||row.text.length>90&&(row.text.match(/\d/g)||[]).length<row.text.length*.15&&row.fontHeight>=line.fontHeight*.95&&!hasCellGaps(row)))break;
            joined=union(joined,rule);count++;
          }
          if(count>=2&&joined[3]>.015){
            // Vertical rules can rise above the first horizontal rule beside
            // rotated column headings. Keep them and their labels in the table.
            for(const r of graphics)if(r[2]<.003&&r[3]>.015&&r[0]>=joined[0]&&r[0]<=joined[0]+joined[2]&&gap(r,joined)<.005)joined=union(joined,r);
            ruledTable=joined;
          }
        }
      }
      const availableClusters=objectClusters.map(r=>{
        let result=r;
        for(const region of regions){const bottom=region.rect[1]+region.rect[3];if(bottom<c[1]&&bottom>result[1]&&bottom<result[1]+result[3]&&overlap(result,region.rect)>Math.min(result[2],region.rect[2])*.5)result=[result[0],bottom+.002,result[2],result[1]+result[3]-bottom-.002];}
        return result;
      });
      const candidates=availableClusters.filter(r=>!claimed(r)&&inLane(r)&&overlap(r,c)>.01&&gap(r,c)<.13&&(kind!=='figure'||r[1]<c[1]+c[3]));
      candidates.sort((a,b)=>(gap(a,c)+(kind==='figure'?(a[1]>c[1]?.08:0):(a[1]<c[1]?.025:0)))-(gap(b,c)+(kind==='figure'?(b[1]>c[1]?.08:0):(b[1]<c[1]?.025:0))));
      let object=sideObject||ruledAlgorithm||ruledTable||candidates[0];
      if(object&&!sideObject&&!ruledTable&&!ruledAlgorithm){
        for(const other of candidates.slice(1))if(other[0]>=left-.02&&other[0]+other[2]<=right+.02&&Math.min(object[1]+object[3],other[1]+other[3])-Math.max(object[1],other[1])>Math.min(object[3],other[3])*.4)object=union(object,other);
      }
      let captionRect=[...c],captionText=line.text;
      let captionLines=1,lastCaption=line;
      // Wrapped figures need their own text lane, even on a single-column page.
      const wrapped=kind==='figure'&&!full&&gutter===null&&!!object;
      const captionLane=sideObject?linesOf(texts.filter(item=>item.rect[0]>=c[0]-.004&&item.rect[0]+item.rect[2]<=c[0]+c[2]+.012)):wrapped?linesOf(texts.filter(item=>item.rect[0]>=c[0]-.004&&item.rect[0]+item.rect[2]<=Math.max(c[0]+c[2],object[0]+object[2])+.012)):lines;
      for(const next of kind==='algorithm'?[]:captionLane){
        if(next===line||next.guide.rect[1]<=lastCaption.guide.rect[1]+lastCaption.fontHeight*.5||next.rect[0]<left||next.rect[0]+next.rect[2]>right+.02)continue;
        if(next.guide.rect[1]-lastCaption.guide.rect[1]-lastCaption.fontHeight>line.fontHeight*.9)break;
        if(wrapped&&Math.abs(next.rect[0]-c[0])>Math.max(.018,c[2]*.15))break;
        if(ruledTable&&ruledTable[1]>c[1]&&next.guide.rect[1]>=ruledTable[1]-.002)break;
        if(captionLines>=24||captionText.length>4000||next.fontHeight>line.fontHeight*1.1)break;
        captionRect=union(captionRect,next.rect);captionText+=' '+next.text;captionLines++;lastCaption=next;captionRows.add(next);for(const part of next.parts)captionParts.add(part);
      }
      if(ruledTable&&ruledTable[1]>=c[1]){
        // Many tables omit a bottom border: a horizontal rule may only divide
        // row groups. Continue through aligned data until prose or a new caption.
        const table=[...ruledTable],fonts=lines.filter(row=>row.rect[1]>=table[1]&&row.rect[1]+row.rect[3]<=table[1]+table[3]&&row.rect[0]>=table[0]-.005&&row.rect[0]+row.rect[2]<=table[0]+table[2]+.005).map(row=>row.fontHeight).sort((a,b)=>a-b),tableFont=fonts[Math.floor(fonts.length/2)]||line.fontHeight;let edge=table[1]+table[3];
        for(const row of lines){
          if(row.rect[1]<table[1]+table[3]-.003||!inLane(row.rect)||overlap(row.rect,table)<=0)continue;
          const rowFont=Math.max(row.fontHeight,...lines.filter(other=>inLane(other.rect)&&overlap(other.rect,table)>0&&Math.abs(other.guide.rect[1]+other.fontHeight/2-row.guide.rect[1]-row.fontHeight/2)<Math.max(other.fontHeight,row.fontHeight)*.7).map(other=>other.fontHeight));
          if(row.rect[1]-edge>.025||captionAt(row)||rowFont>tableFont*1.15||row.rect[0]<table[0]-.015||row.rect[0]+row.rect[2]>table[0]+table[2]+.015)break;
          if(clusters.some(r=>r[1]>=table[1]+table[3]-.003&&r[3]>.025&&row.rect[1]>=r[1]-.015&&row.rect[1]<r[1]+r[3]&&overlap(row.rect,r)>Math.min(row.rect[2],r[2])*.5&&lines.some(next=>/^fig/i.test(captionAt(next)?.[1]||'')&&next.rect[1]>=r[1]+r[3]-.005&&gap(next.rect,r)<.13)))break;
          if(row.text.length>90&&(row.text.match(/\d/g)||[]).length<row.text.length*.15&&!hasCellGaps(row))break;
          object=union(object,row.rect);edge=Math.max(edge,row.rect[1]+row.rect[3]);
        }
      }
      if(object&&kind==='figure'&&!sideObject){
        // A caption can describe vertically stacked panels separated by substantial whitespace.
        let changed=true;
        while(changed){changed=false;for(const other of availableClusters){
          if(claimed(other)||!inLane(other)||other===object||other[1]+other[3]>c[1]+.005||overlap(other,object)<Math.min(other[2],object[2])*.35)continue;
          const betweenTop=Math.min(other[1]+other[3],object[1]+object[3]),betweenBottom=Math.max(other[1],object[1]);
          // A panel heading can bridge a larger gap between drawings in one figure.
          const distance=gap(other,object),headingBridge=distance>.075&&distance<.13&&lines.some(row=>panelHeading(row)&&inLane(row.rect)&&row.rect[1]>=betweenTop&&row.rect[1]+row.rect[3]<=betweenBottom&&gap(row.rect,object)<.055&&gap(row.rect,other)<.055&&overlap(row.rect,object)>.01&&overlap(row.rect,other)>.01);
          if(distance>.075&&!headingBridge)continue;
          if(lines.some(row=>row.guide.rect[1]>=betweenTop&&row.guide.rect[1]+row.fontHeight<=betweenBottom&&(captionAt(row)||isCaptionRow(row)||row.text.length>70&&!panelHeading(row))&&overlap(row.rect,object)>Math.min(row.rect[2],object[2])*.5))continue;
          const joined=union(object,other);if(joined[2]>object[2]+.001||joined[3]>object[3]+.001){object=joined;changed=true;}
        }}
      }
      if(kind!=='figure'&&!ruledTable&&!ruledAlgorithm){
        const above=kind==='table'&&object&&object[1]+object[3]/2<c[1];
        const rows=lines.filter(row=>row!==line&&(above?row.guide.rect[1]+row.fontHeight<=c[1]:row.guide.rect[1]>=lastCaption.guide.rect[1]+lastCaption.fontHeight*.9)&&row.rect[0]>=left&&row.rect[0]+row.rect[2]<=right+.01);
        if(above)rows.reverse();
        let edge=above?c[1]:lastCaption.guide.rect[1]+lastCaption.fontHeight,count=0,lastY=-1,textObject=null;
        for(const row of rows){
          const distance=above?edge-row.guide.rect[1]-row.fontHeight:row.guide.rect[1]-edge;
          if(distance>(count ? .025 : .05)||captionAt(row)||row.fontHeight>line.fontHeight*1.4)break;
          textObject=textObject?union(textObject,row.rect):row.rect;edge=above?Math.min(edge,row.guide.rect[1]):Math.max(edge,row.guide.rect[1]+row.fontHeight);
          if(Math.abs(row.guide.rect[1]-lastY)>row.fontHeight*.5){lastY=row.guide.rect[1];if(++count>=40)break;}
        }
        if(count>=2)object=object?union(object,textObject):textObject;
        else if(!object||object[3]<.015)object=null;
      }
      if(!object||object[2]<.07||object[3]<.015)continue;
      let figureTextFloor=0;
      if(kind==='figure'){
        const limit=object[1]+Math.min(.065,object[3]*.25);let top=object[1];
        // PDF form bounds can include whitespace overlapping the preceding paragraph.
        // Require a broad prose line: shorter panel titles can sit inside the drawing.
        for(const row of lines)if(overlap(row.rect,object)>Math.min(row.rect[2],object[2])*.5&&row.rect[1]>=object[1]&&row.rect[1]<limit&&row.text.length>35&&row.rect[2]>object[2]*.65&&row.fontHeight>=line.fontHeight*.95&&!captionAt(row)&&!panelHeading(row))top=Math.max(top,row.rect[1]+row.rect[3]+.008);
        if(top>object[1])figureTextFloor=top;
        object=[object[0],top,object[2],object[1]+object[3]-top];
      }
      if(object&&kind==='figure'){
        // Axis labels, headings and panel markers are PDF text, not painted paths.
        // Keep the search anchored to the graphics so labels cannot chain into prose.
        const graphic=[...object];
        // Small front-matter or body prose above a drawing is a boundary even
        // when its font is smaller than the caption (for example author notes).
        for(const row of lines)if(row.rect[1]+row.rect[3]<=graphic[1]&&gap(row.rect,graphic)<.055&&row.text.length>70&&row.rect[2]>graphic[2]*.65&&overlap(row.rect,graphic)>row.rect[2]*.5&&!panelHeading(row))figureTextFloor=Math.max(figureTextFloor,row.rect[1]+row.rect[3]+.004);
        for(const row of lines){
          const marker=panelHeading(row);
          const floating=wrapped&&gutter===null;
          // Author superscripts can be separate runs in the figure's column
          // while the associated name crosses the gutter outside that column.
          if(row.rect[1]+row.rect[3]<graphic[1]&&/^[\d\s*∗†‡]+$/.test(row.text)&&lines.some(other=>!inLane(other.rect)&&other.fontHeight>row.fontHeight*1.2&&Math.abs(other.rect[1]-row.rect[1])<row.fontHeight&&Math.max(0,row.rect[0]-other.rect[0]-other.rect[2],other.rect[0]-row.rect[0]-row.rect[2])<.02))continue;
          if(floating&&(row.rect[0]<Math.min(c[0],graphic[0])-.012||row.rect[0]+row.rect[2]>Math.max(c[0]+c[2],graphic[0]+graphic[2])+.012))continue;
          if(claimed(row.rect)||row.rect[1]<figureTextFloor||captionAt(row)||isCaptionRow(row)||!inLane(row.rect)||row.rect[1]+row.rect[3]>c[1]||gap(row.rect,graphic)>(floating?.02:.055)||overlap(row.rect,graphic)<=0)continue;
          if(row.fontHeight>line.fontHeight*(marker?2.5:1.1)||!marker&&row.text.length>70)continue;
          if(!marker&&row.fontHeight>=line.fontHeight*.95&&lines.some(other=>other!==row&&other.text.length>70&&other.fontHeight>=line.fontHeight*.95&&other.rect[1]+other.rect[3]<=graphic[1]&&gap(other.rect,row.rect)<line.fontHeight*.8&&overlap(other.rect,row.rect)>row.rect[2]*.5))continue;
          object=union(object,row.rect);
        }
      }
      let rect=union(object,captionRect);const contentTop=rect[1];
      // Captions can follow prose with less whitespace than the usual padding.
      const preceding=lines.filter(row=>row.rect[1]+row.rect[3]<=contentTop&&row.rect[1]+row.rect[3]>contentTop-.006&&overlap(row.rect,rect)>Math.min(row.rect[2],rect[2])*.5);
      const textFloor=preceding.length?(Math.max(...preceding.map(row=>row.rect[1]+row.rect[3]))+contentTop)/2:0;
      rect=[Math.max(0,rect[0]-.006),Math.max(0,rect[1]-.006),Math.min(1-rect[0],rect[2]+.012),Math.min(1-rect[1],rect[3]+.012)];
      if(rect[1]<textFloor){rect[3]-=textFloor-rect[1];rect[1]=textFloor;}
      if(rect[1]<headerFloor){rect[3]-=headerFloor-rect[1];rect[1]=headerFloor;}
      const maxHeight=kind==='figure'||ruledTable||ruledAlgorithm ? .9 : .65;
      if(rect[3]>maxHeight||regions.some(region=>region.label===label))continue;
      const contentLines=wrapped?linesOf(texts.filter(item=>item.rect[0]>=rect[0]-.002&&item.rect[0]+item.rect[2]<=rect[0]+rect[2]+.002)):lines;
      const contents=contentLines.filter(row=>overlap(row.rect,rect)>row.rect[2]*.5&&row.rect[1]>=rect[1]&&row.rect[1]+row.rect[3]<=rect[1]+rect[3]).map(row=>row.text);
      regions.push({kind,label,rect,text:[label,captionText,...contents.filter(text=>!captionText.includes(text))].join('\n').slice(0,12000)});
    }
    return regions;
  }
  const multiply=(a,b)=>[a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
  function graphicRects(list,ops,viewport){
    let matrix=[1,0,0,1,0,0],clip=null,pendingClip=false,fillAlpha=1,strokeAlpha=1;const stack=[],rects=[];
    const intersect=(a,b)=>{const x=Math.max(a[0],b[0]),y=Math.max(a[1],b[1]);return [x,y,Math.max(0,Math.min(a[0]+a[2],b[0]+b[2])-x),Math.max(0,Math.min(a[1]+a[3],b[1]+b[3])-y)];};
    const boundsRect=bounds=>{
      if(!bounds||bounds.length!==4)return null;
      const m=multiply(viewport.transform,matrix),points=[[bounds[0],bounds[1]],[bounds[2],bounds[1]],[bounds[0],bounds[3]],[bounds[2],bounds[3]]].map(([x,y])=>[m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]]);
      const xs=points.map(p=>p[0]/viewport.width),ys=points.map(p=>p[1]/viewport.height),x=Math.min(...xs),y=Math.min(...ys);
      return [x,y,Math.max(...xs)-x,Math.max(...ys)-y];
    };
    const add=bounds=>{
      let rect=boundsRect(bounds);if(!rect||!rect.every(Number.isFinite))return;
      if(clip){
        if(clip[2]<=0||clip[3]<=0||rect[0]+rect[2]<clip[0]||rect[0]>clip[0]+clip[2]||rect[1]+rect[3]<clip[1]||rect[1]>clip[1]+clip[3])return;
        rect=intersect(rect,clip);
      }
      const [x,y,w,h]=rect;
      if(x<-.01||y<-.01||x+w>1.01||y+h>1.01||w<.006&&h<.006||w<.07&&h<.012)return;
      if(rects.length>=2000)return;
      rects.push([Math.max(0,x),Math.max(0,y),Math.max(w,.001),Math.max(h,.001)]);
    };
    const save=()=>stack.push({matrix:[...matrix],clip:clip&&[...clip],fillAlpha,strokeAlpha});
    const restore=()=>{const state=stack.pop();matrix=state?.matrix||[1,0,0,1,0,0];clip=state?.clip||null;fillAlpha=state?.fillAlpha??1;strokeAlpha=state?.strokeAlpha??1;};
    for(let i=0;i<list.fnArray.length;i++){
      const op=list.fnArray[i],args=list.argsArray[i]||[];
      if(op===ops.save)save();
      else if(op===ops.restore)restore();
      else if(op===ops.transform)matrix=multiply(matrix,args);
      else if(op===ops.setGState){for(const [key,value] of args[0]||[]){if(key==='ca')fillAlpha=value;else if(key==='CA')strokeAlpha=value;}}
      else if(op===ops.paintFormXObjectBegin){
        // Form bounds clip content but are never painted regions themselves.
        save();if(args[0])matrix=multiply(matrix,args[0]);
        const bounds=boundsRect(args[1]);if(bounds)clip=clip?intersect(clip,bounds):bounds;
      }
      else if(op===ops.paintFormXObjectEnd)restore();
      // PDF.js emits the clipping operator before the optimized constructPath.
      else if(op===ops.clip||op===ops.eoClip)pendingClip=true;
      else if(op===ops.constructPath){
        const strokeOnly=[ops.stroke,ops.closeStroke].filter(Number.isInteger).includes(args[0]),fillOnly=[ops.fill,ops.eoFill].filter(Number.isInteger).includes(args[0]);
        if(args[0]!==ops.endPath&&(strokeOnly?strokeAlpha>0:fillOnly?fillAlpha>0:fillAlpha>0||strokeAlpha>0))add(args[2]);
        if(pendingClip){const bounds=boundsRect(args[2]);if(bounds)clip=clip?intersect(clip,bounds):bounds;pendingClip=false;}
      }
      else if(fillAlpha>0&&[ops.paintImageXObject,ops.paintInlineImageXObject,ops.paintImageMaskXObject,ops.paintSolidColorImageMask].filter(Number.isInteger).includes(op))add([0,0,1,1]);
    }
    return rects;
  }
  function tightenRect(rect,raster,background=[255,255,255]){
    const {width,height,data}=raster,x0=Math.max(0,Math.floor(rect[0]*width)),y0=Math.max(0,Math.floor(rect[1]*height)),x1=Math.min(width,Math.ceil((rect[0]+rect[2])*width)),y1=Math.min(height,Math.ceil((rect[1]+rect[3])*height));
    let left=x1,top=y1,right=x0,bottom=y0,count=0;
    for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
      const offset=(y*width+x)*4,r=data[offset],g=data[offset+1],b=data[offset+2];
      // Pale code-panel fills are visible content, even when close to the page color.
      if(data[offset+3]<32||r>248&&g>248&&b>248||Math.abs(r-background[0])+Math.abs(g-background[1])+Math.abs(b-background[2])<12)continue;
      left=Math.min(left,x);right=Math.max(right,x+1);top=Math.min(top,y);bottom=Math.max(bottom,y+1);count++;
    }
    if(count<16)return rect;
    // Raster padding must not grow past the geometric boundary and reintroduce
    // an excluded running header or neighboring column.
    const x=Math.max(rect[0],left/width-.006),y=Math.max(rect[1],top/height-.006);
    return [x,y,Math.min(rect[0]+rect[2],right/width+.006)-x,Math.min(rect[1]+rect[3],bottom/height+.006)-y];
  }
  const cache=new WeakMap();
  function textRects(items,viewport){
    return items.filter(item=>item.str?.trim()&&item.transform).map(item=>{
      const [a,b,c,d,x,y]=item.transform,u=Math.hypot(a,b)||1,v=Math.hypot(c,d)||1,w=item.width,h=item.height||v;
      const corners=[[x,y],[x+a/u*w,y+b/u*w],[x+c/v*h,y+d/v*h],[x+a/u*w+c/v*h,y+b/u*w+d/v*h]].map(([x,y])=>viewport.convertToViewportPoint(x,y));
      const left=Math.min(...corners.map(p=>p[0])),top=Math.min(...corners.map(p=>p[1])),right=Math.max(...corners.map(p=>p[0])),bottom=Math.max(...corners.map(p=>p[1]));
      return {text:item.str,rect:[left/viewport.width,top/viewport.height,(right-left)/viewport.width,(bottom-top)/viewport.height]};
    }).filter(item=>item.rect.every(Number.isFinite)&&item.rect[2]>0&&item.rect[3]>0);
  }
  async function regions(page,engine,items){
    if(!cache.has(page))cache.set(page,page.getOperatorList().then(list=>graphicRects(list,engine.OPS,page.getViewport({scale:1}))).catch(()=>[]));
    const texts=textRects(items||(await page.getTextContent()).items,page.getViewport({scale:1}));
    return detect(texts,await cache.get(page));
  }
  async function mount(entry,page,engine,active){
    if(!cache.has(page))cache.set(page,page.getOperatorList().then(list=>graphicRects(list,engine.OPS,page.getViewport({scale:1}))).catch(()=>[]));
    const graphics=await cache.get(page);if(!active())return;
    const bounds=entry.box.getBoundingClientRect(),texts=[...entry.box.querySelectorAll('.textLayer span')].filter(span=>span.textContent.trim()&&!span.querySelector('span')).map(span=>({text:span.textContent,rect:normalizedRect(span.getBoundingClientRect(),bounds)}));
    entry.objects=detect(texts,graphics);
    const canvas=entry.box.querySelector('canvas');
    if(entry.objects.length&&canvas?.width&&canvas.height){
      // Drawing bounds can contain invisible padding; crop to visible ink in a bounded raster.
      const sample=document.createElement('canvas'),scale=Math.min(1,1000/canvas.width,1400/canvas.height);
      try{
        sample.width=Math.max(1,Math.round(canvas.width*scale));sample.height=Math.max(1,Math.round(canvas.height*scale));
        const context=sample.getContext('2d',{willReadFrequently:true});context.drawImage(canvas,0,0,sample.width,sample.height);
        const raster=context.getImageData(0,0,sample.width,sample.height),background=entry.box.classList.contains('dark')?[32,33,36]:[255,255,255];
        for(const object of entry.objects)object.rect=tightenRect(object.rect,raster,background);
      }catch{/* Retain geometric bounds if raster readback is unavailable. */}
      finally{sample.width=sample.height=0;}
    }
    const layer=document.createElement('div');layer.className='pdf-object-regions';
    for(const object of entry.objects){
      const button=document.createElement('button');button.type='button';button.className='pdf-object-target';button.setAttribute('aria-label',`Add ${object.label} to chat`);button.style.cssText=`left:${object.rect[0]*100}%;top:${object.rect[1]*100}%;width:${object.rect[2]*100}%;height:${object.rect[3]*100}%`;object.button=button;
      button.onfocus=()=>button.classList.add('hovered');button.onblur=()=>button.classList.remove('hovered');button.onclick=event=>{event.preventDefault();attach(entry,object);};layer.append(button);
    }
    entry.box.querySelector('.pdf-object-regions')?.remove();entry.box.append(layer);
  }
  function hit(entry,x,y){return (entry.objects||[]).filter(object=>pdfPointInRect(x,y,object.rect)).sort((a,b)=>a.rect[2]*a.rect[3]-b.rect[2]*b.rect[3])[0];}
  function clear(entry){for(const object of entry.objects||[])object.button?.classList.remove('hovered');entry.box.classList.remove('over-pdf-object');}
  function hover(entry,x,y){const object=hit(entry,x,y);for(const item of entry.objects||[])item.button?.classList.toggle('hovered',item===object);entry.box.classList.toggle('over-pdf-object',!!object);}
  function attach(entry,object){
    if(!window.NoctuaChatSelections?.add)return false;
    const rect=[...object.rect],page=entry.number;PDF.selection=null;updateChatContext();
    NoctuaChatSelections.add({text:object.text,source:{kind:'pdf',label:`${PDF.paper?.title||'PDF'} · ${object.label}`.slice(0,500),paper_key:PDF.key,page,page_end:page,region_kind:object.kind,region_label:object.label,rect},anchor:{kind:'pdf',page,rect,pages:[{page,rects:[rect]}]}});
    clear(entry);
    return true;
  }
  return {detect,graphicRects,tightenRect,textRects,regions,columnGutter,linesOf,mount,hit,hover,clear,attach};
})();
