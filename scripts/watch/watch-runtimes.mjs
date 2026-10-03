#!/usr/bin/env node
// Diff the facts node24-ready hard-codes against their sources and report what moved. Standard library only (Node 20+).
//
//   1. src/eol.ts NODE_EOL / LTS_NAMES  vs  https://github.com/nodejs/Release schedule.json   (new release lines, changed end dates, new LTS codenames)
//   2. the `runs.using` node values GitHub documents (metadata-syntax page)  vs  scripts/watch/known-runtimes.txt
//   3. GitHub changelog (label: actions) entries about Node / runtimes  vs  scripts/watch/known-changelog.txt
//
// Exit codes: 0 nothing to report, 3 something to look at, 2 network/usage error. `--out FILE` writes JSON with an issue title and body.
// The changelog feed holds only the latest ~10 entries and the docs page is scraped for a sentence ("Use node24 for Node.js v24"),
// so both are signals, not proof; the Node release schedule is the authoritative source for (1).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEDULE_URL = 'https://raw.githubusercontent.com/nodejs/Release/main/schedule.json';
export const DOCS_URL = 'https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax';
export const FEED_URL = 'https://github.blog/changelog/label/actions/feed/';
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

export function parseEolTs(text) {
  const table = /NODE_EOL[^{]*\{([^}]*)\}/s.exec(text);
  const names = /LTS_NAMES[^{]*\{([^}]*)\}/s.exec(text);
  const eol = {};
  for (const m of (table?.[1] ?? '').matchAll(/(\d+):\s*'(\d{4}-\d{2}-\d{2})'/g)) eol[Number(m[1])] = m[2];
  const lts = {};
  for (const m of (names?.[1] ?? '').matchAll(/([a-z]+):\s*(\d+)/g)) lts[m[1]] = Number(m[2]);
  return { eol, lts };
}

export function compareSchedule(schedule, table) {
  const out = [];
  for (const [key, v] of Object.entries(schedule)) {
    const major = Number(key.replace(/^v/, ''));
    if (!Number.isInteger(major) || !v.end || major < 8) continue; // the table starts at Node 8
    const newest = Math.max(...Object.keys(table.eol).map(Number));
    if (!(major in table.eol) && !(v.lts || major > newest)) continue; // short-lived odd lines below the newest known one never matter
    if (!(major in table.eol)) out.push(`Node ${major} (end of life ${v.end}) is missing from NODE_EOL in src/eol.ts`);
    else if (table.eol[major] !== v.end) out.push(`Node ${major}: NODE_EOL says ${table.eol[major]}, the release schedule says ${v.end}`);
    const name = (v.codename || '').toLowerCase();
    if (name && !(name in table.lts)) out.push(`Node ${major} has the LTS codename "${v.codename}", which is not in LTS_NAMES in src/eol.ts`);
    else if (name && table.lts[name] !== major) out.push(`LTS_NAMES maps "${v.codename}" to ${table.lts[name]}, the schedule says ${major}`);
  }
  return out;
}

export function docsRuntimes(text) {
  const plain = text.replace(/\\u003c[^]*?\\u003e/g, '').replace(/<[^>]+>/g, ' ');
  return [...new Set([...plain.matchAll(/Use\s+(node\d+)\s+for\s+Node\.js/gi)].map((m) => m[1].toLowerCase()))].sort();
}

export function parseList(text) {
  return new Set(text.split('\n').map((l) => l.split('#')[0].trim()).filter(Boolean).map((l) => l.split(/\s+/)[0]));
}

export function feedItems(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const title = /<title>([\s\S]*?)<\/title>/.exec(m[1])?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    const link = /<link>([\s\S]*?)<\/link>/.exec(m[1])?.[1]?.trim();
    if (title && link) items.push({ title, link });
  }
  return items;
}

const NODE_NEWS = /node\s?\d+|node\.js|runs\.using|javascript actions|actions runtime/i;

