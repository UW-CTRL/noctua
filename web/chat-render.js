'use strict';

const NoctuaChatRender = (() => {
  let library, sequence = 0, queue = Promise.resolve();
  const cache = new Map(), pending = new Map();
  const dark = () => document.documentElement.dataset.theme === 'dark' ||
    (!document.documentElement.dataset.theme || document.documentElement.dataset.theme === 'system') && matchMedia('(prefers-color-scheme: dark)').matches;

  function loadMermaid() {
    if (window.mermaid) return Promise.resolve(window.mermaid);
    if (!library) library = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/vendor/mermaid/mermaid.min.js';
      script.onload = () => resolve(window.mermaid);
      script.onerror = () => { script.remove(); library = null; reject(Error('Diagram renderer unavailable')); };
      document.head.appendChild(script);
    });
    return library;
  }

  function diagram(source, theme) {
    const key = theme + '\n' + source;
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    if (pending.has(key)) return pending.get(key);
    const job = queue.then(async () => {
      // Keep configuration under application control, including for saved replies.
      if (source.length > 30000 || /%%\s*\{|^\s*---/.test(source)) throw Error('Unsupported diagram configuration');
      const mermaid = await loadMermaid();
      mermaid.initialize({startOnLoad: false, securityLevel: 'strict', theme,
        suppressErrorRendering: true, maxTextSize: 30000, maxEdges: 500,
        flowchart: {htmlLabels: false}, fontFamily: 'sans-serif'});
      const result = await mermaid.render('chat-diagram-' + (++sequence), source);
      cache.set(key, result.svg);
      if (cache.size > 40) cache.delete(cache.keys().next().value);
      return result.svg;
    });
    queue = job.catch(() => {});
    pending.set(key, job);
    job.then(() => pending.delete(key), () => pending.delete(key));
    return job;
  }

  function enhance(root) {
    const theme = dark() ? 'dark' : 'default';
    root.querySelectorAll('[data-diagram]').forEach(block => {
      if (block.dataset.renderTheme === theme) return;
      block.dataset.renderTheme = theme;
      const view = block.querySelector('.chat-diagram-view');
      const source = block.querySelector('pre code').textContent;
      view.textContent = 'Rendering diagram…';
      block.classList.remove('diagram-ready');
      diagram(source, theme).then(svg => {
        if (!block.isConnected || block.dataset.renderTheme !== theme) return;
        const image = document.createElement('img');
        image.alt = 'Chat diagram';
        image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        view.replaceChildren(image);
        block.classList.add('diagram-ready');
      }).catch(() => {
        if (block.isConnected && block.dataset.renderTheme === theme) view.textContent = 'Diagram unavailable. Source shown below.';
      });
    });
  }

  function update(body, markdown) {
    const open = Array.from(body.querySelectorAll('details.chat-details'), item => item.open);
    body.innerHTML = renderMd(markdown);
    body.querySelectorAll('details.chat-details').forEach((item, index) => {
      if (index < open.length) item.open = open[index];
    });
  }

  async function copy(text) {
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(text); return; } catch (_) { /* Fall back in webviews. */ }
    }
    const area = document.createElement('textarea'), focused = document.activeElement;
    area.value = text; area.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(area); area.select();
    try { if (!document.execCommand('copy')) throw Error('Copy failed'); }
    finally { area.remove(); focused?.focus({preventScroll: true}); }
  }

  document.addEventListener('click', async event => {
    const toggle = event.target.closest('.chat-source-toggle');
    if (toggle) {
      const expanded = toggle.closest('.chat-code').classList.toggle('show-source');
      toggle.setAttribute('aria-expanded', String(expanded));
      return;
    }
    const button = event.target.closest('.chat-copy');
    if (!button) return;
    try {
      await copy(button.closest('.chat-code').querySelector('pre code').textContent);
      button.textContent = 'Copied';
      setTimeout(() => { if (button.isConnected) button.textContent = 'Copy'; }, 1600);
    } catch (_) { button.textContent = 'Copy failed'; }
  });
  const refresh = () => enhance(document);
  new MutationObserver(refresh).observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme']});
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', refresh);
  return {update, enhance};
})();
