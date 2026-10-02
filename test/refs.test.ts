import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareVersions, isFullSha, parseTagVersion, parseUses } from '../src/refs.js';
import { isDeprecatedUsing } from '../src/runtime.js';
import { parseFile } from '../src/workflow.js';

describe('parseUses', () => {
  it('classifies references', () => {
    assert.deepEqual(parseUses('actions/checkout@v4'), { type: 'remote', owner: 'actions', repo: 'checkout', path: '', ref: 'v4', isWorkflow: false });
    const sub = parseUses('github/codeql-action/upload-sarif@v3');
    assert.equal(sub?.type === 'remote' && sub.path, 'upload-sarif');
    const wf = parseUses('o/r/.github/workflows/x.yml@main');
    assert.equal(wf?.type === 'remote' && wf.isWorkflow, true);
    assert.equal(parseUses('./local')?.type, 'local');
    assert.equal(parseUses('docker://alpine:3')?.type, 'docker');
    assert.equal(parseUses('noref'), null);
  });
  it('knows full SHAs', () => {
    assert.equal(isFullSha('a'.repeat(40)), true);
    assert.equal(isFullSha('v4'), false);
  });
});

describe('versions', () => {
  it('parses tags and compares', () => {
    assert.equal(parseTagVersion('v4')?.floating, true);
    assert.equal(parseTagVersion('v4.2.1')?.floating, false);
    assert.equal(parseTagVersion('latest'), null);
    const a = parseTagVersion('v4.10.0');
    const b = parseTagVersion('v4.9.9');
    assert.ok(a && b && compareVersions(a, b) > 0);
  });
  it('knows deprecated runtimes', () => {
    for (const u of ['node12', 'node16', 'node20', "'node20'"]) assert.equal(isDeprecatedUsing(u.replace(/'/g, '')), true);
    for (const u of ['node24', 'node26', 'composite', 'docker']) assert.equal(isDeprecatedUsing(u), false);
  });
});

describe('parseFile', () => {
  it('extracts uses with positions, step and job level, and runs.using', () => {
    const p = parseFile('a.yml', 'jobs:\n  j:\n    uses: o/r/.github/workflows/w.yml@v1\n  k:\n    steps:\n      - uses: a/b@v1 # c\n');
    assert.deepEqual(p.uses.map((u) => [u.value, u.line, u.column]), [
      ['o/r/.github/workflows/w.yml@v1', 3, 11],
      ['a/b@v1', 6, 15],
    ]);
    assert.equal(p.uses[1]?.comment, 'c');
    const a = parseFile('action.yml', 'runs:\n  using: node20\n  main: x.js\n');
    assert.equal(a.runsUsing?.value, 'node20');
    assert.equal(a.runsUsing?.line, 2);
  });
  it('reports invalid YAML instead of throwing', () => {
    assert.ok(parseFile('a.yml', 'a: [x\n').error);
  });
});
