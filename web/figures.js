'use strict';
// Images in notes, Obsidian-style. An image cell is an ordinary text cell
// whose LaTeX is a figure environment: paste, drop or pick images to add them
// (more images turn it into subfigures), click an image to select it, drag its
// edge to resize (the width is written back into the LaTeX), ✕ or Delete to
// remove it. New files share the note folder's media/ directory.
// Uses notes.js / app.js globals (N, $, enc, toast, markDirty, …).

// ---------------------------------------------------------------- figure LaTeX (pure)

// Blanks out % comments (keeping offsets) so commented-out code is skipped.
const maskComments = (s) => s.replace(/(^|[^\\])(%.*)$/gm, (m, a, c) => a + ' '.repeat(c.length));

// `s[i]` is '{' or '['; returns { text, end } with end just past the match.
function texGroup(s, i, open = '{', close = '}') {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === open) depth++;
    else if (s[j] === close && --depth === 0) return { text: s.slice(i + 1, j), end: j + 1 };
  }
  return { text: s.slice(i + 1), end: s.length };
}

// Optional [..] then required {..} argument starting at i (spaces allowed).
function texArgs(s, i) {
  let j = i;
  while (/\s/.test(s[j] || '')) j++;
  let opt = null;
  if (s[j] === '[') { const g = texGroup(s, j, '[', ']'); opt = g.text; j = g.end; while (/\s/.test(s[j] || '')) j++; }
  if (s[j] !== '{') return { opt, arg: null, end: j };
  const g = texGroup(s, j);
  return { opt, arg: g.text, end: g.end };
}

// Offsets of each \includegraphics, in the order the renderer numbers them.
function mediaCommandLength(src, at) { return /^\\(?:includegraphics|includevideo)/.exec(src.slice(at))?.[0].length || 0; }

function imageOffsets(src) {
  const out = [];
  const re = /\\(?:includegraphics|includevideo)(?![A-Za-z])/g;
  for (let m; (m = re.exec(maskComments(src)));) out.push(m.index);
  return out;
}

// [{ start, end }] of each figure environment (end is just past \end{figure}).
function figureSpans(src) {
  const masked = maskComments(src), out = [];
  const re = /\\begin\s*\{(figure\*?)\}/g;
  for (let m; (m = re.exec(masked));) {
    const close = `\\end{${m[1]}}`;
    const e = masked.indexOf(close, re.lastIndex);
    const end = e < 0 ? src.length : e + close.length;
    out.push({ start: m.index, end });
    re.lastIndex = end;
  }
  return out;
}

const figureAt = (src, offset) => figureSpans(src).find((f) => f.start <= offset && offset < f.end) || null;

// `0.48\textwidth` -> 0.48, `\linewidth` -> 1, otherwise null.
function texWidth(s) {
  const m = /^\s*(\d*\.?\d*)\s*\\(?:textwidth|linewidth|columnwidth)(?![A-Za-z])/.exec(s || '');
  return m ? (m[1] === '' ? 1 : parseFloat(m[1])) : null;
}
const optWidth = (opt) => texWidth((/(?:^|,)\s*width\s*=\s*([^,]*)/.exec(opt || '') || [])[1]);
const fmtWidth = (w) => w >= 0.995 ? '\\textwidth' : `${+w.toFixed(2)}\\textwidth`;

// The first \caption / \label argument in s (null if none).
function cmdArg(s, name) {
  const m = new RegExp(`\\\\${name}(?![A-Za-z])`).exec(maskComments(s));
  return m ? texArgs(s, m.index + m[0].length).arg : null;
}

