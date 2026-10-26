'use strict';
// Searching papers, notes, and project entries together: @-mentions in the chat, and [[ note
// links in note text (inserted as \noteref{id}). Uses app.js and notes.js globals.

const REF = { papers: [], notes: [], at: 0, loading: null, project: null, projectAt: 0, entries: [], revision: null };

// Every Noctua paper (all libraries) and every note (all folders). Cached briefly.
function loadRefs(force = false) {
  if (!force && REF.at && Date.now() - REF.at < 30000) return Promise.resolve();
  if (REF.loading) return REF.loading;
  const libs = collections.targets.filter((t) => t.id === 'L1');
  REF.loading = Promise.all([api('/api/notes/all'), ...libs.map((l) => api(`/api/library/items?target=${enc(l.id)}`))])
    .then(([notes, ...items]) => {
      REF.notes = notes;
      REF.papers = items.flat();
      REF.at = Date.now();
    })
    .catch(() => {})
    .finally(() => { REF.loading = null; });
  return REF.loading;
}

const folderName = (target) => collections.targets.find((t) => t.id === target)?.name || '';

// Project entries use stable IDs; paths are display/search labels, not identity.
function mentionEntryPath(entries, entry) {
 const parts=[entry.name||'Untitled'],seen=new Set([entry.id]);let parent=entry.parent;
 while(parent){const folder=entries.find(e=>e.id===parent&&!e.deleted);if(!folder||seen.has(parent))break;seen.add(parent);parts.unshift(folder.name);parent=folder.parent;}
 return parts.join('/');
}
let projectRefsSequence=0;
async function loadProjectRefs(target) {
 const revision=W.target===target?W.manifest?.revision:null;
 if(REF.project===target&&REF.revision===revision&&Date.now()-REF.projectAt<2000)return;
 const seq=++projectRefsSequence;
 // Drop old candidates immediately; a failed fetch must not expose another project's files.
 REF.project=null;REF.entries=[];REF.projectAt=0;
 if(!target)return;
 try{
  const m=await api(`/api/workspaces/${enc(target)}`);
  if(seq!==projectRefsSequence||chatProjectTarget()!==target)return;
  REF.entries=(m.entries||[]).filter(e=>!e.deleted).map(e=>({...e,target,path:mentionEntryPath(m.entries,e)}));
  REF.project=target;REF.revision=revision;REF.projectAt=Date.now();
 }catch(e){if(seq===projectRefsSequence)REF.projectError=e.message;}
}
const refIdentity=r=>JSON.stringify([r.kind,r.ref.target||'',r.ref.key||r.ref.id]);
function mentionToken(r) {
 const label=refLabel(r).replace(/[\[\]\r\n]/g,'');
 let token=`@[${label}]`,i=1;
 while(chat.mentions.has(token)&&refIdentity(chat.mentions.get(token))!==refIdentity(r))token=`@[${label} · ${r.kind} ${++i}]`;
 return token;
}

// Best matches for `q`: every word must appear; title-word prefixes rank highest.
function searchRefs(q, { kinds = ['paper', 'note', 'file', 'folder', 'collection'], limit = 8 } = {}) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  const consider = (kind, ref, title, extra, recency) => {
    const t = (title || '').toLowerCase();
    const hay = `${t} ${extra}`.toLowerCase();
    if (!words.every((w) => hay.includes(w))) return;
    const tw = t.split(/[^\p{L}\p{N}]+/u);
    let score = 0;
    for (const w of words) score += tw.some((x) => x.startsWith(w)) ? 3 : t.includes(w) ? 2 : 1;
    out.push({ kind, ref, score: score + recency });
  };
  const notes=[...REF.notes];
  for(const e of REF.entries.filter(e=>e.kind==='note')){const at=notes.findIndex(n=>n.id===e.note&&n.target===e.target);const n={...(notes[at]||{}),id:e.note,target:e.target,title:e.name};if(at>=0)notes[at]=n;else notes.push(n);}
  const newest = Math.max(1, ...notes.map((n) => n.updated || 0));
  if (kinds.includes('note')) {
    for (const n of notes) {
      const here = n.target && n.target === N.target ? 0.5 : 0;
      consider('note', n, n.title, folderName(n.target), here + 0.4 * ((n.updated || 0) / newest));
    }
  }
  if (kinds.includes('paper')) {
    for (const p of REF.papers) consider('paper', p, p.title, `${(p.creators || []).join(' ')} ${p.year || ''} ${p.venue || ''}`, 0);
  }
  if(kinds.includes('file')||kinds.includes('folder'))for(const e of REF.entries){
    if(kinds.includes(e.kind)&&['file','folder'].includes(e.kind))consider(e.kind,e,e.name,`${e.path} ${folderName(e.target)}`,0.6);
  }
  if(kinds.includes('collection'))for(const c of collections.targets)consider('collection',c,c.name,'collection project folder',c.id===chatProjectTarget()?0.5:0);
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

