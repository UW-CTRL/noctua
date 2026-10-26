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
  renderDetails();
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
  try{await saveWorkspaceFile();await flushNoteEdits();}catch(e){toast(e.message,{error:true});$('#notes-target').value=N.target||'';return;}
  W.file=null;
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
  await loadWorkspace(target);
  const hidden=new Set((W.manifest?.entries||[]).filter(e=>e.deleted&&e.note).map(e=>e.note));
  N.list=N.list.filter(n=>!hidden.has(n.id));
  const last = store.get('noctua.note.' + target);
  if (N.list.some((n) => n.id === last)) await openNote(last);
  else if (N.list.length) await openNote(N.list[0].id);
  else { N.doc = null; renderEditor(); }
}

function renderNoteList() {
  if(W.manifest&&W.target===N.target)renderWorkspaceTree();
  const el = $('#note-list');
  if (!N.list.length) {
    el.innerHTML = '<p class="hint">No notes in this folder yet.</p>';
    return;
  }
  el.innerHTML = N.list.map((n) => `
    <li data-id="${esc(n.id)}" class="${n.id === N.doc?.id ? 'active' : ''}">
      <div class="n-title">${esc(n.title || 'Untitled note')}</div>
      <div class="n-date">${new Date(n.updated).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>
      <button class="icon n-del" title="Delete note" data-icon="trash-2" aria-label="Delete note" data-icon-only>×</button>
    </li>`).join('');
}

