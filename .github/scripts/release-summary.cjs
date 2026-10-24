// Keep update prompts short; maintainers can supply a curated summary in release notes.
const kinds = [
  ['breaking', /breaking/i], ['features', /new features|added|features/i],
  ['fixes', /bug fixes|fixed|fixes/i], ['improvements', /improvements|improved|changed/i],
];
const numericVersion = tag => /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag || '')?.slice(1).map(Number);
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

function summarize(body = '') {
  const curated = body.match(/<!-- noctua:update-summary -->([\s\S]*?)<!-- \/noctua:update-summary -->/);
  const groups = new Map();
  let kind = 'other', count = 0, inCode = false;
  for (const line of (curated?.[1] || body).split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { inCode = !inCode; continue; }
    if (inCode) continue;
    const heading = line.match(/^#{1,6}\s+(.+)/);
    if (heading) {
      kind = /contributors|full changelog/i.test(heading[1]) ? null :
        kinds.find(([, pattern]) => pattern.test(heading[1]))?.[0] || 'other';
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.+)/);
    if (!bullet || !kind || count >= 6) continue;
    let text = bullet[1].replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\s+by\s+@\S+.*$/i, '')
      .replace(/https?:\/\/\S+/g, '').replace(/<!--.*?-->/g, '')
      .replace(/<[^>]*>/g, '').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    text = text.length > 110 ? text.slice(0, 107).trimEnd() + '…' : text;
    const items = groups.get(kind) || [];
    if (items.length >= 2 || items.includes(text)) continue;
    groups.set(kind, [...items, text]);
    count++;
  }
  return [...kinds.map(([kind]) => kind), 'other']
    .filter(kind => groups.has(kind)).map(kind => ({ kind, items: groups.get(kind) }));
}

function releaseSummaries(release, history) {
  const latest = numericVersion(release.tag_name);
  if (!latest) throw new Error('Updater summaries require a numeric release version.');
  const releases = [release, ...history.filter(item => !item.draft && !item.prerelease &&
    numericVersion(item.tag_name) && compare(numericVersion(item.tag_name), latest) < 0)];
  const unique = new Map();
  for (const item of releases) {
    const version = numericVersion(item.tag_name).join('.');
    if (!unique.has(version)) unique.set(version, { version, changes: summarize(item.body || '') });
  }
  return [...unique.values()].sort((a, b) => compare(numericVersion(b.version), numericVersion(a.version)));
}

module.exports = { summarize, releaseSummaries };
