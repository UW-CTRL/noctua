'use strict';

// Lineage layout: papers placed by publication time (older left, newer right)
// and grouped into lanes along "threads", the citation chains that most paths
// through the graph follow (main-path analysis with search path counts).
// The research assistant can name and explain the threads (/api/threads).

// ---------------------------------------------------------------- analysis (pure)

// Fractional publication time: year plus month when Semantic Scholar has a date.
function paperTime(p) {
  if (!p?.year) return null;
  const m = /^(\d{4})-(\d{2})/.exec(p.publicationDate || '');
  const month = m && Number(m[1]) === p.year ? Number(m[2]) : 0;
  return month >= 1 && month <= 12 ? p.year + (month - 0.5) / 12 : p.year + 0.5;
}

// ids: paper ids; timeOf: id -> time or null; cites: [citing, cited] pairs.
// Flow runs from the cited (older) paper to the citing one. Citations of a
// newer paper, and edges closing a cycle, are reported as anomalies instead.
function computeThreads(ids, timeOf, cites, maxThreads = 5) {
  const known = new Set(ids);
  const out = new Map(ids.map((id) => [id, []]));
  const inc = new Map(ids.map((id) => [id, []]));
  const anomalies = [];
  const seen = new Set();
  for (const [s, t] of cites) {
    const k = t + '>' + s;
    if (s === t || !known.has(s) || !known.has(t) || seen.has(k)) continue;
    seen.add(k);
    const ts = timeOf.get(s), tt = timeOf.get(t);
    if (ts != null && tt != null && tt > ts) { anomalies.push([t, s]); continue; }
    out.get(t).push(s);
    inc.get(s).push(t);
  }

  // Sorted adjacency makes ties break the same way whatever order the links
  // arrived in, so the same graph always yields the same (cached) threads.
  const byTime = (a, b) => (timeOf.get(a) ?? -Infinity) - (timeOf.get(b) ?? -Infinity) || (a < b ? -1 : a > b ? 1 : 0);
  for (const list of [...out.values(), ...inc.values()]) list.sort(byTime);

  // Topological order (Kahn); a leftover cycle is broken at its earliest paper.
  const indeg = new Map(ids.map((id) => [id, inc.get(id).length]));
  const done = new Set();
  const order = [];
  const ready = ids.filter((id) => !indeg.get(id)).sort(byTime);
  while (order.length < ids.length) {
    if (!ready.length) {
      const v = ids.filter((id) => !done.has(id)).sort(byTime)[0];
      for (const u of inc.get(v)) {
        if (done.has(u)) continue;
        anomalies.push([u, v]);
        out.set(u, out.get(u).filter((x) => x !== v));
      }
      inc.set(v, inc.get(v).filter((u) => done.has(u)));
      ready.push(v);
    }
    const v = ready.shift();
    done.add(v);
    order.push(v);
    for (const w of out.get(v)) {
      indeg.set(w, indeg.get(w) - 1);
      if (!indeg.get(w)) ready.push(w);
    }
  }

  // Search path count: an edge's weight is how many source-to-sink paths use it.
  const nIn = new Map(), nOut = new Map();
  for (const v of order) {
    const ps = inc.get(v);
    nIn.set(v, ps.length ? ps.reduce((a, u) => a + nIn.get(u), 0) : 1);
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const cs = out.get(order[i]);
    nOut.set(order[i], cs.length ? cs.reduce((a, w) => a + nOut.get(w), 0) : 1);
  }
  const flow = [];
  for (const u of order) for (const v of out.get(u)) flow.push({ u, v, w: nIn.get(u) * nOut.get(v) });
  flow.sort((a, b) => b.w - a.w || byTime(a.u, b.u) || byTime(a.v, b.v));
  const top = flow.length ? flow[0].w : 1;
  const weight = new Map(flow.map((e) => [e.u + '>' + e.v, e.w / top]));

  // Threads: grow the heaviest unused edge into a path along the heaviest
  // neighbours, stopping where it meets an earlier thread (a junction).
  const threadOf = new Map();
  const junctions = new Set();
  const used = new Set();
  const threads = [];
  const heaviest = (list, key) => {
    let best = null, bw = -1;
    for (const x of list) {
      if (used.has(key(x))) continue;
      const w = weight.get(key(x));
      if (w > bw) { bw = w; best = x; }
    }
    return best;
  };
  for (const e of flow) {
    if (threads.length >= maxThreads || e.w < top * 0.01) break;
    const k = e.u + '>' + e.v;
    if (used.has(k)) continue;
    used.add(k);
    if (threadOf.has(e.u) && threadOf.has(e.v)) continue;
    const path = [e.u, e.v];
    for (let cur = e.u; !threadOf.has(cur);) {
      const p = heaviest(inc.get(cur), (x) => x + '>' + cur);
      if (!p) break;
      used.add(p + '>' + cur);
      path.unshift(p);
      cur = p;
    }
    for (let cur = e.v; !threadOf.has(cur);) {
      const n = heaviest(out.get(cur), (x) => cur + '>' + x);
      if (!n) break;
      used.add(cur + '>' + n);
      path.push(n);
      cur = n;
    }
    if (path.length < 3 || path.filter((id) => !threadOf.has(id)).length < 2) continue;
    const ti = threads.length;
    for (const id of path) {
      if (threadOf.has(id)) junctions.add(id);
      else threadOf.set(id, ti);
    }
    threads.push({ core: path, steps: path.slice(1).map((id, i) => [path[i], id]) });
  }

  // Other papers join the thread they are most tied to (second pass: via
  // papers that joined in the first). A link counts 1/degree so hubs pull
  // less, and links to junctions (e.g. the center paper) don't count at all.
  const memberOf = new Map(threadOf);
  const deg = (x) => inc.get(x).length + out.get(x).length;
  for (let pass = 0; pass < 2; pass++) {
    const from = new Map(memberOf);
    for (const id of order) {
      if (memberOf.has(id)) continue;
      const score = new Map();
      for (const x of [...inc.get(id), ...out.get(id)]) {
        const t = from.get(x);
        if (t !== undefined && t >= 0 && !junctions.has(x)) score.set(t, (score.get(t) || 0) + 1 / deg(x));
      }
      let bt = -1, bs = 0;
      for (const [t, s] of score) if (s > bs || (s === bs && t < bt)) { bs = s; bt = t; }
      if (bt >= 0) memberOf.set(id, bt);
    }
  }
  for (const id of ids) if (!memberOf.has(id)) memberOf.set(id, -1);

  // Undated papers are placed just after what they cite (or before what
  // cites them), so the flow still reads left to right.
  const placeTime = new Map(timeOf);
  for (const v of order) {
    if (placeTime.get(v) != null) continue;
    const before = inc.get(v).map((u) => placeTime.get(u)).filter((t) => t != null);
    if (before.length) placeTime.set(v, Math.max(...before));
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const v = order[i];
    if (placeTime.get(v) != null) continue;
    const after = out.get(v).map((w) => placeTime.get(w)).filter((t) => t != null);
    if (after.length) placeTime.set(v, Math.min(...after));
  }

  return { order, inc, out, flow, weight, anomalies, threads, threadOf, memberOf, junctions, placeTime };
}

