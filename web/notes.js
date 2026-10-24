'use strict';
// Notes mode: per-folder notes made of typed-LaTeX blocks and handwriting
// pads. Uses app.js globals ($, esc, api, store, toast, collections, …).

const N = {
  target: null,        // Noctua folder ("C1") whose notes are listed
  list: [],
  doc: null,           // open note
  items: new Map(),    // Noctua item key -> item, for \cite
  editing: null,       // id of the text block whose source is open
  pads: new Map(),     // block id -> Ink pad
  dirty: false,
  saving: false,
  saveTimer: null,
  typesetTimer: null,
  focusBlock: null,    // block new blocks are inserted after (⌘⇧D)
  suggestions: [],     // the assistant's pending edits: { id, op, block_id, latex, reason, summary }
  agentUndo: [],      // block lists from before each direct edit by Claude
  imgSel: null,        // selected image: { block, k } (figures.js)
};

const isNotesMode = () => document.body.classList.contains('notes-mode');
const newId = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ---------------------------------------------------------------- mode & folders

function setMode(mode) {
  const notes = mode === 'notes';
  document.body.classList.toggle('pdf-mode', mode === 'pdf');
  document.body.classList.toggle('notes-mode', notes);
  document.querySelectorAll('.mode-switch button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  store.set('noctua.mode', mode);
  $('#tooltip').classList.add('hidden');
  if (notes) {
    notesRefreshFolders();  // also loads the folder's notes the first time
    loadRefs(true).then(typeset);  // note titles for \noteref links
  } else {
    saveNow();
    requestAnimationFrame(() => draw());  // the canvas was hidden; repaint at its real size
  }
  updateChatContext();
}

// Called by app.js whenever the Noctua folder list (re)loads.
function notesRefreshFolders() {
  const ids = collections.targets.map((t) => t.id);
  const want = N.target || store.get('noctua.notesTarget');
  const pick = ids.includes(want) ? want : ids.find((i) => i.startsWith('C')) || ids[0] || '';
  $('#notes-target').innerHTML = collectionOptions(pick);
  if (isNotesMode() && !N.target && pick) loadNoteFolder(pick);
}

async function loadNoteFolder(target) {
  if (!target) return;
  await saveNow();
  N.target = target;
  store.set('noctua.notesTarget', target);
  $('#notes-target').value = target;
  N.items = new Map();
  try {
    const [list, items] = await Promise.all([api(`/api/notes?target=${enc(target)}`), api(`/api/library/items?target=${enc(target)}`)]);
    N.list = list;
    for (const it of items) { N.items.set(it.key, it); for (const key of it.cite_keys || []) N.items.set(key, it); }
  } catch (e) {
    N.list = [];
    toast(e.message, { error: true });
  }
  renderNoteList();
  const last = store.get('noctua.note.' + target);
  if (N.list.some((n) => n.id === last)) await openNote(last);
  else if (N.list.length) await openNote(N.list[0].id);
  else { N.doc = null; renderEditor(); }
}

function renderNoteList() {
  const el = $('#note-list');
  if (!N.list.length) {
    el.innerHTML = '<p class="hint">No notes in this folder yet.</p>';
    return;
  }
  el.innerHTML = N.list.map((n) => `
    <li data-id="${esc(n.id)}" class="${n.id === N.doc?.id ? 'active' : ''}">
      <div class="n-title">${esc(n.title || 'Untitled note')}</div>
      <div class="n-date">${new Date(n.updated).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>
      <button class="icon n-del" title="Delete note">×</button>
    </li>`).join('');
}

async function createNote() {
  if (!N.target) return;
  await saveNow();
  try {
    const doc = await api('/api/notes', { target: N.target, title: '' });
    N.list.unshift({ id: doc.id, title: doc.title, created: doc.created, updated: doc.updated });
    REF.notes.push({ id: doc.id, title: doc.title, updated: doc.updated, target: N.target });
    showNote(doc);
    startEdit(doc.blocks[0].id);
    const t = $('.note-title');
    t.focus();
    t.select();
  } catch (e) {
    toast(e.message, { error: true });
  }
}

async function deleteNote(id) {
  const n = N.list.find((x) => x.id === id);
  if (!confirm(`Delete “${n?.title || 'this note'}”?\n(It's moved to notes/.trash in Noctua's folder.)`)) return;
  if (N.doc?.id === id) { clearTimeout(N.saveTimer); N.dirty = false; }
  const r = await fetch(`/api/notes/${enc(N.target)}/${enc(id)}`, { method: 'DELETE' }).catch(() => null);
  if (!r?.ok) return toast("Couldn't delete the note", { error: true });
  N.list = N.list.filter((x) => x.id !== id);
  REF.notes = REF.notes.filter((x) => x.id !== id);
  if (N.doc?.id === id) {
    N.doc = null;
    if (N.list.length) return openNote(N.list[0].id);
    renderEditor();
  }
  renderNoteList();
}

async function openNote(id) {
  await saveNow();
  try {
    showNote(await api(`/api/notes/${enc(N.target)}/${enc(id)}`));
  } catch (e) {
    toast(e.message, { error: true });
  }
}

function showNote(doc) {
  if (N.doc?.id !== doc.id) { N.suggestions = []; N.agentUndo = []; N.preambleOpen = false; N.imgSel = null; N.conflict = false; }
  N.doc = doc;
  N.editing = null;
  N.focusBlock = null;
  store.set('noctua.note.' + N.target, doc.id);
  renderNoteList();
  renderEditor();
  updateChatContext();
}

// ---------------------------------------------------------------- saving

function markDirty() {
  N.dirty = true;
  if (N.conflict) return;  // keep the conflict notice until the user picks
  setStatus('Unsaved');
  clearTimeout(N.saveTimer);
  N.saveTimer = setTimeout(saveNow, 800);
}

// The note was saved from another tab or window since this copy was loaded.
function showConflict() {
  const el = $('#note-status');
  if (!el) return;
  el.innerHTML = '<span class="warn">Changed in another tab or window.</span> <a href="#" data-c="reload">Reload it</a> (drops your changes here) · <a href="#" data-c="mine">Keep mine</a> (overwrites)';
  el.onclick = async (e) => {
    const a = e.target.closest('[data-c]');
    if (!a) return;
    e.preventDefault();
    el.onclick = null;
    const doc = N.doc;
    N.conflict = false;
    if (a.dataset.c === 'reload') {
      N.dirty = false;
      N.doc = null;
      await openNote(doc.id);
    } else {
      const fresh = await api(`/api/notes/${enc(N.target)}/${enc(doc.id)}`);
      doc.updated = fresh.updated;
      saveNow();
    }
  };
}

function setStatus(s) {
  const el = $('#note-status');
  if (el) el.textContent = s;
}

async function saveNow() {
  clearTimeout(N.saveTimer);
  if (!N.dirty || !N.doc || N.saving || N.conflict) return;
  const doc = N.doc, target = N.target;
  N.dirty = false;
  N.saving = true;
  setStatus('Saving…');
  try {
    const r = await fetch(`/api/notes/${enc(target)}/${enc(doc.id)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc),
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 409 && N.doc === doc) {
      N.dirty = true;
      N.conflict = true;
      showConflict();
      return;
    }
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    doc.updated = j.updated;
    const entry = N.list.find((n) => n.id === doc.id);
    if (entry) { entry.updated = j.updated; entry.title = doc.title; }
    const ref = REF.notes.find((n) => n.id === doc.id);
    if (ref) { ref.updated = j.updated; ref.title = doc.title; }
    if (N.doc === doc) setStatus('Saved');
  } catch (e) {
    if (N.doc === doc) {
      N.dirty = true;
      setStatus(`Save failed (${e.message}); retrying…`);
      N.saveTimer = setTimeout(saveNow, 3000);
    }
  } finally {
    N.saving = false;
  }
  if (N.dirty && N.doc === doc) markDirty();  // edited while saving
}

// ---------------------------------------------------------------- citations

function citeHtml(keys, { textual, note }) {
  const parts = keys.map((k) => {
    const it = N.items.get(k);
    if (!it) return { html: `<span class="tex-missing" title="No item with this key in the folder">${esc(k)}?</span>`, year: '' };
    const last = (it.creators?.[0] || it.title || '?').trim().split(/\s+/).pop();
    const who = it.creators?.length > 2 ? `${last} et al.` : it.creators?.length === 2 ? `${last} and ${it.creators[1].trim().split(/\s+/).pop()}` : last;
    return { key: k, who: esc(who), year: esc(it.year ?? 'n.d.') };
  });
  const link = (p, text) => p.key ? `<a class="cite" data-key="${esc(p.key)}" title="${esc(N.items.get(p.key).title || '')}">${text}</a>` : p.html;
  const tail = note ? `, ${esc(note)}` : '';
  if (textual) return parts.map((p) => link(p, p.key ? `${p.who} (${p.year}${tail})` : '')).join('; ');
  return `(${parts.map((p) => link(p, p.key ? `${p.who} ${p.year}` : '')).join('; ')}${tail})`;
}

// ---------------------------------------------------------------- editor

function renderEditor() {
  for (const p of N.pads.values()) p.destroy();
  N.pads.clear();
  const stage = $('#notes-stage');
  const media = stage.dataset.mediaNote === N.doc?.id ? captureVideos(stage) : [];
  stage.dataset.mediaNote = N.doc?.id || '';
  if (!N.doc) {
    stage.innerHTML = `<div class="note-page note-empty">
      <p>${N.target ? 'No note open.' : 'Pick a Noctua folder.'}</p>
      ${N.target ? '<button class="primary" id="note-new-big">New note</button>' : ''}</div>`;
    stage.querySelector('#note-new-big')?.addEventListener('click', createNote);
    return;
  }
  const folder = collections.targets.find((t) => t.id === N.target)?.name || '';
  stage.innerHTML = `<div class="note-page">
    <div class="note-head${N.preambleOpen ? ' open' : ''}">
      <div class="nb-tools"><button id="note-preamble-toggle" title="Preamble: page margins (\\geometry), \\usepackage, \\newcommand">⚙</button></div>
      <input class="note-title" value="${esc(N.doc.title)}" placeholder="Untitled note" spellcheck="false">
      <div class="note-meta">${esc(folder)} · <span id="note-status">Saved</span>${N.agentUndo.length
        ? ` · <a href="#" id="note-undo-agent">Undo assistant's edit</a>` : ''}${N.suggestions.length > 1
        ? ` · ${N.suggestions.length} suggestions: <a href="#" id="sg-accept-all">accept all</a> / <a href="#" id="sg-reject-all">reject all</a>` : ''}</div>
      ${N.preambleOpen ? `<div class="note-preamble">
        <textarea class="nb-src" spellcheck="false" placeholder="% Preamble: applies to the whole note and takes no space on the page
\\usepackage[margin=1in]{geometry}
\\newcommand{\\R}{\\mathbb{R}}
\\DeclareMathOperator{\\Tr}{Tr}">${esc(N.doc.preamble || '')}</textarea>
        <div class="preamble-status"></div></div>` : ''}
    </div>
    <div class="note-blocks"></div></div>`;
  wirePreamble(stage);
  const wrap = stage.querySelector('.note-blocks');
  wrap.appendChild(inserter(0));
  N.doc.blocks.forEach((b, i) => {
    wrap.appendChild(blockEl(b));
    for (const sg of N.suggestions.filter((x) => x.block_id === b.id || (!x.block_id && i === 0))) {
      const card = suggestionEl(sg);
      // Inserts at the top go before the first block; everything else after its block.
      if (!sg.block_id) wrap.insertBefore(card, wrap.firstChild.nextSibling);
      else wrap.appendChild(card);
    }
    wrap.appendChild(inserter(i + 1));
  });
  // Drop suggestions whose block no longer exists.
  N.suggestions = N.suggestions.filter((x) => !x.block_id || blockIndex(x.block_id) >= 0);
  typeset();
  restoreVideos(stage, media);
}

// ---------------------------------------------------------------- preamble (the header cell)

// The page is a sheet drawn at a fixed scale (a letter-size 8.5in sheet is
// 760px wide); it never shrinks, and the stage scrolls sideways when the page
// is wider than it. \geometry{paperwidth=…} or `landscape` widens the sheet.
const PAPER_IN = 8.5;
const PX_PER_IN = 760 / PAPER_IN;
const UNIT_IN = { in: 1, cm: 1 / 2.54, mm: 1 / 25.4, pt: 1 / 72.27, bp: 1 / 72, pc: 12 / 72.27, px: 1 / 96 };
const GEOMETRY_KEYS = {
  margin: ['top', 'left', 'right'], hmargin: ['left', 'right'], left: ['left'], lmargin: ['left'], inner: ['left'],
  right: ['right'], rmargin: ['right'], outer: ['right'], top: ['top'], tmargin: ['top'],
};
// Packages KaTeX (or Noctua) already provides, so \usepackage of them is a no-op.
const BUILTIN_PACKAGES = new Set(['parskip', 'amsmath', 'amssymb', 'amsfonts', 'amsthm', 'mathtools', 'geometry', 'hyperref', 'bm', 'mathrsfs', 'xcolor', 'color', 'cancel', 'latexsym', 'graphicx', 'subcaption', 'caption', 'float']);

function parsePreamble(src) {
  src = src.replace(/(^|[^\\])%.*$/gm, '$1');
  const margins = {}, used = [], ignored = [], packages = [], opts = [];
  for (const m of src.matchAll(/\\usepackage\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/g)) {
    for (const p of m[2].split(',').map((x) => x.trim()).filter(Boolean)) {
      packages.push(p);
      if (p === 'geometry' && m[1]) opts.push(m[1]);
    }
  }
  for (const m of src.matchAll(/\\geometry\s*\{([^}]*)\}/g)) opts.push(m[1]);
  // Paper width first: margins are fractions of it, whatever the key order.
  let paper = PAPER_IN;
  const lengths = [];
  for (const kv of opts.join(',').split(',').map((x) => x.trim()).filter(Boolean)) {
    const [k, v = ''] = kv.split('=').map((x) => x.trim());
    if (kv === 'landscape') { paper = 11; used.push(kv); continue; }
    if (kv === 'letterpaper' || kv === 'portrait') { used.push(kv); continue; }
    const u = /^(\d*\.?\d+)\s*([a-z]{2})$/.exec(v);
    const inches = u && UNIT_IN[u[2]] ? Number(u[1]) * UNIT_IN[u[2]] : null;
    if (inches == null || !(GEOMETRY_KEYS[k] || k === 'textwidth' || k === 'paperwidth')) { ignored.push(kv); continue; }
    if (k === 'paperwidth') paper = Math.max(4, Math.min(30, inches));
    else lengths.push([k, inches]);
    used.push(kv);
  }
  const frac = (f) => Math.max(0, Math.min(0.4, f));
  for (const [k, inches] of lengths) {
    if (k === 'textwidth') margins.left = margins.right = frac((1 - inches / paper) / 2);
    else for (const side of GEOMETRY_KEYS[k]) margins[side] = frac(inches / paper);
  }
  // Paragraph shape: the parskip package, or \setlength{\parindent|\parskip}{len}.
  const par = packages.includes('parskip') ? { indent: '0', skip: '0.5em' } : {};
  for (const m of src.matchAll(/\\setlength\s*\{?\s*\\par(indent|skip)\s*\}?\s*\{\s*([^}]*?)\s*\}/g)) {
    if (/^(0|\d*\.?\d+(pt|em|ex|in|cm|mm|pc|px))$/.test(m[2])) par[m[1]] = m[2];
    else ignored.push(`\\par${m[1]}=${m[2]}`);
  }
  return { paper, margins, used, ignored, packages, par };
}

// Applies the preamble's margins to the page and fills its status line.
function applyPreamble() {
  const page = $('#notes-stage .note-page');
  if (!page || !N.doc) return;
  const src = N.doc.preamble || '';
  const g = parsePreamble(src);
  const width = g.paper * PX_PER_IN;
  page.style.width = g.paper === PAPER_IN ? '' : `${Math.round(width)}px`;
  for (const side of ['top', 'left', 'right']) {
    const f = g.margins[side];
    page.style.setProperty(`padding-${side}`, f == null ? '' : `${(f * width).toFixed(1)}px`);
  }
  page.style.setProperty('--np-parindent', g.par.indent ?? '');
  page.style.setProperty('--np-parskip', g.par.skip ?? '');
  const status = page.querySelector('.preamble-status');
  if (!status) return;
  const macros = Object.keys(NoctuaLatex.macrosOf(src));
  const missing = g.packages.filter((p) => !BUILTIN_PACKAGES.has(p));
  status.innerHTML = [
    g.used.length && `Margins: ${esc(g.used.join(', '))}`,
    (g.par.indent || g.par.skip) && `Paragraphs: ${esc([g.par.indent && `indent ${g.par.indent}`, g.par.skip && `skip ${g.par.skip}`].filter(Boolean).join(', '))}`,
    g.ignored.length && `<span class="warn">Ignored options: ${esc(g.ignored.join(', '))}</span>`,
    macros.length && `Defines ${esc(macros.join(' '))}`,
    missing.length && `<span class="warn">Not available (Noctua typesets with KaTeX): ${esc(missing.join(', '))}</span>`,
  ].filter(Boolean).join(' · ') || 'Margins (\\geometry), \\newcommand, \\DeclareMathOperator. Esc closes.';
}

function wirePreamble(stage) {
  applyPreamble();
  stage.querySelector('#note-preamble-toggle').addEventListener('click', () => {
    stopEdit();
    N.preambleOpen = !N.preambleOpen;
    renderEditor();
    if (N.preambleOpen) stage.querySelector('.note-preamble textarea').focus();
  });
  const ta = stage.querySelector('.note-preamble textarea');
  if (!ta) return;
  const grow = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 2 + 'px'; };
  grow();
  ta.addEventListener('focus', () => stopEdit());
  ta.addEventListener('input', () => {
    N.doc.preamble = ta.value;
    grow();
    applyPreamble();
    markDirty();
    clearTimeout(N.typesetTimer);
    N.typesetTimer = setTimeout(typeset, 150);
  });
  ta.addEventListener('keydown', (e) => {
    if (texKeys(e, ta)) return;
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      N.preambleOpen = false;
      renderEditor();
    }
  });
}

// ---------------------------------------------------------------- the assistant's edits

function suggestionEl(sg) {
  const d = document.createElement('div');
  d.className = `nb-suggest op-${sg.op}`;
  d.dataset.sid = sg.id;
  const what = { replace: 'Assistant suggests rewriting the block above', insert_after: 'Assistant suggests adding', delete: 'Assistant suggests deleting the block above' }[sg.op];
  const why = sg.reason || sg.summary;
  const body = sg.op === 'delete' ? ''
    : `<div class="sg-body tex-view">${NoctuaLatex.renderDoc([sg.latex], { cite: citeHtml, noteref: noteRefHtml, image: noteImageUrl, preamble: N.doc.preamble })[0]}</div>
       <details class="sg-src"><summary>LaTeX</summary><pre>${esc(sg.latex)}</pre></details>`;
  d.innerHTML = `<div class="sg-head">${what}${why ? `: <span class="sg-why">${esc(why)}</span>` : ''}</div>${body}
    <div class="sg-actions"><button data-act="accept" class="primary">Accept</button><button data-act="reject">Reject</button></div>`;
  d.querySelector('.sg-actions').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) resolveSuggestion(sg.id, b.dataset.act === 'accept');
  });
  return d;
}

// Applies one edit to the open note. Returns false if its block is gone.
function applyEdit(e) {
  const i = e.block_id ? blockIndex(e.block_id) : -1;
  if (e.op === 'replace' || e.op === 'delete') {
    if (i < 0) return false;
    if (e.op === 'delete') {
      N.doc.blocks.splice(i, 1);
      if (!N.doc.blocks.length) N.doc.blocks.push({ id: newId('b'), type: 'text', src: '' });
    } else if (N.doc.blocks[i].type === 'text') {
      N.doc.blocks[i].src = e.latex;
    } else {
      // A drawing can't hold text: keep it and add the text after it.
      N.doc.blocks.splice(i + 1, 0, { id: newId('b'), type: 'text', src: e.latex });
    }
    return true;
  }
  if (e.op === 'insert_after') {
    if (e.block_id && i < 0) return false;
    const nb = { id: newId('b'), type: 'text', src: e.latex };
    N.doc.blocks.splice(e.block_id ? i + 1 : 0, 0, nb);
    e.newId = nb.id;
    return true;
  }
  return false;
}

function resolveSuggestion(id, accept) {
  const sg = N.suggestions.find((x) => x.id === id);
  if (!sg) return;
  N.suggestions = N.suggestions.filter((x) => x !== sg);
  if (accept) {
    stopEdit();
    if (!applyEdit(sg)) toast('That block no longer exists; suggestion dropped.', { error: true });
    markDirty();
  }
  renderEditor();
}

// Called for the chat's `note_edit` action (the edit_note tool).
async function noteEditFromChat(a) {
  if (!isNotesMode()) setMode('notes');
  if (N.target !== a.folder) { N.target = null; await loadNoteFolder(a.folder); }
  if (N.doc?.id !== a.note_id) await openNote(a.note_id);
  if (N.doc?.id !== a.note_id) return toast("Couldn't open the note the assistant wanted to edit.", { error: true });
  stopEdit();
  const edits = (a.edits || []).map((e) => ({ ...e, id: newId('s'), summary: a.summary }));
  if (a.mode === 'direct') {
    N.agentUndo.push(JSON.stringify(N.doc.blocks));
    const touched = [];
    let skipped = 0;
    for (const e of edits) {
      if (applyEdit(e)) touched.push(e.newId || e.block_id);
      else skipped++;
    }
    markDirty();
    renderEditor();
    for (const id of touched) document.querySelector(`.nb[data-id="${id}"]`)?.classList.add('nb-flash');
    toast(`The assistant edited the note${skipped ? ` (${skipped} edit(s) skipped: block not found)` : ''}.`);
    document.querySelector('.nb-flash')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  } else {
    N.suggestions.push(...edits);
    renderEditor();
    document.querySelector(`.nb-suggest[data-sid="${edits[0]?.id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function inserter(index) {
  const d = document.createElement('div');
  d.className = 'nb-insert';
  d.innerHTML = '<button data-type="text">+ Text</button><button data-type="ink">+ Drawing</button><button data-type="image">+ Image / Video</button>';
  d.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b?.dataset.type === 'image') pickImages({ index });
    else if (b) insertBlock(index, b.dataset.type);
  });
  return d;
}

function blockEl(b) {
  const el = document.createElement('div');
  el.className = `nb nb-${b.type}`;
  el.dataset.id = b.id;
  el.innerHTML = `<div class="nb-tools">
      <button data-act="up" title="Move up">↑</button>
      <button data-act="down" title="Move down">↓</button>
      ${b.type === 'ink' ? '<button data-act="latex" title="Convert handwriting to LaTeX (inserted below)">TeX</button>'
        : '<button data-act="image" title="Add images or videos (to this figure, or as a new cell below)">🖼</button>'}
      <button data-act="delete" title="Delete block">✕</button>
    </div><div class="nb-body"></div>`;
  const body = el.querySelector('.nb-body');
  if (b.type === 'text') {
    body.innerHTML = '<div class="nb-view tex-view" data-placeholder="Click to write (LaTeX: $x^2$, \\section{…}, \\cite{…})"></div>';
    body.addEventListener('click', (e) => {
      if (e.target.closest('a, .tex-img')) return;
      if (N.editing !== b.id) startEdit(b.id);
    });
  } else {
    N.pads.set(b.id, Ink.mount(body, b, markDirty));
    body.addEventListener('focusin', () => { N.focusBlock = b.id; });
  }
  el.querySelector('.nb-tools').addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (t) blockAction(b.id, t.dataset.act, t);
  });
  return el;
}

