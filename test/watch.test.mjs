import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyse, compareSchedule, docsRuntimes, feedItems, parseEolTs, renderIssue } from '../scripts/watch/watch-runtimes.mjs';

const EOL = readFileSync(new URL('../src/eol.ts', import.meta.url), 'utf8');
const SCHEDULE = {
  v22: { start: '2024-04-24', lts: '2024-10-29', end: '2027-04-30', codename: 'Jod' },
  v24: { start: '2025-05-06', lts: '2025-10-28', end: '2028-04-30', codename: 'Krypton' },
  v25: { start: '2025-10-15', end: '2026-06-01' },
  v9: { start: '2018-04-01', end: '2018-06-30' },
};
const DOCS = '<p>Use node20 for Node.js v20.</p><p>Use <code>node24</code> for Node.js v24.</p>';
const FEED = '<rss><channel><item><title>Node 20 is no longer available in GitHub Actions</title><link>https://example.test/a</link></item>' +
  '<item><title>Something about caches</title><link>https://example.test/b</link></item></channel></rss>';
const base = () => ({ schedule: SCHEDULE, eolText: EOL, docsText: DOCS, feedXml: FEED, knownRuntimes: 'node20\nnode24 # x\n', knownChangelog: 'https://example.test/a # x\n' });

test('eol.ts tables parse', () => {
  const t = parseEolTs(EOL);
  assert.equal(t.eol[24], '2028-04-30');
  assert.equal(t.lts.krypton, 24);
});

test('nothing to report when everything matches (old odd lines are ignored)', () => {
  const res = analyse(base());
  assert.deepEqual(res.signals, []);
  assert.deepEqual(res.runtimes, ['node20', 'node24']);
});

test('a new Node line, a changed end date and a new LTS codename are reported', () => {
  const table = parseEolTs(EOL);
  const out = compareSchedule({ v28: { lts: '2031-10-01', end: '2032-04-30', codename: 'Lithium' }, v22: { lts: 'x', end: '2027-05-01', codename: 'Jod' } }, table);
  assert.equal(out.length, 3);
  assert.match(out.join('\n'), /Node 28 .* missing from NODE_EOL/);
  assert.match(out.join('\n'), /"Lithium", which is not in LTS_NAMES/);
  assert.match(out.join('\n'), /Node 22: NODE_EOL says 2027-04-30, the release schedule says 2027-05-01/);
});

test('a new runs.using value, a vanished one and a new changelog entry are reported', () => {
  const res = analyse({ ...base(), docsText: DOCS.replace('node20', 'node26'), feedXml: FEED.replace('example.test/a', 'example.test/c') });
  const text = res.signals.join('\n');
  assert.match(text, /new `runs.using` value: `node26`/);
  assert.match(text, /`node20` is no longer documented/);
  assert.match(text, /New changelog entry: \[Node 20 is no longer available in GitHub Actions\]\(https:\/\/example.test\/c\)/);
  assert.equal(res.signals.length, 3);
});

test('docs scraping and the feed parser', () => {
  assert.deepEqual(docsRuntimes('Use \\u003ccode\\u003enode24\\u003c/code\\u003e for Node.js v24. Use node20 for Node.js v20.'), ['node20', 'node24']);
  assert.equal(feedItems(FEED).length, 2);
});

test('the issue has a stable dedupe key', () => {
  const a = renderIssue(['x', 'y']);
  assert.equal(a.key, renderIssue(['y', 'x']).key);
  assert.match(a.title, /^Node runtime facts: 2 change\(s\) to look at \[[0-9a-f]{8}\]$/);
  assert.match(a.body, new RegExp(`node24-ready:watch:${a.key}`));
});

test('runner-images announcements: only unreviewed deprecation/label news is a signal', async () => {
  const { announcementSignals } = await import('../scripts/watch/watch-runtimes.mjs');
  const issues = [
    { title: '[macOS] The macOS 14 Sonoma based runner images will begin deprecation on July 6th', html_url: 'https://github.com/actions/runner-images/issues/13518' },
    { title: '[Ubuntu] Ubuntu 22 images will be fully unsupported by April 17th', html_url: 'https://github.com/actions/runner-images/issues/14254' },
    { title: '[Windows] MySQL will be updated from 8.0 to 8.4', html_url: 'https://github.com/actions/runner-images/issues/14818' },
    { title: '[Windows] The `windows-11-arm` image label will use Visual Studio 2026', html_url: 'https://github.com/actions/runner-images/issues/14602' },
    { title: '[Ubuntu] Ubuntu 20 will be unsupported', html_url: 'https://github.com/actions/runner-images/issues/99999' },
  ];
  const cited = 'sources: ["https://github.com/actions/runner-images/issues/13518"]';
  const sig = announcementSignals(issues, cited, 'https://github.com/actions/runner-images/issues/14254 # reviewed\n');
  assert.equal(sig.length, 2);
  assert.match(sig[0], /windows-11-arm/);
  assert.match(sig[1], /issues\/99999/);
  const res = analyse({ ...base(), announcements: issues, deadlinesText: cited, knownAnnouncements: '' });
  assert.ok(res.signals.some((s) => s.includes('issues/14254')));
  assert.deepEqual(analyse(base()).signals, []); // announcements are optional input
});
