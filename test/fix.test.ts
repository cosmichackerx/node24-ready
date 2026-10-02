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
      '    runs-on: ubuntu-latest',
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
        '    runs-on: ubuntu-latest',
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
