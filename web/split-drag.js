'use strict';
// Drag highlighted PDF text or a detected figure from the Reader into the note
// beside it. Pointer events keep this independent of native drag-and-drop, which
// desktop webviews may reserve for dropped files.
const SplitDrag = { pending: null, active: false, ghost: null, target: null };

// Citation keys resolve against the note folder; the paper key always identifies the paper.
const splitDragCite = () => `\\cite{${PDF.paper?.cite_keys?.[0] || PDF.key}}`;
const splitDragTeX = (text) => text.replace(/\s+/g, ' ').trim()
  .replace(/[\\{}$&#^_%~]/g, (c) => ({ '\\': '\\textbackslash{}', '^': '\\^{}', '~': '\\~{}' }[c] || '\\' + c));

function splitDragSelection(e) {
  const selection = getSelection();
  if (!selection.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0), box = range.commonAncestorContainer.parentElement?.closest('.pdf-page');
  if (!box || !$('#pdf-stage').contains(box) || !selection.toString().trim()) return null;
  const inside = [...range.getClientRects()].some((r) => e.clientX >= r.left - 2 && e.clientX <= r.right + 2 && e.clientY >= r.top - 2 && e.clientY <= r.bottom + 2);
  if (!inside) return null;
  return { kind: 'text', text: selection.toString(), page: pdfPageEntries.find((entry) => entry.box === box)?.number || PDF.page };
}

function splitDragObject(handle) {
  const entry = pdfPageEntries.find((x) => x.box === handle.closest('.pdf-page'));
  const object = entry?.objects?.[Number(handle.dataset.object)];
  if (!object) return null;
  // The paper's own caption line becomes the note caption and is cropped out of the image.
  const starts = (text) => text.trim().toLowerCase().startsWith(object.label.toLowerCase());
  const line = (object.text || '').split('\n').map((l) => l.trim()).find((l) => starts(l) && l.length > object.label.length + 2);
  const bounds = entry.box.getBoundingClientRect(), [x, y, w, h] = object.rect;
  const span = [...entry.box.querySelectorAll('.textLayer span')].map((s) => ({ s, r: s.getBoundingClientRect() }))
    .map(({ s, r }) => ({ text: s.textContent, rect: [(r.left - bounds.left) / bounds.width, (r.top - bounds.top) / bounds.height, r.width / bounds.width, r.height / bounds.height] }))
    .find((t) => starts(t.text) && t.rect[1] + t.rect[3] > y && t.rect[1] < y + h && t.rect[0] < x + w && t.rect[0] + t.rect[2] > x);
  return { kind: 'figure', label: object.label, rect: [...object.rect], page: entry.number, caption: line ? line.slice(object.label.length).replace(/^\s*[:.]\s*/, '') : '', captionRect: span?.rect || null };
}

// Note blocks under the pointer; the item goes below the block, or at the end.
function splitDropTarget(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el?.closest('#notes-stage') || !N.doc || W.file) return null;
  const nb = el.closest('.nb') || [...$('#notes-stage').querySelectorAll('.nb')].pop() || null;
  return { el: nb, blockId: nb?.dataset.id || null };
}

function startSplitDrag(e, item) {
  SplitDrag.pending = { item, x: e.clientX, y: e.clientY, key: PDF.key };
  window.addEventListener('pointermove', moveSplitDrag, true);
  window.addEventListener('pointerup', endSplitDrag, true);
  window.addEventListener('pointercancel', cancelSplitDrag, true);
}

function moveSplitDrag(e) {
  const p = SplitDrag.pending;
  if (!p) return;
  if (!SplitDrag.active) {
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < 5) return;
    SplitDrag.active = true;
    document.body.classList.add('split-dragging');
    const ghost = SplitDrag.ghost = document.createElement('div');
    ghost.className = 'split-drag-ghost';
    ghost.textContent = p.item.kind === 'text' ? p.item.text.replace(/\s+/g, ' ').trim().slice(0, 90) + (p.item.text.length > 90 ? '…' : '') : p.item.label;
    document.body.append(ghost);
  }
  e.preventDefault();
  SplitDrag.ghost.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 14}px)`;
  const stage = $('#notes-stage'), r = stage.getBoundingClientRect();
  if (e.clientX >= r.left && e.clientX <= r.right) {
    if (e.clientY < r.top + 48) stage.scrollTop -= 14;
    else if (e.clientY > r.bottom - 48) stage.scrollTop += 14;
  }
  const target = splitDropTarget(e.clientX, e.clientY);
  if (target?.el !== SplitDrag.target?.el) {
    clearDrop();
    if (target?.el) {
      target.el.classList.add('drop-target');
      target.el.dataset.drop = p.item.kind === 'text' ? 'Insert quote below' : `Insert ${p.item.label} below`;
    }
  }
  SplitDrag.target = target;
  SplitDrag.ghost.classList.toggle('over-note', !!target);
}

function endSplitDrag(e) {
  const p = SplitDrag.pending, active = SplitDrag.active, target = active && splitDropTarget(e.clientX, e.clientY);
  cancelSplitDrag();
  if (!p) return;
  if (!active) {
    // A click inside the selection still clears it, as it would without dragging.
    if (p.item.kind === 'text') getSelection().removeAllRanges();
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  if (p.key !== PDF.key) return;
  if (!target) {
    if (e.target.closest?.('#notes-stage')) toast('Open a note before adding from the paper.', { error: true });
    return;
  }
  insertFromPDF(p.item, target.blockId).catch((err) => toast(err.message, { error: true }));
}

function cancelSplitDrag() {
  window.removeEventListener('pointermove', moveSplitDrag, true);
  window.removeEventListener('pointerup', endSplitDrag, true);
  window.removeEventListener('pointercancel', cancelSplitDrag, true);
  SplitDrag.ghost?.remove();
  Object.assign(SplitDrag, { pending: null, active: false, ghost: null, target: null });
  document.body.classList.remove('split-dragging');
  clearDrop();
}

async function insertFromPDF(item, blockId) {
  if (!N.doc || W.file) throw new Error('Open a note before adding from the paper.');
  const after = blockId ? N.doc.blocks.find((b) => b.id === blockId) : null;
  const reuse = after?.type === 'text' && !after.src.trim();
  if (item.kind === 'figure') {
    const file = new File([await pdfRegionImage(item.page, await splitDragCrop(item))], `${item.label}.png`, { type: 'image/png' });
    const caption = item.caption ? splitDragTeX(item.caption).replace(/([^.!?])$/, '$1.') + ' ' : '';
    return importMediaFiles([file], { blockId: after?.id || null, forceNew: !reuse, captions: [`${caption}From ${splitDragCite()}, p. ${item.page}, ${item.label}.`] });
  }
  const src = `\\begin{quote}\n${splitDragTeX(item.text)}\n\\end{quote}\n${splitDragCite()}, p. ${item.page}`;
  stopEdit();
  let block = after;
  if (reuse) after.src = src;
  else {
    block = { id: newId('b'), type: 'text', src };
    N.doc.blocks.splice(after ? blockIndex(after.id) + 1 : N.doc.blocks.length, 0, block);
  }
  markDirty();
  renderEditor();
  document.querySelector(`#notes-stage .nb[data-id="${block.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// Keep the painted figure with room for axis labels, without nearby body text or the
