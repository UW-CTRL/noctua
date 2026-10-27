'use strict';
const picker = { open: false, hovering: false, matches: [], index: 0, start: 0, sequence: 0 };
const citationCache=new Map();
function citationCandidates(){const library=[...new Map([...N.items.values()].filter(it=>!it.bib).map(it=>[it.key,it])).values()];return [...library,...(W.target===N.target?W.manifest?.bib_index||[]:[])];}
async function paperCitations(){const target=W.target;const stamp=JSON.stringify([target,(W.manifest?.entries||[]).filter(e=>!e.deleted&&/\.bib$/i.test(e.name)).map(e=>[e.id,e.name,e.parent,e.blob])]);if(!citationCache.has(stamp)){citationCache.clear();citationCache.set(stamp,api(`/api/workspaces/${enc(target)}/bibliography-search`).catch(e=>{citationCache.delete(stamp);throw e;}));}return citationCache.get(stamp);}
function citationTitle(it){return NoctuaLatex.renderDoc([it.fields?.title||it.title||'(untitled)'],{})[0];}


// Pixel position of the caret in a textarea (mirror-div technique).
function caretXY(ta) {
  const cs = getComputedStyle(ta);
  const div = document.createElement('div');
  for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderLeftWidth', 'boxSizing', 'tabSize']) div.style[p] = cs[p];
  Object.assign(div.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', width: ta.offsetWidth + 'px', top: '0', left: '-9999px' });
  div.textContent = ta.value.slice(0, ta.selectionEnd);
  const span = document.createElement('span');
  span.textContent = '\u200b';
  div.appendChild(span);
  document.body.appendChild(div);
  const r = ta.getBoundingClientRect();
  const xy = { x: r.left + span.offsetLeft - ta.scrollLeft, y: r.top + span.offsetTop + span.offsetHeight - ta.scrollTop };
  div.remove();
  return xy;
}

async function updatePicker(ta) {
  const sequence=++picker.sequence,target=W.target;
  const before = ta.value.slice(0, ta.selectionEnd);
  const m = /\\cite[a-z]*(?:\[[^\]]*\])*\{([^}]*)$/.exec(before);
  if (!m) return closePicker();
  const token = m[1].split(',').pop();
  const q = token.trim().toLowerCase();
  picker.start = ta.selectionEnd - token.length;
  let items,errors=[];
  try{if(ta.matches('.workspace-source')){const result=await paperCitations();items=result.entries;errors=result.errors||[];}else items=citationCandidates();}
  catch(error){items=[];errors=[error.message];}
  if(sequence!==picker.sequence||!ta.isConnected||target!==W.target)return;
  picker.matches = items
    .filter((it) => !q || [it.title, (it.creators || []).join(' '), it.year, it.key].join(' ').toLowerCase().includes(q))
    .slice(0, 50);
  picker.index = 0;
  const el = $('#cite-picker');
  if (!picker.matches.length) {
    el.innerHTML = `<div class="cp-empty">${errors.length?esc(errors.join('; ')):items.length?'No matching citation':'No citations available; import a .bib file for papers or enable it for notes'}</div>`;
  } else {
    el.innerHTML = picker.matches.map((it, i) => `
      <div class="cp-item${i === 0 ? ' active' : ''}" data-i="${i}">
        <div class="cp-title">${citationTitle(it)}</div>
        <div class="cp-meta">${esc((it.creators || []).slice(0, 3).join(', '))}${it.year ? ' · ' + esc(it.year) : ''}</div><div class="cp-source">${it.bib?'Bib: '+esc(it.file_name):'Collection'} · <code>${esc(it.key)}</code></div>
      </div>`).join('');
  }
  const { x, y } = caretXY(ta);
  el.style.left = Math.min(x, window.innerWidth - 400) + 'px';
  el.style.top = Math.min(y + 4, window.innerHeight - 260) + 'px';
  el.classList.remove('hidden');
  el._ta = ta;
  picker.open = true;
}

function closePicker() {
  picker.sequence++;
  picker.open = false;
  picker.hovering = false;
  $('#cite-picker').classList.add('hidden');
}

function pickerKey(e, ta) {
  const n = picker.matches.length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!n) return false;
    e.preventDefault();
    picker.index = (picker.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    document.querySelectorAll('#cite-picker .cp-item').forEach((d, i) => d.classList.toggle('active', i === picker.index));
    $('#cite-picker .cp-item.active')?.scrollIntoView({block:'nearest'});
    return true;
  }
  if ((e.key === 'Enter' || e.key === 'Tab') && n) { e.preventDefault(); pickCite(ta, picker.matches[picker.index]); return true; }
  if (e.key === 'Escape') { e.preventDefault(); closePicker(); return true; }
  return false;
}

function pickCite(ta, it) {
  const end = ta.selectionEnd;
  const after = ta.value.slice(end);
  const closes = /^[^{}\n]*\}/.test(after);
  const rest = closes ? after.replace(/^[^,}]*/, '') : '}' + after;  // drop the rest of the typed token
  ta.value = ta.value.slice(0, picker.start) + it.key + rest;
  const pos = picker.start + it.key.length + (closes ? 0 : 1);
  ta.setSelectionRange(pos, pos);
  closePicker();
  ta.dispatchEvent(new Event('input'));
  closePicker();
  ta.focus();
}

const cp = $('#cite-picker');
cp.addEventListener('mouseenter', () => { picker.hovering = true; });
cp.addEventListener('mouseleave', () => { picker.hovering = false; });
cp.addEventListener('mousedown', (e) => {
  e.preventDefault();  // keep focus in the textarea
  const d = e.target.closest('.cp-item');
  if (d && cp._ta) pickCite(cp._ta, picker.matches[Number(d.dataset.i)]);
});

function paperCitationInput(ta){return ta?.matches('.workspace-source')&&!ta.dataset.paperCompletion&&/\.tex$/i.test(W.manifest?.entries.find(e=>e.id===W.file)?.name||'');}
document.addEventListener('input',e=>{if(paperCitationInput(e.target))updatePicker(e.target);});
document.addEventListener('click',e=>{if(paperCitationInput(e.target))updatePicker(e.target);else if(!e.target.closest('#cite-picker,.nb-src'))closePicker();});
document.addEventListener('keydown',e=>{if(paperCitationInput(e.target)&&picker.open&&$('#cite-picker')._ta===e.target&&pickerKey(e,e.target))e.stopImmediatePropagation();},true);