// Positions: x from time (years without papers are squeezed), y from lanes,
// one per thread, with papers stacked in rows so none overlap.
function layoutLineage(ids, res, radiusOf) {
  const timeOf = res.placeTime;
  const ROW = 36, PAD_TOP = 30, PAD_BOTTOM = 16;
  const count = new Map();
  for (const id of ids) {
    const t = timeOf.get(id);
    if (t != null) count.set(Math.floor(t), (count.get(Math.floor(t)) || 0) + 1);
  }
  const years = [...count.keys()].sort((a, b) => a - b);
  // Busy years get wider columns (by the square root of their paper count).
  const mean = ids.length / Math.max(1, years.length);
  const share = (y) => Math.max(0.4, Math.min(4, Math.sqrt(count.get(y) / mean)));
  const px = Math.max(40, Math.min(170, 1600 / Math.max(1, years.reduce((a, y) => a + share(y), 0))));
  const cols = [];
  let x = 0, gap = 0;
  for (let y = years[0]; years.length && y <= years[years.length - 1]; y++) {
    const full = count.has(y);
    gap = full ? 0 : gap + 1;
    const w = full ? px * share(y) : gap <= 6 ? px * 0.15 : 0;
    cols.push({ year: y, x, w, empty: !full });
    x += w;
  }
  const shift = -x / 2;
  for (const c of cols) c.x += shift;
  const x0 = shift, x1 = x + shift, undatedX = x0 - px * 0.8;
  const colOf = (t) => cols[Math.floor(t) - years[0]];
  const xOf = (t) => t == null ? undatedX : colOf(t).x + (t - Math.floor(t)) * colOf(t).w;
  // Papers known only by year (and related papers) may sit anywhere in their year's column.
  const yearOnly = (id) => { const t = timeOf.get(id); return t != null && t - Math.floor(t) === 0.5; };

  // Lane order: each next thread goes on the side whose end lane it links to most.
  const T = res.threads.length;
  const link = Array.from({ length: T }, () => new Array(T).fill(0));
  for (const { u, v } of res.flow) {
    const a = res.memberOf.get(u), b = res.memberOf.get(v);
    if (a >= 0 && b >= 0 && a !== b) { link[a][b]++; link[b][a]++; }
  }
  const lanes = T ? [0] : [];
  for (let t = 1; t < T; t++) {
    const up = link[t][lanes[0]], down = link[t][lanes[lanes.length - 1]];
    if (up > down || (up === down && t % 2)) lanes.unshift(t);
    else lanes.push(t);
  }
  if (ids.some((id) => res.memberOf.get(id) === -1)) lanes.push(-1);

  const pos = new Map();
  const placed = new Map();  // id -> x, across lanes
  const bands = [];
  let top = 0;
  for (const lane of lanes) {
    const mine = ids.filter((id) => res.memberOf.get(id) === lane).map((id) => {
      const core = res.threadOf.get(id) === lane;
      const t = timeOf.get(id), c = t != null && colOf(t);
      const x = xOf(t);
      return { id, x, r: radiusOf(id), core, lo: c && !core ? c.x + c.w * 0.08 - x : 0, hi: c && !core ? c.x + c.w * 0.92 - x : 0 };
    });
    // Same-year papers along the thread spread across their year, in path order.
    if (lane >= 0) {
      const byId = new Map(mine.map((it) => [it.id, it]));
      const core = res.threads[lane].core.filter((id) => byId.get(id)?.core);
      const year = (id) => yearOnly(id) ? Math.floor(timeOf.get(id)) : null;
      for (let i = 0, j; i < core.length; i = j + 1) {
        for (j = i; j + 1 < core.length && year(core[i]) != null && year(core[j + 1]) === year(core[i]);) j++;
        const c = j > i && colOf(timeOf.get(core[i]));
        for (let k = i; c && k <= j; k++) byId.get(core[k]).x = c.x + c.w * (0.15 + (0.7 * (k - i)) / (j - i));
      }
    }
    mine.sort((a, b) => b.core - a.core || a.x - b.x);
    const rows = new Map();
    const fits = (row, it) => {
      for (const rr of [row - 1, row, row + 1]) {
        for (const o of rows.get(rr) || []) {
          if (Math.hypot(it.x - o.x, (rr - row) * ROW) < it.r + o.r + 6) return false;
        }
      }
      return true;
    };
    let lo = 0, hi = 0;
    for (const it of mine) {
      // Keep a paper right of what it cites and left of what cites it.
      let min = it.lo, max = it.hi;
      for (const u of res.inc.get(it.id)) if (placed.has(u)) min = Math.max(min, placed.get(u) + 4 - it.x);
      for (const w of res.out.get(it.id)) if (placed.has(w)) max = Math.min(max, placed.get(w) - 4 - it.x);
      if (min <= max) { it.lo = min; it.hi = max; }
      // Thread papers prefer the centre row; related papers keep off it.
      let row = 0;
      place: for (let i = it.core || lane === -1 ? 0 : 1; ; i++) {
        row = i % 2 ? -Math.ceil(i / 2) : i / 2;
        const base = Math.min(Math.max(0, it.lo), it.hi);
        for (let d = 0; d <= it.hi - it.lo; d += 8) {
          for (const dx of d ? [base + d, base - d] : [base]) {
            if (dx > it.hi || dx < it.lo) continue;
            if (fits(row, { ...it, x: it.x + dx })) { it.x += dx; break place; }
          }
        }
      }
      if (!rows.has(row)) rows.set(row, []);
      rows.get(row).push(it);
      it.row = row;
      placed.set(it.id, it.x);
      lo = Math.min(lo, row); hi = Math.max(hi, row);
    }
    const centre = top + PAD_TOP + -lo * ROW + 14;
    for (const it of mine) pos.set(it.id, { x: it.x, y: centre + it.row * ROW });
    const bottom = centre + hi * ROW + 14 + PAD_BOTTOM;
    bands.push({ thread: lane, y0: top, y1: bottom });
    top = bottom;
  }
  for (const p of pos.values()) p.y -= top / 2;
  for (const b of bands) { b.y0 -= top / 2; b.y1 -= top / 2; }
  return { pos, bands, axis: { cols, px, x0, x1, undatedX, hasUndated: ids.some((id) => timeOf.get(id) == null) } };
}

