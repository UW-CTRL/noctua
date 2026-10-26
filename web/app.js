'use strict';

const $ = (s) => document.querySelector(s);
const enc = encodeURIComponent;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

// ---------------------------------------------------------------- API

let inflight = 0;
let queueTimer = null;

async function api(path, body) {
  inflight++;
  watchQueue();
  try {
    const opts = body === undefined ? {} : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
    const r = await fetch(path, opts);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { status: r.status });
    return j;
  } finally {
    inflight--;
    if (!inflight) notifyProgress('requests', null);
  }
}

// Request progress shares the same notification surface as every feature.
function watchQueue() {
  if (queueTimer !== null) return;
  const tick = async () => {
    let message = 'Working…';
    if (inflight > 0) {
      try {
        const status = await (await fetch('/api/status')).json();
        if (status.pending > 0) message = `Semantic Scholar · ${status.pending} queued · about ${Math.ceil(status.pending * 1.1)}s`;
      } catch { /* The request itself reports connection errors. */ }
    }
    if (inflight > 0) {
      notifyProgress('requests', message);
      queueTimer = setTimeout(tick, 400);
    } else {
      queueTimer = null;
      notifyProgress('requests', null);
    }
  };
  queueTimer = setTimeout(tick, 250);
}

// ---------------------------------------------------------------- state

const ROLE_LABEL = {
  center: 'Center paper',
  ref: 'Referenced by center',
  cite: 'Cites center',
  sim: 'Similar',
  exp: 'From expansion',
  proj: 'In this project',
  shared: 'Shared reference',
};

// Cluster colours for project graphs (cycled past ten clusters).
const PALETTE = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#b07aa1', '#76b7b2', '#edc948', '#ff9da7', '#9c755f', '#2f9e8f'];
const clusterColor = (c) => PALETTE[(c - 1) % PALETTE.length];

const G = {
  nodes: new Map(),   // id -> { id, p, roles:Set, x, y, vx, vy, fixed, deg, expanded }
  edges: [],          // { s, t }  (s cites t)
  edgeKeys: new Set(),
  centerId: null,
  selected: null,
  hover: null,
  show: { ref: true, cite: true, sim: true, shared: true },
  filter: '',        // local text filter shared by Graph and Lineage
  layout: 'library',  // library table, network, or lineage (lineage.js)
  inLib: new Set(),
  token: 0,
  autoFit: false,
  libKey: null,       // Noctua item key the current graph was built from
  project: null,      // project graph being shown: the /api/project result plus { name }
};
// Noctua library browser: selected folder, its items, item shown in details.
const lib = {
  target: store.get('noctua.libTarget') || 'L1', items: null, detail: null,
  expanded: (() => {
    try { const saved = JSON.parse(store.get('noctua.expandedFolders') || '["L1"]'); return new Set(Array.isArray(saved) ? saved : ['L1']); }
    catch { return new Set(['L1']); }
  })(),
};
const view = { x: 0, y: 0, k: 1 };
let results = [];          // current search results (paper objects)
let collections = { live: false, targets: [] };

function resetGraph() {
  G.nodes.clear();
  G.edges = [];
  G.edgeKeys.clear();
  G.centerId = null;
  G.selected = null;
  G.hover = null;
  G.project = null;
  G.filter = '';
  $('#graph-filter').value = '';
  $('#filter').value = '';
  $('#graph-filter-control').classList.remove('has-query');
  $('#papers-filter-control').classList.remove('has-query');
  $('#graph-filter-empty').hidden = true;
}

function addNode(p, role, near) {
  if (!p || !p.paperId) return null;
  let n = G.nodes.get(p.paperId);
  if (n) {
    // 'exp' only marks papers that expansion newly introduced.
    if (role !== 'exp') n.roles.add(role);
    if (!n.p.abstract && p.abstract) n.p = { ...n.p, ...p };
    return n;
  }
  const dx = role === 'ref' ? -160 : role === 'cite' ? 160 : 0;
  const dy = role === 'sim' ? 160 : 0;
  const bx = near ? near.x : 0;
  const by = near ? near.y : 0;
  n = {
    id: p.paperId, p, roles: new Set([role]),
    x: bx + dx + (Math.random() - 0.5) * 140,
    y: by + dy + (Math.random() - 0.5) * 140,
    vx: 0, vy: 0, fixed: false, deg: 0, expanded: false,
  };
  G.nodes.set(n.id, n);
  return n;
}

function addEdge(s, t) {
  const k = s + '>' + t;
  if (s === t || G.edgeKeys.has(k) || !G.nodes.has(s) || !G.nodes.has(t)) return;
  G.edgeKeys.add(k);
  G.edges.push({ s, t });
  G.nodes.get(s).deg++;
  G.nodes.get(t).deg++;
}

function isVisible(n) {
  if (G.filter && ![n.p.title, ...(n.p.authors || []).map(a => a.name), n.p.venue, n.p.journal?.name, n.p.year].join(' ').toLowerCase().includes(G.filter)) return false;
  if (n.roles.has('center') || n.roles.has('proj') || n.roles.has('exp') || n.expanded || n.id === G.selected) return true;
  for (const r of n.roles) if (G.show[r]) return true;
  return false;
}

const visibleNodes = () => [...G.nodes.values()].filter(isVisible);

function primaryRole(n) {
  for (const r of ['center', 'proj', 'cite', 'ref', 'sim', 'shared', 'exp']) if (n.roles.has(r)) return r;
  return 'exp';
}

// ---------------------------------------------------------------- loading

const graphLimit = () => Number($('#limit').value) || 60;

// Resolves to 'ok', 'notfound' (only with quiet404), 'error' or 'stale'.
async function loadGraph(id, { push = true, quiet404 = false, libKey = null, switchTab = true } = {}) {
  if (G.layout === 'library') setLayout('network');
  closeSearchResults();
  const token = ++G.token;
  toast('Building graph… (references and citations)');
  let g;
  try {
    g = await api(`/api/graph?id=${enc(id)}&limit=${graphLimit()}`);
  } catch (e) {
    if (token !== G.token) return 'stale';
    if (quiet404 && e.status === 404) return 'notfound';
    toast(e.message, { error: true });
    return 'error';
  }
  if (token !== G.token) return 'stale';

  resetGraph();
  G.libKey = libKey;
  const c = addNode(g.center, 'center');
  c.x = 0; c.y = 0;
  G.centerId = c.id;
  for (const p of g.references) if (addNode(p, 'ref', c)) addEdge(c.id, p.paperId);
  for (const p of g.citations) if (addNode(p, 'cite', c)) addEdge(p.paperId, c.id);

  const url = '#paper=' + enc(c.id);
  if (push && location.hash !== url) history.pushState(null, '', url);
  document.title = `${g.center.title} · Noctua`;
  $('#empty').classList.add('hidden');

  view.x = 0; view.y = 0; view.k = 0.9;
  G.autoFit = true;
  select(c.id);
  kick(1);
  refreshAll();
  renderLibItems();
  if (switchTab) showTab('nodes');
  checkLibrary();

  toast('Finding links between papers…');
  await loadLinks(token);
  if (token !== G.token) return 'ok';

  toast('Finding similar papers…');
  try {
    const sims = await api(`/api/similar?id=${enc(c.id)}&limit=30`);
    if (token !== G.token) return 'ok';
    for (const p of sims) addNode(p, 'sim', c);
    refreshAll();
    kick(0.7);
    await loadLinks(token);
    checkLibrary();
  } catch (e) {
    if (token === G.token) toast('Similar papers unavailable: ' + e.message, { error: true });
    return 'ok';
  }
  if (token === G.token) hideToast({ keepError: true });
  return 'ok';
}

function clearGraph({ push = true } = {}) {
  G.token++;          // abandon any graph still loading
  resetGraph();
  G.libKey = null;
  if (push && location.hash) history.pushState(null, '', location.pathname);
  document.title = 'Noctua';
  $('#empty').classList.remove('hidden');
  $('#tooltip').classList.add('hidden');
  hideToast({ keepError: true });
  refreshAll();
  renderLibItems();
}

const targetName = (id) => collections.targets.find((t) => t.id === id)?.name || id;

// A Noctua folder's own citation graph: its papers, coloured by cluster, plus
// the outside papers that several clusters cite.
async function openProject(target, { push = true } = {}) {
  if (!target) return;
  if (G.layout === 'library') setLayout('network');
  closeSearchResults();
  const token = ++G.token;
  const name = targetName(target);
  if (lib.target !== target && collections.targets.some(t => t.id === target)) {
    lib.target = target;
    store.set('noctua.libTarget', target);
    renderLibTree();
    loadLibItems();
  }
  showTab(G.layout === 'lineage' ? 'threads' : 'nodes');
  toast(`Opening project graph for “${name}”…`);
  let g;
  try {
    g = await api(`/api/project?target=${enc(target)}`);
  } catch (e) {
    if (token === G.token) toast(e.message, { error: true });
    return;
  }
  if (token !== G.token) return;

  resetGraph();
  G.libKey = null;
  G.project = { ...g, name };
  // Start each cluster in its own spot; unconnected papers around the outside.
  const big = g.clusters.filter((c) => c.size > 1).length;
  const sizes = new Map(g.clusters.map((c) => [c.id, c.size]));
  for (const p of g.papers) {
    const single = sizes.get(p.cluster) === 1;
    const a = single ? p.cluster * 2.4 : (p.cluster / Math.max(1, big)) * 2 * Math.PI;
    const r = single ? 420 : big > 1 ? 220 : 0;
    const n = addNode(p, 'proj', { x: Math.cos(a) * r, y: Math.sin(a) * r });
    n.cluster = p.cluster;
    n.single = single;
  }
  for (const [s, t] of g.edges) addEdge(s, t);
  for (const r of g.shared) {
    if (!r.title) continue;
    addNode(r, 'shared');
    for (const c of r.citedBy) addEdge(c, r.paperId);
  }

  const url = '#project=' + enc(target);
  if (push && location.hash !== url) history.pushState(null, '', url);
  document.title = `${name} · Noctua`;
  $('#empty').classList.add('hidden');
  view.x = 0; view.y = 0; view.k = 0.9;
  G.autoFit = true;
  select(null);
  kick(1);
  refreshAll();
  checkLibrary();
  if (g.warning) toast(g.warning, { error: true });
  else toast(g.fetched ? `${g.fetched} papers updated. Graph ready.` : `${name} graph ready.`);
}

// Noctua items carry a DOI / arXiv id / Noctua-written S2 id when we have
// one; otherwise fall back to Semantic Scholar's title matcher.
async function graphFromLibrary(item) {
  const opts = { quiet404: true, libKey: item.key, switchTab: false };
  const ids = [];
  if (item.s2) ids.push(item.s2);
  if (item.arxiv) ids.push('ARXIV:' + item.arxiv);
  if (item.DOI && !/^10\.48550\/arxiv\./i.test(item.DOI)) ids.push('DOI:' + item.DOI);
  for (const id of ids) {
    const r = await loadGraph(id, opts);
    if (r !== 'notfound') return;
  }
  if (item.title) {
    toast('Looking up by title on Semantic Scholar…');
    try {
      const m = await api(`/api/match?title=${enc(item.title)}`);
      if (titlesAgree(item.title, m.title)) {
        if (await loadGraph(m.paperId, opts) !== 'notfound') return;
      } else {
        toast(`Couldn’t find this paper on Semantic Scholar (closest match: “${m.title}”)`, { error: true });
        return;
      }
    } catch (e) {
      if (e.status !== 404) { toast(e.message, { error: true }); return; }
    }
  }
  toast(`Couldn’t find “${item.title || 'this item'}” on Semantic Scholar`, { error: true });
}

