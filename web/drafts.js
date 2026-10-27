'use strict';
// Each editor owns a durable slot. Separate tabs must never overwrite each other's
// disconnected work. The frame name is stable when the desktop restores its tabs.
if (!window.name) window.name = `noctua-editor-${crypto.randomUUID()}`;
const NoteDrafts = {
  server: window.noctuaServerId || null,
  owner: window.name,
  prefix(target, id) {
    if (!this.server) throw Error('Server identity is not ready; draft storage unavailable');
    return `noctua.draft.v2:${this.server}:${target}:${id}:`;
  },
  key(target, id) { return this.prefix(target, id) + encodeURIComponent(this.owner); },
  put(target, doc) {
    const snapshot = JSON.stringify(doc);
    localStorage.setItem(this.key(target, doc.id), snapshot);
    return snapshot;
  },
  candidates(target, id) {
    const prefix = this.prefix(target, id), legacy = `noctua.draft.v1:${this.server}:${target}:${id}`;
    const result = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(prefix) && key !== legacy) continue;
      const snapshot = localStorage.getItem(key);
      try {
        const doc = JSON.parse(snapshot);
        if (doc?.id === id && Array.isArray(doc.blocks)) result.push({ key, snapshot, doc });
      } catch { /* Keep unreadable records; never silently delete user data. */ }
    }
    return result.sort((a, b) => Number(b.key === this.key(target, id)) - Number(a.key === this.key(target, id)));
  },
  get(target, id) { return this.candidates(target, id)[0]?.doc || null; },
  acknowledge(target, id, snapshot, key = this.key(target, id)) {
    if (key !== `noctua.draft.v1:${this.server}:${target}:${id}` && !key.startsWith(this.prefix(target, id))) throw Error('Draft belongs to another server or note');
    if (localStorage.getItem(key) === snapshot) localStorage.removeItem(key);
  },
};
window.noctuaServer?.then(s => { NoteDrafts.server = s.server_id; }).catch(() => {});
