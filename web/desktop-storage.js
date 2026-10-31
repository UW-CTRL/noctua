'use strict';
// Used only by native origin migration and its regression checks. No data is
// removed from the old origin, and the destination never overwrites saved work.
window.noctuaStorageMigration = {
  allowed(key) {
    return key.startsWith('noctua.') || key.startsWith('pdf-draft:') || key.startsWith('pdf-draft-base:');
  },
  read() {
    try { return {ok:true,entries:Object.entries(localStorage).filter(([key])=>this.allowed(key))}; }
    catch(error) { return {ok:false,error:String(error)}; }
  },
  apply(entries, marker) {
    try {
      if (!Array.isArray(entries) || !entries.every(entry=>Array.isArray(entry) && entry.length===2 && entry.every(v=>typeof v==='string') && this.allowed(entry[0]))) return false;
      for (const [key,value] of entries) {
        if (localStorage.getItem(key)===null) localStorage.setItem(key,value);
        else if (localStorage.getItem(key)!==value && key.startsWith('noctua.draft.')) {
          const recovered=key.replace('noctua.draft.v1:','noctua.draft.v2:')+':migrated';
          if (localStorage.getItem(recovered)===null) localStorage.setItem(recovered,value);
        }
      }
      if (typeof marker==='string') localStorage.setItem(marker,'1');
      return true;
    } catch { return false; }
  },
};