// paper's caption. Falls back to the detected region when no graphics are found.
async function splitDragCrop(item) {
  const [x, y, w, h] = item.rect, right = x + w, bottom = y + h;
  let painted = [];
  try { painted = await NoctuaPDFObjects.graphics(await PDF.doc.getPage(item.page), await pdfjs()); } catch {}
  const inside = painted.map((g) => [Math.max(g[0], x), Math.max(g[1], y), Math.min(g[0] + g[2], right), Math.min(g[1] + g[3], bottom)])
    .filter((g) => g[2] - g[0] > .002 && g[3] - g[1] > .002);
  if (!inside.length) return item.rect;
  let top = Math.max(y, Math.min(...inside.map((g) => g[1])) - .03), low = Math.min(bottom, Math.max(...inside.map((g) => g[3])) + .03);
  const left = Math.max(x, Math.min(...inside.map((g) => g[0])) - .06), end = Math.min(right, Math.max(...inside.map((g) => g[2])) + .06);
  const c = item.captionRect;
  if (c) {
    const graphicsMid = (Math.min(...inside.map((g) => g[1])) + Math.max(...inside.map((g) => g[3]))) / 2;
    if (c[1] + c[3] / 2 > graphicsMid) low = Math.min(low, c[1] - .003);
    else top = Math.max(top, c[1] + c[3] + .003);
  }
  return low - top > .01 && end - left > .01 ? [left, top, end - left, low - top] : item.rect;
}

// Render only the region, sharp enough for the note without a full-page raster.
async function pdfRegionImage(pageNumber, rect) {
  const page = await PDF.doc.getPage(pageNumber), base = page.getViewport({ scale: 1 });
  const scale = Math.max(1, Math.min(4, 1600 / Math.max(1, rect[2] * base.width)));
  const viewport = page.getViewport({ scale }), canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(rect[2] * viewport.width));
  canvas.height = Math.max(1, Math.round(rect[3] * viewport.height));
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport, transform: [1, 0, 0, 1, -rect[0] * viewport.width, -rect[1] * viewport.height] }).promise;
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  canvas.width = canvas.height = 0;
  if (!blob) throw new Error('Could not render this region of the PDF.');
  return blob;
}

$('#pdf-stage').addEventListener('pointerdown', (e) => {
  if (!splitViewActive() || e.button !== 0 || PDF.mode === 'draw') return;
  const handle = e.target.closest('.pdf-object-drag');
  const item = handle ? splitDragObject(handle) : splitDragSelection(e);
  if (!item) return;
  // Keep the selection and stop page handlers from treating this as a click.
  e.stopPropagation();
  startSplitDrag(e, item);
}, true);
// Pressing inside selected text would otherwise collapse it or start a native drag.
$('#pdf-stage').addEventListener('mousedown', (e) => { if (SplitDrag.pending) e.preventDefault(); }, true);
$('#pdf-stage').addEventListener('dragstart', (e) => { if (splitViewActive() && e.target.closest?.('.pdf-page')) e.preventDefault(); }, true);
// Keyboard and click alternative: add the figure below the note's current block.
$('#pdf-stage').addEventListener('click', (e) => {
  const handle = e.target.closest('.pdf-object-drag');
  if (!handle) return;
  e.preventDefault();
  e.stopPropagation();
  const item = splitDragObject(handle);
  if (item) insertFromPDF(item, N.focusBlock || N.doc?.blocks.at(-1)?.id).catch((err) => toast(err.message, { error: true }));
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && SplitDrag.pending) { e.preventDefault(); cancelSplitDrag(); } }, true);