// A figure environment as { env, place, caption, label, items: [{ path, width, caption, label }] }.
function parseFigure(src, span) {
  const text = src.slice(span.start, span.end);
  const head = /^\\begin\s*\{(figure\*?)\}(\s*\[([^\]]*)\])?/.exec(text);
  const fig = { env: head[1], place: head[3] ?? null, caption: null, label: null, items: [] };
  const masked = maskComments(text);
  let outer = '', last = 0;
  const re = /\\begin\s*\{subfigure\}/g;
  for (let m; (m = re.exec(masked));) {
    const a = texArgs(text, m.index + m[0].length);
    const e = masked.indexOf('\\end{subfigure}', a.end);
    const end = e < 0 ? text.length : e + '\\end{subfigure}'.length;
    const body = text.slice(a.end, e < 0 ? text.length : e);
    const g = /\\(?:includegraphics|includevideo)(?![A-Za-z])/.exec(maskComments(body));
    if (g) fig.items.push({ command: g[0].slice(1), path: texArgs(body, g.index + g[0].length).arg || '', width: texWidth(a.arg) ?? 0.48, caption: cmdArg(body, 'caption'), label: cmdArg(body, 'label') });
    outer += text.slice(last, m.index);
    last = re.lastIndex = end;
  }
  outer += text.slice(last);
  if (!fig.items.length) {
    const re2 = /\\(?:includegraphics|includevideo)(?![A-Za-z])/g;
    for (let m; (m = re2.exec(maskComments(outer)));) {
      const a = texArgs(outer, m.index + m[0].length);
      fig.items.push({ command: m[0].slice(1), path: a.arg || '', width: optWidth(a.opt) ?? 0.6, caption: null, label: null });
    }
  }
  fig.caption = cmdArg(outer, 'caption');
  fig.label = cmdArg(outer, 'label');
  return fig;
}

function figureSrc(fig) {
  const place = fig.place != null ? `[${fig.place}]` : '';
  const lines = [`\\begin{${fig.env}}${place}`, '  \\centering'];
  if (fig.items.length === 1) {
    const it = fig.items[0];
    lines.push(`  \\${it.command || 'includegraphics'}[width=${fmtWidth(it.width)}]{${it.path}}`);
  } else {
    fig.items.forEach((it, i) => {
      if (i) lines.push('  \\hfill');
      lines.push(`  \\begin{subfigure}[b]{${fmtWidth(it.width)}}`, '    \\centering', `    \\${it.command || 'includegraphics'}[width=\\textwidth]{${it.path}}`);
      if (it.caption != null) lines.push(`    \\caption{${it.caption}}`);
      if (it.label) lines.push(`    \\label{${it.label}}`);
      lines.push('  \\end{subfigure}');
    });
  }
  if (fig.caption != null) lines.push(`  \\caption{${fig.caption}}`);
  if (fig.label) lines.push(`  \\label{${fig.label}}`);
  lines.push(`\\end{${fig.env}}`);
  return lines.join('\n');
}

const SINGLE_WIDTH = 0.6, ROW = 0.96;
const round2 = (w) => Math.round(w * 100) / 100;
const evenWidths = (items) => items.every((it) => Math.abs(it.width - items[0].width) < 0.015);

// Sets widths after the number of images changed: untouched (equal) widths
// are re-spread evenly; widths the user set are kept, scaled down to fit a row.
function refit(fig, wasEven) {
  const n = fig.items.length;
  if (n === 1) { if (wasEven) fig.items[0].width = SINGLE_WIDTH; return; }
  if (wasEven) { for (const it of fig.items) it.width = round2(ROW / n); return; }
  const sum = fig.items.reduce((a, it) => a + it.width, 0);
  if (sum > ROW) for (const it of fig.items) it.width = Math.floor(it.width * ROW / sum * 100) / 100;
}

// Adds images ({ path, caption, label }) to a figure; one image becomes subfigures.
function addFigureItems(fig, items) {
  const wasEven = fig.items.length > 1 ? evenWidths(fig.items) : true;
  if (fig.items.length === 1) {  // the figure's caption stays the overall one
    const first = fig.items[0];
    first.caption = first.newCaption ?? 'Caption.';
  }
  for (const it of items) fig.items.push({ command: it.command, path: it.path, width: ROW / (fig.items.length + 1), caption: it.caption, label: it.label });
  refit(fig, wasEven);
  return fig;
}

// Removes image i; with one left, the subfigures fold back into a plain figure.
function removeFigureItem(fig, i) {
  const wasEven = evenWidths(fig.items);
  fig.items.splice(i, 1);
  if (fig.items.length === 1) {
    const it = fig.items[0];
    if (fig.caption == null) fig.caption = it.caption;
    if (!fig.label) fig.label = it.label;
    it.caption = it.label = null;
  }
  if (fig.items.length) refit(fig, wasEven);
  return fig;
}