function titlesAgree(a, b) {
  const words = (s) => new Set((s || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
  const wa = words(a), wb = words(b);
  if (!wa.size || !wb.size) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.min(wa.size, wb.size) >= 0.7;
}

async function loadLinks(token) {
  try {
    const edges = await api('/api/links', { ids: [...G.nodes.keys()] });
    if (token !== G.token) return;
    for (const [s, t] of edges) addEdge(s, t);
    refreshAll();
    kick(0.6);
  } catch (e) {
    toast('Could not load links: ' + e.message, { error: true });
  }
}

async function expand(id) {
  const n = G.nodes.get(id);
  if (!n) return;
  const token = G.token;
  toast('Expanding…');
  try {
    const g = await api(`/api/graph?id=${enc(id)}&limit=30`);
    if (token !== G.token) return;
    n.expanded = true;
    for (const p of g.references) if (addNode(p, 'exp', n)) addEdge(n.id, p.paperId);
    for (const p of g.citations) if (addNode(p, 'exp', n)) addEdge(p.paperId, n.id);
    refreshAll();
    kick(0.8);
    await loadLinks(token);
    checkLibrary();
    hideToast({ keepError: true });
  } catch (e) {
    toast(e.message, { error: true });
  }
}

async function checkLibrary() {
  const seen = new Map();
  for (const n of G.nodes.values()) seen.set(n.id, n.p);
  for (const p of results) if (p.paperId) seen.set(p.paperId, p);
  if (!seen.size) return;
  const papers = [...seen.values()].map((p) => ({ id: p.paperId, doi: p.externalIds?.DOI || null, title: p.title }));
  try {
    G.inLib = new Set(await api('/api/library/check', { papers }));
    refreshAll();
    renderResults();
  } catch { /* no Noctua database; ignore */ }
}

// ---------------------------------------------------------------- search

function parseId(s) {
  s = s.trim();
  let m;
  if ((m = s.match(/semanticscholar\.org\/paper\/(?:[^/]+\/)?([0-9a-f]{40})/i)) || (m = s.match(/^([0-9a-f]{40})$/i))) return m[1];
  if ((m = s.match(/arxiv\.org\/(?:abs|pdf)\/([^\s?#]+?)(?:v\d+)?(?:\.pdf)?\/?$/i)) || (m = s.match(/^(?:arxiv:\s*)?(\d{4}\.\d{4,5})(?:v\d+)?$/i))) return 'ARXIV:' + m[1];
  if ((m = s.match(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?(10\.\d{4,9}\/\S+)$/i))) return 'DOI:' + m[1].replace(/[.,;]$/, '');
  return null;
}

let searchState = { q: '', next: null };
let searchToken = 0;

function closeSearchResults() { $('#tab-results').classList.add('hidden'); }

async function search(q, offset = 0) {
  if (document.body.classList.contains('notes-mode') || document.body.classList.contains('pdf-mode')) setMode('graph');
  const token = ++searchToken;
  const id = parseId(q);
  if (id) return loadGraph(id);
  $('#tab-results').classList.remove('hidden');
  if (offset === 0) {
    results = [];
    $('#tab-results').innerHTML = '<p class="hint">Searching…</p>';
  }
  try {
    const r = await api(`/api/search?q=${enc(q)}&offset=${offset}`);
    if (token !== searchToken) return;
    results = results.concat(r.data || []);
    searchState = { q, next: r.next ?? null, total: r.total };
    renderResults();
    checkLibrary();
  } catch (e) {
    if (token !== searchToken) return;
    $('#tab-results').innerHTML = `<p class="hint">${esc(e.message)}</p>`;
  }
}

// ---------------------------------------------------------------- rendering: lists & details

function authorsShort(p) {
  const a = (p.authors || []).map((x) => x.name);
  if (!a.length) return 'Unknown authors';
  return a.length > 3 ? `${a.slice(0, 2).join(', ')} et al.` : a.join(', ');
}

function lastName(p) {
  const a = p.authors?.[0]?.name;
  return a ? a.trim().split(/\s+/).pop() : (p.title || '').split(/\s+/)[0];
}

const fmt = (n) => (n ?? 0).toLocaleString();

function paperLi(p, extraClass = '') {
  const inLib = G.inLib.has(p.paperId) ? '<span class="badge">in Noctua</span>' : '';
  const venue = p.venue ? `${esc(p.venue)} · ` : '';
  return `<li data-id="${esc(p.paperId)}" class="${extraClass}">
    <div class="p-title">${esc(p.title)}${inLib}</div>
    <div class="p-meta">${esc(authorsShort(p))}</div>
    <div class="p-meta">${venue}${p.year ?? '—'} · ${fmt(p.citationCount)} citations</div>
  </li>`;
}

function renderResults() {
  const el = $('#tab-results');
  if (!searchState.q) return;
  if (!results.length) {
    el.innerHTML = '<p class="hint">No results.</p>';
    return;
  }
  el.innerHTML = `<p class="hint">${fmt(searchState.total)} results — click one to build its graph.</p>
    <ul class="papers">${results.map((p) => paperLi(p)).join('')}</ul>
    ${searchState.next ? '<button class="more" id="more" data-icon="chevron-down">More results</button>' : ''}`;
  el.querySelectorAll('li').forEach((li) => li.addEventListener('click', () => loadGraph(li.dataset.id)));
  el.querySelector('#more')?.addEventListener('click', () => search(searchState.q, searchState.next));
}

function renderNodeList() {
  const sort = $('#sort').value;
  let ns = visibleNodes();
  const cmp = {
    citations: (a, b) => (b.p.citationCount || 0) - (a.p.citationCount || 0),
    'year-desc': (a, b) => (b.p.year || 0) - (a.p.year || 0),
    'year-asc': (a, b) => (a.p.year || 9999) - (b.p.year || 9999),
    links: (a, b) => b.deg - a.deg,
  }[sort];
  ns.sort(cmp);
  const el = $('#node-list');
  if (!G.nodes.size) {
    el.innerHTML = '<p class="hint">No graph open. Pick a paper from Search or Library.</p>';
    $('#filter').placeholder = 'Filter 0 papers';
    return;
  }
  el.innerHTML = ns.map((n) => paperLi(n.p, `role-${primaryRole(n)}${n.id === G.selected ? ' selected' : ''}`)).join('');
  el.querySelectorAll('li').forEach((li) => li.addEventListener('click', () => {
    select(li.dataset.id);
    focusNode(li.dataset.id);
  }));
  $('#filter').placeholder = `Filter ${G.nodes.size} paper${G.nodes.size === 1 ? '' : 's'}`;
}

function renderCounts() {
  const c = { ref: 0, cite: 0, sim: 0, shared: 0 };
  for (const n of G.nodes.values()) for (const r of n.roles) if (r in c) c[r]++;
  $('#n-ref').textContent = c.ref;
  $('#n-cite').textContent = c.cite;
  $('#n-sim').textContent = c.sim;
  $('#n-shared').textContent = c.shared;
}

function refreshAll() {
  $('#graph-filter-empty').hidden = !G.filter || !G.nodes.size || !!visibleNodes().length;
  $('#stage').classList.toggle('project', !!G.project);
  updateChatContext();
  renderCounts();
  renderNodeList();
  renderDetails();
  draw();
}

function defaultSaveTarget() {
  const saved = store.get('noctua.collection');
  return collections.targets.some(t => t.id === saved) ? saved
    : collections.targets.find(t => t.id === 'L1')?.id || collections.targets[0]?.id || '';
}

function setDefaultSaveTarget(target) {
  if (!collections.targets.some(t => t.id === target)) return;
  store.set('noctua.collection', target);
  renderDetails();
}

async function setIncludeSubfolders(include) {
  const saved = await api('/api/settings/library', { include_subfolders: include });
  settings.include_subfolders = saved.include_subfolders;
  const target = G.project?.target;
  await loadCollections();
  if (target && G.project?.target === target) {
    if (target === 'L1') G.project.include_subfolders = saved.include_subfolders;
    else openProject(target);
  }
  return saved.include_subfolders;
}

function collectionOptions(selected) {
  return collections.targets.map((t) =>
    `<option value="${esc(t.id)}"${t.id === selected ? ' selected' : ''} data-depth="${t.level || 0}">${' '.repeat(t.level || 0)}${esc(t.name)}</option>`
  ).join('');
}

// Selection fetches full records: project/search records can omit abstracts.
const abstractDetails = new Map();
function abstractKey(p,native){return (native?'library:':'paper:')+(native?p.key:p.paperId);}
async function fetchAbstractDetails(p,native){
  if(!native)return api('/api/paper?id='+enc(p.paperId));
  const ids=[p.s2,p.arxiv&&'ARXIV:'+p.arxiv,p.DOI&&'DOI:'+p.DOI].filter(Boolean);
  for(const id of ids){try{return await api('/api/paper?id='+enc(id));}catch(e){if(e.status!==404)throw e;}}
  if(p.title){try{const match=await api('/api/match?title='+enc(p.title));if(titlesAgree(p.title,match.title))return await api('/api/paper?id='+enc(match.paperId));}catch(e){if(e.status!==404)throw e;}}
  return {};
}
function ensureAbstract(p,native=false){
  const field=native?'abstractNote':'abstract',key=abstractKey(p,native);
  if(p[field]?.trim())return;
  const cached=abstractDetails.get(key);
  if(cached){if(cached.data?.abstract)p[field]=cached.data.abstract;return;}
  const state={status:'loading'};abstractDetails.set(key,state);
  fetchAbstractDetails(p,native).then(data=>{state.status='loaded';state.data=data;if(data.abstract)p[field]=data.abstract;})
    .catch(e=>{state.status='error';state.error=e.message;})
    .finally(()=>{
      const readerPaper=typeof PDF!=='undefined'&&document.body.classList.contains('pdf-mode')?PDF.paper:null;
      const current=native?(readerPaper || lib.detail):(G.nodes.get(G.selected)?.p || results.find(r=>r.paperId===G.selected));
      if(current&&abstractKey(current,native)===key){if(state.data?.abstract)current[field]=state.data.abstract;renderDetails();updateChatContext();}
    });
}
function abstractHTML(p,native=false){
  const text=native?p.abstractNote:p.abstract,state=abstractDetails.get(abstractKey(p,native));
  if(text?.trim())return `<div class="abstract">${esc(text)}</div>`;
  if(state?.status==='error')return `<div class="abstract">Couldn’t load the abstract: ${esc(state.error)} <button data-retry-abstract data-icon="rotate-cw">Retry</button></div>`;
  return `<div class="abstract">${state?.status==='loading'?'Loading abstract…':'No abstract supplied by Semantic Scholar for this paper.'}</div>`;
}
function bindAbstractRetry(el,p,native=false){el.querySelector('[data-retry-abstract]')?.addEventListener('click',()=>{abstractDetails.delete(abstractKey(p,native));renderDetails();});}

function renderDetails() {
  const el = $('#details');
  if (typeof PDF !== 'undefined' && document.body.classList.contains('pdf-mode') && PDF.paper) return renderLibDetails(PDF.paper);
  const n = G.nodes.get(G.selected);
  const p = n?.p || results.find((r) => r.paperId === G.selected);
  if (!p) {
    if (lib.detail) return renderLibDetails(lib.detail);
    el.innerHTML = '<p class="hint">Click a node to see the paper and add it to Noctua.</p>';
    return;
  }
  ensureAbstract(p);
  const ext = p.externalIds || {};
  const pdf = p.openAccessPdf?.url || (ext.ArXiv ? `https://arxiv.org/pdf/${ext.ArXiv}` : '');
  const authors = (p.authors || []).map((a) => a.name);
  const authorText = authors.length > 12 ? authors.slice(0, 12).join(', ') + `, … (+${authors.length - 12})` : authors.join(', ');
  const roleText = (r) => r === 'proj' ? (n.single ? 'Unconnected in this project' : `Cluster ${n.cluster}`)
    : r === 'shared' ? `Shared reference · cited by ${n.deg} project papers` : ROLE_LABEL[r];
  const roles = n ? [...n.roles].map((r) => `<span class="role ${r}"${r === 'proj' && !n.single ? ` style="background:${clusterColor(n.cluster)}"` : ''}>${roleText(r)}</span>`).join('') : '';
  const inLib = G.inLib.has(p.paperId);
  const target = defaultSaveTarget();

  el.innerHTML = `
    <div class="roles">${roles}</div>
    <h2>${esc(p.title)}</h2>
    <div class="authors">${esc(authorText || 'Unknown authors')}</div>
    <div class="venue">${esc([p.venue || p.journal?.name, p.publicationDate || p.year].filter(Boolean).join(' · '))}</div>
    <div class="stats">
      <span><b>${fmt(p.citationCount)}</b>citations</span>
      <span><b>${fmt(p.referenceCount)}</b>references</span>
      <span><b>${fmt(p.influentialCitationCount)}</b>influential</span>
      ${n ? `<span><b>${n.deg}</b>links here</span>` : ''}
    </div>
    ${typeof lineageDetailsHTML === 'function' ? lineageDetailsHTML(n) : ''}
    <div class="links">
      ${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">Semantic Scholar ↗</a>` : ''}
      ${ext.DOI ? `<a href="https://doi.org/${esc(ext.DOI)}" target="_blank" rel="noopener">DOI ↗</a>` : ''}
      ${ext.ArXiv ? `<a href="https://arxiv.org/abs/${esc(ext.ArXiv)}" target="_blank" rel="noopener">arXiv ↗</a>` : ''}
      ${pdf ? `<a href="${esc(pdf)}" target="_blank" rel="noopener">PDF ↗</a>` : ''}
    </div>
    <div class="paper-primary-actions" role="group" aria-label="Paper actions">
      <button id="act-read-pdf" class="paper-read-button" data-icon="file-text" data-label="Read PDF" aria-label="Read PDF">Read PDF</button>
      <button id="act-pdf-tab" data-icon="external-link" data-icon-only data-label="New tab" aria-label="PDF in new tab"></button>
      ${p.paperId !== G.centerId ? '<button id="act-center" data-icon="network" data-icon-only data-label="Graph" aria-label="Build graph from this paper"></button>' : ''}
      ${n && p.paperId !== G.centerId && !n.expanded ? '<button id="act-expand" data-label="Expand graph" aria-label="Expand this paper in the current graph" data-icon="expand" data-icon-only></button>' : ''}
    </div>
    <div class="library-add">
      ${inLib ? '<div class="in-lib">✓ Already in your Noctua library</div>' : ''}
      <div class="row">
        <select id="add-target">${collectionOptions(target)}</select>
        <button id="act-add" class="${inLib ? '' : 'primary'}" data-icon="${inLib ? 'folder-plus' : 'plus'}">${inLib ? 'Add to collection' : 'Add to Noctua'}</button>
      </div>
      ${pdf ? '<label><input type="checkbox" id="add-pdf" checked> Attach open-access PDF</label>' : ''}

    </div>
    ${p.tldr?.text ? `<div class="section-label">TL;DR</div><div class="tldr">${esc(p.tldr.text)}</div>` : ''}
    <div class="section-label">Abstract</div>
    ${abstractHTML(p)}
  `;
  bindAbstractRetry(el,p);
  el.querySelector('#act-read-pdf').addEventListener('click', () => readDiscoveredPaper(p));
  el.querySelector('#act-pdf-tab').addEventListener('click', () => readDiscoveredPaper(p, 'tab'));
  el.querySelector('#act-center')?.addEventListener('click', () => loadGraph(p.paperId));
  el.querySelector('#act-expand')?.addEventListener('click', () => expand(p.paperId));
  el.querySelector('#act-add').addEventListener('click', (ev) => saveToLibrary(p, ev.currentTarget));
}

async function saveToLibrary(p, btn) {
  const target = $('#add-target').value;
  const attach = $('#add-pdf')?.checked ?? false;
  btn.disabled = true;
  btn.textContent = 'Adding…';
  btn.dataset.icon = 'loader-circle';
  try {
    const saved = await api('/api/library/add', { paper: p, target, attach_pdf: attach });
    G.inLib.add(p.paperId);
    const name = collections.targets.find((t) => t.id === target)?.name || 'Noctua';
    toast(saved.warning ? `Saved to “${name}”. ${saved.warning}` : `Saved to “${name}”`, { error: !!saved.warning });
    loadCollections();
    loadRefs(true);
    refreshAll();
    renderResults();
  } catch (e) {
    toast(e.message, { error: true });
    btn.disabled = false;
    btn.textContent = 'Add to Noctua';
    btn.dataset.icon = 'plus';
  }
}

// ---------------------------------------------------------------- Noctua library browser

function renderLibTree() {
  const el = $('#lib-tree');
  if (!collections.targets.length) {
    el.innerHTML = `<p class="hint">${esc(collections.error || 'Noctua library not found.')} <a href="#" class="open-settings">Settings</a></p>`;
    return;
  }
  const byId = new Map(collections.targets.map(t => [t.id, t]));
  const parents = new Set(collections.targets.map(t => t.parent).filter(Boolean));
  const targets = collections.targets.filter(t => {
    for (let parent = t.parent; parent; parent = byId.get(parent)?.parent) {
      if (!lib.expanded.has(parent)) return false;
    }
    return true;
  });
  el.innerHTML = targets.map((t) => `
    <li data-id="${esc(t.id)}" class="${t.id === lib.target ? 'active' : ''}" style="padding-left:${8 + (t.level || 0) * 8}px">
      ${parents.has(t.id) ? `<button type="button" class="t-toggle" data-icon="${lib.expanded.has(t.id) ? 'chevron-down' : 'chevron-right'}" data-icon-only aria-expanded="${lib.expanded.has(t.id)}" aria-label="${lib.expanded.has(t.id) ? 'Collapse' : 'Expand'} ${esc(t.name)}" title="${lib.expanded.has(t.id) ? 'Collapse' : 'Expand'} subfolders"></button>` : '<span class="t-toggle-spacer" aria-hidden="true"></span>'}
      <span class="tree-symbol" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${t.id.startsWith('L') ? '<path d="m16 6 4 14M12 6v14M8 8v12M4 4v16"/>' : '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'}</svg></span>
      <span class="t-name">${esc(t.name)}</span>
      <span class="t-tail">
      <span class="t-count">${t.count ?? ''}</span>
      <span class="t-actions" role="group" aria-label="Folder actions">
      ${t.id.startsWith('C') ? '<button class="icon t-rename" title="Rename folder" data-icon="pencil" aria-label="Rename folder" data-icon-only>✎</button>' : ''}
      <button class="icon t-rename t-new" title="New folder inside" data-icon="folder-plus" aria-label="New folder inside" data-icon-only>+</button>
      ${t.id === lib.target ? '<button id="import-pdf" class="icon t-import" title="Import PDF into this folder" aria-label="Import PDF into this folder" data-icon="file-up" data-icon-only></button>' : ''}
      </span></span>
    </li>`).join('');
  el.querySelectorAll('li').forEach((li) => {
    li.addEventListener('click', () => {
      if (li.querySelector('input')) return;
      lib.target = li.dataset.id;
      store.set('noctua.libTarget', lib.target);
      renderLibTree();
      loadLibItems();
      if (G.layout !== 'library') openProject(lib.target);
    });
    li.querySelector('.t-toggle')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = li.dataset.id;
      if (!lib.expanded.delete(id)) lib.expanded.add(id);
      store.set('noctua.expandedFolders', JSON.stringify([...lib.expanded]));
      renderLibTree();
      el.querySelector(`[data-id="${CSS.escape(id)}"] .t-toggle`)?.focus();
    });
    li.querySelector('.t-rename:not(.t-new)')?.addEventListener('click', (e) => {
      e.stopPropagation();
      startRename(li);
    });
    li.querySelector('.t-new').addEventListener('click', (e) => {
      e.stopPropagation();
      startNewFolder(li);
    });
    li.querySelector('.t-import')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const button = e.currentTarget; button.disabled = true;
      try { await importLibraryPDF(li.dataset.id); }
      finally { if (button.isConnected) button.disabled = false; }
    });
  });
}

function startRename(li) {
  const nameEl = li.querySelector('.t-name');
  const old = nameEl.textContent;
  const input = document.createElement('input');
  input.className = 't-input';
  input.value = old;
  nameEl.replaceWith(input);
  li.querySelectorAll('.t-rename').forEach((b) => b.remove());
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (!save || !name || name === old) return renderLibTree();
    input.disabled = true;
    try {
      await api('/api/library/rename', { target: li.dataset.id, name });
      toast(`Renamed “${old}” to “${name}”`);
      await loadCollections();
    } catch (e) {
      toast(e.message, { error: true });
      renderLibTree();
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(false));
}

// An inline name field under `li`; Enter creates the folder there.
function startNewFolder(li) {
  const level = (collections.targets.find((t) => t.id === li.dataset.id)?.level || 0) + 1;
  const row = document.createElement('li');
  row.style.paddingLeft = `${8 + level * 8}px`;
  row.innerHTML = '<span class="t-toggle-spacer" aria-hidden="true"></span><span class="tree-symbol" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg></span><input class="t-input" placeholder="New folder name">';
  li.after(row);
  const input = row.querySelector('input');
  input.focus();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (!save || !name) return row.remove();
    input.disabled = true;
    try {
      const { id } = await api('/api/library/folder', { parent: li.dataset.id, name });
      toast(`Created “${name}”`);
      lib.target = id;
      store.set('noctua.libTarget', id);
      lib.expanded.add(li.dataset.id);
      store.set('noctua.expandedFolders', JSON.stringify([...lib.expanded]));
      await loadCollections();
    } catch (e) {
      toast(e.message, { error: true });
      row.remove();
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(false));
}

async function loadLibItems() {
  const el = $('#lib-items');
  if (!collections.targets.some((t) => t.id === lib.target)) lib.target = collections.targets[0]?.id;
  if (!lib.target) return;
  const target = lib.target;
  lib.items = null;
  renderLibraryTable([]);
  el.innerHTML = '<p class="hint">Loading library…</p>';
  try {
    const items = await api(`/api/library/items?target=${enc(target)}`);
    if (target !== lib.target) return;
    lib.items = items;
  } catch (e) {
    if (target !== lib.target) return;
    lib.items = null;
    $('#library-table-status').textContent = e.message;
    el.innerHTML = `<p class="hint">${esc(e.message)}</p>`;
    return;
  }
  renderLibItems();
}

const libAuthors = (it) => {
  const a = it.creators || [];
  if (!a.length) return 'Unknown authors';
  return a.length > 3 ? `${a.slice(0, 2).join(', ')} et al.` : a.join(', ');
};

function renderLibItems() {
  const el = $('#lib-items');
  if (!lib.target || !lib.items) return;
  const f = $('#lib-filter').value.trim().toLowerCase();
  let items = lib.items;
  if (f) items = items.filter((it) => [it.title, libAuthors(it), it.venue].join(' ').toLowerCase().includes(f));
  const cmp = {
    added: (a, b) => (b.dateAdded || '').localeCompare(a.dateAdded || ''),
    title: (a, b) => (a.title || '').localeCompare(b.title || ''),
    'year-desc': (a, b) => (b.year || 0) - (a.year || 0),
    'year-asc': (a, b) => (a.year || 9999) - (b.year || 9999),
  }[$('#lib-sort').value];
  items = items.slice().sort(cmp);
  renderLibraryTable(items);
  if (!items.length) {
    el.innerHTML = `<p class="hint">${lib.items.length ? 'No matches.' : 'This folder is empty.'}</p>`;
    return;
  }
  el.innerHTML = items.map((it) => `
    <li class="lib${it.key === G.libKey ? ' graphed' : ''}${it.key === lib.detail?.key ? ' selected' : ''}" data-key="${esc(it.key)}">
      <div class="p-body">
        <div class="p-title" title="${esc(it.title || '(untitled)')}">${esc(it.title || '(untitled)')}</div>
        <div class="p-meta p-authors" title="${esc(libAuthors(it))}">${esc(libAuthors(it))}</div>
        <div class="p-meta">${esc([it.venue, it.year].filter(Boolean).join(' · ') || it.itemType)}</div>
      </div>
      <div class="paper-row-actions" role="group" aria-label="Paper actions">
      ${it.has_pdf ? '<button class="read-btn" title="Read PDF (⌘/Ctrl-click opens a new tab)" data-icon="file-text" aria-label="Read PDF (⌘/Ctrl-click opens a new tab)" data-icon-only>PDF</button>' : ''}
      <button class="graph-btn" title="Build this paper's citation graph" data-icon="network" aria-label="Build this paper's citation graph" data-icon-only>Graph</button>
      </div>
    </li>`).join('');
  el.querySelectorAll('li').forEach((li) => {
    const it = lib.items.find((x) => x.key === li.dataset.key);
    li.addEventListener('click', () => showLibItem(it));
    li.querySelector('.read-btn')?.addEventListener('click', (e) => { e.stopPropagation(); openPaperView(it.key, e.metaKey || e.ctrlKey ? 'tab' : 'here'); });
    li.querySelector('.graph-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      showLibItem(it);
      graphFromLibrary(it);
    });
  });
}

// The library table includes local items even when Semantic Scholar cannot match them.
function renderLibraryTable(items) {
  $('#library-title').textContent = targetName(lib.target) || 'Library';
  $('#library-count').textContent = lib.items ? `${items.length} of ${lib.items.length} papers` : '';
  const status = $('#library-table-status');
  status.hidden = !!items.length;
  status.textContent = !lib.items ? 'Loading library…' : lib.items.length ? 'No matches.' : 'This folder is empty. Import a PDF or search for papers to get started.';
  document.querySelectorAll('[data-library-sort]').forEach((button) => {
    const sort = $('#lib-sort').value;
    button.closest('th').setAttribute('aria-sort', button.dataset.librarySort === sort ? (sort === 'year-desc' ? 'descending' : 'ascending') : button.dataset.librarySort === 'year-desc' && sort === 'year-asc' ? 'ascending' : 'none');
  });
  const rows = $('#library-rows');
  rows.innerHTML = items.map(it => `<tr data-key="${esc(it.key)}" class="${it.key === lib.detail?.key ? 'selected' : ''}">
    <td><button class="library-paper-title" data-select-paper>${esc(it.title || '(untitled)')}</button></td>
    <td title="${esc(libAuthors(it))}">${esc(libAuthors(it))}</td><td>${esc(it.year || '—')}</td>
    <td title="${esc(it.venue || '')}">${esc(it.venue || '—')}</td>
    <td><div class="paper-row-actions">${it.has_pdf ? '<button data-read data-icon="file-text" data-icon-only title="Read PDF" aria-label="Read PDF"></button>' : ''}<button data-network data-icon="network" data-icon-only title="Build citation graph" aria-label="Build citation graph"></button></div></td>
  </tr>`).join('');
  const byKey = new Map(items.map(it => [it.key, it]));
  rows.querySelectorAll('tr').forEach(row => {
    const it = byKey.get(row.dataset.key);
    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-read], [data-network]')) return;
      showLibItem(it);
    });
    row.querySelector('[data-select-paper]').addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showLibItem(it); $('#library-rows').querySelector(`[data-key="${CSS.escape(it.key)}"] [data-select-paper]`)?.focus(); }
    });
    row.addEventListener('dblclick', (e) => { if (it.has_pdf && !e.target.closest('[data-read], [data-network]')) openPaperView(it.key); });
    row.querySelector('[data-read]')?.addEventListener('click', e => openPaperView(it.key, e.metaKey || e.ctrlKey ? 'tab' : 'here'));
    row.querySelector('[data-network]').addEventListener('click', () => { showLibItem(it); graphFromLibrary(it); });
  });
}

function showLibItem(it) {
  lib.detail = it;
  G.selected = null;
  updateChatContext();
  renderDetails();
  document.querySelectorAll('#lib-items [data-key], #library-rows [data-key]').forEach(row => row.classList.toggle('selected', row.dataset.key === it.key));
  draw();
}

function renderLibDetails(it) {
  ensureAbstract(it,true);
  const el = $('#details');
  const doi = it.DOI && !/^10\.48550\/arxiv\./i.test(it.DOI) ? it.DOI : null;
  el.innerHTML = `
    <div class="roles"><span class="role exp">In library</span></div>
    <h2>${esc(it.title || '(untitled)')}</h2>
    <div class="authors">${esc((it.creators || []).join(', ') || 'Unknown authors')}</div>
    <div class="venue">${esc([it.venue, it.date || it.year].filter(Boolean).join(' · '))}</div>
    <div class="links">

      ${doi ? `<a href="https://doi.org/${esc(doi)}" target="_blank" rel="noopener">DOI ↗</a>` : ''}
      ${it.arxiv ? `<a href="https://arxiv.org/abs/${esc(it.arxiv)}" target="_blank" rel="noopener">arXiv ↗</a>` : ''}
      ${it.url && !it.arxiv && !doi ? `<a href="${esc(it.url)}" target="_blank" rel="noopener">Link ↗</a>` : ''}
    </div>
    <div class="paper-primary-actions" role="group" aria-label="Paper actions">
      <button id="act-lib-graph" data-icon="network" data-icon-only data-label="Graph" aria-label="${it.key === G.libKey ? 'Rebuild paper graph' : 'Visualize paper graph'}"></button>
    </div>
    <div class="paper-collection-tools"></div>
    <div class="section-label">Abstract</div>${abstractHTML(it,true)}`;
  bindAbstractRetry(el,it,true);
  el.querySelector('#act-lib-graph').addEventListener('click', () => graphFromLibrary(it));
  libraryPaperActions(el, it);
}

async function loadCollections() {
  try {
    collections = await api('/api/library/collections');
  } catch (e) {
    collections = { live: false, targets: [], error: e.message };
    renderLibTree();
    return;
  }
  renderLibTree();
  loadLibItems();
  if (typeof notesRefreshFolders === 'function') notesRefreshFolders();  // notes.js may still be loading
  const saveFolder = $('#setup-save-target');
  if (saveFolder) saveFolder.innerHTML = collectionOptions(defaultSaveTarget());
  renderDetails();
}

// ---------------------------------------------------------------- chat

const chat = { provider: 'claude', ready: false, switching: false, running: null, id: null, busy: false, abort: null, sentGraphKey: null, sentNoteKey: null, mode: store.get('noctua.chatMode') || 'suggest' };

const agentLabel = (provider = chat.provider) => provider === 'codex' ? 'Codex' : 'Claude Code';

async function readEvents(response, handle) {
  const reader = response.body.getReader();
  const dec = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    buffer += done ? dec.decode() : dec.decode(value, { stream: true });
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      if (line.trim()) handle(JSON.parse(line));
    }
    if (done) { if (buffer.trim()) handle(JSON.parse(buffer)); break; }
  }
}

// Wait until the server has saved even a stopped turn before restoring a
// conversation. Session ids and the current conversation are provider-specific.
async function stopChat() {
  chat.abort?.abort();
  await chat.running;
  if (!chat.id) return;
  for (let i = 0; i < 100; i++) {
    const c = await api(`/api/chats/${enc(chat.id)}?provider=${chat.provider}`);
    if (!c.busy) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('The previous reply is still stopping. Please try again.');
}

async function activateAgent(provider, { persist = true } = {}) {
  if (chat.switching) return;
  chat.switching = true;
  if ($('#setup-agent')) $('#setup-agent').disabled = true;
  $('#chat-input').disabled = true;
  $('#chat-send').disabled = true;
  try {
    await stopChat();
    if (persist) await api('/api/settings/agent', { provider });
    if (chat.ready) store.set('noctua.chatDraft.' + chat.provider, $('#chat-input').value);
    chat.provider = provider;
    chat.ready = true;
    chat.sentGraphKey = null; chat.sentNoteKey = null;
    $('#chat-input').value = store.get('noctua.chatDraft.' + provider) || '';
    toggleChatHistory(false);
    const id = store.get('noctua.chat.' + provider) || (provider === 'claude' ? store.get('noctua.chat') : null);
    chat.id = null;
    if (id) await openChat(id); else { setChatId(null); chatWelcome(); }
    // Once imported, the old shared pointer must never reopen a deleted chat.
    if (provider === 'claude') store.set('noctua.chat', '');
    if (typeof settings !== 'undefined' && settings) settings.agent = provider;
    refreshAgentBadge();
  } finally {
    chat.switching = false;
    if ($('#setup-agent')) {
      $('#setup-agent').value = chat.provider;
      $('#setup-agent').disabled = false;
    }
    $('#chat-input').disabled = false;
    $('#chat-send').disabled = false;
  }
}

async function refreshAgentBadge() {
  const provider = chat.provider;
  try {
    const s = await api('/api/agents/' + provider);
    if (provider !== chat.provider) return;
    if ($('#agent-status')) $('#agent-status').textContent = s.signed_in ? 'Signed in' : s.installed ? 'Not signed in' : 'CLI not found';
  } catch { /* account details remain available in Settings */ }
}

// What the assistant may do to notes: suggest edits (accept/reject), plan (read-only), or edit directly.
const CHAT_MODES = {
  suggest: { label: 'Suggest edits', hint: 'The assistant proposes note edits; you accept or reject each.' },
  plan: { label: 'Plan', hint: 'Read-only: the assistant investigates and proposes a plan, but changes nothing.' },
  direct: { label: 'Direct edits', hint: 'The assistant edits notes directly; you can undo.' },
};

function setChatMode(mode) {
  if (!CHAT_MODES[mode]) mode = 'suggest';
  chat.mode = mode;
  store.set('noctua.chatMode', mode);
  const b = $('#chat-mode');
  b.textContent = CHAT_MODES[mode].label;
  b.dataset.icon = {suggest:'pencil', plan:'list-checks', direct:'zap'}[mode];
  b.title = `${CHAT_MODES[mode].hint} (Shift+Tab in the chat box to cycle)`;
  b.dataset.mode = mode;
}

function cycleChatMode() {
  const order = Object.keys(CHAT_MODES);
  setChatMode(order[(order.indexOf(chat.mode) + 1) % order.length]);
}

const TOOL_LABEL = {
  search_papers: 'Searching Semantic Scholar',
  get_paper: 'Reading paper details',
  show_graph: 'Building graph',
  get_project_graph: 'Reading project graph',
  show_project_graph: 'Opening project graph',
  select_paper: 'Selecting paper',
  list_folder_items: 'Reading Noctua folder',
  list_notes: 'Listing notes',
  read_note: 'Reading note',
  view_note_image: 'Looking at image',
  edit_note: 'Editing note',
  save_to_library: 'Saving to library',
  list_library_collections: 'Reading collections',
  download_pdf: 'Downloading PDF',
  read_pdf: 'Reading PDF',
  search_pdf: 'Searching PDF',
  view_pdf_page: 'Viewing PDF page',
  annotate_pdf: 'Annotating PDF',
  comment_on_pdf_annotation: 'Commenting on PDF',
  search_library: 'Searching saved papers',
  update_paper_memberships: 'Organizing project papers',
  edit_collection: 'Updating collection',
  create_note: 'Creating note',
  get_edit_proposal: 'Checking proposed changes',
  list_project_files: 'Listing project files',
  read_project_file: 'Reading project file',
  edit_project_file: 'Editing project file',
  read_skill: 'Reading skill',
  request_skill_run: 'Requesting script approval',
  get_skill_run: 'Checking script result',
  read_pdf_outline: 'Reading saved outline',
  get_paper_relations: 'Reading related papers',
  view_note_drawing: 'Viewing handwriting',
  show_pdf: 'Opening PDF',
  list_pdf_annotations: 'Reading PDF annotations',
};

const paperLine = (p) =>
  `${p.title} (${p.year ?? 'n.d.'}; ${authorsShort(p)}; ${fmt(p.citationCount)} citations) [paperId: ${p.paperId}]`;

// What the assistant sees each turn. The full paper list is only resent when
// the graph changed, to keep the conversation small.
function chatContext() {
  if (document.body.classList.contains('pdf-mode') && typeof pdfContext === 'function') return { context: JSON.stringify(pdfContext()), key: 'pdf:' + PDF.key, noteKey: null };
  const L = [];
  const c = G.nodes.get(G.centerId);
  const P = G.project;
  if (P) {
    const nc = P.clusters.filter((x) => x.size > 1).length;
    L.push(`Project graph open for Noctua folder "${P.name}" (${P.target}): ${P.papers.length} of ${P.items} items found on Semantic Scholar, ` +
      `${P.edges.length} direct citation links, ${nc} clusters, ${P.clusters.length - nc} unconnected papers. ` +
      'Use get_project_graph for the connections between clusters.');
  } else L.push(c ? `Graph center: ${paperLine(c.p)}` : 'Graph center: none (no graph open)');
  const s = G.nodes.get(G.selected);
  if (s && s.id !== G.centerId) L.push(`Selected paper: ${paperLine(s.p)}`);
  if (s?.p.abstract) L.push(`Selected paper abstract: ${s.p.abstract.slice(0, 1500)}`);
  if (!s && lib.detail) L.push(`Selected Noctua item: ${lib.detail.title} (${lib.detail.year ?? 'n.d.'}; ${libAuthors(lib.detail)})`);
  if (!s && lib.detail) { L.push(`Native paper_key: ${lib.detail.key}; PDF available: ${!!lib.detail.has_pdf}`); if(lib.detail.abstractNote)L.push(`Selected paper abstract: ${lib.detail.abstractNote}`); }
  const add = collections.targets.find((t) => t.id === defaultSaveTarget());
  if (add) L.push(`Add-to folder: ${add.name} (${add.id})`);
  const open = collections.targets.find((t) => t.id === lib.target);
  if (open) L.push(`Folder open in Library tab: ${open.name} (${open.id})`);

  const root = G.centerId || (P && 'project:' + P.target);
  const lin = typeof lineageContext === 'function' ? lineageContext() : { sig: '', lines: [] };
  const key = root ? `${root}:${G.nodes.size}:${G.edges.length}${lin.sig}` : '';
  if (key && key !== chat.sentGraphKey) {
    const ns = [...G.nodes.values()].sort((a, b) => (b.p.citationCount || 0) - (a.p.citationCount || 0)).slice(0, 150);
    const role = (n) => !P ? primaryRole(n) : n.roles.has('shared') ? 'shared-ref' : n.single ? 'unconnected' : `cluster ${n.cluster}`;
    L.push(`Papers in graph (${G.nodes.size} total, most cited first). ` + (P
      ? 'Roles: cluster N = in the folder, in that cluster; unconnected = in the folder, no citation links to the others; shared-ref = outside paper cited from several clusters.'
      : 'Roles: ref = cited by center, cite = cites center, sim = similar, exp = from expansion.'));
    L.push('role | paperId | year | citations | title');
    for (const n of ns) L.push(`${role(n)} | ${n.id} | ${n.p.year ?? '?'} | ${n.p.citationCount ?? 0} | ${n.p.title}`);
    L.push(...lin.lines);
  } else if (key) {
    L.push('Papers in graph: unchanged since the previous message.');
  }
  const nc = notesContext(chat.sentNoteKey);
  L.push(...nc.lines);
  return { context: L.join('\n'), key, noteKey: nc.key };
}

function updateChatContext() {
  const label = $('#chat-context');
  let title;
  if (document.body.classList.contains('pdf-mode') && typeof PDF !== 'undefined' && PDF.paper) {
    title = PDF.paper.title || 'Untitled paper';
  } else if (document.body.classList.contains('notes-mode')) {
    title = N.doc ? (N.doc.title || 'Untitled note') : 'No note open';
  } else {
    const selected = G.nodes.get(G.selected), center = G.nodes.get(G.centerId);
    title = selected?.p.title || lib.detail?.title || center?.p.title || G.project?.name || 'No graph open';
  }
  label.textContent = title;
  label.title = title;
}

// Typesets $…$, $$…$$, \(…\) and \[…\] with KaTeX, leaving code alone. Math is
// swapped for \u0001n\u0001 placeholders so the Markdown pass can't touch it.
function extractMath(src) {
  const math = [];
  const put = (tex, display) => {
    math.push(katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'html', strict: 'ignore' }));
    return `\u0001${math.length - 1}\u0001`;
  };
  const text = src.split(/(```[\s\S]*?(?:```|$))/).map((part, i) => i % 2 ? part
    : part.split(/(`[^`\n]*`)/).map((s, j) => j % 2 ? s : s
      .replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => put(t, true))
      .replace(/\\\[([\s\S]+?)\\\]/g, (_, t) => put(t, true))
      .replace(/\\\(([\s\S]+?)\\\)/g, (_, t) => put(t, false))
      // $…$ needs non-space just inside both dollars and no digit after (so "$5 and $10" stays text).
      .replace(/(^|[^\\$\w])\$(?=\S)([^$\n]*?\S)\$(?!\d)/g, (_, pre, t) => pre + put(t, false))
    ).join('')).join('');
  return { text, restore: (html) => html.replace(/\u0001(\d+)\u0001/g, (_, n) => math[n] ?? '') };
}

// A user's chat message: plain text with @-mention chips and typeset math.
function userMsgHtml(text, selections=[]) {
  const { text: t, restore } = extractMath(text);
  return restore(mentionChips(esc(t)))+(window.NoctuaChatSelections?.sentHTML(selections)||'');
}

// Split table rows without treating escaped pipes or inline code as cell boundaries.
function markdownTableCells(line) {
  const text = line.trim(), cells = [];
  let cell = '', ticks = 0, hasPipe = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\\' && text[i + 1] === '\\') { cell += '\\\\'; i++; }
    else if (char === '\\' && text[i + 1] === '|') { cell += '|'; i++; }
    else if (char === '`') {
      let length = 1;
      while (text[i + length] === '`') length++;
      if (!ticks) ticks = length; else if (ticks === length) ticks = 0;
      cell += '`'.repeat(length); i += length - 1;
    } else if (char === '|' && !ticks) { cells.push(cell.trim()); cell = ''; hasPipe = true; }
    else cell += char;
  }
  if (!hasPipe) return null;
  cells.push(cell.trim());
  if (text.startsWith('|') && cells[0] === '') cells.shift();
  if (text.endsWith('|') && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

function renderChatCode(source, language, complete) {
  let html = esc(source);
  if (language !== 'mermaid' && source.length <= 30000 && typeof hljs !== 'undefined' && hljs.getLanguage(language)) {
    try { html = hljs.highlight(source, {language, ignoreIllegals: true}).value; } catch (_) { /* Keep plain text on unsupported syntax. */ }
  }
  const diagram = language === 'mermaid' && complete;
  return `<div class="chat-code${diagram ? ' chat-diagram' : ''}"${diagram ? ' data-diagram' : ''}><div class="chat-code-head"><span>${esc(language || 'Code')}</span>${diagram ? '<button type="button" class="chat-source-toggle" aria-expanded="false">Source</button>' : ''}<button type="button" class="chat-copy" aria-label="Copy code">Copy</button></div>${diagram ? '<div class="chat-diagram-view" aria-label="Diagram"></div>' : ''}<pre><code>${html}</code></pre></div>`;
}

function renderMd(src, mathProcessed = false) {
  const { text: mdSrc, restore } = mathProcessed ? {text: src, restore: html => html} : extractMath(src);
  src = mdSrc;
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|paper:|pdf:)[^)\s]+)\)/g, (m, text, url) => url.startsWith('paper:')
      ? `<a href="${url}" class="paper-link">${text}</a>`
      : url.startsWith('pdf:') ? `<a href="${url}" class="pdf-link">${text}</a>`
      : `<a href="${url}" target="_blank" rel="noopener">${text}</a>`);
  const out = [];
  let para = [], list = null, code = null, codeLanguage = '';
  const flushPara = () => { if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`); para = []; };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => {
      const task = /^\[([ xX])\]\s+(.*)$/.exec(i);
      return task ? `<li class="chat-task"><label><input type="checkbox" disabled${task[1] !== ' ' ? ' checked' : ''}><span>${inline(task[2])}</span></label></li>` : `<li>${inline(i)}</li>`;
    }).join('')}</${list.tag}>`);
    list = null;
  };
  const lines = src.split('\n');
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    if (code) {
      if (/^\s*```\s*$/.test(line)) { out.push(renderChatCode(code.join('\n'), codeLanguage, true)); code = null; }
      else code.push(line);
      continue;
    }
    if (/^\s*>/.test(line)) {
      flushPara(); flushList();
      const quoted = [];
      while (lineIndex < lines.length && /^\s*>/.test(lines[lineIndex])) {
        quoted.push(lines[lineIndex].replace(/^\s*> ?/, '')); lineIndex++;
      }
      lineIndex--;
      out.push(`<blockquote>${renderMd(quoted.join('\n'), true)}</blockquote>`);
      continue;
    }
    if (/^\s*<details(?: open)?>\s*$/.test(line)) {
      flushPara(); flushList();
      let depth = 1, contents = [], title = 'More details', open = / open>/.test(line), fenced = false;
      for (lineIndex++; lineIndex < lines.length; lineIndex++) {
        const current = lines[lineIndex];
        if (/^\s*```/.test(current)) { fenced = !fenced; contents.push(current); continue; }
        if (fenced) { contents.push(current); continue; }
        if (/^\s*<details(?: open)?>\s*$/.test(current)) depth++;
        if (/^\s*<\/details>\s*$/.test(current) && --depth === 0) break;
        const summary = depth === 1 && !contents.some(value => value.trim()) && /^\s*<summary>(.*?)<\/summary>\s*$/.exec(current);
        if (summary) title = summary[1]; else contents.push(current);
      }
      out.push(`<details class="chat-details"${open ? ' open' : ''}><summary>${inline(title)}</summary>${renderMd(contents.join('\n'), true)}</details>`);
      continue;
    }
    const header = markdownTableCells(line);
    const divider = markdownTableCells(lines[lineIndex + 1] || '');
    if (!/^\s*(?:```|#{1,4}\s|[-*]\s|\d+\.\s)/.test(line) && header?.length && divider?.length === header.length && divider.every(cell => /^:?-+:?$/.test(cell))) {
      flushPara(); flushList();
      const alignment = divider.map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left');
      const row = (cells, tag) => header.map((_, index) => `<${tag}${tag === 'th' ? ' scope="col"' : ''} style="text-align:${alignment[index]}">${inline(cells[index] || '')}</${tag}>`).join('');
      const rows = [];
      lineIndex++; // Consume the delimiter row.
      while (lineIndex + 1 < lines.length) {
        const cells = markdownTableCells(lines[lineIndex + 1]);
        if (!cells || /^\s*(?:```|#{1,4}\s|[-*]\s|\d+\.\s)/.test(lines[lineIndex + 1])) break;
        rows.push(`<tr>${row(cells, 'td')}</tr>`); lineIndex++;
      }
      out.push(`<div class="chat-table-scroll" role="region" aria-label="Table" tabindex="0"><table><thead><tr>${row(header, 'th')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`);
      continue;
    }
    let m;
    if (/^\s*```/.test(line)) { flushPara(); flushList(); code = []; const name = line.trim().slice(3).trim().toLowerCase(); codeLanguage = /^[\w+-]{1,30}$/.test(name) ? name : ''; }
    else if ((m = line.match(/^\s*(?:[-*]|(\d+)\.)\s+(.*)$/))) {
      flushPara();
      const tag = m[1] ? 'ol' : 'ul';
      if (list?.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push(m[2]);
    }
    else if ((m = line.match(/^#{1,4}\s+(.*)$/))) { flushPara(); flushList(); out.push(`<h4>${inline(m[1])}</h4>`); }
    else if (!line.trim()) { flushPara(); flushList(); }
    else if (list) list.items[list.items.length - 1] += ' ' + line.trim();
    else para.push(line.trim());
  }
  if (code) out.push(renderChatCode(code.join('\n'), codeLanguage, false));
  flushPara();
  flushList();
  return restore(out.join(''));
}

function appendMsg(role, html) {
  const log = $('#chat-log');
  log.querySelector('.hint')?.remove();
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.innerHTML = html;
  log.appendChild(el);
  if (role === 'assistant') NoctuaChatRender.enhance(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

function chatWelcome() {
  $('#chat-log').innerHTML = `<p class="hint">Ask about the papers you're looking at. I can see the current graph and selection,
    and I can search for papers, open graphs, and add papers to your Noctua folders.</p>`;
}

function renderStoredMsg(m) {
  if (m.role === 'user') return appendMsg('user', userMsgHtml(m.text,m.selections));
  const tools = (m.tools || []).map((n) => `<div class="tool">⚙ ${esc(TOOL_LABEL[n] || n)}</div>`).join('');
  appendMsg('assistant', `${tools}<div class="body">${renderMd(m.text || '')}${
    m.error ? `<p class="error">${esc(m.error)}</p>` : ''}${m.stopped ? '<p class="tool">Stopped.</p>' : ''}</div>`);
}

function setChatId(id) {
  const previousId=chat.id,selectionKey=window.NoctuaChatSelections?.storageKey();
  chat.id = id;
  store.set('noctua.chat.' + chat.provider, id || '');
  if(previousId==null&&id&&chat.busy)window.NoctuaChatSelections?.moveDraft(selectionKey);
  else window.NoctuaChatSelections?.restore();
}

function newChat() {
  chat.abort?.abort();
  setChatId(null);
  chat.sentGraphKey = null;
  chat.sentNoteKey = null;
  chatWelcome();
}

async function openChat(id) {
  await stopChat();
  let c;
  try { c = await api(`/api/chats/${enc(id)}?provider=${chat.provider}`); } catch (e) {
    if (e.status === 404) return newChat();
    return toast(`Couldn't open chat: ${e.message}`, { error: true });
  }
  setChatId(c.id);
  chat.sentGraphKey = null; // resend the current graph; it may differ from back then
  chat.sentNoteKey = null;
  $('#chat-log').innerHTML = '';
  if (!c.messages.length) chatWelcome();
  c.messages.forEach(renderStoredMsg);
}

