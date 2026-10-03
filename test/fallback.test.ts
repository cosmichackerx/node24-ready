import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { run } from '../src/cli.js';
import { parseLsRemote } from '../src/github.js';
import { scan } from '../src/scan.js';
import { startMock, world, type MockServer } from './mock-github.js';

const repos = world();
let mock: MockServer;
let raw: Server;
let rawUrl = '';
const rawHits: string[] = [];
const limited: { after: number; seen: number } = { after: 0, seen: 0 };
let limitedApi: Server;
let limitedUrl = '';

before(async () => {
  mock = await startMock(repos);
  // raw.githubusercontent.com look-alike: /<owner>/<repo>/<ref>/<path>
  raw = createServer((req, res) => {
    rawHits.push(req.url ?? '');
    const m = /^\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(req.url ?? '');
    const body = m ? repos[`${m[1]}/${m[2]}`]?.files[`${decodeURIComponent(m[4] as string)}@${decodeURIComponent(m[3] as string)}`] : undefined;
    if (body === undefined) res.writeHead(404).end('404: Not Found');
    else res.writeHead(200, { 'content-type': 'text/plain' }).end(body);
  });
  await new Promise<void>((r) => raw.listen(0, '127.0.0.1', r));
  rawUrl = `http://127.0.0.1:${(raw.address() as AddressInfo).port}`;
  // an API that works for `after` requests and then reports the rate limit
  limitedApi = createServer((req, res) => {
    limited.seen++;
    if (limited.seen > limited.after) return void res.writeHead(403, { 'x-ratelimit-remaining': '0' }).end('{"message":"API rate limit exceeded"}');
    const u = new URL(req.url ?? '/', 'http://x');
    const m = /^\/repos\/([^/]+)\/([^/]+)\/(contents\/(.+)|tags)$/.exec(u.pathname);
    const repo = m ? repos[`${m[1]}/${m[2]}`] : undefined;
    if (!m || !repo) return void res.writeHead(404).end('{}');
    if (m[3] === 'tags') return void res.writeHead(200).end(JSON.stringify(repo.tags.map((t) => ({ name: t.name, commit: { sha: t.sha } }))));
    const body = repo.files[`${decodeURIComponent(m[4] as string)}@${u.searchParams.get('ref')}`];
    if (body === undefined) res.writeHead(404).end('{}');
    else res.writeHead(200).end(body);
  });
  await new Promise<void>((r) => limitedApi.listen(0, '127.0.0.1', r));
  limitedUrl = `http://127.0.0.1:${(limitedApi.address() as AddressInfo).port}`;
});
after(async () => {
  await mock.close();
  await new Promise((r) => raw.close(r));
  await new Promise((r) => limitedApi.close(r));
});

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'n24fb-'));
  mkdirSync(join(dir, '.github/workflows'), { recursive: true });
  writeFileSync(join(dir, '.github/workflows/ci.yml'), 'on: push\njobs:\n  a:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: acme/checkout@v4\n      - uses: acme/setup@v1\n');
  return dir;
}

const gitTags = async (owner: string, repo: string) => repos[`${owner}/${repo}`]?.tags ?? null;

describe('rate-limit fallback (raw files + git ls-remote)', () => {
  it('gives the same findings through the fallback as through the API', async () => {
    const dir = project();
    const viaApi = await scan({ paths: ['.'], cwd: dir, clientOptions: { apiUrl: mock.url, retryDelayMs: 0 } });
    limited.after = 0;
    limited.seen = 0;
    const viaFallback = await scan({ paths: ['.'], cwd: dir, clientOptions: { apiUrl: limitedUrl, rawUrl, gitTags, retryDelayMs: 0 } });
    const shape = (r: typeof viaApi) => r.findings.map((f) => `${f.line} ${f.rule} ${f.uses} -> ${f.suggestion?.tag ?? ''}`);
    assert.ok(viaApi.findings.length >= 2);
    assert.deepEqual(shape(viaFallback), shape(viaApi));
    assert.ok((viaFallback.summary.fallbackLookups ?? 0) > 0);
    assert.equal(viaApi.summary.fallbackLookups, undefined);
    assert.ok(rawHits.some((h) => h === '/acme/checkout/v4/action.yml'));
  });

  it('switches over in the middle of a run when the limit is hit part-way', async () => {
    limited.after = 2;
    limited.seen = 0;
    const r = await scan({ paths: ['.'], cwd: project(), clientOptions: { apiUrl: limitedUrl, rawUrl, gitTags, retryDelayMs: 0 } });
    assert.ok(r.findings.length >= 2);
    assert.ok((r.summary.fallbackLookups ?? 0) > 0);
    assert.ok(r.summary.fetches >= 3);
  });

  it('--no-fallback keeps the old behaviour: exit 2 with a clear message', async () => {
    limited.after = 0;
    limited.seen = 0;
    let err = '';
    const code = await run(['-C', project(), '--api-url', limitedUrl, '--no-fallback'], { stdout: () => undefined, stderr: (s) => (err += s), env: { GITHUB_TOKEN: 'x' } });
    assert.equal(code, 2);
    assert.match(err, /rate limit/);
  });


  it('a missing file stays missing and a failing git lister gives unresolved, not a crash', async () => {
    limited.after = 0;
    limited.seen = 0;
    const dir = mkdtempSync(join(tmpdir(), 'n24fb-'));
    mkdirSync(join(dir, '.github/workflows'), { recursive: true });
    writeFileSync(join(dir, '.github/workflows/ci.yml'), 'on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - uses: acme/checkout@v4\n      - uses: acme/nonexistent@v1\n');
    const r = await scan({ paths: ['.'], cwd: dir, clientOptions: { apiUrl: limitedUrl, rawUrl, gitTags: async () => { throw new Error('git missing'); }, retryDelayMs: 0 } });
    assert.ok(r.findings.some((f) => f.uses === 'acme/checkout@v4' && f.rule === 'action-runtime-deprecated'));
    assert.ok(!r.findings.some((f) => f.uses === 'acme/checkout@v4' && f.suggestion), 'no upgrade target without a tag list');
  });
});

describe('parseLsRemote against real `git ls-remote` output', () => {
  it('prefers the peeled commit of annotated tags', () => {
    const dir = mkdtempSync(join(tmpdir(), 'n24ls-'));
    const g = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@e.x', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8' });
    g('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'f'), '1');
    g('add', '-A');
    g('commit', '-q', '-m', 'one');
    g('tag', 'v1');
    g('tag', '-a', 'v2', '-m', 'annotated');
    const commit = g('rev-parse', 'HEAD').trim();
    const tags = parseLsRemote(g('ls-remote', '--tags', dir));
    assert.deepEqual(tags.sort((a, b) => a.name.localeCompare(b.name)), [
      { name: 'v1', sha: commit },
      { name: 'v2', sha: commit },
    ]);
    assert.notEqual(g('rev-parse', 'v2').trim(), commit, 'v2 really is an annotated tag object');
  });
});