// Every paper reachable from `start` (itself included) along `adj`.
function closure(start, adj) {
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) for (const x of adj.get(stack.pop()) || []) if (!seen.has(x)) { seen.add(x); stack.push(x); }
  return seen;
}

// The papers that carried a thread forward, in thread order: the assistant's
// pick when it has one, else the endpoints, junctions and most-cited papers
// (at most five).
function keyPapers(core, picked, isJunction, citations) {
  const valid = new Set((picked || []).filter((id) => core.includes(id)));
  if (valid.size >= 2) return core.filter((id) => valid.has(id) || id === core[0] || id === core[core.length - 1]);
  const pick = new Set([core[0], core[core.length - 1]]);
  for (const id of core) if (pick.size < 5 && isJunction(id)) pick.add(id);
  for (const id of core.slice().sort((a, b) => citations(b) - citations(a))) {
    if (pick.size >= 5) break;
    pick.add(id);
  }
  return core.filter((id) => pick.has(id));
}

// ---------------------------------------------------------------- state

const LIN = {
  max: Number(store.get('noctua.threadCount')) || 5,
  sig: '',
  res: null,           // computeThreads result
  lay: null,           // layoutLineage result
  timeOf: new Map(),
  citesOf: new Map(),  // id -> papers it cites (in view)
  citedBy: new Map(),  // id -> papers citing it (in view)
  threadEdge: new Map(), // 'citing>cited' -> thread index
  anomaly: new Set(),    // 'citing>cited' keys that point forward in time
  focusThread: null,
  trace: null,         // { a, b, set }: papers on citation chains from a to b
  hl: null,            // cached highlight for the hovered/selected paper
  labels: [],          // lane label rectangles (screen space) for clicks
  reqKey: '',          // identifies the threads that LIN.ai describes
  ai: null,            // { common, threads: Map, steps: Map }
  explaining: false,
  auto: store.get('noctua.threadsAuto') !== '0',  // summarize threads without a click
  autoTimer: null,
  error: null,         // { key, message } of the last failed summary
  expanded: new Set(), // explicitly opened threads; new cards start collapsed
  openGaps: new Set(),  // expanded "papers in between", by thread and paper
};

const lineageOn = () => G.layout === 'lineage';
const threadColor = (t) => t == null || t < 0 ? colors.muted : PALETTE[t % PALETTE.length];
const paperShort = (id) => { const p = G.nodes.get(id)?.p; return p ? `${lastName(p)} ${p.year ?? ''}`.trim() : '?'; };

function threadName(t) {
  if (t == null || t < 0) return 'Other papers';
  const ai = LIN.ai?.threads.get('t' + (t + 1));
  if (ai?.name) return ai.name;
  const core = LIN.res?.threads[t]?.core || [];
  return core.length ? `${paperShort(core[0])} → ${paperShort(core[core.length - 1])}` : `Thread ${t + 1}`;
}

// Recomputes threads and targets when the papers, links or settings change.
function ensureLineage(ns) {
  const shape = Math.round((canvas.clientHeight / Math.max(1, canvas.clientWidth)) * 20);
  const sig = [ns.length, G.nodes.size, G.edges.length, G.centerId, G.project?.target, LIN.max, G.filter, Object.values(G.show).join(''), shape].join(':');
  if (sig === LIN.sig && LIN.res) return;
  LIN.sig = sig;
  const ids = ns.map((n) => n.id);
  const vis = new Set(ids);
  LIN.timeOf = new Map(ns.map((n) => [n.id, paperTime(n.p)]));
  LIN.citesOf = new Map(ids.map((id) => [id, []]));
  LIN.citedBy = new Map(ids.map((id) => [id, []]));
  for (const e of G.edges) {
    if (!vis.has(e.s) || !vis.has(e.t)) continue;
    LIN.citesOf.get(e.s).push(e.t);
    LIN.citedBy.get(e.t).push(e.s);
  }
  LIN.res = computeThreads(ids, LIN.timeOf, G.edges.map((e) => [e.s, e.t]), LIN.max);
  LIN.lay = layoutLineage(ids, LIN.res, (id) => radius(G.nodes.get(id)));
  stretchToCanvas(LIN.lay);
  for (const n of ns) {
    const p = LIN.lay.pos.get(n.id);
    n.tx = p.x; n.ty = p.y;
  }
  LIN.threadEdge = new Map();
  LIN.res.threads.forEach((t, i) => { for (const [u, v] of t.steps) LIN.threadEdge.set(v + '>' + u, i); });
  LIN.anomaly = new Set(LIN.res.anomalies.map(([u, v]) => v + '>' + u));
  LIN.hl = null;
  if (LIN.focusThread != null && LIN.focusThread >= LIN.res.threads.length) LIN.focusThread = null;
  if (LIN.trace && !(vis.has(LIN.trace.a) && vis.has(LIN.trace.b))) LIN.trace = null;
  const key = JSON.stringify(LIN.res.threads.map((t) => t.core));
  if (key !== LIN.reqKey) {
    LIN.reqKey = key;
    LIN.ai = null;
    clearTimeout(LIN.autoTimer);
    if (LIN.res.threads.length && !G.filter) requestThreads({ cacheOnly: true });
  }
  renderThreads();
  kick(0.8);
}

// A timeline is much wider than tall, so fitting it leaves the canvas mostly
// empty above and below. Spread the lanes (up to 3x) to match the canvas shape.
function stretchToCanvas(lay) {
  const ps = [...lay.pos.values()];
  if (!ps.length || !lay.bands.length) return;
  const xs = ps.map((p) => p.x);
  const width = Math.max(...xs) - Math.min(...xs) + 160;
  const height = lay.bands[lay.bands.length - 1].y1 - lay.bands[0].y0;
  const room = (canvas.clientHeight - 110) / Math.max(1, canvas.clientWidth);
  const k = Math.max(1, Math.min(3, (width * room) / Math.max(1, height)));
  if (k === 1) return;
  for (const p of ps) p.y *= k;
  for (const b of lay.bands) { b.y0 *= k; b.y1 *= k; }
}

function threadKeyPapers(t, i) {
  const picked = LIN.ai?.threads.get('t' + (i + 1))?.key;
  return keyPapers(t.core, picked, (id) => LIN.res.junctions.has(id), (id) => G.nodes.get(id)?.p.citationCount || 0);
}

// Thread papers split as in the Threads panel: key papers, and the papers
// folded into "N papers in between". Recomputed when threads or labels change.
function keySets() {
  const tag = LIN.reqKey + (LIN.ai ? ':ai' : '');
  if (LIN.keys?.tag === tag) return LIN.keys;
  const key = new Set(), between = new Set();
  LIN.res.threads.forEach((t, i) => {
    const k = threadKeyPapers(t, i);
    for (const id of k) key.add(id);
    for (const id of t.core) if (LIN.res.threadOf.get(id) === i && !k.includes(id)) between.add(id);
  });
  for (const id of key) between.delete(id);  // a junction that is key on any thread stays key
  return (LIN.keys = { tag, key, between });
}

