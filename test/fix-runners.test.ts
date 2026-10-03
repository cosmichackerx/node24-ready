import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { run } from '../src/cli.js';

const setup = (text: string, eol = '\n') => {
  const dir = mkdtempSync(join(tmpdir(), 'n24r-'));
  mkdirSync(join(dir, '.github/workflows'), { recursive: true });
  const file = join(dir, '.github/workflows/ci.yml');
  writeFileSync(file, text.split('\n').join(eol));
  return { dir, file };
};
const cli = async (args: string[]) => {
  let out = '';
  let err = '';
  const code = await run(args, { stdout: (s) => (out += s), stderr: (s) => (err += s), env: {} });
  return { code, out, err };
};
const base = ['--today', '2026-10-03', '--no-suggest', '--fix-runners'];

const WF = [
  'on: push',
  'jobs:',
  '  a:',
  '    runs-on: macos-14   # keep',
  '    steps: [{ run: echo }]',
  '  b:',
  '    runs-on: "ubuntu-22.04"',
  '    steps: [{ run: echo }]',
  '  c:',
  '    runs-on: [self-hosted, macos-14-xlarge]',
  '    steps: [{ run: echo }]',
  '  d:',
  '    runs-on: ${{ matrix.os }}',
  '    strategy:',
  '      matrix:',
  '        os: [macos-14, ubuntu-latest, ubuntu-22.04-arm]',
  '    steps: [{ run: echo }]',
  '  e:',
  '    runs-on: macos-13',
  '    steps: [{ run: echo }]',
  '',
].join('\n');

describe('--fix-runners', () => {
  it('rewrites scalars, quoted scalars, list items and matrix entries one generation up; leaves macos-13 and ubuntu-latest alone', async () => {
    const { dir, file } = setup(WF);
    const r = await cli(['-C', dir, ...base, '.']);
    assert.equal(r.code, 0);
    const out = readFileSync(file, 'utf8');
    assert.match(out, /runs-on: macos-15   # keep/);
    assert.match(out, /runs-on: "ubuntu-24.04"/);
    assert.match(out, /\[self-hosted, macos-15-xlarge\]/);
    assert.match(out, /os: \[macos-15, ubuntu-latest, ubuntu-24.04-arm\]/);
    assert.match(out, /runs-on: macos-13/);
    assert.match(r.err, /Ubuntu 24.04 image/);
    // second run changes nothing
    const again = await cli(['-C', dir, ...base, '.']);
    assert.match(again.err, /found no label it could rewrite safely/);
    assert.equal(readFileSync(file, 'utf8'), out);
  });

  it('--dry-run writes nothing and prints a diff', async () => {
    const { dir, file } = setup(WF);
    const r = await cli(['-C', dir, ...base, '--dry-run', '.']);
    assert.equal(r.code, 0);
    assert.equal(readFileSync(file, 'utf8'), WF);
    assert.match(r.out, /^-    runs-on: macos-14   # keep$/m);
    assert.match(r.out, /^\+    runs-on: macos-15   # keep$/m);
    assert.match(r.err, /dry run: 5 label\(s\)/);
  });

  it('keeps CRLF line endings', async () => {
    const { dir, file } = setup(WF, '\r\n');
    await cli(['-C', dir, ...base, '.']);
    const out = readFileSync(file, 'utf8');
    assert.ok(out.includes('runs-on: macos-15   # keep\r\n'));
    assert.ok(!/[^\r]\n/.test(out));
  });

  it('does not create a duplicate when the target is already in the matrix', async () => {
    const wf = 'on: push\njobs:\n  a:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [macos-14, macos-15]\n    steps: [{ run: echo }]\n';
    const { dir, file } = setup(wf);
    await cli(['-C', dir, ...base, '.']);
    assert.equal(readFileSync(file, 'utf8'), wf);
  });

  it('is opt-in: plain --fix and a plain scan leave runner labels alone', async () => {
    const { dir, file } = setup(WF);
    await cli(['-C', dir, '--today', '2026-10-03', '--no-suggest', '.']);
    assert.equal(readFileSync(file, 'utf8'), WF);
  });

  it('refuses unsafe flag combinations', async () => {
    const { dir } = setup(WF);
    assert.equal((await cli(['-C', dir, '--fix-runners', '--no-deadlines', '.'])).code, 2);
    assert.equal((await cli(['-C', dir, '--fix-runners', '--fix', '--dry-run', '.'])).code, 2);
  });

  it('findings carry the label position as JSON for tools', async () => {
    const { dir } = setup(WF);
    const r = await cli(['-C', dir, '--today', '2026-10-03', '--no-suggest', '--format', 'json', '.']);
    const f: { labelFix: { from: string; to: string } } = JSON.parse(r.out).findings.find((x: { uses: string; labelFix?: unknown }) => x.uses === 'macos-14' && x.labelFix);
    assert.deepEqual({ from: f.labelFix.from, to: f.labelFix.to }, { from: 'macos-14', to: 'macos-15' });
  });
});