async function toggleChatHistory(show = $('#chat-history').classList.contains('hidden')) {
  const box = $('#chat-history');
  box.classList.toggle('hidden', !show);
  $('#chat-history-btn').classList.toggle('active', show);
  if (!show) return;
  const provider = chat.provider;
  box.innerHTML = '<li class="hint">Loading…</li>';
  let list;
  try { list = await api('/api/chats?provider=' + provider); } catch (e) {
    box.innerHTML = `<li class="error">${esc(e.message)}</li>`;
    return;
  }
  if (provider !== chat.provider) return;
  box.innerHTML = list.length ? list.map((c) => `
    <li data-id="${esc(c.id)}" class="${c.id === chat.id ? 'current' : ''}">
      <span class="h-title">${esc(c.title || 'Untitled')}</span>
      <span class="h-when">${new Date(c.updated * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
      <button class="h-del icon" title="Delete this chat" data-icon="trash-2" aria-label="Delete this chat" data-icon-only>×</button>
    </li>`).join('') : '<li class="hint">No saved chats yet.</li>';
}

function runChatAction(a, host) {
  if (a.action?.startsWith('pdf_')) { pdfAction(a).catch((e) => toast(e.message, { error: true })); return; }
  if (a.action === 'skill_run') { showSkillRun(a.id); return; }
  if (a.action === 'file_edit_approval') { showFileEditApproval(a, host); return; }
  if (a.action === 'workspace_changed') { refreshWorkspaceView(a.target).catch(e=>toast(e.message,{error:true})); return; }
  if (a.action === 'note_changed') { refreshAgentNote(a).catch(e=>toast(e.message,{error:true})); return; }
  if (a.action === 'agent_edit_proposal') { showAgentEdit(a.proposal_id).catch(e=>toast(e.message,{error:true})); return; }
  if (a.action === 'note_drawing') { prepareNoteDrawing(a).catch(e=>toast(e.message,{error:true})); return; }
  if (a.action !== 'library' && (document.body.classList.contains('notes-mode') || document.body.classList.contains('pdf-mode'))) setMode('graph');
  if (a.action === 'graph') loadGraph(a.id);
  else if (a.action === 'project') openProject(a.target);
  else if (a.action === 'select') {
    if (G.nodes.has(a.id)) { select(a.id); focusNode(a.id); }
    else loadGraph(a.id);
  } else if (a.action === 'library') {
    checkLibrary();
    loadCollections();
  }
}