const refLabel = r => ['file','folder'].includes(r.kind)?(r.ref.path||r.ref.name):r.kind==='collection'?r.ref.name:(r.ref.title||'Untitled');
const refKindLabel = r => r.kind==='file'?((r.ref.name.includes('.')?r.ref.name.split('.').pop():'FILE').slice(0,12).toUpperCase()):r.kind.toUpperCase();

function refMeta(r) {
  if(['file','folder'].includes(r.kind))return [folderName(r.ref.target),r.ref.path].filter(Boolean).join(' · ');
  if(r.kind==='collection')return 'Collection / project';
  if (r.kind === 'note') return [folderName(r.ref.target), r.ref.updated && new Date(r.ref.updated).toLocaleDateString()].filter(Boolean).join(' · ');
  const p = r.ref;
  return [(p.creators || []).slice(0, 2).join(', ') + ((p.creators || []).length > 2 ? ' et al.' : ''), p.year].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------- the popup

// One popup shared by the chat box and note text areas.
const mention = { open: false, results: [], index: 0, ta: null, start: 0, onPick: null };

function showMentions(ta, start, results, onPick, emptyText) {
  const el = $('#mention-picker');
  mention.results = results;
  mention.index = 0;
  mention.ta = ta;
  mention.start = start;
  mention.onPick = onPick;
  el.innerHTML = results.length ? results.map((r, i) => `
    <div class="cp-item${i === 0 ? ' active' : ''}" data-i="${i}">
      <div class="cp-title"><span class="ref-kind ${r.kind}">${esc(refKindLabel(r))}</span>${esc(refLabel(r))}</div>
      <div class="cp-meta">${esc(refMeta(r))}</div>
    </div>`).join('') : `<div class="cp-empty">${esc(emptyText)}</div>`;
  const { x, y } = caretXY(ta);
  el.classList.remove('hidden');
  el.style.left = Math.max(8, Math.min(x, window.innerWidth - 400)) + 'px';
  // Below the caret, or above it when there's no room (the chat box sits at the bottom).
  const h = el.offsetHeight;
  el.style.top = (y + 4 + h > window.innerHeight ? Math.max(8, y - ta.clientHeight / 2 - h - 18) : y + 4) + 'px';
  mention.open = true;
}

function closeMentions() {
  mention.open = false;
  $('#mention-picker').classList.add('hidden');
}

// Arrow keys / Enter / Tab / Esc while the popup is open. Returns true if handled.
function mentionKey(e) {
  if (!mention.open) return false;
  const n = mention.results.length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!n) return false;
    e.preventDefault();
    mention.index = (mention.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    document.querySelectorAll('#mention-picker .cp-item').forEach((d, i) => d.classList.toggle('active', i === mention.index));
    $('#mention-picker .cp-item.active')?.scrollIntoView({block:'nearest'});
    return true;
  }
  if ((e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) && n) {
    e.preventDefault();
    mention.onPick(mention.results[mention.index]);
    return true;
  }
  if (e.key === 'Escape') { e.preventDefault(); closeMentions(); return true; }
  return false;
}

// Replaces ta.value[mention.start .. caret] with `text`.
function replaceTyped(ta, text) {
  const end = ta.selectionEnd;
  ta.value = ta.value.slice(0, mention.start) + text + ta.value.slice(end);
  const pos = mention.start + text.length;
  ta.setSelectionRange(pos, pos);
  closeMentions();
  ta.focus();
}

// ---------------------------------------------------------------- chat @-mentions

chat.mentions = new Map();  // "@[Title]" -> { kind, ref }

