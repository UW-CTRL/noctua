'use strict';
// Handwriting pads for notes. Strokes are stored as vectors in pad units
// (0..1000 across the pad's width), so pads scale with the page and files
// stay small. Pen pressure sets the line width; the Wacom eraser end (or the
// eraser tool) removes whole strokes; touch input is ignored (palm rejection).

const Ink = (() => {
  const UNIT = 1000;
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
      <canvas></canvas>
      <canvas class="ink-live" aria-hidden="true"></canvas>
      <div class="ink-resize" title="Drag to resize"></div>`;
    const [canvas, live] = el.querySelectorAll('canvas');
    const ctx = canvas.getContext('2d'), liveCtx = live.getContext('2d');
    const undo = [], redo = [];
    let scale = 1, cur = null, erasing = false, erasedAny = false, paint = (c) => c;

    function layout() {
      const w = el.clientWidth || 600;
      const h = Math.max(60, Math.round(w * block.h));
      const dpr = window.devicePixelRatio || 1;
      for (const c of [canvas, live]) {
        c.style.height = h + 'px';
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
        c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      scale = w / UNIT;
      redraw();
      drawLive();
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
      const k = UNIT / r.width;
      const p = e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5;
      return [Math.round((e.clientX - r.left) * k * 10) / 10, Math.round((e.clientY - r.top) * k * 10) / 10, Math.round(p * 100) / 100];
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
        cur = null;
        drawLive();
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

    // Drag the bottom edge to change the pad's height.
    el.querySelector('.ink-resize').addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const startY = e.clientY, startH = canvas.clientHeight, w = el.clientWidth;
      const move = (ev) => { block.h = Math.max(60, startH + ev.clientY - startY) / w; layout(); };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); changed(); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    const ro = new ResizeObserver(() => { if (canvas.width !== Math.round(el.clientWidth * (window.devicePixelRatio || 1))) layout(); });
    ro.observe(el);
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
    return pad;
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

  return { mount, tool, preview, refresh };
})();