function setChatBusy(busy) {
  chat.busy = busy;
  notifyProgress('assistant', busy ? 'Assistant is working…' : null);
  $('#chat-new').disabled = busy;
  $('#chat-history-btn').disabled = busy;
  $('#chat-send').textContent = busy ? 'Stop' : 'Send';
  $('#chat-send').dataset.icon = busy ? 'square' : 'send';
  $('#chat-send').setAttribute('aria-label', busy ? 'Stop' : 'Send');
  $('#chat-send').title = busy ? 'Stop' : 'Send';
  $('#chat-send').classList.toggle('primary', !busy);
}

async function sendChat(text) {
  try { stopEdit(); await saveWorkspaceFile(); await flushNoteEdits(); } catch (e) { toast(e.message, {error:true}); return; }
  const provider = chat.provider;
  const selectedPassages=window.NoctuaChatSelections?.snapshot()||{items:[]};
  const ctrl = new AbortController();
  chat.abort = ctrl;
  setChatBusy(true);
  appendMsg('user', userMsgHtml(text,selectedPassages.items));
  const el = appendMsg('assistant', '<div class="body"><span class="typing">Thinking…</span></div>');
  const body = el.querySelector('.body');
  const log = $('#chat-log');
  let md = '';
  const { context, key, noteKey } = chatContext();

  const handle = (e) => {
    if (e.type === 'chat') setChatId(e.id);
    else if (e.type === 'text_start') { if (md && !md.endsWith('\n\n')) md += '\n\n'; }
    else if (e.type === 'text') { md += e.text; NoctuaChatRender.update(body, md); }
    else if (e.type === 'tool') {
      notifyProgress('assistant', `${TOOL_LABEL[e.name] || e.name}…`);
      const t = document.createElement('div');
      t.className = 'tool';
      t.textContent = `⚙ ${TOOL_LABEL[e.name] || e.name}…`;
      el.insertBefore(t, body);
    }
    else if (e.type === 'action') runChatAction(e, el);
    else if (e.type === 'done') { chat.sentGraphKey = key; chat.sentNoteKey = noteKey; }
    else if (e.type === 'error') body.insertAdjacentHTML('beforeend', `<p class="error">${esc(e.message)}</p>`);
    log.scrollTop = log.scrollHeight;
  };

  try {
    const attachments = await chatAttachments(text);
    if (ctrl.signal.aborted) return;
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, provider, context, project_target: chatProjectTarget(), skill_ids: getChatSkillOverride(), chat_id: chat.id, mode: chat.mode, attachments, selections:selectedPassages.items }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    window.NoctuaChatSelections?.consume(selectedPassages);
    await readEvents(r, handle);
  } catch (e) {
    if (e.name === 'AbortError') body.insertAdjacentHTML('beforeend', '<p class="tool">Stopped.</p>');
    else body.insertAdjacentHTML('beforeend', `<p class="error">${esc(e.message)}</p>`);
  } finally {
    body.querySelector('.typing')?.remove();
    NoctuaChatRender.enhance(body);
    chat.abort = null;
    closeFileEditApprovals();
    setChatBusy(false);
  }
}

