import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { applyFixes } from '../src/fix.js';
import { scan } from '../src/scan.js';
import { startMock, sha, world, type MockServer } from './mock-github.js';

let mock: MockServer;
before(async () => {
  mock = await startMock(world());
});
after(async () => {
  await mock.close();
});

describe('applyFixes', () => {
  it('rewrites tag refs and sha pins (with the version comment), keeps everything else', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n24fix-'));
    mkdirSync(join(dir, '.github/workflows'), { recursive: true });
    const file = join(dir, '.github/workflows/ci.yml');
    const original = [
      'on: push',
      'jobs:',
      '  a:',
      '    runs-on: ubuntu-24.04',
      '    steps:',
      '      - uses: acme/checkout@v4   # keep this',
      `      - uses: "acme/checkout@${sha(4)}" # v4.2.0`,
      '      - uses: acme/checkout@v5',
      '      - run: echo hi',
      '',
    ].join('\r\n');
    writeFileSync(file, original);
    const r = await scan({ paths: ['.'], cwd: dir, clientOptions: { apiUrl: mock.url, retryDelayMs: 0 } });
    const changes = applyFixes(r.findings, dir);
    assert.equal(changes.length, 2);
    const after = readFileSync(file, 'utf8');
    assert.equal(
      after,
      [
        'on: push',
        'jobs:',
        '  a:',
        '    runs-on: ubuntu-24.04',
        '    steps:',
        '      - uses: acme/checkout@v5   # keep this',
        `      - uses: "acme/checkout@${sha(51)}" # v5.1.0`,
        '      - uses: acme/checkout@v5',
        '      - run: echo hi',
        '',
      ].join('\r\n'),
    );
    const again = await scan({ paths: ['.'], cwd: dir, clientOptions: { apiUrl: mock.url, retryDelayMs: 0 } });
    assert.deepEqual(again.findings, []);
  });

  it('leaves findings without a suggestion and local-action findings alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'n24fix-'));
    mkdirSync(join(dir, '.github/workflows'), { recursive: true });
    const file = join(dir, '.github/workflows/ci.yml');
    const body = 'on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - uses: acme/stuck@v1\n';
    writeFileSync(file, body);
    const r = await scan({ paths: ['.'], cwd: dir, clientOptions: { apiUrl: mock.url, retryDelayMs: 0 } });
    assert.deepEqual(applyFixes(r.findings, dir), []);
    assert.equal(readFileSync(file, 'utf8'), body);
  });
});

describe('--fix --dry-run', () => {
  const sh = async (...args: string[]) => {
    const { spawnSync } = await import('node:child_process');
    return spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });
  };
  for (const eol of ['\n', '\r\n']) {
    it(`prints a unified diff that git apply accepts and leaves the files alone (${JSON.stringify(eol)})`, async () => {
      const { run } = await import('../src/cli.js');
      const dir = mkdtempSync(join(tmpdir(), 'n24dry-'));
      mkdirSync(join(dir, '.github/workflows'), { recursive: true });
      const file = join(dir, '.github/workflows/ci.yml');
      const original = ['on: push', 'jobs:', '  a:', '    runs-on: ubuntu-24.04', '    steps:', '      - uses: acme/checkout@v4', ...Array.from({ length: 9 }, (_, i) => `      - run: echo ${i}`), `      - uses: "acme/checkout@${sha(4)}" # v4.2.0`, ''].join(eol);
      writeFileSync(file, original);
      let out = '';
      let err = '';
      const code = await run(['--fix', '--dry-run', '-C', dir, '--api-url', mock.url], { stdout: (s) => (out += s), stderr: (s) => (err += s), env: {} });
      assert.equal(code, 0);
      assert.equal(readFileSync(file, 'utf8'), original, 'dry run must not write');
      assert.match(err, /dry run: 2 line\(s\) in 1 file\(s\) would change; nothing was written/);
      assert.equal((out.match(/^@@ /gm) ?? []).length, 2, 'two separate hunks');
      assert.match(out, /^-      - uses: acme\/checkout@v4/m);
      assert.match(out, /^\+      - uses: acme\/checkout@v5/m);
      const patch = join(dir, 'fix.patch');
      writeFileSync(patch, out);
      const r = await sh('init', '-q', dir);
      assert.equal(r.status, 0);
      const apply = await sh('-C', dir, 'apply', '--check', 'fix.patch');
      assert.equal(apply.status, 0, apply.stderr);
      assert.equal((await sh('-C', dir, 'apply', 'fix.patch')).status, 0);
      assert.match(readFileSync(file, 'utf8'), /acme\/checkout@v5/);
    });
  }

  it('is a usage error without --fix', async () => {
    const { run } = await import('../src/cli.js');
    let err = '';
    assert.equal(await run(['--dry-run'], { stdout: () => undefined, stderr: (s) => (err += s), env: {} }), 2);
    assert.match(err, /--dry-run only makes sense together with --fix/);
  });
});