function stepLineage(ns) {
  ensureLineage(ns);
  for (const n of ns) {
    if (n.tx == null) continue;
    n.x += (n.tx - n.x) * 0.22;
    n.y += (n.ty - n.y) * 0.22;
    n.vx = 0; n.vy = 0;
  }
}

// What to emphasise: a traced path, else the focused paper's lineage
// (blue = what it builds on, orange = what builds on it), else a thread.
// edge(citing, cited) returns [colour, strong] for emphasised citations.
function lineageHighlight(focus) {
  if (LIN.trace) {
    const { set, links } = LIN.trace;
    return { nodes: set, edge: (s, t) => set.has(s) && set.has(t) ? [colors.accent, links.has(s + '>' + t)] : null, dim: 0.15 };
  }
  if (focus) {
    if (LIN.hl?.id !== focus) {
      const up = closure(focus, LIN.citesOf), down = closure(focus, LIN.citedBy);
      LIN.hl = { id: focus, up, down, nodes: new Set([...up, ...down]) };
    }
    const { up, down, nodes } = LIN.hl;
    const direct = (s, t) => s === focus || t === focus;
    return { nodes, edge: (s, t) => up.has(s) && up.has(t) ? [colors.ref, direct(s, t)] : down.has(s) && down.has(t) ? [colors.cite, direct(s, t)] : null, dim: 0.2 };
  }
  if (LIN.focusThread != null) {
    const ft = LIN.focusThread;
    const nodes = new Set([...LIN.res.memberOf].filter(([, t]) => t === ft).map(([id]) => id));
    for (const [u, v] of LIN.res.threads[ft].steps) { nodes.add(u); nodes.add(v); }
    return { nodes, edge: () => null, dim: 0.15 };
  }
  return null;
}

// ---------------------------------------------------------------- drawing

function curve(s, t) {
  const dx = Math.max(24, Math.abs(s.x - t.x) / 2);
  ctx.moveTo(t.x, t.y);
  ctx.bezierCurveTo(t.x + dx, t.y, s.x - dx, s.y, s.x, s.y);
}

// Arrowhead at the citing paper's left side (flow arrives from the left).
function arrowIn(s) {
  const r = radius(s) + 2 / view.k, a = 7 / view.k;
  ctx.beginPath();
  ctx.moveTo(s.x - r, s.y);
  ctx.lineTo(s.x - r - a, s.y - a * 0.45);
  ctx.lineTo(s.x - r - a, s.y + a * 0.45);
  ctx.closePath();
  ctx.fill();
}

function lineageAxisY() {
  const controls = $('#stage .controls');
  return (controls ? controls.getBoundingClientRect().bottom - canvas.getBoundingClientRect().top : 40) + 16;
}

function fitLineage(ns, maxK) {
  const visible = visibleNodes();
  ensureLineage(visible); // Refresh targets after filtering or resizing before fitting.
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (w <= 0 || h <= 0) return;
  const { bands, axis } = LIN.lay;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  let labelWidth = 0;
  ctx.save();
  ctx.font = `${11 * colors.fontScale}px ${colors.font}`;
  for (const n of ns) {
    const r = radius(n);
    x0 = Math.min(x0, n.tx - r); x1 = Math.max(x1, n.tx + r);
    y0 = Math.min(y0, n.ty - r); y1 = Math.max(y1, n.ty + r);
    labelWidth = Math.max(labelWidth, ctx.measureText(`${lastName(n.p)} ${n.p.year ?? ''}`).width);
  }
  ctx.restore();
  for (const b of bands) {
    if (!ns.some(n => n.ty >= b.y0 && n.ty <= b.y1)) continue;
    y0 = Math.min(y0, b.y0); y1 = Math.max(y1, b.y1);
  }
  if (ns.length === visible.length) {
    x0 = Math.min(x0, axis.hasUndated ? axis.undatedX : axis.x0);
    x1 = Math.max(x1, axis.x1);
  }
  // The axis, wrapped controls, labels, and legend occupy screen pixels.
  const side = Math.min(w / 4, Math.max(24, labelWidth / 2 + 8));
  const top = lineageAxisY() + 32;
  const legend = $('#stage .legend');
  const bottom = (legend ? legend.offsetTop : h) - 24;
  if (bottom <= top) return;
  view.k = Math.min(maxK, (w - 2 * side) / Math.max(1, x1 - x0), (bottom - top) / Math.max(1, y1 - y0));
  view.x = -((x0 + x1) / 2) * view.k;
  view.y = (top + bottom - h) / 2 - ((y0 + y1) / 2) * view.k;
  draw();
}