function showRightTab(name, { focus = true } = {}) {
  name = name === 'chat' ? 'chat' : 'paper';
  store.set('noctua.rightTab', name);
  document.querySelectorAll('#right > .tabs button').forEach((b) => b.classList.toggle('active', b.dataset.rtab === name));
  $('#details').classList.toggle('hidden', name !== 'paper');
  $('#chat').classList.toggle('hidden', name !== 'chat');
  if (name === 'chat') { restoreChatInputHeight(); updateChatContext(); if (focus) $('#chat-input').focus(); }
}

// ---------------------------------------------------------------- toast / tabs

let toastTimer = null;
let toastNotice = null;
const notificationProgress = new Map();

function renderToast() {
  const el = $('#toast');
  const tasks = [...notificationProgress].sort(([a], [b]) => Number(a === 'requests') - Number(b === 'requests')).map(([, message]) => message);
  const message = toastNotice?.message || tasks[0] || '';
  const remaining = toastNotice ? tasks : tasks.slice(1);
  const detail = remaining.length ? remaining[0] + (remaining.length > 1 ? ` · +${remaining.length - 1} tasks` : '') : '';
  el.textContent = message;
  el.dataset.detail = detail;
  el.classList.toggle('error', !!toastNotice?.error);
  el.classList.toggle('busy', !toastNotice && !!tasks.length);
  el.classList.toggle('hidden', !message);
  el.setAttribute('aria-label', [message, detail].filter(Boolean).join('. '));
  el.setAttribute('aria-live', toastNotice?.error ? 'assertive' : 'polite');
  if (message) { el.hidePopover?.(); el.showPopover?.(); } else el.hidePopover?.();
}

