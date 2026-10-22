'use strict';
// Searching papers and notes together: @-mentions in the chat, and [[ note
// links in note text (inserted as \noteref{id}). Uses app.js and notes.js globals.

const REF = { papers: [], notes: [], at: 0, loading: null };

// Every Zotero paper (all libraries) and every note (all folders). Cached briefly.
function loadRefs(force = false) {
  if (!force && REF.at && Date.now() - REF.at < 30000) return Promise.resolve();
  if (REF.loading) return REF.loading;
  const libs = collections.targets.filter((t) => t.id.startsWith('L'));
  REF.loading = Promise.all([api('/api/notes/all'), ...libs.map((l) => api(`/api/zotero/items?target=${enc(l.id)}`))])
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

// Best matches for `q`: every word must appear; title-word prefixes rank highest.
function searchRefs(q, { kinds = ['paper', 'note'], limit = 4 } = {}) {
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
  const newest = Math.max(1, ...REF.notes.map((n) => n.updated || 0));
  if (kinds.includes('note')) {
    for (const n of REF.notes) {
      const here = n.target && n.target === N.target ? 0.5 : 0;
      consider('note', n, n.title, folderName(n.target), here + 0.4 * ((n.updated || 0) / newest));
    }
  }
  if (kinds.includes('paper')) {
    for (const p of REF.papers) consider('paper', p, p.title, `${(p.creators || []).join(' ')} ${p.year || ''} ${p.venue || ''}`, 0);
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

const refLabel = (r) => r.kind === 'note' ? (r.ref.title || 'Untitled note') : (r.ref.title || '(untitled)');

function refMeta(r) {
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
      <div class="cp-title"><span class="ref-kind ${r.kind}">${r.kind === 'note' ? 'NOTE' : 'PAPER'}</span>${esc(refLabel(r))}</div>
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
  const m = /(?:^|\s)@([^@\n\[\]]{0,40})$/.exec(before);
  if (!m) return closeMentions();
  await loadRefs();
  if (ta.value.slice(0, ta.selectionEnd) !== before) return;  // typed on while loading
  const q = m[1];
  showMentions(ta, ta.selectionEnd - q.length - 1, searchRefs(q), (r) => {
    const token = `@[${refLabel(r).replace(/[\[\]]/g, '')}]`;
    chat.mentions.set(token, r);
    replaceTyped(ta, token + ' ');
  }, q ? 'No paper or note matches' : 'Type to search your papers and notes');
}

// Text attached to the message for every mention still in it.
async function chatAttachments(text) {
  const parts = [];
  for (const [token, r] of chat.mentions) {
    if (!text.includes(token)) continue;
    if (r.kind === 'paper') {
      const p = r.ref;
      parts.push([
        `${token} = Zotero paper (item key ${p.key}):`,
        `Title: ${p.title || ''}`,
        `Authors: ${(p.creators || []).join(', ')}`,
        `Year: ${p.year ?? 'n.d.'}${p.venue ? ` · ${p.venue}` : ''}`,
        p.DOI && `DOI: ${p.DOI}`, p.arxiv && `arXiv: ${p.arxiv}`, p.s2 && `Semantic Scholar paperId: ${p.s2}`,
        p.abstractNote && `Abstract: ${p.abstractNote.slice(0, 3000)}`,
      ].filter(Boolean).join('\n'));
    } else {
      const n = r.ref;
      try {
        // The open note may have unsaved edits; use the editor's copy.
        const doc = N.doc?.id === n.id ? N.doc : await api(`/api/notes/${enc(n.target)}/${enc(n.id)}`);
        const body = noteText(doc);
        parts.push(`${token} = note "${doc.title}" (folder_id ${n.target}, note_id ${n.id}):\n${body.length > 12000 ? body.slice(0, 12000) + '\n[… truncated; use read_note]' : body}`);
      } catch (e) {
        parts.push(`${token} = note ${n.id} (could not be read: ${e.message})`);
      }
    }
  }
  chat.mentions.clear();
  return parts.join('\n\n');
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
  if (!target) return toast("That note's Zotero folder no longer exists.", { error: true });
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