function newFigure(items) {
  if (items.length === 1) return { env: 'figure', place: 'h', caption: items[0].caption, label: items[0].label, items: [{ command: items[0].command, path: items[0].path, width: SINGLE_WIDTH }] };
  const fig = { env: 'figure', place: 'h', caption: 'Caption.', label: null, items: [] };
  for (const it of items) fig.items.push({ command: it.command, path: it.path, width: round2(ROW / items.length), caption: it.caption, label: it.label });
  return fig;
}

// Writes width w (fraction of \textwidth) for image k of src: its subfigure's
// width if it's in one, else its own width= option.
function setImageWidth(src, k, w) {
  const at = imageOffsets(src)[k];
  if (at == null) return src;
  const masked = maskComments(src);
  const sub = masked.lastIndexOf('\\begin{subfigure}', at);
  if (sub >= 0 && masked.lastIndexOf('\\end{subfigure}', at) < sub) {
    const a = texArgs(src, sub + '\\begin{subfigure}'.length);
    if (a.arg !== null) return src.slice(0, a.end - a.arg.length - 1) + fmtWidth(w) + src.slice(a.end - 1);
  }
  const start = at + mediaCommandLength(src, at);
  const a = texArgs(src, start);
  const width = `width=${fmtWidth(w)}`;
  if (a.opt === null) return src.slice(0, start) + `[${width}]` + src.slice(start);
  const optStart = src.indexOf('[', start);
  const opt = /(^|,)\s*width\s*=\s*[^,]*/.test(a.opt) ? a.opt.replace(/(^|,)(\s*)width\s*=\s*[^,]*/, `$1$2${width}`) : `${width},${a.opt}`;
  return src.slice(0, optStart + 1) + opt + src.slice(optStart + 1 + a.opt.length);
}

// Removes image k of src: from its figure (shrinking subfigures), or the bare
// \includegraphics if it isn't in one. An emptied figure is removed.
function removeImage(src, k) {
  const at = imageOffsets(src)[k];
  if (at == null) return src;
  const span = figureAt(src, at);
  if (!span) {
    const a = texArgs(src, at + mediaCommandLength(src, at));
    return src.slice(0, at) + src.slice(a.end);
  }
  const fig = parseFigure(src, span);
  removeFigureItem(fig, k - imageOffsets(src).filter((o) => o < span.start).length);
  const before = src.slice(0, span.start), after = src.slice(span.end);
  if (fig.items.length) return before + figureSrc(fig) + after;
  const b = before.replace(/\s*$/, ''), a = after.replace(/^\s*/, '');
  return b + (b && a ? '\n\n' : '') + a;
}