function notifyProgress(id, message) {
  if (message === notificationProgress.get(id)) return;
  if (message) notificationProgress.set(id, message); else notificationProgress.delete(id);
  renderToast();
}

function toast(msg, { error = false, duration } = {}) {
  if (toastNotice?.error && !error) return;
  toastNotice = { message: String(msg), error };
  clearTimeout(toastTimer);
  renderToast();
  toastTimer = setTimeout(hideToast, Number.isFinite(duration) ? Math.max(0, duration) : error ? 8000 : 4000);
}
function hideToast({ keepError = false } = {}) {
  if (keepError && toastNotice?.error) return;
  clearTimeout(toastTimer);
  toastNotice = null;
  renderToast();
}

let graphSidebarList = store.get('noctua.graphSidebarList') === 'threads' ? 'threads' : 'nodes';
function setGraphSidebarList(name = graphSidebarList) {
  if (G.layout === 'lineage') {
    graphSidebarList = name === 'threads' ? 'threads' : 'nodes';
    store.set('noctua.graphSidebarList', graphSidebarList);
  }
  const active = G.layout === 'lineage' ? graphSidebarList : 'nodes';
  $('#tab-nodes').classList.toggle('hidden', active !== 'nodes');
  $('#tab-threads').classList.toggle('hidden', active !== 'threads');
  document.querySelectorAll('[data-graph-list]').forEach(button => {
    button.classList.toggle('active', button.dataset.graphList === active);
    button.setAttribute('aria-pressed', String(button.dataset.graphList === active));
  });
}
document.querySelectorAll('[data-graph-list]').forEach(button => button.addEventListener('click', () => setGraphSidebarList(button.dataset.graphList)));
function showTab(name) {
  if (name === 'threads' || name === 'nodes') setGraphSidebarList(name);
}

// ---------------------------------------------------------------- force simulation

let alpha = 0;
let raf = null;
let dragging = null;

function kick(a = 1) {
  alpha = Math.max(alpha, a);
  if (!raf) raf = requestAnimationFrame(frame);
}

function frame() {
  raf = null;
  if (alpha > 0.002) {
    step();
    alpha *= 0.977;
    if (G.autoFit && alpha < 0.25) { G.autoFit = false; fit(); }
  }
  draw();
  if (alpha > 0.002 || dragging) raf = requestAnimationFrame(frame);
}

const radius = (n) => (4 + 3.2 * Math.log10((n.p.citationCount || 0) + 1)) * (n.roles.has('shared') ? 0.75 : 1);

function nodeColor(n, range) {
  if (!G.project) return yearColor(n.p.year, range);
  if (n.roles.has('shared')) return colors.panel;
  return n.single ? colors.muted : clusterColor(n.cluster);
}

function yearRange(ns) {
  let lo = Infinity, hi = -Infinity;
  for (const n of ns) if (n.p.year) { lo = Math.min(lo, n.p.year); hi = Math.max(hi, n.p.year); }
  return lo === Infinity ? [2000, 2000] : [lo, hi];
}

function step() {
  const ns = visibleNodes();
  if (G.layout === 'lineage') { stepLineage(ns); return; }
  const N = ns.length;
  const vis = new Set(ns.map((n) => n.id));

  // Repulsion + collision (O(n²); fine for a few hundred nodes).
  for (let i = 0; i < N; i++) {
    const a = ns[i];
    for (let j = i + 1; j < N; j++) {
      const b = ns[j];
      let dx = b.x - a.x, dy = b.y - a.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1e-4) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = dx * dx + dy * dy; }
      if (d2 > 360000) continue;
      const f = (-260 * alpha) / d2;
      a.vx += dx * f; a.vy += dy * f;
      b.vx -= dx * f; b.vy -= dy * f;
      const minD = radius(a) + radius(b) + 4;
      if (d2 < minD * minD) {
        const d = Math.sqrt(d2);
        const push = ((minD - d) / d) * 0.5;
        a.x -= dx * push; a.y -= dy * push;
        b.x += dx * push; b.y += dy * push;
      }
    }
  }

  // Springs along citation edges (d3-style degree-normalised strength).
  for (const e of G.edges) {
    if (!vis.has(e.s) || !vis.has(e.t)) continue;
    const s = G.nodes.get(e.s), t = G.nodes.get(e.t);
    let dx = t.x + t.vx - s.x - s.vx, dy = t.y + t.vy - s.y - s.vy;
    const l = Math.sqrt(dx * dx + dy * dy) || 1;
    const strength = 1 / Math.max(1, Math.min(s.deg, t.deg));
    const k = ((l - 90) / l) * alpha * strength;
    dx *= k; dy *= k;
    const bias = s.deg / (s.deg + t.deg || 1);
    t.vx -= dx * bias; t.vy -= dy * bias;
    s.vx += dx * (1 - bias); s.vy += dy * (1 - bias);
  }

  for (const n of ns) {
    n.vx += -n.x * 0.03 * alpha;
    n.vy += -n.y * 0.03 * alpha;
    if (n.fixed || n.id === G.centerId) {
      n.vx = 0; n.vy = 0;
      if (n.id === G.centerId && !n.fixed) { n.x = 0; n.y = 0; }
      continue;
    }
    n.vx *= 0.6; n.vy *= 0.6;
    n.x += n.vx; n.y += n.vy;
  }
}

