import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { scan } from '../src/scan.js';
import { startMock, sha, world, type MockServer } from './mock-github.js';

let mock: MockServer;
before(async () => {
  mock = await startMock(world());
});
after(async () => {
  await mock.close();
});

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'n24-'));
  for (const [p, body] of Object.entries(files)) {
    const abs = join(dir, p);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}

const wf = (...uses: string[]): string =>
  `on: push\njobs:\n  a:\n    runs-on: ubuntu-24.04\n    steps:\n${uses.map((u) => `      - uses: ${u}\n`).join('')}`;

const opts = (cwd: string) => ({ paths: ['.'], cwd, clientOptions: { apiUrl: mock.url, retryDelayMs: 0 } });

describe('scan', () => {
  it('flags a direct node20 action and suggests the smallest node24 major', async () => {
    const cwd = project({ '.github/workflows/ci.yml': wf('acme/checkout@v4') });
    const r = await scan(opts(cwd));
    assert.equal(r.findings.length, 1);
    const f = r.findings[0]!;
    assert.equal(f.rule, 'action-runtime-deprecated');
    assert.equal(f.severity, 'error');
    assert.equal(f.runtime, 'node20');
    assert.equal(f.line, 6);
    assert.deepEqual(f.suggestion, { ref: 'v5', tag: 'v5.1.0', sha: sha(51), using: 'node24' });
  });

  it('accepts node24 and ignores local and docker references', async () => {
    const cwd = project({ '.github/workflows/ci.yml': wf('acme/checkout@v5', './local', 'docker://alpine:3') });
    const r = await scan(opts(cwd));
    assert.deepEqual(r.findings, []);
    assert.equal(r.summary.ok, 1);
  });

  it('flags node16 as well', async () => {
    const cwd = project({ '.github/workflows/ci.yml': wf('acme/checkout@v3') });
    const r = await scan(opts(cwd));
    assert.equal(r.findings[0]?.runtime, 'node16');
  });

  it('looks through a composite action (action-runtime-nested)', async () => {
    const cwd = project({ '.github/workflows/ci.yml': wf('acme/setup@v1') });
    const r = await scan(opts(cwd));
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0]?.rule, 'action-runtime-nested');
    assert.deepEqual(r.findings[0]?.via, ['acme/checkout@v4']);
    assert.equal(r.findings[0]?.suggestion?.ref, 'v2');
  });

  it('looks through a reusable workflow', async () => {
    const cwd = project({
      '.github/workflows/ci.yml': 'on: push\njobs:\n  call:\n    uses: acme/flows/.github/workflows/build.yml@main\n',
    });
    const r = await scan(opts(cwd));
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0]?.rule, 'action-runtime-nested');
    assert.match(r.findings[0]?.message ?? '', /reusable workflow/);
  });

  it('reports unresolved actions as warnings, never as errors', async () => {
    const cwd = project({ '.github/workflows/ci.yml': wf('acme/private@v1', 'acme/nothere@v1') });
    const r = await scan(opts(cwd));
    assert.equal(r.findings.length, 2);
    for (const f of r.findings) {
      assert.equal(f.rule, 'action-runtime-unresolved');
      assert.equal(f.severity, 'warning');
    }
  });

  it('says so when no newer release exists', async () => {
    const cwd = project({ '.github/workflows/ci.yml': wf('acme/stuck@v1') });
    const r = await scan(opts(cwd));
    assert.equal(r.findings[0]?.suggestion, undefined);
    assert.match(r.findings[0]?.noSuggestion ?? '', /no release newer than v1/);
  });

  it('resolves a SHA pin to its own commit, not a tag name', async () => {
    const cwd = project({ '.github/workflows/ci.yml': wf(`acme/checkout@${sha(4)} # v4.2.0`) });
    const r = await scan(opts(cwd));
    assert.equal(r.findings[0]?.rule, 'action-runtime-deprecated');
    assert.equal(r.findings[0]?.suggestion?.tag, 'v5.1.0');
  });

  it('flags the repository own action.yml when it declares node20', async () => {
    const cwd = project({ 'action.yml': "name: x\nruns:\n  using: 'node20'\n  main: index.js\n" });
    const r = await scan(opts(cwd));
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0]?.rule, 'local-action-runtime');
    assert.equal(r.findings[0]?.line, 3);
  });

  it('skips suggestions with suggestions:false and makes fewer requests', async () => {
    const cwd = project({ '.github/workflows/ci.yml': wf('acme/checkout@v4') });
    const before = mock.requests.length;
    const r = await scan({ ...opts(cwd), suggestions: false });
    assert.equal(r.findings[0]?.suggestion, undefined);
    assert.equal(mock.requests.length - before, 1);
  });

  it('fetches each distinct reference once', async () => {
    const cwd = project({ '.github/workflows/a.yml': wf('acme/checkout@v5', 'acme/checkout@v5'), '.github/workflows/b.yml': wf('acme/checkout@v5') });
    const before = mock.requests.length;
    const r = await scan(opts(cwd));
    assert.equal(r.summary.uses, 3);
    assert.equal(mock.requests.length - before, 1);
  });

  it('reports invalid YAML instead of crashing or ignoring it silently', async () => {
    const cwd = project({ '.github/workflows/bad.yml': 'a: [unclosed\n', 'notes.txt': 'uses: acme/checkout@v4' });
    const r = await scan(opts(cwd));
    assert.deepEqual(r.findings.map((f) => [f.rule, f.severity, f.file]), [['file-unparseable', 'warning', '.github/workflows/bad.yml']]);
    assert.equal(readFileSync(join(cwd, 'notes.txt'), 'utf8').length > 0, true);
  });
});