function drawLineage(w, h, ns, vis) {
  ensureLineage(ns);
  const { bands, axis } = LIN.lay;
  const res = LIN.res;
  const focus = [G.hover, G.selected].find(id => vis.has(id));
  const hl = lineageHighlight(focus);
  const sx = (x) => w / 2 + view.x + x * view.k;
  const sy = (y) => h / 2 + view.y + y * view.k;
  const fade = (on) => hl && !on ? hl.dim : 1;
  // The year axis sits just below the graph controls, which may wrap.
  const axisY = lineageAxisY();

  // Year gridlines (screen space).
  ctx.strokeStyle = colors.edge;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const c of axis.cols) {
    if (c.empty || c.w <= 0) continue;
    const x = Math.round(sx(c.x)) + 0.5;
    if (x < 0 || x > w) continue;
    ctx.moveTo(x, axisY + 6); ctx.lineTo(x, h);
  }
  ctx.stroke();

  ctx.save();
  ctx.translate(w / 2 + view.x, h / 2 + view.y);
  ctx.scale(view.k, view.k);

  // Lane bands.
  const left = (-w / 2 - view.x) / view.k, width = w / view.k;
  for (const b of bands) {
    ctx.globalAlpha = (b.thread === LIN.focusThread ? 0.14 : 0.06) * (LIN.focusThread != null && b.thread !== LIN.focusThread ? 0.4 : 1);
    ctx.fillStyle = threadColor(b.thread);
    ctx.fillRect(left, b.y0 + 2, width, b.y1 - b.y0 - 4);
  }
  ctx.globalAlpha = 1;

  // Background citations, then dashed ones that point forward in time.
  const hot = [], threadEdges = [], dashed = [];
  ctx.strokeStyle = colors.edge;
  ctx.lineWidth = 1 / view.k;
  ctx.globalAlpha = hl ? 0.5 : 1;
  ctx.beginPath();
  for (const e of G.edges) {
    if (!vis.has(e.s) || !vis.has(e.t)) continue;
    const k = e.s + '>' + e.t;
    const c = hl?.edge(e.s, e.t);
    if (c) { hot.push([e, c]); continue; }
    if (LIN.threadEdge.has(k)) { threadEdges.push(e); continue; }
    if (LIN.anomaly.has(k)) { dashed.push(e); continue; }
    curve(G.nodes.get(e.s), G.nodes.get(e.t));
  }
  ctx.stroke();
  if (dashed.length) {
    ctx.setLineDash([4 / view.k, 4 / view.k]);
    ctx.beginPath();
    for (const e of dashed) curve(G.nodes.get(e.s), G.nodes.get(e.t));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // The threads themselves.
  ctx.lineCap = 'round';
  for (const e of threadEdges) {
    const t = LIN.threadEdge.get(e.s + '>' + e.t);
    ctx.globalAlpha = hl && !(hl.nodes.has(e.s) && hl.nodes.has(e.t)) ? hl.dim : 0.75;
    ctx.strokeStyle = threadColor(t);
    ctx.lineWidth = 3.5 / view.k;
    ctx.beginPath();
    curve(G.nodes.get(e.s), G.nodes.get(e.t));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // Indirect links first and faint, so direct ones (or the traced chain) read on top.
  hot.sort((a, b) => a[1][1] - b[1][1]);
  for (const [e, [c, strong]] of hot) {
    const s = G.nodes.get(e.s);
    ctx.strokeStyle = c;
    ctx.fillStyle = c;
    ctx.globalAlpha = strong ? 1 : 0.3;
    ctx.lineWidth = (strong ? 2.4 : 1.2) * (LIN.threadEdge.has(e.s + '>' + e.t) ? 1.4 : 1) / view.k;
    ctx.beginPath();
    curve(s, G.nodes.get(e.t));
    ctx.stroke();
    if (strong) arrowIn(s);
  }
  ctx.globalAlpha = 1;
  ctx.lineCap = 'butt';

  // Papers: filled = on a thread, ring = related to it.
  const order = hl ? ns.slice().sort((a, b) => hl.nodes.has(a.id) - hl.nodes.has(b.id)) : ns;
  // Key papers get a bold ring; papers between them are smaller and fainter.
  const { key, between } = keySets();
  for (const n of order) {
    const t = res.memberOf.get(n.id);
    const minor = between.has(n.id);
    ctx.globalAlpha = fade(hl?.nodes.has(n.id)) * (minor ? 0.5 : 1);
    drawNode(n, res.threadOf.get(n.id) === t || res.junctions.has(n.id) ? threadColor(t) : null, threadColor(t), minor ? 0.65 : 1);
    if (key.has(n.id)) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, radius(n) + 3.5 / view.k, 0, Math.PI * 2);
      ctx.lineWidth = 2.5 / view.k;
      ctx.strokeStyle = threadColor(t);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  ctx.font = `${11 * colors.fontScale / view.k}px ${colors.font}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  // Labels in priority order (focus, center, highlighted, thread papers, then
  // by size), skipping any that would overlap one already drawn.
  // Key papers always keep their label; in-between ones only when highlighted.
  const rank = (n) => n.id === focus ? 5 : n.id === G.centerId ? 4 : key.has(n.id) ? 3 : hl?.nodes.has(n.id) ? 2 : res.threadOf.has(n.id) ? 1 : 0;
  const placed = [];
  const lh = (13 * colors.fontScale) / view.k;
  for (const n of ns.slice().sort((a, b) => rank(b) - rank(a) || radius(b) - radius(a))) {
    const r = radius(n);
    const core = res.threadOf.has(n.id);
    // Overlaps are skipped below, so thread papers can be labelled at any zoom.
    const show = n.id === focus || n.id === G.centerId || key.has(n.id) || (hl ? hl.nodes.has(n.id) : core ? !between.has(n.id) : r * view.k > 6);
    if (!show) continue;
    const w = ctx.measureText(`${lastName(n.p)} ${n.p.year ?? ''}`).width + 4 / view.k;
    // Below the paper, else (for key papers) above it; the focus and center always show.
    const below = { x0: n.x - w / 2, x1: n.x + w / 2, y0: n.y + r + 2 / view.k, y1: n.y + r + 2 / view.k + lh };
    const above = { ...below, y0: n.y - r - 2 / view.k - lh, y1: n.y - r - 2 / view.k };
    const free = (box) => !placed.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0);
    const up = rank(n) < 4 && !free(below);
    if (up && (rank(n) < 3 || !free(above))) continue;
    placed.push(up ? above : below);
    drawLabel(n, up);
  }
  ctx.restore();

  // Year labels along the top; squeezed empty years get an ellipsis.
  ctx.font = `${11 * colors.fontScale}px ${colors.font}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineWidth = 3;
  ctx.strokeStyle = colors.bg;
  ctx.fillStyle = colors.muted;
  const every = [1, 2, 5, 10, 20, 50].find((s) => s * axis.px * view.k >= 42) || 100;
  let lastRight = -Infinity;  // skip a year label that would run into the previous one
  const label = (text, x) => {
    const half = ctx.measureText(text).width / 2;
    if (x < -20 || x > w + 20 || x - half < lastRight + 6) return;
    lastRight = x + half;
    ctx.strokeText(text, x, axisY);
    ctx.fillText(text, x, axisY);
  };
  for (let i = 0; i < axis.cols.length; i++) {
    const c = axis.cols[i];
    if (!c.empty) { if (c.year % every === 0 || every === 1) label(String(c.year), sx(c.x + c.w / 2)); continue; }
    if (axis.cols[i - 1]?.empty) continue;
    let j = i;
    while (axis.cols[j + 1]?.empty) j++;
    const end = axis.cols[j];
    if ((end.x + end.w - c.x) * view.k > 14) label('⋯', sx((c.x + end.x + end.w) / 2));
  }
  if (axis.hasUndated) label('n.d.', sx(axis.undatedX));

  // Lane labels pinned to the left edge; clicking one focuses its thread.
  LIN.labels = [];
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = `600 ${12 * colors.fontScale}px ${colors.font}`;
  for (const b of bands) {
    const y0 = sy(b.y0), y1 = sy(b.y1);
    if (y1 < axisY + 16 || y0 > h - 40) continue;
    const y = Math.min(Math.max(y0 + 14, axisY + 24), y1 - 12);
    const full = threadName(b.thread);
    const text = fitText(full, Math.max(160, Math.min(w - 60, 560)));
    const rect = { x: 10, y: y - 11, w: ctx.measureText(text).width + 30, h: 22, thread: b.thread, full, cut: text !== full };
    ctx.globalAlpha = LIN.focusThread != null && LIN.focusThread !== b.thread ? 0.5 : 0.92;
    ctx.fillStyle = colors.panel;
    ctx.strokeStyle = threadColor(b.thread);
    ctx.lineWidth = b.thread === LIN.focusThread ? 2 : 1;
    pill(rect);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = threadColor(b.thread);
    ctx.beginPath();
    ctx.arc(rect.x + 11, y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = colors.ink;
    ctx.fillText(text, rect.x + 20, y);
    ctx.globalAlpha = 1;
    if (b.thread >= 0) LIN.labels.push(rect);
  }
}

// `text` shortened with an ellipsis to fit `max` pixels in the current font.
function fitText(text, max) {
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(text.slice(0, mid).trimEnd() + '…').width <= max) lo = mid; else hi = mid - 1;
  }
  return text.slice(0, lo).trimEnd() + '…';
}

