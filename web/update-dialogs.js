'use strict';
// Shared release history and in-app confirmation for server pages and the offline native manager.
globalThis.NoctuaUpdateDialogs = (() => {
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function summary(result, currentVersion = 'Current version') {
  const labels = { breaking: 'Breaking changes', features: 'New', fixes: 'Fixed', improvements: 'Improved', other: 'Other' };
  const releases = Array.isArray(result.releases) && result.releases.length ? result.releases : [{ version: result.version, changes: [] }];
  return `<p class="update-version">${esc(result.current_version || currentVersion || 'Current version')} → ${esc(result.version)}</p>` +
    '<p class="update-history-hint">Release highlights, newest first. Open each version’s release notes for full details.</p>' +
    releases.map(release => {
      const changes = Array.isArray(release.changes) ? release.changes : [];
      const items = changes.filter(group => group && typeof group === 'object').flatMap(group => (Array.isArray(group.items) ? group.items : []).slice(0, 2)
        .map(item => `<li><strong>${Object.prototype.hasOwnProperty.call(labels, group.kind) ? labels[group.kind] : 'Other'}:</strong> ${esc(String(item))}</li>`)).slice(0, 6);
      return `<section class="update-release"><h4>Version ${esc(release.version)} <a href="https://github.com/UW-CTRL/noctua/releases/tag/v${encodeURIComponent(release.version)}" target="_blank" rel="noopener" aria-label="Full release notes for version ${esc(release.version)}">Release notes</a></h4>` +
        (items.length ? `<ul>${items.join('')}</ul>` : '<p>See the full release notes for details.</p>') + '</section>';
    }).join('') + `<p><a href="https://github.com/UW-CTRL/noctua/compare/v${encodeURIComponent(result.current_version || currentVersion || '')}...v${encodeURIComponent(result.version)}" target="_blank" rel="noopener">All changes since your version</a> · <a href="https://github.com/UW-CTRL/noctua/releases/tag/v${encodeURIComponent(result.version)}" target="_blank" rel="noopener">Full release notes</a></p>`;
}

function confirmInstall(version, {className = 'setup-card'} = {}) {
  if (document.querySelector('#app-update-confirm-dialog')) return Promise.resolve(false);
  return new Promise(resolve => {
    const previousFocus = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.id = 'app-update-confirm-dialog';
    dialog.className = className;
    dialog.setAttribute('aria-labelledby', 'app-update-confirm-title');
    dialog.innerHTML = `<h2 id="app-update-confirm-title">Install Noctua ${esc(version)}?</h2>
      <p>Save your work before continuing. Noctua may close and restart during installation.</p>
      <div class="setup-actions end"><button data-cancel>Cancel</button><button class="primary" data-confirm>Install update</button></div>`;
    let confirmed = false;
    dialog.addEventListener('close', () => {
      dialog.remove();
      if (previousFocus?.isConnected) previousFocus.focus();
      resolve(confirmed);
    }, { once: true });
    dialog.querySelector('[data-cancel]').addEventListener('click', () => dialog.close());
    dialog.querySelector('[data-confirm]').addEventListener('click', () => { confirmed = true; dialog.close(); });
    dialog.addEventListener('cancel', event => { event.preventDefault(); dialog.close(); });
    document.body.appendChild(dialog);
    dialog.showModal();
    dialog.querySelector('[data-cancel]').focus();
  });
}

return {summary, confirmInstall};
})();