const blockIndex = (id) => N.doc.blocks.findIndex((b) => b.id === id);

function insertBlock(index, type) {
  const b = type === 'ink' ? { id: newId('b'), type: 'ink', h: 0.35, strokes: [] } : { id: newId('b'), type: 'text', src: '' };
  stopEdit();
  N.doc.blocks.splice(index, 0, b);
  markDirty();
  renderEditor();
  if (type === 'text') startEdit(b.id);
  else {
    N.focusBlock = b.id;
    const el = document.querySelector(`.nb[data-id="${b.id}"] .ink`);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  return b;
}

async function blockAction(id, act, btn) {
  const i = blockIndex(id);
  const b = N.doc.blocks[i];
  if (act === 'up' || act === 'down') {
    const j = act === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= N.doc.blocks.length) return;
    stopEdit();
    [N.doc.blocks[i], N.doc.blocks[j]] = [N.doc.blocks[j], N.doc.blocks[i]];
    markDirty();
    renderEditor();
  } else if (act === 'delete') {
    const empty = b.type === 'text' ? !b.src.trim() : !b.strokes.length;
    if (!empty && !confirm(`Delete this ${b.type === 'text' ? 'text block' : 'drawing'}?`)) return;
    if (N.editing === id) N.editing = null;
    N.doc.blocks.splice(i, 1);
    if (!N.doc.blocks.length) N.doc.blocks.push({ id: newId('b'), type: 'text', src: '' });
    markDirty();
    renderEditor();
  } else if (act === 'image') {
    pickImages({ blockId: id });
  } else if (act === 'latex') {
    if (!chat.ready || chat.switching) return toast('Choose a research assistant first.');
    const doc = N.doc, target = N.target, provider = chat.provider;
    const png = N.pads.get(id)?.toPNG();
    if (!png) return toast('Draw something first.');
    btn.disabled = true;
    btn.textContent = '…';
    toast('Converting handwriting to LaTeX…');
    try {
      const { latex } = await api('/api/ink-latex', { png, provider });
      if (N.doc !== doc || N.target !== target || blockIndex(id) < 0) {
        toast('The note changed while transcribing. Reopen the drawing and try again.');
        return;
      }
      const nb = { id: newId('b'), type: 'text', src: latex };
      N.doc.blocks.splice(blockIndex(id) + 1, 0, nb);
      markDirty();
      renderEditor();
      toast('Converted. The LaTeX is below the drawing; delete the drawing if you no longer need it.');
    } catch (e) {
      toast(e.message, { error: true });
      btn.disabled = false;
      btn.textContent = 'TeX';
    }
  }
}