// ---------------------------------------------------------------- drawing

const canvas = $('#graph');
const ctx = canvas.getContext('2d');
let colors = {};

function readColors() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of ['ink', 'muted', 'accent', 'ref', 'cite', 'sim', 'ok', 'edge', 'node-old', 'node-new', 'panel', 'bg']) {
    colors[k] = cs.getPropertyValue('--' + k).trim();
  }
  colors.font = cs.getPropertyValue('--font-ui').trim() || '-apple-system, sans-serif';
  colors.fontScale = Number(cs.getPropertyValue('--ui-font-scale')) || 1;
  colors.oldRgb = hexRgb(colors['node-old']);
  colors.newRgb = hexRgb(colors['node-new']);
}

function hexRgb(h) {
  const m = h.replace('#', '').match(/.{2}/g) || ['80', '80', '80'];
  return m.map((x) => parseInt(x, 16));
}

function yearColor(year, range) {
  if (!year) return colors['node-old'];
  const t = range[1] > range[0] ? (year - range[0]) / (range[1] - range[0]) : 1;
  const c = colors.oldRgb.map((o, i) => Math.round(o + (colors.newRgb[i] - o) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function size() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  return { w, h, dpr };
}

function draw() {
  const { w, h, dpr } = size();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!G.nodes.size) return;

  const ns = visibleNodes();
  const vis = new Set(ns.map((n) => n.id));
  if (G.layout === 'lineage') { drawLineage(w, h, ns, vis); return; }
  const range = yearRange(ns);
  const focus = [G.hover, G.selected].find(id => vis.has(id));
  const near = new Set();
  if (focus) {
    near.add(focus);
    for (const e of G.edges) {
      if (e.s === focus) near.add(e.t);
      if (e.t === focus) near.add(e.s);
    }
  }

  ctx.translate(w / 2 + view.x, h / 2 + view.y);
  ctx.scale(view.k, view.k);

  // Background edges in one path.
  ctx.lineWidth = 1 / view.k;
  ctx.strokeStyle = colors.edge;
  const hot = [], dashed = [];
  ctx.beginPath();
  for (const e of G.edges) {
    if (!vis.has(e.s) || !vis.has(e.t)) continue;
    if (focus && (e.s === focus || e.t === focus)) { hot.push(e); continue; }
    const s = G.nodes.get(e.s), t = G.nodes.get(e.t);
    if (t.roles.has('shared')) { dashed.push(e); continue; }  // project graph: link to a shared reference
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(t.x, t.y);
  }
  ctx.stroke();
  if (dashed.length) {
    ctx.setLineDash([4 / view.k, 4 / view.k]);
    ctx.beginPath();
    for (const e of dashed) {
      const s = G.nodes.get(e.s), t = G.nodes.get(e.t);
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(t.x, t.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Focused edges: blue = the focused paper cites it, orange = it cites the focused paper.
  for (const e of hot) {
    const s = G.nodes.get(e.s), t = G.nodes.get(e.t);
    ctx.strokeStyle = e.s === focus ? colors.ref : colors.cite;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 1.6 / view.k;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(t.x, t.y);
    ctx.stroke();
    arrow(s, t);
  }

  // Nodes (focused neighbourhood drawn last, on top).
  const order = focus ? ns.slice().sort((a, b) => near.has(a.id) - near.has(b.id)) : ns;
  for (const n of order) {
    ctx.globalAlpha = focus && !near.has(n.id) ? 0.28 : 1;
    drawNode(n, nodeColor(n, range));
  }
  ctx.globalAlpha = 1;

  // Labels for big-enough nodes, the focus and its neighbours.
  ctx.font = `${11 * colors.fontScale / view.k}px ${colors.font}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const n of order) {
    const r = radius(n);
    const show = n.id === focus || n.id === G.centerId || (focus ? near.has(n.id) && r * view.k > 6 : r * view.k > 11);
    if (show) drawLabel(n);
  }
}

// A paper's circle with its library, center and selection rings. With no
// fill, it is drawn hollow with a `ring`-coloured outline.
function drawNode(n, fill, ring, scale = 1) {
  const r = radius(n) * scale;
  ctx.beginPath();
  ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill || colors.panel;
  ctx.fill();
  ctx.lineWidth = (fill ? (n.roles.has('shared') ? 1.5 : 1) : 2) / view.k;
  ctx.strokeStyle = !fill ? ring : n.roles.has('shared') ? colors.muted : colors.panel;
  ctx.stroke();
  if (G.inLib.has(n.id) && !n.roles.has('proj')) {  // every project paper is in Noctua
    ctx.beginPath();
    ctx.arc(n.x, n.y, r + 3 / view.k, 0, Math.PI * 2);
    ctx.lineWidth = 2.5 / view.k;
    ctx.strokeStyle = colors.ok;
    ctx.stroke();
  }
  if (n.id === G.centerId || n.id === G.selected) {
    ctx.beginPath();
    ctx.arc(n.x, n.y, r + (G.inLib.has(n.id) ? 6 : 3) / view.k, 0, Math.PI * 2);
    ctx.lineWidth = (n.id === G.selected ? 2.5 : 3) / view.k;
    ctx.strokeStyle = n.id === G.selected ? colors.ink : colors.accent;
    ctx.stroke();
  }
}

// "LastName Year" under a paper; expects font and alignment already set.
function drawLabel(n, above = false) {
  const label = `${lastName(n.p)} ${n.p.year ?? ''}`.trim();
  // With textBaseline 'top', a label above starts one line height higher.
  const y = above ? n.y - radius(n) - 3 / view.k - 13 * (colors.fontScale || 1) / view.k : n.y + radius(n) + 3 / view.k;
  ctx.lineWidth = 3 / view.k;
  ctx.strokeStyle = colors.bg;
  ctx.strokeText(label, n.x, y);
  ctx.fillStyle = colors.ink;
  ctx.fillText(label, n.x, y);
}

function arrow(s, t) {
  const r = radius(t) + 2 / view.k;
  const ang = Math.atan2(t.y - s.y, t.x - s.x);
  const x = t.x - Math.cos(ang) * r, y = t.y - Math.sin(ang) * r;
  const a = 7 / view.k;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - a * Math.cos(ang - 0.4), y - a * Math.sin(ang - 0.4));
  ctx.lineTo(x - a * Math.cos(ang + 0.4), y - a * Math.sin(ang + 0.4));
  ctx.closePath();
  ctx.fill();
}

// ---------------------------------------------------------------- view helpers & interaction

function toWorld(sx, sy) {
  return [(sx - canvas.clientWidth / 2 - view.x) / view.k, (sy - canvas.clientHeight / 2 - view.y) / view.k];
}

function hit(sx, sy) {
  const [x, y] = toWorld(sx, sy);
  const ns = visibleNodes();
  for (let i = ns.length - 1; i >= 0; i--) {
    const n = ns[i];
    const r = radius(n) + 3 / view.k;
    if ((n.x - x) ** 2 + (n.y - y) ** 2 <= r * r) return n;
  }
  return null;
}

function fit(ns = visibleNodes(), maxK = 2.2) {
  if (!ns.length) return;
  G.autoFit = false; // A pending automatic fit must not overwrite a manual/thread fit.
  if (G.layout === 'lineage') return fitLineage(ns, maxK);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of ns) {
    const x = n.x, y = n.y;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y);
    x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  const w = canvas.clientWidth, h = canvas.clientHeight - 80;
  if (w <= 0 || h <= 0) return;
  view.k = Math.min(maxK, w / (x1 - x0 + 100), h / (y1 - y0 + 100));
  view.x = -((x0 + x1) / 2) * view.k;
  view.y = -((y0 + y1) / 2) * view.k + 20;
  draw();
}

function focusNode(id) {
  const n = G.nodes.get(id);
  if (!n) return;
  view.x = -n.x * view.k;
  view.y = -n.y * view.k;
  draw();
}

function select(id) {
  G.selected = id;
  if (id) lib.detail = null;
  updateChatContext();
  renderDetails();
  document.querySelectorAll('#node-list li').forEach((li) => li.classList.toggle('selected', li.dataset.id === id));
  draw();
}

let pointer = null; // { x, y, node, moved, vx, vy }

canvas.addEventListener('pointerdown', (e) => {
  if (G.layout === 'lineage' && lineagePointerDown(e)) return;
  canvas.setPointerCapture(e.pointerId);
  const node = hit(e.offsetX, e.offsetY);
  pointer = { x: e.offsetX, y: e.offsetY, node, moved: false, vx: view.x, vy: view.y };
  if (node) { dragging = node; node.fixed = true; }
  canvas.classList.add('dragging');
});

canvas.addEventListener('pointermove', (e) => {
  const tip = $('#tooltip');
  if (pointer) {
    const dx = e.offsetX - pointer.x, dy = e.offsetY - pointer.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) pointer.moved = true;
    if (pointer.node) {
      const [x, y] = toWorld(e.offsetX, e.offsetY);
      if (G.layout === 'lineage') pointer.node.y = pointer.node.ty = y;  // x stays tied to time
      else { pointer.node.x = x; pointer.node.y = y; }
      kick(0.15);
    } else {
      view.x = pointer.vx + dx;
      view.y = pointer.vy + dy;
      draw();
    }
    tip.classList.add('hidden');
    return;
  }
  const n = hit(e.offsetX, e.offsetY);
  const id = n?.id || null;
  if (id !== G.hover) { G.hover = id; draw(); }
  const label = !n && G.layout === 'lineage' ? lineageLabelAt(e.offsetX, e.offsetY) : null;
  canvas.style.cursor = n || label ? 'pointer' : '';
  if (n || label?.cut) {
    tip.innerHTML = label ? `<b>${esc(label.full)}</b>`  // a lane label shortened to fit
      : `<b>${esc(n.p.title)}</b><br>${esc(authorsShort(n.p))} · ${n.p.year ?? '—'} · ${fmt(n.p.citationCount)} cites` + (typeof lineageTip === 'function' ? lineageTip(n) : '');
    tip.style.left = Math.min(e.offsetX + 14, canvas.clientWidth - 330) + 'px';
    tip.style.top = (e.offsetY + 14) + 'px';
    tip.classList.remove('hidden');
  } else {
    tip.classList.add('hidden');
  }
});

function endPointer(e) {
  if (!pointer) return;
  const lin = G.layout === 'lineage';
  if (pointer.node) {
    pointer.node.fixed = false;
    if (pointer.moved) { /* dragged */ }
    else if (lin && e?.shiftKey && G.selected && G.selected !== pointer.node.id) traceLineage(G.selected, pointer.node.id);
    else { if (lin) LIN.trace = null; select(pointer.node.id); }
  } else if (!pointer.moved) {
    if (lin) clearLineageFocus();
    select(null);
  }
  dragging = null;
  pointer = null;
  canvas.classList.remove('dragging');
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', () => { if (!pointer && G.hover) { G.hover = null; $('#tooltip').classList.add('hidden'); draw(); } });

canvas.addEventListener('dblclick', (e) => {
  const n = hit(e.offsetX, e.offsetY);
  if (n && n.id !== G.centerId) loadGraph(n.id);
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const [wx, wy] = toWorld(e.offsetX, e.offsetY);
  view.k = Math.min(6, Math.max(0.08, view.k * Math.exp(-e.deltaY * 0.0015)));
  view.x = e.offsetX - canvas.clientWidth / 2 - wx * view.k;
  view.y = e.offsetY - canvas.clientHeight / 2 - wy * view.k;
  draw();
}, { passive: false });

// ---------------------------------------------------------------- wiring

$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#search').value.trim();
  if (q) search(q);
});

$('#search-form button').addEventListener('click', (e) => {
  if (!$('#search').value.trim()) { e.preventDefault(); $('#search').focus(); }
});
$('#search').addEventListener('input', () => {
  searchToken++; // Ignore responses for a query that has since been edited.
  closeSearchResults();
});
$('#search').addEventListener('focus', () => {
  if (searchState.q === $('#search').value.trim() && results.length) $('#tab-results').classList.remove('hidden');
});
$('#research-search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeSearchResults(); $('#search').blur(); }
});
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#research-search')) closeSearchResults();
});
function applyGraphFilter(value) {
  G.filter = value.trim().toLowerCase();
  $('#graph-filter').value = value;
  $('#filter').value = value;
  $('#graph-filter-control').classList.toggle('has-query', !!value);
  $('#papers-filter-control').classList.toggle('has-query', !!value);
  $('#graph-filter-empty').hidden = !G.filter || !G.nodes.size || !!visibleNodes().length;
  G.hover = null;
  refreshAll();
  kick(.8);
  fit();
}
$('#papers-filter-control button').addEventListener('click', () => $('#filter').focus());
$('#filter').addEventListener('keydown', e => {
  if (e.key === 'Escape') { applyGraphFilter(''); e.target.blur(); }
});
$('#graph-filter-control button').addEventListener('click', () => $('#graph-filter').focus());
$('#graph-filter').addEventListener('input', e => applyGraphFilter(e.target.value));
$('#graph-filter').addEventListener('keydown', e => {
  if (e.key === 'Escape') { applyGraphFilter(''); e.target.blur(); }
});
$('#library-filter-control button').addEventListener('click', () => $('#library-table-filter').focus());
$('#library-table-filter').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.target.value = '';
    e.target.dispatchEvent(new Event('input'));
    e.target.blur();
  }
});
$('#library-table-filter').addEventListener('input', (e) => {
  $('#library-filter-control').classList.toggle('has-query', !!e.target.value);
  $('#lib-filter').value = e.target.value;
  renderLibItems();
});
document.querySelectorAll('[data-library-sort]').forEach((button) => button.addEventListener('click', () => {
  let sort = button.dataset.librarySort;
  if (sort === 'year-desc' && $('#lib-sort').value === sort) sort = 'year-asc';
  $('#lib-sort').value = sort;
  renderLibItems();
}));

document.querySelectorAll('.controls input[data-role]').forEach((cb) => cb.addEventListener('change', () => {
  G.show[cb.dataset.role] = cb.checked;
  refreshAll();
  kick(0.5);
}));
$('#limit').addEventListener('change', () => { if (G.centerId) loadGraph(G.centerId, { push: false }); });
$('#fit').addEventListener('click', () => fit());
$('#sort').addEventListener('change', renderNodeList);
$('#filter').addEventListener('input', e => applyGraphFilter(e.target.value));

document.querySelectorAll('#right > .tabs button').forEach((b) => b.addEventListener('click', () => showRightTab(b.dataset.rtab)));
// Resize the composer from the divider above it, keeping room for the conversation.
const chatResize = $('#chat-resize');
let chatResizeDrag = null;
function chatInputMaxHeight() {
  return Math.max(60, Math.min(400, innerHeight / 2, $('#chat').clientHeight - 140));
}
function setChatInputHeight(height, save = true) {
  const max = chatInputMaxHeight(), value = Math.round(Math.max(60, Math.min(max, height)));
  $('#chat-input').style.height = value + 'px';
  chatResize.setAttribute('aria-valuemax', Math.floor(max));
  chatResize.setAttribute('aria-valuenow', value);
  if (save) store.set('noctua.chatInputHeight', String(value));
}
function restoreChatInputHeight() {
  if (!$('#chat').clientHeight || chatResizeDrag) return;
  const saved = Number(store.get('noctua.chatInputHeight'));
  if (Number.isFinite(saved) && saved > 0) setChatInputHeight(saved, false);
  else if ($('#chat-input').style.height) setChatInputHeight($('#chat-input').getBoundingClientRect().height, false);
}
chatResize.addEventListener('pointerdown', e => {
  if (e.button !== 0 || chatResizeDrag) return;
  e.preventDefault();
  chatResizeDrag = { id: e.pointerId, y: e.clientY, height: $('#chat-input').getBoundingClientRect().height };
  chatResize.setPointerCapture(e.pointerId);
  chatResize.classList.add('dragging');
  document.body.classList.add('chat-resizing');
});
chatResize.addEventListener('pointermove', e => {
  if (chatResizeDrag?.id === e.pointerId) setChatInputHeight(chatResizeDrag.height + chatResizeDrag.y - e.clientY, false);
});
function endChatInputResize(e) {
  if (chatResizeDrag?.id !== e.pointerId) return;
  setChatInputHeight($('#chat-input').getBoundingClientRect().height);
  chatResizeDrag = null;
  chatResize.classList.remove('dragging');
  document.body.classList.remove('chat-resizing');
  if (chatResize.hasPointerCapture(e.pointerId)) chatResize.releasePointerCapture(e.pointerId);
}
['pointerup', 'pointercancel', 'lostpointercapture'].forEach(type => chatResize.addEventListener(type, endChatInputResize));
chatResize.addEventListener('keydown', e => {
  const height = $('#chat-input').getBoundingClientRect().height;
  const next = { ArrowUp: height + 20, ArrowDown: height - 20, Home: 60, End: chatInputMaxHeight() }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  setChatInputHeight(next);
});
window.addEventListener('resize', restoreChatInputHeight);
window.addEventListener('storage', e => {
  if (e.key === 'noctua.chatInputHeight' || e.key === null) restoreChatInputHeight();
});
restoreChatInputHeight();
$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!chat.ready || chat.switching) return;
  if (chat.busy) { stopChat().catch((err) => toast(err.message, { error: true })); return; }
  const text = $('#chat-input').value.trim()||(window.NoctuaChatSelections?.count()?'Explain the selected passages.':'');
  if (!text) return;
  $('#chat-input').value = '';
  chat.running = sendChat(text);
});
function syncChatFontSize() {
  const size = NoctuaFonts.getChatSize();
  $('#chat-font-smaller').disabled = size <= 10;
  $('#chat-font-larger').disabled = size >= 24;
  $('#chat-font-smaller').title = `Decrease chat text size (${size}px)`;
  $('#chat-font-larger').title = `Increase chat text size (${size}px)`;
}
$('#chat-font-smaller').addEventListener('click', () => NoctuaFonts.setChatSize(NoctuaFonts.getChatSize() - 1));
$('#chat-font-larger').addEventListener('click', () => NoctuaFonts.setChatSize(NoctuaFonts.getChatSize() + 1));
document.addEventListener('noctua-chat-text-change', syncChatFontSize);
syncChatFontSize();
$('#chat-mode').addEventListener('click', cycleChatMode);
$('#chat-input').addEventListener('keydown', (e) => {
  if (mentionKey(e)) return;  // @-mention popup open
  if (e.key === 'Tab' && e.shiftKey) {
    e.preventDefault();
    cycleChatMode();
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('#chat-form').requestSubmit();
  }
});
$('#chat-new').addEventListener('click', async () => { try { await stopChat(); toggleChatHistory(false); newChat(); } catch (e) { toast(e.message, { error: true }); } });
$('#chat-history-btn').addEventListener('click', () => toggleChatHistory());
$('#chat-history').addEventListener('click', async (e) => {
  if (chat.switching) return;
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  const id = li.dataset.id;
  if (e.target.closest('.h-del')) {
    if (!confirm(`Delete “${li.querySelector('.h-title').textContent}”?`)) return;
    const r = await fetch(`/api/chats/${enc(id)}?provider=${chat.provider}`, { method: 'DELETE' }).catch(() => null);
    if (!r?.ok) return toast("Couldn't delete chat", { error: true });
    if (id === chat.id) newChat();
    toggleChatHistory(true);
    return;
  }
  toggleChatHistory(false);
  openChat(id);
});
$('#chat-log').addEventListener('click', (e) => {
  const pdf = e.target.closest('a.pdf-link');
  if (pdf) { e.preventDefault(); const [key, query] = pdf.getAttribute('href').slice(4).split('?'); const q = new URLSearchParams(query); openPDF(key, { page: Number(q.get('page')) || 1, annotation: q.get('annotation') }).catch((err) => toast(err.message, { error: true })); return; }
  const a = e.target.closest('a.paper-link');
  if (!a) return;
  e.preventDefault();
  runChatAction({ action: 'select', id: a.getAttribute('href').slice('paper:'.length) });
});
$('#lib-sort').addEventListener('change', renderLibItems);
$('#lib-filter').addEventListener('input', () => {
  $('#library-table-filter').value = $('#lib-filter').value;
  $('#library-filter-control').classList.toggle('has-query', !!$('#lib-filter').value);
  renderLibItems();
});

window.addEventListener('popstate', () => {
  if (!location.hash.startsWith('#pdf=') && document.body.classList.contains('pdf-mode')) setMode('graph');
  const m = location.hash.match(/^#paper=(.+)$/);
  const pm = location.hash.match(/^#project=(.+)$/);
  if (m) loadGraph(decodeURIComponent(m[1]), { push: false });
  else if (pm) openProject(decodeURIComponent(pm[1]), { push: false });
  else if (!location.hash.startsWith('#pdf=')) clearGraph({ push: false });
});
new ResizeObserver(() => draw()).observe($('#stage'));
new ResizeObserver(() => draw()).observe($('#stage .controls'));
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readColors(); draw(); });

function setAppTheme(theme) {
  const next = ['light', 'dark', 'system'].includes(theme) ? theme : 'system';
  document.documentElement.dataset.theme = next;
  store.set('noctua.theme', next);
  if ($('#setup-app-theme')) $('#setup-app-theme').value = next;
  readColors();
  draw();
}
document.addEventListener('noctua-font-change', e => { if (e.detail.kind === 'ui') { readColors(); draw(); } });
document.addEventListener('noctua-font-size-change', e => { if (e.detail.kind === 'ui') { readColors(); draw(); } });
setAppTheme(store.get('noctua.theme'));
window.addEventListener('storage', (e) => {
  if (e.key === 'noctua.theme' || e.key === null) setAppTheme(store.get('noctua.theme'));
  if (e.key === 'noctua.collection' || e.key === null) {
    const select = $('#setup-save-target');
    if (select) select.value = defaultSaveTarget();
    renderDetails();
  }
});
setChatMode(chat.mode);
chatWelcome();
showRightTab(store.get('noctua.rightTab'), { focus: false });

const collectionsReady = loadCollections();
{
  const m = location.hash.match(/^#paper=(.+)$/);
  const pm = location.hash.match(/^#project=(.+)$/);
  if (m) collectionsReady.then(() => loadGraph(decodeURIComponent(m[1]), { push: false }));
  else if (pm) collectionsReady.then(() => openProject(decodeURIComponent(pm[1]), { push: false }));
}

// The folder/paper split is shared by Graph and Lineage and remembered locally.
const folderDivider = $('#folder-divider');
const defaultFolderHeight = 440;
function setFolderHeight(height, save = true) {
  const max = Math.max(60, Math.floor($('#research-sidebar').clientHeight * .65));
  const value = Math.round(Math.max(60, Math.min(max, height)));
  $('#research-sidebar').style.setProperty('--folder-height', value + 'px');
  folderDivider.setAttribute('aria-valuemax', String(max));
  folderDivider.setAttribute('aria-valuenow', String(value));
  if (save) store.set('noctua.folderHeight', String(value));
}
const savedFolderHeight = Number(store.get('noctua.folderHeight'));
if (savedFolderHeight) setFolderHeight(savedFolderHeight, false);
folderDivider.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  e.preventDefault();
  const startY = e.clientY, startHeight = $('#tab-library').getBoundingClientRect().height;
  folderDivider.setPointerCapture(e.pointerId);
  folderDivider.classList.add('dragging');
  const move = ev => setFolderHeight(startHeight + ev.clientY - startY, false);
  const end = ev => {
    folderDivider.removeEventListener('pointermove', move);
    folderDivider.removeEventListener('pointerup', end);
    folderDivider.removeEventListener('pointercancel', end);
    folderDivider.classList.remove('dragging');
    setFolderHeight(startHeight + ev.clientY - startY);
  };
  folderDivider.addEventListener('pointermove', move);
  folderDivider.addEventListener('pointerup', end);
  folderDivider.addEventListener('pointercancel', end);
});
folderDivider.addEventListener('keydown', e => {
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
  e.preventDefault();
  const height = $('#tab-library').getBoundingClientRect().height;
  setFolderHeight(e.key === 'Home' ? 60 : e.key === 'End' ? Infinity : height + (e.key === 'ArrowUp' ? -20 : 20));
});
folderDivider.addEventListener('dblclick', () => setFolderHeight(defaultFolderHeight));
new ResizeObserver(() => {
  if (G.layout !== 'library') setFolderHeight(Number(store.get('noctua.folderHeight')) || defaultFolderHeight, false);
}).observe($('#research-sidebar'));
