const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarize, releaseSummaries } = require('./release-summary.cjs');

test('generated categories become concise plain-text highlights without authors or URLs', () => {
  assert.deepEqual(summarize("## What's Changed\n### New Features\n* Add [startup prompts](https://example.com) by @author in https://example.com/pull/1\n### Bug Fixes\n* Fix **update** retries\n### New Contributors\n* @new made their first contribution\n**Full Changelog**: https://example.com"), [
    { kind: 'features', items: ['Add startup prompts'] }, { kind: 'fixes', items: ['Fix update retries'] },
  ]);
});

test('curated update summaries override generated notes while keeping breaking changes first', () => {
  const body = '* A long generated item\n<!-- noctua:update-summary -->\n### Fixed\n- Preserve settings\n### Breaking Changes\n- Requires a new data format\n<!-- /noctua:update-summary -->\n* Another generated item';
  assert.deepEqual(summarize(body), [
    { kind: 'breaking', items: ['Requires a new data format'] }, { kind: 'fixes', items: ['Preserve settings'] },
  ]);
});

test('summaries are bounded, deduplicated, and exclude images and code examples', () => {
  const long = 'x'.repeat(200);
  const result = summarize(`### Improvements\n- ${long}\n- Second\n- Third\n### Bug Fixes\n- Fix\n- Fix\n- Another\n### New Features\n- One\n- Two\n- Three\n### Other Changes\n- Omitted\n\n\u0060\u0060\u0060\n- Code example\n\u0060\u0060\u0060\n- ![Screenshot](https://example.com/image.png)`);
  assert.equal(result.flatMap(group => group.items).length, 6);
  assert.equal(result.find(g => g.kind === 'improvements').items[0].length, 108);
  assert(!JSON.stringify(result).includes('Code example'));
  assert(!JSON.stringify(result).includes('Screenshot'));
});

test('history is sorted numerically and excludes drafts, prereleases, future versions, and duplicates', () => {
  const result = releaseSummaries({ tag_name: 'v0.10.0', body: '- Latest' }, [
    { tag_name: 'v0.2.0', body: '- Older' }, { tag_name: 'v0.3.0', draft: true },
    { tag_name: 'v0.4.0', prerelease: true }, { tag_name: 'v0.5.0-beta' },
    { tag_name: 'v0.11.0' }, { tag_name: 'v0.2.0' }, { tag_name: 'v0.9.0' },
  ]);
  assert.deepEqual(result.map(r => r.version), ['0.10.0', '0.9.0', '0.2.0']);
});