// Caption and label text for a newly added file, from its name.
function imageNames(fileName, usedLabels) {
  const stem = fileName.replace(/\.[^.]*$/, '');
  const generic = !stem || /^(image|screenshot|screen shot|img[_ -]?\d|pasted|photo|clipboard)/i.test(stem);
  const words = stem.replace(/[_-]+/g, ' ').replace(/[\\{}$&#^%~]/g, '').trim();
  const caption = generic || !words ? 'Caption.' : words[0].toUpperCase() + words.slice(1);
  const slug = (generic ? 'image' : stem.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')) || 'image';
  let label = `fig:${slug}`;
  for (let n = 2; usedLabels.has(label); n++) label = `fig:${slug}-${n}`;
  usedLabels.add(label);
  return { caption, label };
}

// ---------------------------------------------------------------- editor UI

// URL of an images/… path of the open note's folder, for the renderer.
function noteImageUrl(path) {
  const file=/^files\/(f[a-zA-Z0-9_-]+)$/.exec(path.trim());
  if(file&&N.target)return `/api/workspaces/${enc(N.target)}/files/${file[1]}/content`;
  const m = /^(images|media)\/([A-Za-z0-9_-]+\.(?:png|jpe?g|gif|webp|mp4|mov|webm))$/i.exec(path.trim());
  return m && N.target ? `/api/note-${m[1] === 'images' ? 'images' : 'media'}/${enc(N.target)}/${m[2]}` : null;
}

const isMediaFile = (f) => /^(image|video)\//.test(f.type) || /\.(png|jpe?g|gif|webp|mp4|m4v|mov|webm)$/i.test(f.name || '');
async function uploadImage(file, target) {
  const r = await fetch(`/api/note-media/${enc(target)}`, { method: 'POST', body: file });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

function usedLabels() {
  const set = new Set();
  for (const b of N.doc.blocks) if (b.type === 'text') for (const m of b.src.matchAll(/\\label\{([^}]*)\}/g)) set.add(m[1]);
  return set;
}

// Replaces a text cell's source, keeping an open source editor in sync.
function setBlockSrc(b, src) {
  b.src = src;
  if (N.editing === b.id) {
    const ta = document.querySelector(`.nb[data-id="${b.id}"] textarea`);
    if (ta) { const p = Math.min(ta.selectionStart, src.length); ta.value = src; ta.setSelectionRange(p, p); ta.dispatchEvent(new Event('input')); }
  }
  markDirty();
  typeset();
}

// Adds image files to cell `blockId`: into its figure if it has one (unless
// forceNew), into it if it's empty, else as a new image cell after it (or at
// `index`).
async function addImages(files, opts = {}) {
  try {
    await importMediaFiles(files, opts);
  } catch (e) {
    console.error('Media import failed', e);
    toast(`Could not add media: ${e.message || e}`, { error: true });
  }
}

async function importMediaFiles(files, { blockId = null, index = null, forceNew = false } = {}) {
  files = [...files].filter(isMediaFile);
  if (!N.doc) return toast('Open a note before adding images or videos.', { error: true });
  if (!files.length) return toast('Choose an image (PNG, JPEG, GIF, WebP) or video (MP4, MOV, WebM).', { error: true });
  toast(files.length > 1 ? `Adding ${files.length} media files…` : 'Adding media…');
  const doc = N.doc, targetFolder = N.target;
  let paths;
  try {
    paths = await Promise.all(files.map((f) => uploadImage(f, targetFolder)));
  } catch (e) {
    return toast(e.message, { error: true });
  }
  if (N.doc !== doc || N.target !== targetFolder) return toast('The note changed during upload. Return to the intended note and add the files again.', { error: true });
  const labels = usedLabels();
  const items = paths.map(({ path, kind }, i) => ({ path, command: kind === 'video' ? 'includevideo' : 'includegraphics', ...imageNames(files[i].name || '', labels) }));
  const b = index == null && blockId ? N.doc.blocks.find((x) => x.id === blockId) : null;
  const spans = b?.type === 'text' && !forceNew ? figureSpans(b.src) : [];
  if (spans.length) {
    const sel = N.imgSel?.block === b.id ? figureAt(b.src, imageOffsets(b.src)[N.imgSel.k] ?? -1) : null;
    const span = sel || spans[spans.length - 1];
    const fig = parseFigure(b.src, span);
    if (fig.items.length === 1) fig.items[0].newCaption = imageNames(fig.items[0].path.replace(/^.*\//, '').replace(/-[0-9a-f]{8}(\.\w+)$/, '$1'), labels).caption;
    const first = imageOffsets(b.src).filter((o) => o < span.start).length + fig.items.length;
    addFigureItems(fig, items);
    setBlockSrc(b, b.src.slice(0, span.start) + figureSrc(fig) + b.src.slice(span.end));
    selectImage(b.id, first);
    if(typeof loadWorkspace==='function')loadWorkspace(N.target);
    return;
  }
  const src = figureSrc(newFigure(items));
  stopEdit();
  let target;
  if (b?.type === 'text' && !b.src.trim() && !forceNew) {
    b.src = src;
    target = b;
  } else {
    target = { id: newId('b'), type: 'text', src };
    const at = index ?? (b ? blockIndex(b.id) + 1 : N.doc.blocks.length);
    N.doc.blocks.splice(at, 0, target);
  }
  markDirty();
  renderEditor();
  selectImage(target.id, 0);
  if(typeof loadWorkspace==='function')loadWorkspace(N.target);
  document.querySelector(`.nb[data-id="${target.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

const imgInput = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp,video/mp4,video/quicktime,video/webm,.mp4,.m4v,.mov,.webm', multiple: true, hidden: true });
document.body.appendChild(imgInput);
// Opens the system file dialog; the chosen images go to addImages(…, opts).
function pickImages(opts) {
  imgInput.onchange = () => { addImages(imgInput.files, opts); imgInput.value = ''; };
  imgInput.click();
}

// ---- selection, resize, remove

function selectImage(block, k) {
  N.imgSel = block == null ? null : { block, k };
  applyImgSel();
}

// Marks the selected image (after every typeset, which rebuilds the HTML).
function applyImgSel() {
  document.querySelectorAll('#notes-stage .tex-img.selected').forEach((el) => {
    el.classList.remove('selected');
    el.querySelector('.img-del')?.remove();
  });
  if (!N.imgSel) return;
  const el = document.querySelector(`.nb[data-id="${N.imgSel.block}"] .nb-view .tex-img[data-img="${N.imgSel.k}"]`);
  if (!el) return;
  el.classList.add('selected');
  el.insertAdjacentHTML('beforeend', '<button class="img-del" title="Remove media (Delete)" data-icon="trash-2" aria-label="Remove media (Delete)" data-icon-only>✕</button>');
}

function deleteSelectedImage() {
  const sel = N.imgSel;
  const b = sel && N.doc?.blocks.find((x) => x.id === sel.block);
  if (!b) return;
  N.imgSel = null;
  const src = removeImage(b.src, sel.k);
  if (!src.trim() && N.doc.blocks.length > 1) {
    N.doc.blocks.splice(blockIndex(b.id), 1);
    markDirty();
    renderEditor();
  } else setBlockSrc(b, src);
}

const EDGE = 8;
let swallowClick = false;  // the click that ends a resize drag must not open the cell's source
const nearEdge = (e, el) => { const r = el.getBoundingClientRect(); return e.clientX - r.left < EDGE || r.right - e.clientX < EDGE; };

// Drags the image's edge: the width updates live, and on release is written
// into the LaTeX (the subfigure's width, or the image's width= option).
function startResize(e, img, sel) {
  const b = N.doc.blocks.find((x) => x.id === sel.block);
  const box = img.closest('.tex-subfig') || img;
  const col = img.closest('.tex-view').getBoundingClientRect().width;
  const r0 = box.getBoundingClientRect();
  const side = e.clientX < (r0.left + r0.right) / 2 ? -1 : 1;
  const centred = !img.closest('.tex-subfig') && img.closest('.tex-fig-row') && !img.closest('.spread');
  const x0 = e.clientX;
  let frac = round2(r0.width / col);
  const badge = Object.assign(document.createElement('div'), { className: 'img-badge', textContent: fmtWidth(frac) });
  img.appendChild(badge);
  document.body.classList.add('img-resizing');
  const move = (ev) => {
    const dx = (ev.clientX - x0) * side * (centred ? 2 : 1);
    frac = round2(Math.min(1, Math.max(0.1, (r0.width + dx) / col)));
    box.style.width = `${frac * 100}%`;
    if (box !== img) img.style.width = '100%';
    badge.textContent = fmtWidth(frac);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    document.body.classList.remove('img-resizing');
    badge.remove();
    swallowClick = true;
    setTimeout(() => { swallowClick = false; });
    setBlockSrc(b, setImageWidth(b.src, sel.k, frac));
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up, { once: true });
}

// ---- wiring

const stageEl = $('#notes-stage');

stageEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('.img-del')) return;
  const img = e.target.closest('.tex-img');
  if (!img) {
    if (N.imgSel && !e.target.closest('.nb-tools')) selectImage(null);
    return;
  }
  const playerClick = e.target.closest('video') && !nearEdge(e, img);
  if (!playerClick) e.preventDefault();  // preserve native playback controls
  const sel = { block: img.closest('.nb').dataset.id, k: Number(img.dataset.img) };
  const inView = !!img.closest('.nb-view');
  if (N.editing && !playerClick) stopEdit();  // clicking an image in the preview finishes the edit
  selectImage(sel.block, sel.k);
  if (inView && nearEdge(e, img)) startResize(e, img, sel);
});
stageEl.addEventListener('pointermove', (e) => {
  const img = e.target.closest('.nb-view .tex-img');
  if (img) img.style.cursor = nearEdge(e, img) ? 'ew-resize' : '';
});
stageEl.addEventListener('click', (e) => {
  if (swallowClick) { swallowClick = false; e.stopPropagation(); return; }
  if (e.target.closest('.img-del')) { e.stopPropagation(); deleteSelectedImage(); }
}, true);

document.addEventListener('keydown', (e) => {
  if (!N.imgSel || !isNotesMode() || e.target.closest?.('input, textarea, [contenteditable]')) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelectedImage(); }
  if (e.key === 'Escape') selectImage(null);
});

// Paste: image files on the clipboard (screenshots, files copied in Finder).
document.addEventListener('paste', (e) => {
  if (!isNotesMode() || !N.doc) return;
  if (!(e.target === document.body || stageEl.contains(e.target)) || e.target.closest?.('.note-preamble, .note-title')) return;
  const files = [...(e.clipboardData?.files || [])].filter(isMediaFile);
  if (!files.length) return;
  e.preventDefault();
  // Into a figure only when one is selected: a selected image, or an image
  // cell whose source is open. Otherwise a new image cell after the current one.
  const editing = N.editing && N.doc.blocks.find((b) => b.id === N.editing);
  if (N.imgSel) addImages(files, { blockId: N.imgSel.block });
  else if (editing && figureSpans(editing.src).length) addImages(files, { blockId: editing.id });
  else addImages(files, { blockId: N.editing || N.focusBlock, forceNew: true });
}, true);

// Drag and drop. dropEffect 'copy' gives the green "+" cursor.
function dropTarget(e) {
  const nb = e.target.closest?.('.nb');
  if (nb) return { el: nb, blockId: nb.dataset.id, forceNew: e.shiftKey };
  const last = [...stageEl.querySelectorAll('.nb')].pop();
  return { el: last, blockId: last?.dataset.id, forceNew: true };
}
function clearDrop() {
  stageEl.querySelectorAll('.drop-target').forEach((el) => { el.classList.remove('drop-target'); delete el.dataset.drop; });
}
stageEl.addEventListener('dragover', (e) => {
  if (!N.doc || !e.dataTransfer.types.includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  const t = dropTarget(e);
  if (!t.el) return;
  const b = N.doc.blocks.find((x) => x.id === t.blockId);
  const label = b?.type === 'text' && !t.forceNew && figureSpans(b.src).length ? 'Add to this figure (⇧ for a new one)'
    : b?.type === 'text' && !t.forceNew && !b.src.trim() ? 'Put media here' : 'New media cell below';
  if (!t.el.classList.contains('drop-target') || t.el.dataset.drop !== label) {
    clearDrop();
    t.el.classList.add('drop-target');
    t.el.dataset.drop = label;
  }
});
stageEl.addEventListener('dragleave', (e) => { if (!stageEl.contains(e.relatedTarget)) clearDrop(); });
stageEl.addEventListener('drop', (e) => {
  if (!N.doc || !e.dataTransfer.types.includes('Files')) return;
  e.preventDefault();
  clearDrop();
  const t = dropTarget(e);
  addImages(e.dataTransfer.files, { blockId: t.blockId, forceNew: t.forceNew });
});
// A file dropped anywhere else must not navigate away from Noctua.
window.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files') && !stageEl.contains(e.target)) e.preventDefault(); });
window.addEventListener('drop', (e) => { if (e.dataTransfer.types.includes('Files') && !stageEl.contains(e.target)) e.preventDefault(); });

// Keep player elements (and their playback position) when the note is typeset.
function captureVideos(root) {
  return [...root.querySelectorAll('video')].map((video) => ({ video, block: video.closest('.nb')?.dataset.id, src: video.getAttribute('src'), playing: !video.paused }));
}
function restoreVideos(root, saved) {
  for (const fresh of root.querySelectorAll('video')) {
    const i = saved.findIndex((s) => s.block === fresh.closest('.nb')?.dataset.id && s.src === fresh.getAttribute('src'));
    if (i < 0) continue;
    const { video, playing } = saved.splice(i, 1)[0];
    fresh.replaceWith(video);
    if (video.error) video.parentElement.querySelector('.video-error').hidden = false;
    if (playing) video.play().catch(() => {});
  }
}
stageEl.addEventListener('error', (e) => {
  if (e.target.matches?.('.tex-video video')) e.target.parentElement.querySelector('.video-error').hidden = false;
}, true);
