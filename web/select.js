'use strict';
// Enhance native single-selects while preserving their values, forms and change handlers.
(() => {
  const controls = new WeakMap();
  let active = null, sequence = 0;
  const arrow = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  const check = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
  function nameOf(select) {
    if (select.getAttribute('aria-label')) return select.getAttribute('aria-label');
    const labelled = (select.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ').trim();
    if (labelled) return labelled;
    const label = select.labels?.[0];
    if (label) {
      const copy = label.cloneNode(true);
      copy.querySelectorAll('select,.web-select').forEach(node => node.remove());
      if (copy.textContent.trim()) return copy.textContent.trim();
    }
    return select.title || ({'lib-sort':'Sort library papers',sort:'Sort graph papers',limit:'Papers to load','add-target':'Collection'}[select.id]) || 'Collection';
  }
  const disabled = option => option.disabled || option.parentElement?.disabled || option.hidden || option.parentElement?.hidden;
  function enabled(state) {
    return Array.from(state.select.options).map((option, index) => disabled(option) ? -1 : index).filter(index => index >= 0);
  }
  function close(focus = false) {
    if (!active) return;
    const state = active; active = null;
    state.trigger.setAttribute('aria-expanded', 'false');
    state.trigger.removeAttribute('aria-activedescendant');
    state.trigger.removeAttribute('aria-controls'); state.buffer = ''; state.typedAt = 0;
    clearTimeout(state.openTimer); clearTimeout(state.closeTimer);
    state.menu.remove();
    if (focus && state.trigger.isConnected) state.trigger.focus();
  }
  function choose(state, index, focus = true) {
    const option = state.select.options[index];
    if (!option || disabled(option) || state.select.matches(':disabled')) { close(focus); return; }
    const changed = state.select.selectedIndex !== index;
    close(focus);
    state.select.selectedIndex = index;
    if (changed) {
      state.select.dispatchEvent(new Event('input', {bubbles:true}));
      state.select.dispatchEvent(new Event('change', {bubbles:true}));
    }
  }
  function position(state) {
    if (active !== state) return;
    const rect = state.trigger.getBoundingClientRect(), menu = state.menu;
    if (!state.trigger.isConnected || !rect.width || !rect.height) { close(); return; }
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
    const width = viewport?.width || innerWidth, height = viewport?.height || innerHeight;
    const below = top + height - rect.bottom - 12, above = rect.top - top - 12;
    const up = below < 160 && above > below;
    menu.style.maxHeight = Math.max(40, Math.min(320, up ? above : below)) + 'px';
    menu.style.maxWidth = Math.max(40, width - 16) + 'px';
    menu.style.minWidth = Math.min(rect.width, width - 16) + 'px';
    menu.style.left = Math.max(left + 8, Math.min(rect.left, left + width - menu.offsetWidth - 8)) + 'px';
    menu.style.top = Math.max(top + 8, up ? rect.top - menu.offsetHeight - 6 : rect.bottom + 6) + 'px';
  }
  function highlight(state, index, scroll = true) {
    state.index = index;
    state.menu.querySelectorAll('[role="option"]').forEach(node => node.classList.toggle('active', Number(node.dataset.index) === index));
    const option = state.menu.querySelector(`[data-index="${index}"]`);
    if (option) {
      state.trigger.setAttribute('aria-activedescendant', option.id);
      if (scroll) option.scrollIntoView({block:'nearest'});
    } else state.trigger.removeAttribute('aria-activedescendant');
  }
  function renderOptions(state) {
    state.menu.replaceChildren();
    let group = null;
    Array.from(state.select.options).forEach((option, index) => {
      if (option.hidden || option.parentElement?.hidden) return;
      if (option.parentElement.tagName === 'OPTGROUP' && group !== option.parentElement) {
        group = option.parentElement;
        const heading = document.createElement('div'); heading.className = 'web-select-heading'; heading.textContent = group.label;
        heading.setAttribute('role', 'presentation'); state.menu.append(heading);
      }
      const row = document.createElement('div');
      row.id = state.menu.id + '-' + index; row.className = 'web-select-option'; row.dataset.index = index;
      row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(index === state.select.selectedIndex));
      row.setAttribute('aria-disabled', String(!!disabled(option)));
      const text = document.createElement('span'); text.textContent = option.label;
      row.append(text);
      if (state.select.id !== 'limit' && state.select.dataset.selectIcon !== 'list-filter') {
        const mark = document.createElement('span'); mark.className = 'web-select-check'; mark.innerHTML = check;
        row.append(mark);
      }
      row.addEventListener('pointermove', event => { if (event.pointerType !== 'touch' && !disabled(option)) highlight(state, index, false); });
      row.addEventListener('click', () => choose(state, index));
      state.menu.append(row);
    });
    highlight(state, enabled(state).includes(state.index) ? state.index : enabled(state)[0] ?? -1, false);
  }
  function sync(state) {
    const {select, trigger, text, wrapper} = state;
    const value = select.options[select.selectedIndex]?.label || '—';
    if (text.textContent !== value) text.textContent = value;
    trigger.disabled = select.matches(':disabled');
    if (select.hasAttribute('data-open-on-hover')) trigger.removeAttribute('title');
    else trigger.title = select.title || nameOf(select);
    trigger.setAttribute('aria-label', nameOf(select) + ': ' + value);
    trigger.setAttribute('aria-required', String(select.required));
    wrapper.hidden = select.hidden || select.classList.contains('hidden');
    if (active === state) {
      if (trigger.disabled || wrapper.hidden || !select.isConnected) close();
      else { renderOptions(state); position(state); }
    }
  }
  function open(state, focus = true) {
    sync(state);
    if (state.trigger.disabled || !enabled(state).length) return;
    close(); active = state; state.hoverOpen = !focus; state.index = state.select.selectedIndex; state.buffer = '';
    state.menu.setAttribute('aria-label', nameOf(state.select));
    renderOptions(state);
    (state.select.closest('dialog[open]') || document.body).append(state.menu);
    // The top layer prevents settings panels and native dialogs clipping the menu.
    if (state.menu.showPopover) state.menu.showPopover();
    state.trigger.setAttribute('aria-controls',state.menu.id);
    state.trigger.setAttribute('aria-expanded', 'true');
    if (focus) state.trigger.focus();
    position(state); highlight(state, state.index);
  }
  function keydown(state, event) {
    const key = event.key, isOpen = active === state;
    if (isOpen) state.hoverOpen = false;
    if (key === 'Tab') { if (isOpen) choose(state, state.index, false); return; }
    if (key === 'Escape') { if (isOpen) { event.preventDefault(); event.stopPropagation(); close(true); } return; }
    if (event.altKey && key === 'ArrowUp') { if (isOpen) { event.preventDefault(); choose(state, state.index); } return; }
    if (event.ctrlKey || event.metaKey || (event.altKey && key !== 'ArrowDown')) return;
    if (['Enter', ' '].includes(key)) {
      event.preventDefault(); if (isOpen) choose(state, state.index); else open(state); return;
    }
    if (['ArrowDown','ArrowUp','Home','End','PageDown','PageUp'].includes(key)) {
      event.preventDefault();
      if (!isOpen) { open(state); if (key === 'ArrowDown') return; }
      if (active !== state) return;
      const options = enabled(state), current = options.indexOf(state.index);
      const next = key === 'Home' ? 0 : key === 'End' ? options.length - 1 : current + ({ArrowDown:1,ArrowUp:-1,PageDown:10,PageUp:-10}[key] || 0);
      highlight(state, options[Math.max(0, Math.min(options.length - 1, next))]); return;
    }
    if (key.length === 1) {
      event.preventDefault(); if (!isOpen) open(state); if (active !== state) return;
      const now = Date.now(), char = key.toLocaleLowerCase();
      state.buffer = now - (state.typedAt || 0) > 700 ? char : state.buffer + char; state.typedAt = now;
      const search = [...state.buffer].every(letter => letter === char) ? char : state.buffer;
      const options = enabled(state), start = search.length === 1 ? options.indexOf(state.index) + 1 : 0;
      const ordered = options.slice(start).concat(options.slice(0,start));
      const found = ordered.find(index => state.select.options[index].label.toLocaleLowerCase().startsWith(search));
      if (found !== undefined) highlight(state, found);
    }
  }
  function enhance(select) {
    if (controls.has(select) || select.multiple || select.size > 1) return;
    const wrapper = document.createElement('span'); wrapper.className = 'web-select';
    const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'web-select-trigger';
    trigger.setAttribute('role','combobox'); trigger.setAttribute('aria-haspopup','listbox'); trigger.setAttribute('aria-expanded','false');
    const text = document.createElement('span'); text.className = 'web-select-value';
    trigger.append(text);
    if (select.dataset.selectIcon) {
      wrapper.classList.add('web-select-icon');
      trigger.dataset.icon = select.dataset.selectIcon; trigger.setAttribute('data-icon-only','');
    } else trigger.insertAdjacentHTML('beforeend',arrow);
    const menu = document.createElement('div'); menu.id = 'web-select-list-' + (++sequence); menu.className = 'web-select-list';
    menu.setAttribute('role','listbox'); menu.setAttribute('popover','manual');
    const state = {select,wrapper,trigger,text,menu,index:-1,buffer:''}; controls.set(select,state);
    select.before(wrapper); wrapper.append(select,trigger);
    select.classList.add('web-select-native'); select.tabIndex = -1; select.setAttribute('aria-hidden','true');
    // Existing app code can assign .value/.selectedIndex without dispatching change.
    for (const property of ['value','selectedIndex']) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,property);
      Object.defineProperty(select,property,{configurable:true,get(){return descriptor.get.call(this);},set(value){descriptor.set.call(this,value);sync(state);}});
    }
    select.addEventListener('change',()=>sync(state));
    select.addEventListener('focus',()=>trigger.focus());
    select.addEventListener('invalid',event=>{event.preventDefault();open(state);});
    select.form?.addEventListener('reset',()=>queueMicrotask(()=>sync(state)));
    trigger.addEventListener('click',event=>{
      event.preventDefault();
      if(active===state&&state.hoverOpen){state.hoverOpen=false;trigger.focus();}
      else if(active===state)close(true);else open(state);
    });
    if (select.hasAttribute('data-open-on-hover')) {
      const leave=()=>{
        clearTimeout(state.openTimer); clearTimeout(state.closeTimer);
        state.closeTimer=setTimeout(()=>{
          if(active===state&&state.hoverOpen&&!wrapper.matches(':hover')&&!menu.matches(':hover'))close();
        },180);
      };
      wrapper.addEventListener('pointerenter',event=>{
        clearTimeout(state.closeTimer);
        if(event.pointerType==='mouse'&&window.matchMedia('(hover: hover)').matches&&active!==state) {
          clearTimeout(state.openTimer); state.openTimer=setTimeout(()=>open(state,false),120);
        }
      });
      wrapper.addEventListener('pointerleave',leave);
      menu.addEventListener('pointerenter',()=>clearTimeout(state.closeTimer));
      menu.addEventListener('pointerleave',leave);
    }
    trigger.addEventListener('keydown',event=>keydown(state,event));
    menu.addEventListener('pointerdown',event=>event.preventDefault());
    sync(state);
  }
  function scan(root) {
    if (root instanceof HTMLSelectElement) enhance(root);
    root.querySelectorAll?.('select').forEach(enhance);
  }
  new MutationObserver(records=>{
    const changed = new Set();
    for (const record of records) {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      const select = target?.closest('select'); if(select) changed.add(select);
      if (record.attributeName === 'disabled') target?.querySelectorAll('select').forEach(node=>changed.add(node));
      record.addedNodes.forEach(node=>{if(node instanceof Element)scan(node);});
    }
    changed.forEach(select=>{const state=controls.get(select);if(state)sync(state);else enhance(select);});
    if(active&&!active.select.isConnected)close();
  }).observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['disabled','selected','label','value','hidden','aria-label','aria-labelledby','title','required']});
  document.addEventListener('pointerdown',event=>{
    if(active&&!active.wrapper.contains(event.target)&&!active.menu.contains(event.target)){if(active.hoverOpen)close();else choose(active,active.index,false);}
  },true);
  document.addEventListener('focusin',event=>{
    if(active&&!active.wrapper.contains(event.target)&&!active.menu.contains(event.target)){if(active.hoverOpen)close();else choose(active,active.index,false);}
  });
  document.addEventListener('click',event=>{
    if (event.target.closest('button')) return;
    const label=event.target.closest('label'),state=label?.control&&controls.get(label.control);
    if(state){event.preventDefault();state.trigger.focus();}
  });
  document.addEventListener('scroll',event=>{if(active&&!active.menu.contains(event.target))position(active);},true);
  window.addEventListener('blur',()=>close());
  window.addEventListener('resize',()=>{if(active)position(active);});
  window.visualViewport?.addEventListener('resize',()=>{if(active)position(active);});
  scan(document.body);
})();
