'use strict';
// A LaTeX-subset typesetter for Noctua notes. Math goes to KaTeX; the
// surrounding document structure (sections, lists, theorem-likes, proofs,
// equation numbers, \label/\ref, \cite) is handled here. All literal text is
// HTML-escaped, so a note can never inject markup.
//
//   NoctuaLatex.renderDoc(sources, { cite(keys, { textual, note }) -> html })
//     sources: one string per text block, or null for a drawing (which ends
//     the paragraph flow, like a figure). Returns one HTML string per source.
//     Numbering and labels run across the whole note. `opts.preamble`: the
//     note's preamble, whose \newcommand etc. apply to every block.
//     `opts.image(path) -> url | null` resolves \includegraphics paths.

const NoctuaLatex = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const THEOREMS = {
    theorem: ['Theorem', 'plain'], lemma: ['Lemma', 'plain'], proposition: ['Proposition', 'plain'],
    corollary: ['Corollary', 'plain'], conjecture: ['Conjecture', 'plain'], claim: ['Claim', 'plain'],
    definition: ['Definition', 'definition'], example: ['Example', 'definition'], problem: ['Problem', 'definition'],
    question: ['Question', 'definition'], exercise: ['Exercise', 'definition'], assumption: ['Assumption', 'definition'],
    remark: ['Remark', 'remark'], note: ['Note', 'remark'],
  };
  const MATH_ENVS = new Set(['equation', 'align', 'gather', 'multline', 'alignat', 'displaymath']);
  const HEADINGS = { section: 0, subsection: 1, subsubsection: 2 };

  // ------------------------------------------------------------ scanning helpers

  // `s[i]` is '{' (or '['); returns { text, end } with end just past the match.
  function group(s, i, open = '{', close = '}') {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (c === '\\') { j++; continue; }
      if (c === open) depth++;
      else if (c === close && --depth === 0) return { text: s.slice(i + 1, j), end: j + 1 };
    }
    return { text: s.slice(i + 1), end: s.length };
  }

  const skipSpace = (s, i) => { while (i < s.length && /[ \t]/.test(s[i])) i++; return i; };

  // Optional [..] argument at i (after spaces).
  function optArg(s, i) {
    const j = skipSpace(s, i);
    if (s[j] !== '[') return { text: null, end: i };
    return group(s, j, '[', ']');
  }

  function reqArg(s, i) {
    const j = skipSpace(s, i);
    if (s[j] !== '{') return { text: '', end: i };
    return group(s, j);
  }

  // Index of the matching \end{env} for a \begin{env} whose body starts at i.
  function findEnd(s, i, env) {
    const open = `\\begin{${env}}`, close = `\\end{${env}}`;
    let depth = 1;
    for (let j = i; j < s.length; j++) {
      if (s[j] === '\\' && s.startsWith(open, j)) { depth++; j += open.length - 1; }
      else if (s[j] === '\\' && s.startsWith(close, j)) { if (--depth === 0) return j; j += close.length - 1; }
      else if (s[j] === '\\') j++;
    }
    return -1;
  }

  // End of an inline math span starting at i ('$' or '\('), or -1.
  function mathEnd(s, i) {
    if (s[i] === '$') {
      for (let j = i + 1; j < s.length; j++) {
        if (s[j] === '\\') { j++; continue; }
        if (s[j] === '$') return j + 1;
      }
      return -1;
    }
    const e = s.indexOf('\\)', i + 2);
    return e < 0 ? -1 : e + 2;
  }

  // Splits at top-level occurrences of `sep` (outside braces and nested envs).
  function splitTop(s, sep) {
    const out = [];
    let depth = 0, envDepth = 0, last = 0;
    for (let j = 0; j < s.length; j++) {
      const c = s[j];
      if (c === '\\') {
        if (s.startsWith('\\begin{', j)) envDepth++;
        else if (s.startsWith('\\end{', j)) envDepth--;
        else if (!depth && !envDepth && s.startsWith(sep, j)) { out.push(s.slice(last, j)); last = j + sep.length; j += sep.length - 1; continue; }
        j++;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') depth--;
    }
    out.push(s.slice(last));
    return out;
  }

  function stripComments(s) {
    return s.replace(/(^|[^\\])%.*$/gm, '$1');
  }

  // Pulls \newcommand/\renewcommand/\def/\DeclareMathOperator definitions out of the text into `macros`.
  function extractMacros(s, macros) {
    const re = /\\(?:re)?newcommand\*?\s*|\\def\s*|\\DeclareMathOperator(\*?)\s*/g;
    let out = '', last = 0, m;
    while ((m = re.exec(s))) {
      let i = re.lastIndex, name;
      if (s[i] === '{') { const g = group(s, i); name = g.text.trim(); i = g.end; }
      else { const n = /^\\[A-Za-z]+/.exec(s.slice(i)); if (!n) continue; name = n[0]; i += name.length; }
      if (!/^\\[A-Za-z]+$/.test(name)) continue;
      const args = optArg(s, i);           // [n] argument count (KaTeX uses #1..#n as-is)
      if (args.text !== null) i = args.end;
      if (m[0].startsWith('\\def')) { while (i < s.length && s[i] !== '{') i++; }
      const body = reqArg(s, i);
      macros[name] = m[0].startsWith('\\Declare') ? `\\operatorname${m[1]}{${body.text}}` : body.text;
      out += s.slice(last, m.index);
      last = body.end;
      re.lastIndex = body.end;
    }
    return out + s.slice(last);
  }

  // ------------------------------------------------------------ math

  function katexHtml(tex, display, st) {
    if (st.dry) return '';
    try {
      return katex.renderToString(tex, {
        displayMode: display, throwOnError: false, output: 'html', strict: 'ignore',
        macros: { ...st.macros }, trust: false,
      });
    } catch (e) {
      return `<span class="tex-error">${esc(tex)}</span>`;
    }
  }

  // Records \label{..} found in `tex` against `value` and removes them.
  function takeLabels(tex, value, st) {
    return tex.replace(/\\label\s*\{([^}]*)\}/g, (_, k) => { if (value != null) st.labels[k.trim()] = String(value); return ''; });
  }

  function display(body, env, st) {
    const base = env ? env.replace('*', '') : null;
    const numbered = !!env && !env.endsWith('*') && base !== 'displaymath';
    const noNum = (t) => /\\(nonumber|notag)\b/.test(t);
    const clean = (t) => t.replace(/\\(nonumber|notag)\b/g, '');
    let tex;
    if (!base || base === 'equation' || base === 'displaymath') {
      let n = null;
      if (numbered && !noNum(body) && !/\\tag\b/.test(body)) n = ++st.eq;
      tex = clean(takeLabels(body, n, st)) + (n ? `\\tag{${n}}` : '');
    } else {
      // align / gather / alignat / multline: one number per row (multline: last row only).
      const head = base === 'alignat' ? (/^\s*\{[^}]*\}/.exec(body)?.[0] || '{1}') : '';
      const rows = splitTop(head ? body.slice(body.indexOf(head) + head.length) : body, '\\\\');
      const out = rows.map((row, k) => {
        const last = k === rows.length - 1;
        const wants = numbered && !noNum(row) && !/\\tag\b/.test(row) && row.trim() && (base !== 'multline' || last);
        const n = wants ? ++st.eq : null;
        return clean(takeLabels(row, n, st)) + (n ? ` \\tag{${n}}` : '');
      });
      const kat = base === 'multline' ? 'gather' : base;  // KaTeX has no multline
      tex = `\\begin{${kat}*}${head}${out.join('\\\\')}\\end{${kat}*}`;
    }
    return `<div class="tex-display">${katexHtml(tex, true, st)}</div>`;
  }

  // ------------------------------------------------------------ inline text

  const SIMPLE = {
    '\\ldots': '…', '\\dots': '…', '\\S': '§', '\\P': '¶', '\\quad': ' ', '\\qquad': '  ',
    '\\,': ' ', '\\ ': ' ', '\\;': ' ', '\\!': '', '\\newline': '<br>', '\\noindent': '', '\\hfill': '',
    '\\par': '', '\\centering': '', '\\smallskip': '', '\\medskip': '', '\\bigskip': '', '\\copyright': '©',
    '\\LaTeX': '<span class="tex-logo">L<sup>a</sup>T<sub>e</sub>X</span>', '\\TeX': '<span class="tex-logo">T<sub>e</sub>X</span>',
    '\\textbackslash': '\\', '\\slash': '/', '\\textendash': '–', '\\textemdash': '—',
  };
  const STYLE_ARG = {
    emph: ['<em>', '</em>'], textit: ['<i>', '</i>'], textbf: ['<b>', '</b>'], texttt: ['<code>', '</code>'],
    textsc: ['<span class="sc">', '</span>'], underline: ['<u>', '</u>'], textrm: ['', ''], text: ['', ''],
    textsf: ['<span class="sf">', '</span>'], textup: ['<span class="up">', '</span>'], mbox: ['', ''],
    textsuperscript: ['<sup>', '</sup>'], textsubscript: ['<sub>', '</sub>'],
  };
  const STYLE_SWITCH = { '\\bf': STYLE_ARG.textbf, '\\it': STYLE_ARG.textit, '\\em': STYLE_ARG.emph, '\\tt': STYLE_ARG.texttt, '\\sc': STYLE_ARG.textsc, '\\sf': STYLE_ARG.textsf };

  const safeUrl = (u) => /^(https?:|mailto:)/i.test(u.trim()) ? u.trim() : null;

  function inline(s, st) {
    let out = '', i = 0;
    const text = (t) => { out += esc(t); };
    while (i < s.length) {
      const c = s[i];
      if (c === '$' || s.startsWith('\\(', i)) {
        const e = mathEnd(s, i);
        if (e > 0) {
          const open = c === '$' ? 1 : 2;
          out += katexHtml(s.slice(i + open, e - open), false, st);
          i = e;
          continue;
        }
      }
      if (c === '\\') {
        if (s.startsWith('\\\\', i)) { out += '<br>'; i = optArg(s, i + 2).end; continue; }
        const sym = /^\\[%&$#_{}~^]/.exec(s.slice(i, i + 2));
        if (sym) { text(sym[0][1] === '~' ? '~' : sym[0][1] === '^' ? '^' : sym[0][1]); i += 2; continue; }
        const m = /^\\([A-Za-z]+\*?|[,;! ])/.exec(s.slice(i));
        if (!m) { text(c); i++; continue; }
        const cmd = m[1], whole = '\\' + cmd;
        let j = i + m[0].length;
        if (SIMPLE[whole] !== undefined) {
          out += SIMPLE[whole];
          if (/^[A-Za-z]/.test(cmd) && s[j] === ' ') j++;   // control words eat one space
          else if (s.startsWith('{}', j)) j += 2;
          i = j;
          continue;
        }
        if (STYLE_ARG[cmd]) {
          const a = reqArg(s, j);
          out += STYLE_ARG[cmd][0] + inline(a.text, st) + STYLE_ARG[cmd][1];
          i = a.end;
          continue;
        }
        if (cmd === 'cite' || cmd === 'citep' || cmd === 'citet' || cmd === 'citeauthor' || cmd === 'citeyear') {
          const note = optArg(s, j);
          const a = reqArg(s, note.end);
          const keys = a.text.split(',').map((k) => k.trim()).filter(Boolean);
          out += st.opts.cite ? st.opts.cite(keys, { textual: cmd === 'citet', note: note.text, kind: cmd })
            : `[${esc(keys.join(', '))}]`;
          i = a.end;
          continue;
        }
        if (cmd === 'includegraphics') {
          const o = optArg(s, j);
          const a = reqArg(s, o.end);
          out += graphic(o.text, a.text, st);
          i = a.end;
          continue;
        }
        if (cmd === 'noteref') {
          const a = reqArg(s, j);
          out += st.opts.noteref ? st.opts.noteref(a.text.trim()) : `[${esc(a.text.trim())}]`;
          i = a.end;
          continue;
        }
        if (cmd === 'ref' || cmd === 'eqref' || cmd === 'autoref' || cmd === 'cref') {
          const a = reqArg(s, j);
          const v = st.labels[a.text.trim()];
          const shown = v == null ? '<span class="tex-missing">??</span>' : esc(v);
          out += cmd === 'eqref' ? `(${shown})` : shown;
          i = a.end;
          continue;
        }
        if (cmd === 'label') {
          const a = reqArg(s, j);
          if (st.current) st.labels[a.text.trim()] = st.current;
          i = a.end;
          continue;
        }
        if (cmd === 'href') {
          const u = reqArg(s, j), t = reqArg(s, u.end);
          const url = safeUrl(u.text);
          out += url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${inline(t.text, st)}</a>` : inline(t.text, st);
          i = t.end;
          continue;
        }
        if (cmd === 'url') {
          const u = reqArg(s, j);
          const url = safeUrl(u.text);
          out += url ? `<a href="${esc(url)}" target="_blank" rel="noopener"><code>${esc(u.text)}</code></a>` : `<code>${esc(u.text)}</code>`;
          i = u.end;
          continue;
        }
        if (cmd === 'footnote') {
          const a = reqArg(s, j);
          out += `<sup class="tex-fn" title="${esc(a.text)}">${++st.fn}</sup>`;
          i = a.end;
          continue;
        }
        if (cmd === 'today') { text(new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })); i = j; continue; }
        if (STYLE_SWITCH[whole]) { i = j; continue; }  // only meaningful inside a {..} group, handled below
        // Unknown command: show it, muted, rather than silently dropping it.
        out += `<span class="tex-unknown">${esc(whole)}</span>`;
        i = j;
        continue;
      }
      if (c === '{') {
        const g = group(s, i);
        const sw = /^\s*(\\[A-Za-z]+)\b\s*/.exec(g.text);
        if (sw && STYLE_SWITCH[sw[1]]) {
          const [o, cl] = STYLE_SWITCH[sw[1]];
          out += o + inline(g.text.slice(sw[0].length), st) + cl;
        } else out += inline(g.text, st);
        i = g.end;
        continue;
      }
      if (c === '}') { i++; continue; }
      if (c === '~') { out += '&nbsp;'; i++; continue; }
      if (s.startsWith('---', i)) { out += '—'; i += 3; continue; }
      if (s.startsWith('--', i)) { out += '–'; i += 2; continue; }
      if (s.startsWith('``', i)) { out += '“'; i += 2; continue; }
      if (s.startsWith("''", i)) { out += '”'; i += 2; continue; }
      if (c === '`') { out += '‘'; i++; continue; }
      if (c === "'") { out += '’'; i++; continue; }
      if (c === '\n') { out += ' '; i++; continue; }
      text(c);
      i++;
    }
    return out;
  }

  // ------------------------------------------------------------ figures

  // `width=0.5\textwidth` (or \linewidth, \columnwidth; bare means 1) -> 0.5, else null.
  function widthFrac(o) {
    const m = /(?:^|,)\s*width\s*=\s*(\d*\.?\d*)\s*\\(?:textwidth|linewidth|columnwidth)(?![A-Za-z])/.exec(o || '');
    return m ? (m[1] === '' ? 1 : parseFloat(m[1])) : null;
  }
  const pct = (f) => +(f * 100).toFixed(2);

  // \includegraphics -> an image. data-img numbers the images of a block in
  // source order, so the editor can map a clicked image back to its source.
  function graphic(opts, path, st) {
    const k = st.img++;
    const w = widthFrac(opts);
    const style = w != null ? ` style="width:${pct(w)}%"` : '';
    const src = st.opts.image ? st.opts.image(path.trim()) : null;
    if (!src) return `<span class="tex-img missing" data-img="${k}"${style}>missing image: ${esc(path)}</span>`;
    return `<span class="tex-img" data-img="${k}"${style}><img src="${esc(src)}" alt="${esc(path)}" draggable="false"></span>`;
  }

  // The body of a figure (num set) or subfigure (num null): its items in
  // source order, its caption, and whether \hfill spreads the row.
  const FIG_TOKEN = /\\begin\s*\{subfigure\}|\\caption(?![A-Za-z])\s*|\\(?:hfill|quad|qquad|centering)(?![A-Za-z])/y;
  function figParts(body, st, num) {
    const items = [];
    let caption = null, text = '', hfill = false, sub = 0, i = 0;
    const flush = () => { if (text.trim()) items.push(inline(text.trim(), st)); text = ''; };
    while (i < body.length) {
      FIG_TOKEN.lastIndex = i;
      const m = body[i] === '\\' ? FIG_TOKEN.exec(body) : null;
      if (!m) { text += body[i++]; continue; }
      flush();
      if (m[0].startsWith('\\begin')) {
        const w = reqArg(body, optArg(body, i + m[0].length).end);
        const end = findEnd(body, w.end, 'subfigure');
        if (!num) { i = end < 0 ? body.length : end + 15; continue; }  // no nesting
        const letter = String.fromCharCode(97 + sub++);
        st.current = num + letter;
        const p = figParts(end < 0 ? body.slice(w.end) : body.slice(w.end, end), st, null);
        st.current = String(num);
        const f = widthFrac('width=' + w.text.trim());
        items.push(`<div class="tex-subfig"${f != null ? ` style="width:${pct(f)}%"` : ''}>${p.items.join(' ')}<div class="tex-subcap">(${letter})${p.caption ? ' ' + p.caption : ''}</div></div>`);
        i = end < 0 ? body.length : end + '\\end{subfigure}'.length;
      } else if (m[0].startsWith('\\caption')) {
        const a = reqArg(body, optArg(body, i + m[0].length).end);
        caption = inline(a.text, st);
        i = a.end;
      } else {
        if (!m[0].includes('centering')) hfill = true;
        i += m[0].length;
      }
    }
    flush();
    return { items, caption, hfill };
  }

  function figure(body, st) {
    const num = ++st.fig;
    st.current = String(num);
    const p = figParts(body, st, num);
    const cap = p.caption == null ? '' : `<figcaption><span class="tex-fig-num">Figure ${num}:</span> ${p.caption}</figcaption>`;
    return `<figure class="tex-figure"><div class="tex-fig-row${p.hfill ? ' spread' : ''}">${p.items.join('')}</div>${cap}</figure>`;
  }

  // ------------------------------------------------------------ block structure

  function heading(kind, star, title, st) {
    if (kind === 'paragraph') return null;  // run-in, handled by the caller
    const lvl = HEADINGS[kind];
    let num = '';
    if (!star) {
      st.sec[lvl]++;
      for (let k = lvl + 1; k < st.sec.length; k++) st.sec[k] = 0;
      num = st.sec.slice(0, lvl + 1).join('.');
      st.current = num;
    }
    const tag = ['h2', 'h3', 'h4'][lvl];
    return `<${tag} class="tex-h">${num ? `<span class="tex-secnum">${num}</span>` : ''}${inline(title, st)}</${tag}>`;
  }

  // Puts `head` at the start of the first paragraph of `html` (run-in heads).
  function runIn(head, html) {
    return /^<p[^>]*>/.test(html) ? html.replace(/^(<p[^>]*>)/, `$1${head} `) : `<p class="noindent">${head}</p>${html}`;
  }

  function environment(env, opt, body, st) {
    const base = env.replace('*', '');
    if (MATH_ENVS.has(base)) return display(body, env, st);
    if (base === 'itemize' || base === 'enumerate' || base === 'description') {
      const items = splitTop(body, '\\item').slice(1);
      const lis = items.map((it) => {
        let label = null;
        const o = optArg(it, 0);
        if (o.text !== null) { label = o.text; it = it.slice(o.end); }
        const inner = blocks(it, { ...st, inList: true, firstPara: true }, st);
        if (base === 'description') return `<dt>${inline(label || '', st)}</dt><dd>${inner}</dd>`;
        return `<li${label !== null ? ` class="custom" data-label="${esc(label)}"` : ''}>${label !== null ? `<span class="tex-label">${inline(label, st)}</span>` : ''}${inner}</li>`;
      }).join('');
      const tag = base === 'enumerate' ? 'ol' : base === 'description' ? 'dl' : 'ul';
      return `<${tag} class="tex-list">${lis}</${tag}>`;
    }
    if (THEOREMS[base]) {
      const [name, style] = THEOREMS[base];
      let num = '';
      if (!env.endsWith('*')) { num = String(++st.thm); st.current = num; }
      const head = `<span class="tex-thm-head">${name}${num ? ' ' + num : ''}${opt ? ` <span class="tex-thm-note">(${inline(opt, st)})</span>` : ''}.</span>`;
      const inner = blocks(body, { ...st, firstPara: true }, st);
      return `<div class="tex-thm ${style}">${runIn(head, inner)}</div>`;
    }
    if (base === 'proof') {
      const head = `<span class="tex-proof-head">${opt ? inline(opt, st) : 'Proof'}.</span>`;
      let inner = runIn(head, blocks(body, { ...st, firstPara: true }, st));
      const qed = '<span class="tex-qed">∎</span>';
      inner = /<\/p>$/.test(inner) ? inner.replace(/<\/p>$/, `${qed}</p>`) : inner + `<p class="noindent">${qed}</p>`;
      return `<div class="tex-proof">${inner}</div>`;
    }
    if (base === 'center' || base === 'quote' || base === 'quotation' || base === 'abstract') {
      const inner = blocks(body, { ...st, firstPara: true }, st);
      return `<div class="tex-${base}">${base === 'abstract' ? '<div class="tex-abstract-head">Abstract</div>' : ''}${inner}</div>`;
    }
    if (base === 'figure') return figure(body, st);
    if (base === 'verbatim') return `<pre class="tex-verbatim">${esc(body.replace(/^\n/, ''))}</pre>`;
    return `<div class="tex-env"><span class="tex-unknown">${esc(env)}</span>${blocks(body, { ...st, firstPara: true }, st)}</div>`;
  }

  // Parses paragraphs and block constructs. `child` state shares counters and
  // labels with `root` (objects are shared by reference; numbers are copied
  // back after nested calls).
  function blocks(s, st, root = null) {
    let out = '', para = '', i = 0, noindent = false;
    const flush = () => {
      const t = para.trim();
      if (t) {
        const cls = st.inList || st.firstPara || noindent || /^\\noindent(?![A-Za-z])/.test(t) ? ' class="noindent"' : '';
        out += `<p${cls}>${inline(t, st)}</p>`;
        st.firstPara = false;
      }
      para = '';
      noindent = false;
    };
    while (i < s.length) {
      const c = s[i];
      if (c === '\n') {
        let j = i + 1;
        while (j < s.length && /[ \t\r]/.test(s[j])) j++;
        if (s[j] === '\n') {
          flush();
          while (j < s.length && /\s/.test(s[j])) j++;
          i = j;
          continue;
        }
      }
      if (c === '$' && s[i + 1] !== '$') {
        const e = mathEnd(s, i);
        if (e > 0) { para += s.slice(i, e); i = e; continue; }
      }
      if (c === '\\') {
        if (s.startsWith('\\(', i)) {
          const e = mathEnd(s, i);
          if (e > 0) { para += s.slice(i, e); i = e; continue; }
        }
        if (s.startsWith('\\[', i) && para.slice(-1) !== '\\') {
          const e = s.indexOf('\\]', i + 2);
          if (e >= 0) { flush(); out += display(s.slice(i + 2, e), null, st); i = e + 2; noindent = true; st.firstPara = false; continue; }
        }
        if (s.startsWith('\\\\', i)) { para += '\\\\'; i += 2; continue; }
        const h = /^\\(section|subsection|subsubsection|paragraph)(\*?)\s*(?=[[{])/.exec(s.slice(i));
        if (h) {
          const o = optArg(s, i + h[0].length);
          const a = reqArg(s, o.end);
          if (h[1] === 'paragraph') {
            flush();
            para = `\\textbf{${a.text}}\\quad `;
            noindent = true;
          } else {
            flush();
            out += heading(h[1], h[2], a.text, st);
            st.firstPara = true;
          }
          i = a.end;
          continue;
        }
        const b = /^\\begin\s*\{([A-Za-z]+\*?)\}/.exec(s.slice(i));
        if (b) {
          const env = b[1];
          let j = i + b[0].length;
          let opt = null;
          if (!MATH_ENVS.has(env.replace('*', ''))) { const o = optArg(s, j); if (o.text !== null) { opt = o.text; j = o.end; } }
          const end = findEnd(s, j, env);
          const body = end < 0 ? s.slice(j) : s.slice(j, end);
          flush();
          out += environment(env, opt, body, st);
          i = end < 0 ? s.length : end + `\\end{${env}}`.length;
          noindent = true;
          st.firstPara = false;
          continue;
        }
      }
      if (c === '$' && s[i + 1] === '$') {
        const e = s.indexOf('$$', i + 2);
        if (e >= 0) { flush(); out += display(s.slice(i + 2, e), null, st); i = e + 2; noindent = true; st.firstPara = false; continue; }
      }
      para += c;
      i++;
    }
    flush();
    if (root) { root.eq = st.eq; root.thm = st.thm; root.fn = st.fn; root.fig = st.fig; root.img = st.img; root.current = st.current; }
    return out;
  }

  function renderDoc(sources, opts = {}) {
    const macros = {};
    if (opts.preamble) extractMacros(stripComments(opts.preamble), macros);
    const cleaned = sources.map((s) => s == null ? null : extractMacros(stripComments(s), macros));
    const run = (dry, labels) => {
      const st = { dry, labels, macros, opts, sec: [0, 0, 0], eq: 0, thm: 0, fn: 0, fig: 0, img: 0, current: '', firstPara: true, inList: false };
      return cleaned.map((s) => {
        if (s == null) { st.firstPara = true; return ''; }
        st.img = 0;
        return blocks(s, st);
      });
    };
    const labels = {};
    run(true, labels);           // pass 1: numbers and labels, no typesetting
    return run(false, labels);   // pass 2: typeset with every \ref resolvable
  }

  // The commands a preamble defines (for its status line).
  const macrosOf = (src) => { const m = {}; extractMacros(stripComments(src), m); return m; };

  return { renderDoc, macrosOf, esc };
})();