async function createNote(title = '') {
  if (!N.target) return;
  try {
    await saveWorkspaceFile();await flushNoteEdits();
    const doc = await api('/api/notes', { target: N.target, title: typeof title === 'string' ? title : '' });
    N.list.unshift({ id: doc.id, title: doc.title, created: doc.created, updated: doc.updated });
    REF.notes.push({ id: doc.id, title: doc.title, updated: doc.updated, target: N.target });
    showNote(doc);
    await loadWorkspace(N.target);
    startEdit(doc.blocks[0].id);
    const t = $('.note-title');
    t.focus();
    t.select();
    return doc;
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
  try {
    await saveWorkspaceFile();await flushNoteEdits();
    showNote(await api(`/api/notes/${enc(N.target)}/${enc(id)}`));
  } catch (e) {
    toast(e.message, { error: true });
  }
}

function showNote(doc) {
  if (N.doc?.id !== doc.id) { N.preambleOpen = false; N.imgSel = null; N.conflict = false; }
  N.doc = doc;
  W.file=null;
  resetNoteHistory();
  N.editing = null;
  N.focusBlock = null;
  store.set('noctua.note.' + N.target, doc.id);
  renderNoteList();
  renderEditor();
  updateChatContext();
}

// ---------------------------------------------------------------- saving

function markDirty() {
  recordNoteChange();
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
  const historyFrames=NoteUndo.frames.splice(0);
  NoteUndo.group=null;
  const progressKey = `note-save:${target}:${doc.id}`;
  notifyProgress(progressKey, 'Saving note…');
  try {
    const r = await fetch(`/api/notes/${enc(target)}/${enc(doc.id)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({...doc,_history:historyFrames}),
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 409 && N.doc === doc) {
      NoteUndo.frames.unshift(...historyFrames);
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
    if (N.doc === doc) { setStatus('Saved'); refreshNoteHistory(); }
  } catch (e) {
    if (N.doc === doc) {
      NoteUndo.frames.unshift(...historyFrames);
      N.dirty = true;
      setStatus(`Save failed (${e.message}); retrying…`);
      N.saveTimer = setTimeout(saveNow, 3000);
    }
  } finally {
    notifyProgress(progressKey, null);
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
  if(typeof paperUnmount==='function')paperUnmount();
  for (const p of N.pads.values()) p.destroy();
  N.pads.clear();
  const stage = $('#notes-stage');
  const media = stage.dataset.mediaNote === N.doc?.id ? captureVideos(stage) : [];
  stage.dataset.mediaNote = N.doc?.id || '';
  if (!N.doc) {
    stage.innerHTML = `<div class="note-page note-empty">
      <p>${N.target ? 'No note open.' : 'Pick a Noctua folder.'}</p>
      ${N.target ? '<button class="primary" id="note-new-big" data-icon="file-plus" data-icon-only title="New note" aria-label="New note"></button>' : ''}</div>`;
    stage.querySelector('#note-new-big')?.addEventListener('click', createNote);
    return;
  }
  const folder = collections.targets.find((t) => t.id === N.target)?.name || '';
  stage.innerHTML = `<div class="note-actions" role="toolbar" aria-label="Note editing">
      ${historyButtons('note')}
      <div class="note-actions-right"><button id="note-help" data-icon="circle-help" data-icon-only title="Note guide" aria-label="Note guide"></button><button id="note-preamble-toggle" data-icon="settings" data-icon-only title="Preamble and page layout" aria-label="Preamble and page layout" aria-expanded="${!!N.preambleOpen}"></button></div>
    </div><div class="note-page">
      <textarea class="note-title" rows="1" placeholder="Untitled note" aria-label="Note title" spellcheck="false">${esc(N.doc.title)}</textarea>
    <div class="note-head${N.preambleOpen ? ' open' : ''}">
      <div class="note-meta"><span class="note-folder">${esc(folder)}</span><span id="note-status" class="note-save-status" role="status">Saved</span></div>
      ${N.preambleOpen ? `<div class="note-preamble">
        <textarea class="nb-src" spellcheck="false" placeholder="% Preamble: applies to the whole note and takes no space on the page
\\usepackage[margin=1in]{geometry}
\\newcommand{\\R}{\\mathbb{R}}
\\DeclareMathOperator{\\Tr}{Tr}">${esc(N.doc.preamble || '')}</textarea>
        <div class="preamble-status"></div></div>` : ''}
    </div>
    <div class="note-blocks"></div></div>`;
  wirePreamble(stage);
  stage.querySelector('#note-help').addEventListener('click', showNoteHelp);
  const wrap = stage.querySelector('.note-blocks');
  wrap.appendChild(inserter(0));
  N.doc.blocks.forEach((b, i) => {
    wrap.appendChild(blockEl(b));
    wrap.appendChild(inserter(i + 1));
  });
  typeset();
  restoreVideos(stage, media);
  updateHistoryButtons();
}

// The title shares the document width and grows with its wrapped text.
function layoutNoteTitle() {
  const title = $('#notes-stage .note-title');
  if (!title) return;
  title.style.height = 'auto';
  title.style.height = title.scrollHeight + 'px';
}

function showNoteHelp() {
  let dialog = document.getElementById('note-help-dialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'note-help-dialog';
    dialog.setAttribute('aria-labelledby', 'note-help-title');
    const example = source => `<pre><code>${esc(source)}</code></pre>`;
    dialog.innerHTML = `<div class="note-help-header"><h2 id="note-help-title">Note guide</h2><form method="dialog"><button data-icon="x" data-icon-only aria-label="Close note guide" title="Close" autofocus></button></form></div>
      <p class="note-help-intro">Write, add media, and connect your research.</p>
      <section><h3>Zotero notes</h3><p>Choose Library → Import from Zotero → Notes to copy paper and standalone notes into their collections. Imported notes are editable text with paragraph breaks; HTML formatting and embedded images are not reproduced. Re-importing preserves existing imported notes and your edits.</p></section>
      <section><h3>Selected passages in chat</h3><p>Drag across rendered note text and click Add to chat. You can attach several passages, hover over the annotation count to preview them, and remove individual passages before sending. Theme-colored numbered badges and faint highlights mark attached source passages. The badges match the attachment preview; click a badge to open it. Removing or sending attachments removes the badges and faint highlights without changing your note. These are chat attachments, not saved PDF annotations. The assistant receives the quoted text and note identifiers; adding or removing attachments is a UI-only control.</p></section>
      <section><h3>Writing and equations</h3><p>Click text to edit its source, with a live preview below. Press Esc or Command/Ctrl + Enter to finish. Changes save automatically. Command/Ctrl + B or I toggles bold or italic; brackets and dollar signs pair automatically.</p>${example(String.raw`Inline math: $E = mc^2$

\[ a^2 + b^2 = c^2 \]

\section{Introduction}
\textbf{Bold} and \emph{emphasis}`)}</section>
      <section><h3>Blocks and layout</h3><p>Hover between blocks to add Text, Drawing, or Image / Video. Hover over a block to reveal its left toolbar: move it up or down, or delete it. Drawing blocks also offer handwriting-to-LaTeX conversion.</p><p>The gear at the far right of the sticky note header opens the preamble for page layout and custom LaTeX commands.</p></section>
      <section><h3>Fonts and appearance</h3><p>Open Settings to choose separate System, Note, and Chat font families and sizes, and the Notes theme. Note font applies to the title, body, collection/save metadata, and empty-block writing hint; Title size defaults to 28 px. Collection and save-status text stay at 14 px. Title size and Body size are separate controls in Settings → Appearance → Fonts. App, Notes, and Reader themes default to System until you choose a preference. Equations keep their math typeface.</p></section>
      <section><h3>Images, videos, and drawings</h3><p>Use Image / Video between blocks, paste a media file or screenshot, or drag files onto the note. Drag an image or video's edge to resize it. Use Drawing for handwriting and sketches.</p><p>For local videos, MP4 with H.264 video and AAC audio is recommended. YouTube links go in a text block.</p></section>
      <section><h3>YouTube videos</h3><p>Paste a video URL on its own line in a text block. Finish editing to watch it inside the note. Shared links, Shorts, live videos, and start times work too.</p>${example('https://www.youtube.com/watch?v=aircAruvnKk')}<p>Use a text link when you want a title instead of a player:</p>${example(String.raw`\href{https://www.youtube.com/watch?v=aircAruvnKk}{What is a neural network?}`)}</section>
      <section><h3>References within a note</h3><p>Add a label to a numbered section, equation, figure, or theorem, then refer to it from any text block. Click the rendered reference number to jump to its label. References can point forward; missing labels show ??.</p>${example(String.raw`\section{Introduction}\label{sec:intro}
See Section \ref{sec:intro}.

\begin{equation}
E = mc^2 \label{eq:energy}
\end{equation}
See Equation \eqref{eq:energy}.`)}</section>
      <section><h3>Assistant changes</h3><p>The assistant can create notes and edit blocks, titles, preambles, and block order. It reads the saved updated version first. Direct edits save on the server before completion. Suggest changes appear in a review dialog; use Assistant changes below the project tree to revisit pending proposals. Accept applies the complete proposal as one undoable change. Concurrent edits require a fresh proposal. Chat can inspect saved handwriting; uncached previews need an active chat. Tree display names and note titles are separate.</p></section>
      <section><h3>Pane controls</h3><p>The thin left/right arrow rails hide or reopen navigation and chat. Pane widths and visibility are remembered without discarding drafts. The paper editor also has arrows to hide either source or PDF while leaving the other visible.</p></section>
      <section><h3>Find</h3><p>Cmd/Ctrl+F searches the selected cell source while editing, or the rendered note when no cell is being edited. In project text files, it searches the source editor only. Enter/Shift+Enter move between matches; Escape closes Find. Citation suggestions show formatted titles and label Collection or Bib filename, retaining both sources.</p></section>
      <section><h3>Paper editor</h3><p>Use Paper in Project files to create a standard LaTeX document beside a live compiled PDF. Import .cls, .sty, .bst, .bib, and images, and use their project-relative paths. Set an imported .tex as the main document from its actions menu. The project settings gear selects bundled Tectonic or pdfLaTeX, with BibTeX, per collection; note cells keep their existing lightweight preview. Double-click compiled PDF text to open and center the matching source line. The paper toolbar has a dedicated guide. You can also ask chat to inspect the LaTeX build log; agents have read-only access to internal workspace diagnostics.</p></section>
      <section><h3>Undo and redo</h3><p>The collection and save status align with the left end of the divider below the title. The title has extra space above it, follows the divider’s width where space permits, and wraps onto additional lines as you type. Only the Undo/Redo icons at the far left and Note guide and preamble icons at the far right stay pinned to the top while you scroll. The title scrolls with the document. The center between the edge controls stays transparent and does not block note text or editing. Use Undo/Redo or Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z for typing, titles, preambles, drawing, media resizing, block moves/deletions, and assistant edits. The reader has the same controls for annotations and comments. History lasts for this app session. Save conflicts must be resolved before undoing.</p></section>
      <section><h3>Project files and bibliographies</h3><p>Each collection has a Project files tree. Images and videos are grouped in a collapsed Media folder by default; click a folder to expand it. Files already placed in custom folders stay there, and later manual moves are preserved. The collection selector and creation icons share one sidebar header. Hover or keyboard-focus a creation icon to reveal its label below without moving the file list. Nested collections use consistent indentation; the current collection is highlighted without a checkmark. New note or file opens a form with Note or Text file, a name, and a destination folder. New folder opens a compact folder form. New files use the exact filename with no automatic extension. Project root appears only while dragging project entries. Drag entries onto a folder or Project root to move them, or onto Trash for an in-app removal confirmation. Folders include their descendants; Undo or Trash restores removed entries. Import files lets you choose or drop files, review and remove selections, then click Import. Failed uploads keep the remaining files for retry. Create folders and text files, import files, rename or move entries using their menu, and preview media. In Suggest mode, project-file edits ask inline in chat once per file per prompt; Direct mode applies edits without approval popups. Notes retain their block editor. Import a .bib file, then select the Bibliographies icon below the tree to enable its citation keys alongside library papers. Suggestions show collection and bibliography sources separately, including duplicates. Rename colliding keys when you need to cite them separately. Invalid bibliography edits show an error and keep the last valid citation index. Text files are editable up to 2 MB; general file imports support up to 32 MB. Use Image / Video for larger note videos.</p></section>
      <section><h3>Agent skills</h3><p>Settings → Skills separates Global Agent Skills from Project Skills. Global Location defaults to ~/.agents/skills; save another existing folder or use Use default. Global installations are read in place. Import Skills from Project copies multiple SKILL.md packages into a named group. Expand or collapse each project to browse its skills. Disconnect removes that group's Noctua copies and leaves original files and other groups unchanged; import again to reconnect. Individual skill imports remain available. Chat project defaults select skills for a Noctua project and are separate from source-project groups. In chat, type / to search all available skills and choose with Up/Down and Enter/Tab or a click (Esc closes). These commands add skills for one message without changing defaults. Every script run needs approval and separate output review. Scripts run local code, not in an OS sandbox. Plan mode cannot run scripts; dependencies are not installed automatically.</p></section>
      <section><h3>Citations and note links</h3><p>Type a citation command and choose a paper from the suggestions. Citation keys default to Noctua library item keys. Project bibliographies can add imported BibTeX keys using the same author/year appearance.</p>${example(String.raw`\cite{PAPER_KEY}`)}<p>Type [[ or \\noteref{ to search your notes, or link a note using its ID:</p>${example(String.raw`\noteref{NOTE_KEY}`)}<p>In chat, type @ to attach papers, notes, project files, folders, or collections. Results show types and paths. Text files attach excerpts; folders attach listings; media attach file references.</p></section>
      <section><h3>Assistant edits</h3><p>Open Chat to discuss the current note. Suggest mode offers edits for you to accept or reject. Plan mode investigates without changing your note. Direct mode saves requested edits on the server before reporting completion; use Undo to revert them. Suggest changes are reviewed as whole proposals in Assistant changes below the project tree.</p></section>`;
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
    document.body.appendChild(dialog);
  }
  if (!dialog.open) dialog.showModal();
}

// ---------------------------------------------------------------- preamble (the header cell)

// The default page fits the writing pane up to 760px. Explicit paper widths
// keep a fixed scale and scroll horizontally; preamble margins use that scale.
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
  layoutNoteTitle();
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

function inserter(index) {
  const d = document.createElement('div');
  d.className = 'nb-insert';
  d.innerHTML = '<span class="nb-insert-tools" role="group" aria-label="Insert block"><button data-type="text" data-icon="type">Text</button><button data-type="ink" data-icon="pen-tool">Drawing</button><button data-type="image" data-icon="image-plus">Image / Video</button></span>';
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
      <button data-act="up" title="Move up" data-icon="arrow-up" aria-label="Move up" data-icon-only>↑</button>
      <button data-act="down" title="Move down" data-icon="arrow-down" aria-label="Move down" data-icon-only>↓</button>
      ${b.type === 'ink' ? '<button data-act="latex" title="Convert handwriting to LaTeX (inserted below)" data-icon="sigma" aria-label="Convert handwriting to LaTeX (inserted below)" data-icon-only>TeX</button>'
        : ''}
      <button data-act="delete" title="Delete block" data-icon="trash-2" aria-label="Delete block" data-icon-only>✕</button>
    </div><div class="nb-body"></div>`;
  const body = el.querySelector('.nb-body');
  if (b.type === 'text') {
    body.innerHTML = '<div class="nb-view tex-view" data-placeholder="Click to write…"></div>';
    body.addEventListener('click', (e) => {
      if (e.target.closest('a, .tex-img, .tex-youtube') || !getSelection().isCollapsed) return;
      if (N.editing !== b.id) startEdit(b.id);
    });
  } else {
    N.pads.set(b.id, Ink.mount(body, b, markDirty, {undo:()=>undoNote(),redo:()=>undoNote(true)}));
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
  } else if (act === 'latex') {
    if (!chat.ready || chat.switching) return toast('Choose a research assistant first.');
    const doc = N.doc, target = N.target, provider = chat.provider;
    const png = N.pads.get(id)?.toPNG();
    if (!png) return toast('Draw something first.');
    btn.disabled = true;
    btn.textContent = '…';
    btn.dataset.icon = 'loader-circle';
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
      btn.dataset.icon = 'sigma';
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
    if (N.editing === id && document.activeElement !== ta && !document.activeElement.closest('#document-find') && !picker.hovering) stopEdit();
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
  if (el) el.innerHTML = '<div class="nb-view tex-view" data-placeholder="Click to write…"></div>';
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
  if(W.manifest)lines.push(`Project workspace: ${W.target}. Enabled bibliography files: ${(W.manifest.bibliographies||[]).join(', ')||'none'}. Use list_project_files/read_project_file for imported keys and files.`);
  if(W.file){lines.push(`Open project file ID: ${W.file}. Use project file tools to inspect it.`);return {lines,key:`file:${W.target}:${W.file}:${W.fileRevision}`};}
  if (!N.doc) return { lines: [...lines, 'No note open.'], key: null };
  const text = noteText(N.doc);
  const key = `${N.target}:${N.doc.id}:${N.doc.updated}`;
  lines.push(`Open note: "${N.doc.title}" (note id ${N.doc.id}, updated ${N.doc.updated}). \\cite keys resolve to library papers and enabled project bibliographies.`);
  const sel = N.imgSel && N.doc.blocks.find((b) => b.id === N.imgSel.block);
  const at = sel && imageOffsets(sel.src)[N.imgSel.k];
  if (at != null) lines.push(`Selected media (the user clicked it): ${texArgs(sel.src, at + mediaCommandLength(sel.src, at)).arg} in block ${sel.id}.`);
  if (key === sentKey) lines.push('Note text: unchanged since the previous message.');
  else lines.push('Note text (LaTeX):', text.length > 6000 ? text.slice(0, 6000) + '\n[… truncated; use read_note for the rest]' : text);
  return { lines, key };
}

// ---------------------------------------------------------------- wiring

new ResizeObserver(layoutNoteTitle).observe($('#notes-stage'));
document.addEventListener('noctua-font-change', layoutNoteTitle);
document.addEventListener('noctua-font-size-change', layoutNoteTitle);
document.fonts?.addEventListener('loadingdone', layoutNoteTitle);

// CSS follows system changes automatically; changing palettes never rewrites note content.
function setNotesTheme(theme) {
  const next = ['dark', 'light', 'system'].includes(theme) ? theme : 'system';
  $('#notes-stage').dataset.notesTheme = next;
  if ($('#setup-notes-theme')) $('#setup-notes-theme').value = next;
  store.set('noctua.notesTheme', next);
}
setNotesTheme(store.get('noctua.notesTheme'));
window.addEventListener('storage', (e) => {
  if (e.key === 'noctua.notesTheme' || e.key === null) setNotesTheme(store.get('noctua.notesTheme'));
});

document.querySelectorAll('.mode-switch button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
$('#notes-target').addEventListener('change', (e) => { loadNoteFolder(e.target.value); });

$('#note-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  if (e.target.closest('.n-del')) deleteNote(li.dataset.id);
  else if (li.dataset.id !== N.doc?.id) openNote(li.dataset.id);
});
$('#notes-stage').addEventListener('input', (e) => {
  if (!e.target.classList.contains('note-title') || !N.doc) return;
  N.doc.title = e.target.value;
  layoutNoteTitle();
  const entry = N.list.find((n) => n.id === N.doc.id);
  if (entry) { entry.title = N.doc.title; renderNoteList(); }
  markDirty();
});
function followNoteReference(key) {
  stopEdit();
  const target = Array.from($('#notes-stage').querySelectorAll('.nb-body [data-tex-label]')).find(anchor => anchor.dataset.texLabel === key);
  if (target) {
    target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
    (target.closest('.tex-display') || target).scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  } else toast('Reference target not found.');
}

$('#notes-stage').addEventListener('click', (e) => {
  const reference = e.target.closest('a.tex-ref');
  if (reference) {
    e.preventDefault();
    e.stopPropagation();
    followNoteReference(reference.dataset.texRef);
    return;
  }
  const a = e.target.closest('a.cite');
  if (!a) return;
  if(showBibReference(a.dataset.key)){e.preventDefault();return;}
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
  if ((isNotesMode() || document.body.classList.contains('pdf-mode')) && e.target.closest('#act-lib-graph')) setMode('graph');
}, true);
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

window.addEventListener('DOMContentLoaded',()=>{ if (store.get('noctua.mode') === 'notes' && !location.hash.startsWith('#pdf=')) collectionsReady.then(() => { if (!location.hash.startsWith('#pdf=')) setMode('notes'); }); });
