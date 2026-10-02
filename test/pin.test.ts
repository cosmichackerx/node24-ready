import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { run } from '../src/cli.js';
import { startMock, sha, world, type MockServer } from './mock-github.js';

let mock: MockServer;
before(async () => {
  mock = await startMock(world());
});
after(async () => {
  await mock.close();
});

const WF = [
  'on: push',
  'jobs:',
  '  a:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: acme/checkout@v4',
  '      - uses: acme/checkout@v4.2.0 # needed for X',
  '      - uses: acme/checkout@v5',
  `      - uses: acme/checkout@${sha(4)} # v4.2.0`,
  '      - uses: acme/checkout@main',
  '      - uses: acme/ghost@v1',
  '      - uses: ./local',
  '      - run: echo hi',
  '',
].join('\n');

function project(content = WF): string {
  const dir = mkdtempSync(join(tmpdir(), 'n24pin-'));
  mkdirSync(join(dir, '.github/workflows'), { recursive: true });
  writeFileSync(join(dir, '.github/workflows/ci.yml'), content);
  return dir;
}

async function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await run(args, { stdout: (s) => (out += s), stderr: (s) => (err += s), env: {} });
  return { code, out, err };
}

describe('--pin-only', () => {
  it('pins tags to the commit they point to, keeps the major, never touches branches or SHAs', async () => {
    const dir = project();
    const r = await cli(['-C', dir, '--api-url', mock.url, '--pin-only']);
    assert.equal(r.code, 0, r.err);
    const after = readFileSync(join(dir, '.github/workflows/ci.yml'), 'utf8').split('\n');
    assert.equal(after[5], `      - uses: acme/checkout@${sha(4)} # v4.2.0`); // v4 -> the exact release on the same commit
    assert.equal(after[6], `      - uses: acme/checkout@${sha(4)} # v4.2.0 needed for X`);
    assert.equal(after[7], `      - uses: acme/checkout@${sha(5)} # v5`);
    assert.equal(after[8], `      - uses: acme/checkout@${sha(4)} # v4.2.0`); // already pinned: unchanged
    assert.equal(after[9], '      - uses: acme/checkout@main');
    assert.equal(after[10], '      - uses: acme/ghost@v1');
    assert.match(r.err, /skipped .*acme\/checkout@main.*never pinned/);
    assert.match(r.err, /skipped .*acme\/ghost@v1.*could not be listed/);
    assert.match(r.err, /pinned 3 line\(s\) in 1 file\(s\); 1 already pinned; 2 skipped/);
  });

  it('--dry-run prints a diff that git apply accepts and writes nothing', async () => {
    const { execFileSync } = await import('node:child_process');
    const dir = project();
    const before = readFileSync(join(dir, '.github/workflows/ci.yml'), 'utf8');
    const r = await cli(['-C', dir, '--api-url', mock.url, '--pin-only', '--dry-run']);
    assert.equal(r.code, 0);
    assert.equal(readFileSync(join(dir, '.github/workflows/ci.yml'), 'utf8'), before);
    assert.match(r.out, /^--- a\/\.github\/workflows\/ci\.yml/m);
    writeFileSync(join(dir, 'p.diff'), r.out);
    execFileSync('git', ['apply', '--check', 'p.diff'], { cwd: dir });
  });

  it('is idempotent and does not upgrade (second run changes nothing, checkout@v4 stays on v4 content)', async () => {
    const dir = project();
    await cli(['-C', dir, '--api-url', mock.url, '--pin-only']);
    const once = readFileSync(join(dir, '.github/workflows/ci.yml'), 'utf8');
    const r = await cli(['-C', dir, '--api-url', mock.url, '--pin-only']);
    assert.equal(readFileSync(join(dir, '.github/workflows/ci.yml'), 'utf8'), once);
    assert.match(r.err, /pinned 0 line\(s\)/);
  });

  it('keeps CRLF files intact and rejects --fix / --changed-since combinations', async () => {
    const dir = project(WF.replace(/\n/g, '\r\n'));
    await cli(['-C', dir, '--api-url', mock.url, '--pin-only']);
    const after = readFileSync(join(dir, '.github/workflows/ci.yml'), 'utf8');
    assert.ok(after.includes('\r\n') && !/[^\r]\n/.test(after));
    assert.equal((await cli(['-C', dir, '--pin-only', '--fix'])).code, 2);
    assert.equal((await cli(['-C', dir, '--pin-only', '--changed-since', 'HEAD'])).code, 2);
    assert.equal((await cli(['-C', dir, '--dry-run'])).code, 2);
  });
});