// Typesets every text block (numbering and \ref run across the note). The
// block being edited shows its result in the live preview instead.
function typeset() {
  if (!N.doc) return;
  const htmls = NoctuaLatex.renderDoc(N.doc.blocks.map((b) => b.type === 'text' ? b.src : null), { cite: citeHtml, noteref: noteRefHtml, image: noteImageUrl, preamble: N.doc.preamble });
  N.doc.blocks.forEach((b, i) => {
    if (b.type !== 'text') return;
    const el = document.querySelector(`.nb[data-id="${b.id}"]`);
    if (!el) return;
    const target = el.querySelector(N.editing === b.id ? '.nb-preview' : '.nb-view');
    if (!target) return;
    if (target._rendered !== htmls[i]) {
      const media = captureVideos(target);
      target.innerHTML = htmls[i];
      target._rendered = htmls[i];
      restoreVideos(target, media);
    }
    target.classList.toggle('is-empty', !b.src.trim());
  });
  applyImgSel();
}

function startEdit(id) {
  stopEdit();
  const b = N.doc.blocks.find((x) => x.id === id);
  const el = document.querySelector(`.nb[data-id="${id}"] .nb-body`);
  if (!b || !el) return;
  const media = captureVideos(el);
  N.editing = id;
  N.focusBlock = id;
  if (N.imgSel?.block === id) N.imgSel = null;
  el.innerHTML = '<textarea class="nb-src" spellcheck="false"></textarea><div class="nb-preview tex-view"></div>';
  const ta = el.querySelector('textarea');
  ta.value = b.src;
  const grow = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 2 + 'px'; };
  grow();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.addEventListener('input', () => {
    b.src = ta.value;
    grow();
    markDirty();
    clearTimeout(N.typesetTimer);
    N.typesetTimer = setTimeout(typeset, 150);
    updatePicker(ta);
    updateNoteLinkPicker(ta);
  });
  ta.addEventListener('keydown', (e) => {
    if (mention.ta === ta && mentionKey(e)) return;
    if (picker.open && pickerKey(e, ta)) return;
    if (texKeys(e, ta)) return;
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); stopEdit(); }
  });
  ta.addEventListener('click', () => updatePicker(ta));
  ta.addEventListener('blur', () => setTimeout(() => {
    if (N.editing === id && document.activeElement !== ta && !picker.hovering) stopEdit();
  }, 120));
  typeset();
  restoreVideos(el, media);
}