export function analyse({ schedule, eolText, docsText, feedXml, knownRuntimes, knownChangelog }) {
  const signals = [];
  signals.push(...compareSchedule(schedule, parseEolTs(eolText)));
  const now = docsRuntimes(docsText);
  const known = parseList(knownRuntimes);
  for (const r of now) if (!known.has(r)) signals.push(`GitHub documents a new \`runs.using\` value: \`${r}\` (known: ${[...known].sort().join(', ')})`);
  for (const r of known) if (!now.includes(r)) signals.push(`\`${r}\` is no longer documented as a \`runs.using\` value`);
  const seen = parseList(knownChangelog);
  const news = feedItems(feedXml).filter((i) => NODE_NEWS.test(i.title) && !seen.has(i.link));
  for (const i of news) signals.push(`New changelog entry: [${i.title}](${i.link})`);
  return { signals, runtimes: now, docsValues: now.length, feedMatches: feedItems(feedXml).filter((i) => NODE_NEWS.test(i.title)).length };
}

export function renderIssue(signals) {
  const key = createHash('sha1').update([...signals].sort().join('\n')).digest('hex').slice(0, 8);
  const title = `Node runtime facts: ${signals.length} change(s) to look at [${key}]`;
  const body = [
    'Opened by the scheduled `Runtime watch` workflow.', '', '### Signals', '', ...signals.map((s) => `- ${s}`), '', '### What to do', '',
    '1. `src/eol.ts`: add the Node line / LTS codename or fix the end-of-life date; run the tests.',
    '2. `src/workflow.ts` `MIN_NODE_MAJOR`: change it only when GitHub has announced a removal (not for a new runtime value alone).',
    '3. Record the signal as known: `scripts/watch/known-runtimes.txt` / `known-changelog.txt` (add the value or link).',
    'Close this issue when the lists cover every line.', '', `<!-- node24-ready:watch:${key} -->`,
  ].join('\n');
  return { title, body, key };
}

async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'node24-ready-watch', accept: '*/*' } });
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  return res.text();
}

async function main(argv) {
  const arg = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
  const known = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
  const inputs = {
    knownRuntimes: known(arg('--known-runtimes', join(HERE, 'known-runtimes.txt'))),
    knownChangelog: known(arg('--known-changelog', join(HERE, 'known-changelog.txt'))),
    eolText: readFileSync(join(ROOT, 'src', 'eol.ts'), 'utf8'),
  };
  try {
    const dir = arg('--pages-dir');
    if (dir) {
      inputs.schedule = JSON.parse(readFileSync(join(dir, 'schedule.json'), 'utf8'));
      inputs.docsText = readFileSync(join(dir, 'metadata-syntax.html'), 'utf8');
      inputs.feedXml = readFileSync(join(dir, 'feed.xml'), 'utf8');
    } else {
      [inputs.schedule, inputs.docsText, inputs.feedXml] = [JSON.parse(await get(SCHEDULE_URL)), await get(DOCS_URL), await get(FEED_URL)];
    }
  } catch (e) {
    console.error(`error: ${e.message}`);
    return 2;
  }
  if (argv.includes('--print-baseline')) {
    for (const r of docsRuntimes(inputs.docsText)) console.log(`${r}  # baseline`);
    for (const i of feedItems(inputs.feedXml).filter((x) => NODE_NEWS.test(x.title))) console.error(`${i.link}  # baseline: ${i.title}`);
    return 0;
  }
  const res = analyse(inputs);
  if (res.docsValues === 0) {
    console.error('error: found no runs.using values in the docs page; the layout may have changed');
    return 2;
  }
  const issue = res.signals.length ? renderIssue(res.signals) : null;
  if (arg('--out')) writeFileSync(arg('--out'), JSON.stringify({ ...res, ...(issue ?? {}) }, null, 2));
  console.log(`documented runtimes: ${res.runtimes.join(', ')}; node-related changelog entries: ${res.feedMatches}; signals: ${res.signals.length}`);
  for (const s of res.signals) console.log('  SIGNAL', s);
  return res.signals.length ? 3 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(await main(process.argv.slice(2)));
