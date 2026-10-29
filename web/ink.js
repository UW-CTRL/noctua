'use strict';
// Handwriting pads for notes. Strokes are stored as vectors in pad units, so
// files stay small. A pad is `w` units wide (1000 for older pads) and `h`
// thousand units tall, and draws at a fixed scale: a wider pad gives more room
// rather than bigger strokes, and pads grow as you write near their edges. Pen pressure sets the line width; the Wacom eraser end (or the
// eraser tool) removes whole strokes; touch input is ignored (palm rejection).

const Ink = (() => {
  const UNIT = 1000;
  const PX_PER_UNIT = 0.632;           // 1000 units fill the classic 632 px text column
  const GUTTER = 64;                   // room beside wide pads for the block tools
  const MAX_W = 6000, MAX_H = 8;       // units wide; thousands of units tall
  const EDGE = 80, GROW_W = 400, GROW_H = 300;  // units
  const COLORS = ['#e8e6e1', '#8b85ff', '#f7768e', '#9ece6a', '#e0af68'];
  const WIDTHS = [1.4, 2.4, 4.5];
  // Shared by every pad, like picking up a pen; the last pen is remembered.
  const saved = (() => { try { return JSON.parse(store.get('noctua.inkTool') || 'null'); } catch { return null; } })();
  const tool = {
    color: COLORS.includes(saved?.color) ? saved.color : COLORS[0],
    width: WIDTHS.includes(saved?.width) ? saved.width : WIDTHS[2],
    eraser: false,
  };
  const saveTool = () => { try { store.set('noctua.inkTool', JSON.stringify({ color: tool.color, width: tool.width })); } catch {} };
  const pads = new Set();

  const segWidth = (s, p, scale) => Math.max(0.6, s.w * scale * (0.35 + 0.9 * p));

  // Light pages show the dark-page palette inverted with hues kept, matching
  // CSS `invert(1) hue-rotate(180deg)` without filtering the canvas itself.
  const lightCache = new Map();
  function lightColor(hex) {
    if (!lightCache.has(hex)) {
      const [r, g, b] = [1, 3, 5].map((i) => 1 - parseInt(hex.slice(i, i + 2), 16) / 255);
      const ch = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
      lightCache.set(hex, '#' + ch(-0.574 * r + 1.43 * g + 0.144 * b) + ch(0.426 * r + 0.43 * g + 0.144 * b) + ch(0.426 * r + 1.43 * g - 0.856 * b));
    }
    return lightCache.get(hex);
  }

  // Samples the midpoint-smoothed stroke as [x, y, width] in pixels.
  function samples(s, scale) {
    const P = s.p, at = (q) => [q[0] * scale, q[1] * scale, segWidth(s, q[2], scale)];
    const out = [at(P[0])];
    let m = P[0];
    for (let i = 1; i < P.length; i++) {
      const c = P[i], n = i < P.length - 1 ? [(c[0] + P[i + 1][0]) / 2, (c[1] + P[i + 1][1]) / 2, (c[2] + P[i + 1][2]) / 2] : c;
      const len = (Math.hypot(c[0] - m[0], c[1] - m[1]) + Math.hypot(n[0] - c[0], n[1] - c[1])) * scale;
      const k = Math.min(16, Math.max(1, Math.ceil(len / 3)));
      for (let j = 1; j <= k; j++) {
        const t = j / k, u = 1 - t, q = (a) => u * u * m[a] + 2 * u * t * c[a] + t * t * n[a];
        out.push(at([q(0), q(1), q(2)]));
      }
      m = n;
    }
    return out;
  }

  // The stroke's outline as one shape: a disc at every sample joined by
  // tangent quads, all wound the same way so overlaps merge under nonzero fill.
  // Filling once avoids the beaded edges of stroking each segment separately.
  function strokePath(s, scale) {
    const pts = samples(s, scale), path = new Path2D();
    const dot = ([x, y, w]) => { path.moveTo(x + w / 2, y); path.arc(x, y, w / 2, 0, Math.PI * 2); };
    dot(pts[0]);
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0, w0] = pts[i - 1], [x1, y1, w1] = pts[i], d = Math.hypot(x1 - x0, y1 - y0);
      if (d > 0.01) {
        const nx = (y0 - y1) / d, ny = (x1 - x0) / d, r0 = w0 / 2, r1 = w1 / 2;
        const q = [[x0 + nx * r0, y0 + ny * r0], [x1 + nx * r1, y1 + ny * r1], [x1 - nx * r1, y1 - ny * r1], [x0 - nx * r0, y0 - ny * r0]];
        let area = 0;
        for (let k = 0; k < 4; k++) area += q[k][0] * q[(k + 1) % 4][1] - q[(k + 1) % 4][0] * q[k][1];
        if (area < 0) q.reverse();
        path.moveTo(...q[0]); path.lineTo(...q[1]); path.lineTo(...q[2]); path.lineTo(...q[3]); path.closePath();
      }
      dot(pts[i]);
    }
    return path;
  }

  function drawStroke(ctx, s, scale, color = s.c) {
    ctx.fillStyle = color;
    ctx.fill(strokePath(s, scale), 'nonzero');
  }

  function bounds(strokes) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of strokes) for (const [x, y] of s.p) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    return x0 === Infinity ? null : { x0, y0, x1, y1 };
  }

  function syncToolbars() {
    document.querySelectorAll('.ink-tools').forEach((bar) => {
      bar.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('active', !tool.eraser && b.dataset.color === tool.color));
      bar.querySelectorAll('[data-width]').forEach((b) => b.classList.toggle('active', Number(b.dataset.width) === tool.width));
      bar.querySelector('[data-act="eraser"]').classList.toggle('active', tool.eraser);
    });
    document.querySelectorAll('.ink canvas').forEach((c) => c.classList.toggle('erasing', tool.eraser));
  }

  // Mounts a pad for `block` ({ h, strokes }) into `el`. `onChange` fires after
  // every finished stroke, erase, undo, clear or resize.
  const padWidth = (block) => Math.min(MAX_W, Math.max(300, Number(block.w) || UNIT));

  // Width in units for a new pad: the room the note panel currently has.
  function defaultWidth() {
    const stage = document.getElementById('notes-stage');
    const column = stage?.querySelector('.note-blocks')?.clientWidth || UNIT * PX_PER_UNIT;
    const room = Math.min(1500, Math.max(column, (stage?.clientWidth || 0) - 2 * GUTTER));
    return Math.max(UNIT, Math.min(MAX_W, Math.round(room / PX_PER_UNIT / 50) * 50));
  }

  function mount(el, block, onChange, history = null) {
    block.strokes = block.strokes || [];
    block.h = block.h || 0.35;
    el.classList.add('ink');
    el.tabIndex = 0;
    el.innerHTML = `
      <div class="ink-tools">
        ${COLORS.map((c) => `<button data-color="${c}" style="--c:${c}" title="Pen colour"></button>`).join('')}
        <span class="sep"></span>
        ${WIDTHS.map((w) => `<button data-width="${w}" title="Pen width"><i style="height:${Math.round(w * 1.3)}px"></i></button>`).join('')}
        <span class="sep"></span>
        <button data-act="eraser" title="Eraser (or flip the Wacom pen)" data-icon="eraser" aria-label="Eraser (or flip the Wacom pen)" data-icon-only>⌫</button>
        <button data-act="undo" title="Undo (⌘Z)" data-icon="undo-2" aria-label="Undo (⌘Z)" data-icon-only>↶</button>
        <button data-act="redo" title="Redo (⇧⌘Z)" data-icon="redo-2" aria-label="Redo (⇧⌘Z)" data-icon-only>↷</button>
        <button data-act="clear" title="Clear pad" data-icon="eraser">Clear</button>
      </div>
      <div class="ink-scroll"><div class="ink-surface">
        <canvas></canvas>
        <canvas class="ink-live" aria-hidden="true"></canvas>
        <div class="ink-edge left" title="Drag left to add room on the left"></div>
        <div class="ink-edge right" title="Drag to change the width"></div>
      </div></div>
      <div class="ink-resize" title="Drag to change the height"></div>`;
    const [canvas, live] = el.querySelectorAll('canvas');
    const scroller = el.querySelector('.ink-scroll'), surface = el.querySelector('.ink-surface');
    const ctx = canvas.getContext('2d'), liveCtx = live.getContext('2d');
    const undo = [], redo = [];
    let scale = PX_PER_UNIT, cur = null, erasing = false, erasedAny = false, paint = (c) => c, geometry = '';

    // Wide pads extend past the text column (centered, up to the note panel's
    // width) and scroll sideways inside themselves beyond that. Beside LaTeX,
    // a pad keeps to its half of the row. Older 1000-unit pads shrink to fit a
    // narrow column, as before.
    function layout(force = false) {
      const nb = el.closest('.nb'), stage = el.closest('#notes-stage');
      const column = (nb || el.parentElement)?.clientWidth || UNIT * PX_PER_UNIT;
      const room = el.closest('.nb-pair') || !stage ? column : Math.max(column, stage.clientWidth - 2 * GUTTER);
      const w = padWidth(block), dpr = window.devicePixelRatio || 1;
      const key = [column, room, w, block.h, dpr].join();
      if (key === geometry && !force) return;
      geometry = key;
      scale = Math.min(PX_PER_UNIT, column / Math.min(w, UNIT));
      const full = Math.round(w * scale), visible = Math.min(full, room);
      const out = Math.max(0, (visible - column) / 2);
      const h = Math.max(60, Math.round(Math.min(MAX_H, block.h) * UNIT * scale));
      nb?.style.setProperty('--pad-out', out + 'px');
      el.style.width = visible + 'px';
      el.style.marginLeft = -out + 'px';
      surface.style.width = full + 'px';
      // Bound the backing store of very large pads.
      const density = Math.min(dpr, Math.sqrt(48 * 1024 * 1024 / (full * h)));
      for (const c of [canvas, live]) {
        c.style.width = full + 'px';
        c.style.height = h + 'px';
        c.width = Math.round(full * density);
        c.height = Math.round(h * density);
        c.getContext('2d').setTransform(density, 0, 0, density, 0, 0);
      }
      redraw();
      drawLive();
    }

    // Finishing a stroke near the right or bottom edge adds room there.
    function grow(s) {
      const b = bounds([s]);
      if (!b) return;
      const w = padWidth(block);
      if (b.x1 > w - EDGE && w < MAX_W) block.w = Math.min(MAX_W, Math.ceil((b.x1 + GROW_W) / 50) * 50);
      if (b.y1 > block.h * UNIT - EDGE && block.h < MAX_H) block.h = Math.min(MAX_H, Math.ceil(b.y1 + GROW_H) / UNIT);
      layout();
    }

    function redraw() {
      paint = getComputedStyle(el).getPropertyValue('--np-ink-filter').includes('invert') ? lightColor : (c) => c;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const s of block.strokes) drawStroke(ctx, s, scale, paint(s.c));
    }

    // The stroke in progress is redrawn whole on its own layer each move.
    function drawLive() {
      liveCtx.clearRect(0, 0, live.width, live.height);
      if (cur) drawStroke(liveCtx, cur, scale, paint(cur.c));
    }

    const changed = () => onChange && onChange();

    function point(e) {
      const r = canvas.getBoundingClientRect();
      const p = e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5;
      return [Math.round((e.clientX - r.left) / scale * 10) / 10, Math.round((e.clientY - r.top) / scale * 10) / 10, Math.round(p * 100) / 100];
    }

    function eraseAt([x, y]) {
      const r2 = 9 * 9;
      for (let i = block.strokes.length - 1; i >= 0; i--) {
        const s = block.strokes[i];
        if (s.p.some(([px, py]) => (px - x) ** 2 + (py - y) ** 2 <= r2)) {
          block.strokes.splice(i, 1);
          undo.push({ removed: s, at: i });
          redo.length = 0;
          erasedAny = true;
        }
      }
      if (erasedAny) redraw();
    }

    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') return;
      e.preventDefault();
      el.focus({ preventScroll: true });
      canvas.setPointerCapture(e.pointerId);
      // Wacom eraser end: buttons bit 5 (32), button 5 on press.
      erasing = tool.eraser || (e.buttons & 32) !== 0 || e.button === 5;
      erasedAny = false;
      if (erasing) eraseAt(point(e));
      else { cur = { c: tool.color, w: tool.width, p: [point(e)] }; drawLive(); }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!cur && !erasing) return;
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of evs.length ? evs : [e]) {
        if (erasing) eraseAt(point(ev));
        else cur.p.push(point(ev));
      }
      if (cur) drawLive();
    });
    const finish = () => {
      if (cur) {
        block.strokes.push(cur);
        undo.push({ added: cur });
        redo.length = 0;
        drawStroke(ctx, cur, scale, paint(cur.c));
        const done = cur;
        cur = null;
        drawLive();
        grow(done);
        changed();
      } else if (erasing && erasedAny) changed();
      erasing = false;
    };
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', finish);

    function doUndo(from, to) {
      const op = from.pop();
      if (!op) return;
      if (op.added) {
        const i = block.strokes.lastIndexOf(op.added);
        if (i >= 0) block.strokes.splice(i, 1);
        to.push({ removed: op.added, at: i < 0 ? block.strokes.length : i });
      } else if (op.removed) {
        block.strokes.splice(Math.min(op.at, block.strokes.length), 0, op.removed);
        to.push({ added: op.removed });
      } else if (op.cleared) {
        const had = block.strokes;
        block.strokes = op.cleared;
        to.push({ cleared: had });
      }
      redraw();
      changed();
    }
    // Undo of an undo is a redo: the inverse op goes onto the other stack.
    const undoOnce = () => history ? history.undo() : doUndo(undo, redo);
    const redoOnce = () => history ? history.redo() : doUndo(redo, undo);

    el.querySelector('.ink-tools').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.color) { tool.color = b.dataset.color; tool.eraser = false; saveTool(); }
      else if (b.dataset.width) { tool.width = Number(b.dataset.width); saveTool(); }
      else if (b.dataset.act === 'eraser') tool.eraser = !tool.eraser;
      else if (b.dataset.act === 'undo') undoOnce();
      else if (b.dataset.act === 'redo') redoOnce();
      else if (b.dataset.act === 'clear' && block.strokes.length) {
        undo.push({ cleared: block.strokes });
        redo.length = 0;
        block.strokes = [];
        redraw();
        changed();
      }
      syncToolbars();
    });
    el.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) redoOnce(); else undoOnce();
      }
    });

    function drag(handle, onMove, onUp = () => {}) {
      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const start = { x: e.clientX, y: e.clientY, h: block.h, w: padWidth(block) };
        const move = (ev) => onMove(ev.clientX - start.x, ev.clientY - start.y, start);
        const up = (ev) => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          onUp(ev.clientX - start.x, start);
          changed();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
    }
    // The bottom edge sets the height; the right edge the width, never cutting
    // off strokes. Dragging the left edge outward adds room on the left by
    // shifting the drawing right (inward removes empty room there).
    drag(el.querySelector('.ink-resize'), (dx, dy, start) => {
      block.h = Math.min(MAX_H, Math.max(60 / scale, start.h * UNIT + dy / scale) / UNIT);
      layout();
    });
    drag(el.querySelector('.ink-edge.right'), (dx, dy, start) => {
      const used = bounds(block.strokes)?.x1 || 0;
      block.w = Math.round(Math.min(MAX_W, Math.max(300, used + 20, start.w + dx / scale)));
      layout();
    });
    const leftEdge = el.querySelector('.ink-edge.left');
    drag(leftEdge, (dx) => { leftEdge.style.transform = `translateX(${dx}px)`; }, (dx, start) => {
      leftEdge.style.transform = '';
      const used = bounds(block.strokes);
      const shift = Math.round(Math.max(-(used ? used.x0 - 10 : 0), Math.min(MAX_W - start.w, -dx / scale)));
      if (!shift) return;
      for (const s of block.strokes) for (const q of s.p) q[0] = Math.round((q[0] + shift) * 10) / 10;
      block.w = start.w + shift;
      layout(true);
      scroller.scrollLeft = 0;
    });

    const ro = new ResizeObserver(() => layout());
    ro.observe(el.closest('.nb') || el.parentElement || el);
    layout();
    syncToolbars();

    const pad = {
      finish,
      layout,
      redraw,
      // Black-on-white PNG of the strokes, cropped, for handwriting recognition.
      toPNG() { return preview(block); },
      destroy() { ro.disconnect(); pads.delete(pad); },
    };
    pads.add(pad);
    observeStage();
    return pad;
  }

  // The note panel's width sets how far wide pads may extend.
  let stageObserved = null;
  const stageRO = new ResizeObserver(() => pads.forEach((p) => p.layout()));
  function observeStage() {
    const stage = document.getElementById('notes-stage');
    if (stage && stage !== stageObserved) { stageObserved = stage; stageRO.observe(stage); }
  }

  // Repaint at the new density when the window moves between screens or zooms.
  function watchDensity() {
    const query = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    query.addEventListener('change', () => { pads.forEach((p) => p.layout()); watchDensity(); }, { once: true });
  }
  watchDensity();
  // Page theme changes recolour the strokes.
  const refresh = () => pads.forEach((p) => p.redraw());
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', refresh);

  function preview(block) {
    const b = bounds(block.strokes);
    if (!b) return null;
    const pad = 20, w = b.x1 - b.x0 + 2 * pad, h = b.y1 - b.y0 + 2 * pad;
    const k = Math.min(1600 / w, 1600 / h, 3);
    const c = document.createElement('canvas');
    c.width = Math.ceil(w * k);
    c.height = Math.ceil(h * k);
    const x = c.getContext('2d');
    x.fillStyle = '#fff';
    x.fillRect(0, 0, c.width, c.height);
    x.translate((pad - b.x0) * k, (pad - b.y0) * k);
    for (const s of block.strokes) drawStroke(x, s, k, '#000');
    return c.toDataURL('image/png');
  }

  return { mount, tool, preview, refresh, defaultWidth };
})();
