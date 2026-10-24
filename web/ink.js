'use strict';
// Handwriting pads for notes. Strokes are stored as vectors in pad units
// (0..1000 across the pad's width), so pads scale with the page and files
// stay small. Pen pressure sets the line width; the Wacom eraser end (or the
// eraser tool) removes whole strokes; touch input is ignored (palm rejection).

const Ink = (() => {
  const UNIT = 1000;
  const COLORS = ['#e8e6e1', '#8b85ff', '#f7768e', '#9ece6a', '#e0af68'];
  const WIDTHS = [1.4, 2.4, 4.5];
  // Shared by every pad, like picking up a pen.
  const tool = { color: COLORS[0], width: WIDTHS[1], eraser: false };

  const segWidth = (s, p, scale) => Math.max(0.6, s.w * scale * (0.35 + 0.9 * p));

  // Draws one stroke with pressure-varying width, smoothed through midpoints.
  function drawStroke(ctx, s, scale, color = s.c) {
    const P = s.p;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (P.length === 1) {
      ctx.beginPath();
      ctx.arc(P[0][0] * scale, P[0][1] * scale, segWidth(s, P[0][2], scale) / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    let mx = P[0][0], my = P[0][1];
    for (let i = 1; i < P.length; i++) {
      const [x, y, p] = P[i];
      const nx = i < P.length - 1 ? (x + P[i + 1][0]) / 2 : x;
      const ny = i < P.length - 1 ? (y + P[i + 1][1]) / 2 : y;
      ctx.lineWidth = segWidth(s, p, scale);
      ctx.beginPath();
      ctx.moveTo(mx * scale, my * scale);
      ctx.quadraticCurveTo(x * scale, y * scale, nx * scale, ny * scale);
      ctx.stroke();
      mx = nx; my = ny;
    }
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
      <div class="ink-resize" title="Drag to resize"></div>`;
    const canvas = el.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const undo = [], redo = [];
    let scale = 1, cur = null, erasing = false, erasedAny = false;

    function layout() {
      const w = el.clientWidth || 600;
      const h = Math.max(60, Math.round(w * block.h));
      const dpr = window.devicePixelRatio || 1;
      canvas.style.height = h + 'px';
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      scale = w / UNIT;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      redraw();
    }

    function redraw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const s of block.strokes) drawStroke(ctx, s, scale);
      if (cur) drawStroke(ctx, cur, scale);
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
      else cur = { c: tool.color, w: tool.width, p: [point(e)] };
      redraw();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!cur && !erasing) return;
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of evs.length ? evs : [e]) {
        if (erasing) eraseAt(point(ev));
        else cur.p.push(point(ev));
      }
      if (cur) {
        // Draw just the newest segments; full redraw on finish.
        const n = cur.p.length;
        drawStroke(ctx, { ...cur, p: cur.p.slice(Math.max(0, n - evs.length - 2)) }, scale);
      }
    });
    const finish = () => {
      if (cur) {
        block.strokes.push(cur);
        undo.push({ added: cur });
        redo.length = 0;
        cur = null;
        redraw();
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
      if (b.dataset.color) { tool.color = b.dataset.color; tool.eraser = false; }
      else if (b.dataset.width) tool.width = Number(b.dataset.width);
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

    return {
      // Black-on-white PNG of the strokes, cropped, for handwriting recognition.
      toPNG() {
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
      },
      destroy() { ro.disconnect(); },
    };
  }

  return { mount, tool };
})();