async function updateChatMentions() {
  const ta = $('#chat-input');
  const before = ta.value.slice(0, ta.selectionEnd);
  const m = /(?:^|\s)@([^@\n\[\]]{0,200})$/.exec(before);
  if (!m) return closeMentions();
  const target=chatProjectTarget();
  await Promise.all([loadRefs(),loadProjectRefs(target)]);
  if (ta.value.slice(0, ta.selectionEnd) !== before||chatProjectTarget()!==target||document.activeElement!==ta) return;  // typed/navigated away while loading
  const q = m[1];
  showMentions(ta, ta.selectionEnd - q.length - 1, searchRefs(q), (r) => {
    const token = mentionToken(r);
    chat.mentions.set(token, r);
    replaceTyped(ta, token + ' ');
  }, q ? 'No paper, note, file, or folder matches' : 'Search papers, notes, project files, and folders');
}

// Text attached to the message for every mention still in it.
async function chatAttachments(text) {
  const parts = [];
  for (const [token, r] of chat.mentions) {
    if (!text.includes(token)) continue;
    if (r.kind === 'paper') {
      const p = r.ref;
      parts.push([
        `${token} = Noctua paper (item key ${p.key}):`,
        `Title: ${p.title || ''}`,
        p.has_pdf && `PDF available: use read_pdf or view_pdf_page with paper_key ${p.key}.`,
        `Authors: ${(p.creators || []).join(', ')}`,
        `Year: ${p.year ?? 'n.d.'}${p.venue ? ` · ${p.venue}` : ''}`,
        p.DOI && `DOI: ${p.DOI}`, p.arxiv && `arXiv: ${p.arxiv}`, p.s2 && `Semantic Scholar paperId: ${p.s2}`,
        p.abstractNote && `Abstract: ${p.abstractNote.slice(0, 3000)}`,
      ].filter(Boolean).join('\n'));
    } else if(r.kind==='note') {
      const n = r.ref;
      try {
        // The open note may have unsaved edits; use the editor's copy.
        const doc = N.target===n.target && N.doc?.id === n.id ? N.doc : await api(`/api/notes/${enc(n.target)}/${enc(n.id)}`);
        const body = noteText(doc);
        parts.push(`${token} = note "${doc.title}" (folder_id ${n.target}, note_id ${n.id}):\n${body.length > 12000 ? body.slice(0, 12000) + '\n[… truncated; use read_note]' : body}`);
      } catch (e) {
        parts.push(`${token} = note ${n.id} (could not be read: ${e.message})`);
      }
    } else {
      const f=r.ref,target=r.kind==='collection'?f.id:f.target;
      try {
        if(r.kind==='file'){
          const read=await api(`/api/workspaces/${enc(target)}/files/${enc(f.id)}`);
          const draft=W.target===target&&W.file===f.id&&W.dirty;
          const source=draft?W.text:read.text;
          const header=`${token} = project file "${f.path}" (folder_id ${target}, file_id ${f.id}, workspace revision ${read.revision}):`;
          parts.push(header+'\n'+(typeof source==='string'?`${draft?'Unsaved editor draft; read_project_file returns saved content.\n':''}${source.slice(0,12000)}${source.length>12000?'\n[… truncated; use read_project_file]':''}`:`Binary or oversized file (${read.entry?.size??'unknown'} bytes). Contents are not attached. Use list_project_files for metadata.${/\.(png|jpe?g|gif|webp)$/i.test(f.name)?' Use view_note_image with folder_id and path files/'+f.id+' to inspect this image.':''}`));
        }else{
          const m=await api(`/api/workspaces/${enc(target)}`),entries=(m.entries||[]).filter(e=>!e.deleted);
          if(r.kind==='folder'&&!entries.some(e=>e.id===f.id&&e.kind==='folder'))throw Error('Folder no longer exists');
          const descendants=new Set(r.kind==='folder'?[f.id]:['']);
          for(let i=0;i<entries.length;i++){let added=false;for(const e of entries)if(descendants.has(e.parent||'')&&!descendants.has(e.id)){descendants.add(e.id);added=true;}if(!added)break;}
          const selected=entries.filter(e=>descendants.has(e.id)&&e.id!==f.id);
          const listing=selected.slice(0,100).map(e=>`${e.kind}: ${mentionEntryPath(entries,e)} (${e.kind==='note'?'note_id '+e.note:e.kind==='folder'?'project_folder_id '+e.id:'file_id '+e.id})`).join('\n');
          parts.push(`${token} = ${r.kind==='folder'?'project folder':'collection/project'} (folder_id ${target}${r.kind==='folder'?', project_folder_id '+f.id:''}, workspace revision ${m.revision}):\n${listing.slice(0,12000)||'(No files)'}\n${selected.length>100||listing.length>12000?'[… listing truncated]\n':''}Use list_project_files, read_project_file, or read_note to inspect individual entries. Folder contents are not recursively attached.`);
          if(r.kind==='collection'){
            const papers=await api(`/api/library/items?target=${enc(target)}`);
            parts.push('Collection papers:\n'+papers.slice(0,100).map(p=>`${p.title} (paper_key ${p.key})`).join('\n').slice(0,12000)+(papers.length>100?'\n[… truncated; use list_folder_items]':''));
          }
        }
      } catch(e){parts.push(`${token} = ${r.kind} (folder_id ${target}, id ${f.id}); could not be read: ${e.message}`);}
    }
  }
  chat.mentions.clear();
  const attached=parts.join('\n\n');
  return attached.length>60000?attached.slice(0,60000)+'\n[… attachment limit reached; use project/library tools for more context]':attached;
}