function pill({ x, y, w, h }) {
  const r = h / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(x + r, y + h);
  ctx.arc(x + r, y + r, r, Math.PI / 2, Math.PI * 1.5);
  ctx.closePath();
}

// ---------------------------------------------------------------- interaction

const lineageLabelAt = (x, y) => LIN.labels.find((l) => x >= l.x && x <= l.x + l.w && y >= l.y && y <= l.y + l.h);

// Clicks on lane labels; returns true when handled.
function lineagePointerDown(e) {
  const r = lineageLabelAt(e.offsetX, e.offsetY);
  if (!r) return false;
  focusThread(r.thread === LIN.focusThread ? null : r.thread);
  return true;
}

function focusThread(t) {
  LIN.focusThread = t;
  LIN.trace = null;
  if (t != null) {
    const core = new Set(LIN.res.threads[t].core);
    const ns = visibleNodes().filter((n) => LIN.res.memberOf.get(n.id) === t || core.has(n.id));
    if (ns.length) fit(ns, 1.4);
    showTab('threads');
    document.querySelector(`#thread-list .thread-card[data-thread="${t}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  renderThreads();
  draw();
}

// Papers on citation chains from `older` to `newer`, or null if none.
function pathSet(older, newer) {
  const down = closure(older, LIN.citedBy);
  if (!down.has(newer)) return null;
  const up = closure(newer, LIN.citesOf);
  return new Set([...down].filter((id) => up.has(id)));
}

// The chain from `older` to `newer` through `set` with the most search-path
// weight: the main line of influence between two papers.
function strongestChain(older, newer, set, res) {
  const best = new Map([[older, { score: 0, prev: null }]]);
  for (const u of res.order) {
    const bu = best.get(u);
    if (!bu || !set.has(u)) continue;
    for (const v of res.out.get(u)) {
      if (!set.has(v)) continue;
      const score = bu.score + (res.weight.get(u + '>' + v) || 0) + 1e-6;
      if (!best.has(v) || score > best.get(v).score) best.set(v, { score, prev: u });
    }
  }
  if (!best.has(newer)) return [older, newer];
  const chain = [];
  for (let x = newer; x != null; x = best.get(x).prev) chain.unshift(x);
  return chain;
}

function traceLineage(a, b) {
  let set = pathSet(a, b);
  if (!set && (set = pathSet(b, a))) [a, b] = [b, a];
  if (!set) {
    toast(`No chain of citations links ${paperShort(a)} and ${paperShort(b)} in this graph.`);
    return;
  }
  const chain = strongestChain(a, b, set, LIN.res);
  LIN.trace = { a, b, set, chain, links: new Set(chain.slice(1).map((id, i) => id + '>' + chain[i])) };
  LIN.focusThread = null;
  showTab('threads');
  renderThreads();
  draw();
}

function clearLineageFocus() {
  if (!LIN.trace && LIN.focusThread == null) return;
  LIN.trace = null;
  LIN.focusThread = null;
  renderThreads();
  draw();
}

function lineageTip(n) {
  if (!lineageOn() || !LIN.res) return '';
  const t = LIN.res.memberOf.get(n.id);
  const lines = [`<i class="swatch" style="background:${threadColor(t)}"></i> ${esc(threadName(t))}${LIN.res.threadOf.get(n.id) === t ? '' : ' <span class="muted">(related)</span>'}`];
  for (const s of LIN.ai?.steps.values() || []) {
    if (s.to === n.id) lines.push(`<span class="rel rel-${esc(s.relation.replace(/\s+/g, '-'))}">${esc(s.relation)}</span> ${esc(paperShort(s.from))}: ${esc(s.note)}`);
  }
  return `<div class="tip-lineage">${lines.join('<br>')}</div>`;
}

// ---------------------------------------------------------------- panels

const relChip = (s) => `<span class="rel rel-${esc(s.relation.replace(/\s+/g, '-'))}">${esc(s.relation)}</span>`;

function stepRow(id, cls = '', after = '') {
  const p = G.nodes.get(id)?.p;
  if (!p) return '';
  return `<li data-lin-id="${esc(id)}" class="${cls}"><span class="t">${esc(p.title)}</span><span class="p-year">${esc(paperShort(id))}</span>${after}</li>`;
}

const TITLE_STOP = new Set(('a an and are as at by for from in into is it its of on or the to via with without using use toward towards '
  + 'through over under our we new based learning learned model models approach method methods network networks deep neural study '
  + 'analysis framework multi large scale improved improving efficient generalizable open set').split(' '));

// Stand-in title until the assistant names a thread: the words its papers'
// titles share most.
function keywordTitle(core) {
  const count = new Map();
  for (const id of core) {
    const words = new Set((G.nodes.get(id)?.p.title || '').toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || []);
    for (const w of words) if (!TITLE_STOP.has(w)) count.set(w, (count.get(w) || 0) + 1);
  }
  const top = [...count].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, 3).map(([w]) => w);
  return top.length ? top.join(' · ').replace(/^./, (c) => c.toUpperCase()) : null;
}

const endpoints = (core) => `${paperShort(core[0])} → ${paperShort(core[core.length - 1])}`;
// Identifies a thread across re-renders and recomputes.
const threadKey = (t) => t.core[0] + '>' + t.core[t.core.length - 1];

function renderThreads() {
  const el = $('#thread-list');
  if (!el) return;
  const res = LIN.res;
  const summarize = $('#explain-threads');
  summarize.disabled = LIN.explaining || !res?.threads.length;
  summarize.textContent = LIN.explaining ? 'Summarizing…' : 'Summarize threads';
  if (!G.nodes.size || !res) {
    el.innerHTML = '<p class="hint">Open a graph, then switch to Lineage to see how its papers build on each other over time.</p>';
    return;
  }
  const year = (id) => G.nodes.get(id)?.p.year;
  let html = '';
  if (LIN.ai?.common) html += `<p class="threads-common">${esc(LIN.ai.common)}</p>`;
  if (!LIN.ai && LIN.error?.key === LIN.reqKey) {
    html += `<p class="warn">Couldn’t summarize the threads: ${esc(LIN.error.message)} <button class="link-btn" data-explain>Retry</button></p>`;
  }

  if (LIN.trace) {
    const { chain, set } = LIN.trace;
    const rest = [...set].filter((id) => !chain.includes(id)).sort((a, b) => (LIN.timeOf.get(a) ?? 0) - (LIN.timeOf.get(b) ?? 0));
    const steps = chain.map((id, j) => {
      const s = j && LIN.ai?.steps.get(chain[j - 1] + '>' + id);
      return (s ? `<li class="step-link"><div class="step-note">${relChip(s)}${esc(s.note)}</div></li>` : '') + stepRow(id);
    });
    html += `<div class="thread-card trace" style="--c:${colors.accent}">
      <div class="thread-head"><b>Path ${esc(paperShort(LIN.trace.a))} → ${esc(paperShort(LIN.trace.b))}</b>
        <button id="trace-clear" class="icon" title="Clear path">×</button></div>
      <p class="hint">Main chain of ${chain.length} papers${rest.length ? `; ${rest.length} more lie on other chains between them` : ''}.</p>
      <ol class="thread-steps">${steps.join('')}</ol>
      ${rest.length ? `<details><summary class="hint">Other papers in between</summary><ol class="thread-steps">${rest.map((id) => stepRow(id)).join('')}</ol></details>` : ''}</div>`;
  }

  if (!res.threads.length) {
    html += `<p class="hint">No citation chains of three or more papers in view yet. Load more papers (Top 100 or 200),
      expand a few, or open a project graph.</p>`;
  }
  res.threads.forEach((t, i) => {
    const ai = LIN.ai?.threads.get('t' + (i + 1));
    const tk = threadKey(t);
    const pending = LIN.explaining && !ai;
    const members = [...res.memberOf.values()].filter((x) => x === i).length - t.core.filter((id) => res.threadOf.get(id) === i).length;
    const span = [year(t.core[0]), year(t.core[t.core.length - 1])].filter(Boolean);
    const key = threadKeyPapers(t, i);
    const rows = [];
    key.forEach((id, j) => {
      if (j) {
        // How this key paper builds on the previous one, and what lies between.
        const prev = key[j - 1];
        const between = t.core.slice(t.core.indexOf(prev) + 1, t.core.indexOf(id));
        const s = LIN.ai?.steps.get(prev + '>' + id);
        const gap = tk + ':' + prev;
        const open = LIN.openGaps.has(gap);
        rows.push(`<li class="step-link"><div class="step-note"><span class="up">↑</span>${s ? relChip(s) + esc(s.note)
          : `<span class="muted">${pending ? 'summarizing…' : 'cites and builds on'}</span>`}</div>
          ${between.length ? `<button class="gap-btn" data-gap="${esc(gap)}" aria-expanded="${open}">${between.length} paper${between.length === 1 ? '' : 's'} in between ${open ? '▾' : '▸'}</button>
            ${open ? `<ol class="gap-list">${between.map((b) => stepRow(b)).join('')}</ol>` : ''}` : ''}</li>`);
      }
      const other = res.threadOf.get(id);
      rows.push(other === i ? stepRow(id)
        : stepRow(id, 'junction', `<span class="from" style="--c:${threadColor(other)}" title="Also on this thread">${esc(threadName(other))}</span>`));
    });
    const title = ai?.name ? `<b>${esc(ai.name)}</b>`
      : `<b class="guess" title="Keywords from the paper titles, until the thread is summarized">${esc(keywordTitle(t.core) || endpoints(t.core))}</b>`;
    html += `<div class="thread-card${LIN.expanded.has(tk) ? '' : ' collapsed'}${LIN.focusThread === i ? ' focused' : ''}${LIN.focusThread != null && LIN.focusThread !== i ? ' dim' : ''}" data-thread="${i}" style="--c:${threadColor(i)}">
      <div class="thread-head" data-toggle="${esc(tk)}" title="Show or hide the papers" role="button" aria-expanded="${LIN.expanded.has(tk)}">
        <span class="chev" aria-hidden="true">▾</span>
        <div class="thread-title">${title}${pending ? '<span class="summarizing">Summarizing…</span>' : ''}
          <span class="thread-sub">${esc(endpoints(t.core))} · ${span.length ? [...new Set(span)].join('–') + ' · ' : ''}${t.core.length} papers${key.length < t.core.length ? `, ${key.length} key` : ''}</span></div>
        <button class="focus-btn" data-focus title="Focus this thread in the graph">◎</button></div>
      ${ai?.problem ? `<div class="thread-problem"><span>Problem</span>${esc(ai.problem)}</div>` : ''}
      ${ai?.summary ? `<div class="thread-summary">${esc(ai.summary)}</div>` : ''}
      <div class="thread-body">
        <ol class="thread-steps">${rows.join('')}</ol>
        ${!LIN.ai && !pending && !LIN.auto ? '<button class="link-btn" data-explain>Summarize what each paper contributes</button>' : ''}
        ${members > 0 ? `<div class="hint">+ ${members} related paper${members === 1 ? '' : 's'} in this lane</div>` : ''}
      </div>
    </div>`;
  });
  el.innerHTML = html;
}

function lineageDetailsHTML(n) {
  if (!lineageOn() || !n || !LIN.res?.memberOf.has(n.id)) return '';
  const t = LIN.res.memberOf.get(n.id);
  const time = (id) => LIN.timeOf.get(id) ?? 0;
  const row = (id, s) => `<li data-lin-id="${esc(id)}"><span class="t">${esc(G.nodes.get(id).p.title)}</span><span class="p-year">${esc(paperShort(id))}</span>
    ${s ? `<div class="step-note">${relChip(s)}${esc(s.note)}</div>` : ''}</li>`;
  const builds = (LIN.citesOf.get(n.id) || []).slice().sort((a, b) => time(b) - time(a));
  const by = (LIN.citedBy.get(n.id) || []).slice().sort((a, b) => time(a) - time(b));
  const list = (ids, step) => `<ul>${ids.slice(0, 8).map((id) => row(id, step(id))).join('')}</ul>${ids.length > 8 ? `<div class="hint">+ ${ids.length - 8} more</div>` : ''}`;
  return `<div class="section-label">Lineage</div>
    <div class="lineage-info">
      <div class="lin-thread"><i class="swatch" style="background:${threadColor(t)}"></i>${esc(threadName(t))}
        <span class="muted">${LIN.res.threadOf.get(n.id) === t ? 'on this thread' : t < 0 ? '' : 'related to this thread'}</span></div>
      ${builds.length ? `<div class="sub">Builds on (${builds.length})</div>${list(builds, (id) => LIN.ai?.steps.get(id + '>' + n.id))}` : ''}
      ${by.length ? `<div class="sub">Built upon by (${by.length})</div>${list(by, (id) => LIN.ai?.steps.get(n.id + '>' + id))}` : ''}
      ${!builds.length && !by.length ? '<p class="hint">No citation links to other papers in view.</p>' : ''}
    </div>`;
}

// Names the threads for the assistant's chat context; sig changes with them.
function lineageContext() {
  if (!lineageOn() || !LIN.res?.threads.length) return { sig: '', lines: [] };
  const lines = ['Lineage view is open (papers by publication year; threads = main citation paths). Threads, oldest paper first:'];
  LIN.res.threads.forEach((t, i) => {
    const ai = LIN.ai?.threads.get('t' + (i + 1));
    lines.push(`Thread ${i + 1} "${threadName(i)}"${ai?.problem ? ` (problem: ${ai.problem})` : ''}: ${t.core.map((id) => `${paperShort(id)} [${id}]`).join(' > ')}`);
  });
  return { sig: ':lin' + LIN.reqKey + (LIN.ai ? ':ai' : ''), lines };
}

// ---------------------------------------------------------------- AI labels

function threadsRequest() {
  const core = new Set();
  const paper = (id) => {
    core.add(id);
    const p = G.nodes.get(id).p;
    return { id, title: p.title || '', year: p.year ?? null, authors: (p.authors || []).slice(0, 3).map((a) => a.name), abstract: p.abstract || p.tldr?.text || '' };
  };
  const threads = LIN.res.threads.map((t, i) => ({ id: 't' + (i + 1), papers: t.core.map(paper), steps: t.steps }));
  const others = visibleNodes().filter((n) => !core.has(n.id))
    .sort((a, b) => (b.p.citationCount || 0) - (a.p.citationCount || 0)).slice(0, 40).map((n) => n.p.title || '');
  return { threads, others };
}

// Summarizes the threads once the graph settles: after the cache lookup
// misses and no other requests (links, similar papers) are still loading.
function scheduleSummary() {
  clearTimeout(LIN.autoTimer);
  if (G.filter || !LIN.auto || LIN.ai || !LIN.res?.threads.length || !lineageOn() || LIN.error?.key === LIN.reqKey) return;
  const key = LIN.reqKey;
  LIN.autoTimer = setTimeout(() => {
    if (key !== LIN.reqKey || LIN.ai) return;
    if (inflight > 0 || LIN.explaining) return scheduleSummary();
    requestThreads({ auto: true });
  }, 2500);
}

async function requestThreads({ force = false, cacheOnly = false, auto = false } = {}) {
  if (!LIN.res?.threads.length) return;
  const key = LIN.reqKey;
  if (!cacheOnly) {
    LIN.explaining = true;
    LIN.error = null;
    renderThreads();
    if (!auto) toast(`Asking the research assistant to summarize ${LIN.res.threads.length} thread${LIN.res.threads.length === 1 ? '' : 's'}…`);
  }
  let found = false;
  try {
    const r = await api('/api/threads', { ...threadsRequest(), force, cache_only: cacheOnly });
    if (key !== LIN.reqKey || !r.threads?.length) return;
    found = true;
    LIN.ai = {
      common: r.common,
      threads: new Map(r.threads.map((t) => [t.id, t])),
      steps: new Map(r.threads.flatMap((t) => t.steps.map((s) => [s.from + '>' + s.to, s]))),
    };
    if (!cacheOnly && !auto) hideToast({ keepError: true });
  } catch (e) {
    if (cacheOnly) return;
    LIN.error = { key, message: e.message };
    if (!auto) toast('Could not summarize the threads: ' + e.message, { error: true });
  } finally {
    if (!cacheOnly) LIN.explaining = false;
    if (key === LIN.reqKey) {
      if (cacheOnly && !found) scheduleSummary();
      renderThreads(); renderDetails(); draw();
    }
  }
}

// ---------------------------------------------------------------- wiring

function setLayout(mode, { user = false } = {}) {
  const previous = G.layout;
  G.layout = ['library', 'network', 'lineage'].includes(mode) ? mode : 'library';
  document.body.classList.toggle('library-view', G.layout === 'library');
  store.set('noctua.layout', G.layout);
  document.body.classList.toggle('lineage', lineageOn());
  setGraphSidebarList();
  document.querySelectorAll('#layout button').forEach((b) => {
    b.classList.toggle('active', b.dataset.layout === G.layout);
    b.setAttribute('aria-pressed', String(b.dataset.layout === G.layout));
  });
  if (G.layout === 'library') renderLibItems();
  if (lineageOn()) {
    LIN.sig = '';
    scheduleSummary();
  } else {
    LIN.trace = null;
    LIN.focusThread = null;
  }
  G.autoFit = true;
  renderDetails();
  kick(1);
  if (user && G.layout !== 'library' && (!G.nodes.size || (previous === 'library' && G.project?.target !== lib.target))) openProject(lib.target);
}

document.querySelectorAll('#layout button').forEach((b) => b.addEventListener('click', () => setLayout(b.dataset.layout, { user: true })));
$('#thread-count').value = String(LIN.max);
$('#thread-count').addEventListener('change', (e) => {
  LIN.max = Number(e.target.value) || 5;
  store.set('noctua.threadCount', String(LIN.max));
  LIN.focusThread = null;
  G.autoFit = true;
  kick(1);
});
$('#explain-threads').addEventListener('click', () => requestThreads({ force: !!LIN.ai }));

const toggle = (set, k) => { if (!set.delete(k)) set.add(k); };

$('#tab-threads').addEventListener('click', (e) => {
  if (e.target.closest('[data-explain]')) return requestThreads();
  if (e.target.closest('#trace-clear')) return clearLineageFocus();
  const gap = e.target.closest('[data-gap]');
  if (gap) { toggle(LIN.openGaps, gap.dataset.gap); return renderThreads(); }
  const li = e.target.closest('[data-lin-id]');
  if (li) { select(li.dataset.linId); focusNode(li.dataset.linId); return; }
  const focus = e.target.closest('[data-focus]')?.closest('.thread-card[data-thread]');
  if (focus) return focusThread(Number(focus.dataset.thread) === LIN.focusThread ? null : Number(focus.dataset.thread));
  const head = e.target.closest('[data-toggle]');
  if (head) { toggle(LIN.expanded, head.dataset.toggle); return renderThreads(); }
});
function setThreadsAuto(enabled) {
  LIN.auto = !!enabled;
  store.set('noctua.threadsAuto', LIN.auto ? '1' : '0');
  if (LIN.auto) scheduleSummary(); else clearTimeout(LIN.autoTimer);
  renderThreads();
}
$('#details').addEventListener('click', (e) => {
  const li = e.target.closest('[data-lin-id]');
  if (li) { select(li.dataset.linId); focusNode(li.dataset.linId); }
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !lineageOn() || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  clearLineageFocus();
});

setLayout(store.get('noctua.layout') || 'library');