function stopEdit() {
  const id = N.editing;
  if (!id) return;
  N.editing = null;
  closePicker();
  closeMentions();
  const el = document.querySelector(`.nb[data-id="${id}"] .nb-body`);
  const media = el ? captureVideos(el) : [];
  if (el) el.innerHTML = '<div class="nb-view tex-view" data-placeholder="Click to write (LaTeX: $x^2$, \\section{…}, \\cite{…})"></div>';
  typeset();
  if (el) restoreVideos(el, media);
}

// ---------------------------------------------------------------- editing keys

// Overleaf-style typing aids for LaTeX source. With a selection, ( [ { $ " '
// wrap it (" and ' as ``…'' and `…'). Without one, ( [ { $ insert their pair,
// typing the closer steps over it, and Backspace inside an empty pair removes
// both. ⌘B / ⌘I wrap in \textbf{…} / \textit{…}; again unwraps.
const PAIRS = { '(': ')', '[': ']', '{': '}', '$': '$' };
const WRAPS = { ...PAIRS, '"': ['``', "''"], "'": ['`', "'"] };

// Replaces [start, end) with text and selects [s0, s1). execCommand keeps ⌘Z working.
function texEdit(ta, start, end, text, s0, s1 = s0) {
  ta.setSelectionRange(start, end);
  if (!document.execCommand(text ? 'insertText' : 'delete', false, text)) ta.setRangeText(text, start, end);
  ta.setSelectionRange(s0, s1);
  ta.dispatchEvent(new Event('input'));  // again, now the caret is in place (\cite{ picker)
}