// User messages show mentions as chips.
const mentionChips = (html) => html.replace(/@\[([^\]]+)\]/g, '<span class="mention">@$1</span>');

// ---------------------------------------------------------------- note links ([[ and \noteref{)

function noteRefHtml(id) {
  const n = REF.notes.find((x) => x.id === id);
  if (!n) return REF.at ? `<span class="tex-missing" title="No note with this id">[note?]</span>` : '<span class="noteref pending">note</span>';
  return `<a class="noteref" data-id="${esc(n.id)}" data-target="${esc(n.target || '')}" title="${esc(folderName(n.target))}">${esc(n.title || 'Untitled note')}</a>`;
}

async function updateNoteLinkPicker(ta) {
  const before = ta.value.slice(0, ta.selectionEnd);
  const m = /(\[\[|\\noteref\{)([^\]\}\n]{0,40})$/.exec(before);
  if (!m) { if (mention.ta === ta) closeMentions(); return; }
  await loadRefs();
  if (ta.value.slice(0, ta.selectionEnd) !== before) return;
  const q = m[2];
  const results = searchRefs(q, { kinds: ['note'], limit: 6 }).filter((r) => r.ref.id !== N.doc?.id);
  showMentions(ta, ta.selectionEnd - m[0].length, results, (r) => {
    // Swallow a closing "]]" / "}" the user may already have typed.
    const close = (m[1] === '[[' ? /^\]\]/ : /^\}/).exec(ta.value.slice(ta.selectionEnd));
    replaceTyped(ta, `\\noteref{${r.ref.id}}`);
    if (close) { const p = ta.selectionEnd; ta.value = ta.value.slice(0, p) + ta.value.slice(p + close[0].length); ta.setSelectionRange(p, p); }
    ta.dispatchEvent(new Event('input'));
  }, q ? 'No note matches' : 'Type a note title');
}

async function openNoteRef(id, target) {
  if (!target) return toast("That note's Noctua folder no longer exists.", { error: true });
  if (N.target !== target) { N.target = null; await loadNoteFolder(target); }
  if (N.doc?.id !== id) await openNote(id);
}

// ---------------------------------------------------------------- wiring

const mp = $('#mention-picker');
mp.addEventListener('mousedown', (e) => {
  e.preventDefault();  // keep focus in the text box
  const d = e.target.closest('.cp-item');
  if (d && mention.onPick) mention.onPick(mention.results[Number(d.dataset.i)]);
});
$('#chat-input').addEventListener('input', updateChatMentions);
$('#chat-input').addEventListener('blur', () => setTimeout(() => { if (mention.ta === $('#chat-input')) closeMentions(); }, 150));
$('#notes-stage').addEventListener('click', (e) => {
  const a = e.target.closest('a.noteref');
  if (!a) return;
  e.preventDefault();
  e.stopPropagation();
  openNoteRef(a.dataset.id, a.dataset.target);
}, true);