function texKeys(e, ta) {
  if (e.isComposing || e.altKey) return false;
  const { selectionStart: s, selectionEnd: t, value: v } = ta;
  const k = e.key;
  if (e.metaKey || e.ctrlKey) {
    const cmd = { b: '\\textbf{', i: '\\textit{' }[k.toLowerCase()];
    if (!cmd || e.shiftKey) return false;
    e.preventDefault();
    if (v.slice(s - cmd.length, s) === cmd && v[t] === '}') texEdit(ta, s - cmd.length, t + 1, v.slice(s, t), s - cmd.length, t - cmd.length);
    else texEdit(ta, s, t, cmd + v.slice(s, t) + '}', s + cmd.length, t + cmd.length);
    return true;
  }
  if (s !== t) {
    if (!WRAPS[k]) return false;
    const [o, c] = Array.isArray(WRAPS[k]) ? WRAPS[k] : [k, WRAPS[k]];
    e.preventDefault();
    texEdit(ta, s, t, o + v.slice(s, t) + c, s + o.length, t + o.length);
    return true;
  }
  const prev = v[s - 1], next = v[s], escaped = v[s - 2] === '\\';
  if (k === 'Backspace') {
    if (!prev || PAIRS[prev] !== next || escaped) return false;
    e.preventDefault();
    texEdit(ta, s - 1, s + 1, '', s - 1);
    return true;
  }
  if (k === '$') {
    if (prev === '\\') return false;
    const inMath = (v.slice(0, s).match(/(?<!\\)\$\$?/g) || []).length % 2 === 1;  // $$ counts once
    e.preventDefault();
    if (inMath && prev === '$' && next === '$' && v[s - 2] !== '$') texEdit(ta, s, s, '$$', s + 1);  // $|$ → $$|$$
    else if (next === '$' && (inMath || prev === '$')) ta.setSelectionRange(s + 1, s + 1);
    else if (inMath || next === '$') texEdit(ta, s, s, '$', s + 1);
    else texEdit(ta, s, s, '$$', s + 1);
    return true;
  }
  if (')]}'.includes(k) && k === next && prev !== '\\') {
    e.preventDefault();
    ta.setSelectionRange(s + 1, s + 1);
    return true;
  }
  // Pair an opener only before whitespace, a closer or the end, and not after a backslash (\{, \().
  if ('([{'.includes(k) && prev !== '\\' && (!next || /[\s)\]}$.,;:]/.test(next))) {
    e.preventDefault();
    texEdit(ta, s, s, k + PAIRS[k], s + 1);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- \cite picker

const picker = { open: false, hovering: false, matches: [], index: 0, start: 0 };

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

function updatePicker(ta) {
  const before = ta.value.slice(0, ta.selectionEnd);
  const m = /\\cite[a-z]*(?:\[[^\]]*\])?\{([^}]*)$/.exec(before);
  if (!m) return closePicker();
  const token = m[1].split(',').pop();
  const q = token.trim().toLowerCase();
  picker.start = ta.selectionEnd - token.length;
  const items = [...new Map([...N.items.values()].map((it) => [it.key, it])).values()];
  picker.matches = items
    .filter((it) => !q || [it.title, (it.creators || []).join(' '), it.year, it.key].join(' ').toLowerCase().includes(q))
    .slice(0, 8);
  picker.index = 0;
  const el = $('#cite-picker');
  if (!picker.matches.length) {
    el.innerHTML = `<div class="cp-empty">${items.length ? 'No matching paper in this folder' : 'This folder has no papers'}</div>`;
  } else {
    el.innerHTML = picker.matches.map((it, i) => `
      <div class="cp-item${i === 0 ? ' active' : ''}" data-i="${i}">
        <div class="cp-title">${esc(it.title || '(untitled)')}</div>
        <div class="cp-meta">${esc((it.creators || []).slice(0, 3).join(', '))}${it.year ? ' · ' + it.year : ''}</div>
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

// ---------------------------------------------------------------- chat context

function noteText(doc) {
  const pre = doc.preamble?.trim() ? `[preamble · not a block; its \\newcommand etc. apply to the whole note]\n${doc.preamble}\n\n` : '';
  return pre + doc.blocks.map((b) => b.type === 'text' ? `[block ${b.id} · text]\n${b.src}` : `[block ${b.id} · drawing]`).join('\n\n');
}

// Lines for the chat's view of the screen while in Notes mode. The note's
// text is only resent when it changed (`key`).
function notesContext(sentKey) {
  if (!isNotesMode()) return { lines: [], key: null };
  const folder = collections.targets.find((t) => t.id === N.target);
  const lines = [`Notes mode. Folder: ${folder ? `${folder.name} (${folder.id})` : 'none'}.`];
  if (!N.doc) return { lines: [...lines, 'No note open.'], key: null };
  const text = noteText(N.doc);
  const key = `${N.doc.id}:${text.length}:${text.slice(0, 50)}:${text.slice(-200)}`;
  lines.push(`Open note: "${N.doc.title}" (note id ${N.doc.id}). \\cite keys are Noctua item keys of the folder's papers.`);
  const sel = N.imgSel && N.doc.blocks.find((b) => b.id === N.imgSel.block);
  const at = sel && imageOffsets(sel.src)[N.imgSel.k];
  if (at != null) lines.push(`Selected media (the user clicked it): ${texArgs(sel.src, at + mediaCommandLength(sel.src, at)).arg} in block ${sel.id}.`);
  if (key === sentKey) lines.push('Note text: unchanged since the previous message.');
  else lines.push('Note text (LaTeX):', text.length > 6000 ? text.slice(0, 6000) + '\n[… truncated; use read_note for the rest]' : text);
  return { lines, key };
}

// ---------------------------------------------------------------- wiring

// CSS follows system changes automatically; changing palettes never rewrites note content.
function setNotesTheme(theme) {
  const next = ['dark', 'light', 'system'].includes(theme) ? theme : 'dark';
  $('#notes-stage').dataset.notesTheme = next;
  if ($('#setup-notes-theme')) $('#setup-notes-theme').value = next;
  store.set('noctua.notesTheme', next);
}
setNotesTheme(store.get('noctua.notesTheme'));
window.addEventListener('storage', (e) => {
  if (e.key === 'noctua.notesTheme' || e.key === null) setNotesTheme(store.get('noctua.notesTheme'));
});

document.querySelectorAll('.mode-switch button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
$('#notes-target').addEventListener('change', (e) => { N.target = null; loadNoteFolder(e.target.value); });
$('#note-new').addEventListener('click', createNote);
$('#note-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  if (e.target.closest('.n-del')) deleteNote(li.dataset.id);
  else if (li.dataset.id !== N.doc?.id) openNote(li.dataset.id);
});
$('#notes-stage').addEventListener('input', (e) => {
  if (!e.target.classList.contains('note-title') || !N.doc) return;
  N.doc.title = e.target.value;
  const entry = N.list.find((n) => n.id === N.doc.id);
  if (entry) { entry.title = N.doc.title; renderNoteList(); }
  markDirty();
});
$('#notes-stage').addEventListener('click', (e) => {
  const act = e.target.closest('#note-undo-agent, #sg-accept-all, #sg-reject-all');
  if (act) {
    e.preventDefault();
    if (act.id === 'note-undo-agent' && N.agentUndo.length) {
      stopEdit();
      N.doc.blocks = JSON.parse(N.agentUndo.pop());
      markDirty();
      renderEditor();
    } else if (act.id !== 'note-undo-agent') {
      const accept = act.id === 'sg-accept-all';
      for (const sg of [...N.suggestions]) resolveSuggestion(sg.id, accept);
    }
    return;
  }
  const a = e.target.closest('a.cite');
  if (!a) return;
  e.preventDefault();
  e.stopPropagation();
  const it = N.items.get(a.dataset.key);
  if (!it) return;
  lib.detail = it;
  G.selected = null;
  renderLibDetails(it);
  showRightTab('paper');
}, true);
// "Visualize paper graph" on a cited paper takes you back to the graph.
$('#details').addEventListener('click', (e) => {
  if (isNotesMode() && e.target.closest('#act-lib-graph')) setMode('graph');
}, true);
const cp = $('#cite-picker');
cp.addEventListener('mouseenter', () => { picker.hovering = true; });
cp.addEventListener('mouseleave', () => { picker.hovering = false; });
cp.addEventListener('mousedown', (e) => {
  e.preventDefault();  // keep focus in the textarea
  const d = e.target.closest('.cp-item');
  if (d && cp._ta) pickCite(cp._ta, picker.matches[Number(d.dataset.i)]);
});
document.addEventListener('keydown', (e) => {
  if (!isNotesMode() || !(e.metaKey || e.ctrlKey)) return;
  if (e.key.toLowerCase() === 's') { e.preventDefault(); saveNow(); }
  if (e.key.toLowerCase() === 'd' && e.shiftKey && N.doc) {
    e.preventDefault();
    const i = N.focusBlock ? blockIndex(N.focusBlock) : -1;
    insertBlock(i < 0 ? N.doc.blocks.length : i + 1, 'ink');
  }
});
window.addEventListener('beforeunload', (e) => {
  if (!N.dirty) return;
  saveNow();
  e.preventDefault();
  e.returnValue = '';
});

if (store.get('noctua.mode') === 'notes' && !location.hash.startsWith('#pdf=')) collectionsReady.then(() => { if (!location.hash.startsWith('#pdf=')) setMode('notes'); });
