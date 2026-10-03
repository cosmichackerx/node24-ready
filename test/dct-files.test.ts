import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { run } from '../src/cli.js';
import { dctSites } from '../src/deadlines.js';

const tree = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'n24dct-'));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  return dir;
};
const cli = async (args: string[]) => {
  let out = '';
  const code = await run(args, { stdout: (s) => (out += s), stderr: () => {}, env: {} });
  return { code, out };
};
const sites = (text: string) => dctSites('x', text).map((s) => `${s.line}:${s.what}`);

describe('Docker Content Trust outside .github', () => {
  it('finds ENV/ARG in a Dockerfile, the old space form, and a RUN prefix', () => {
    assert.deepEqual(sites('FROM x\nENV DOCKER_CONTENT_TRUST=1\nARG DOCKER_CONTENT_TRUST=true\nENV DOCKER_CONTENT_TRUST 1\nRUN DOCKER_CONTENT_TRUST=1 docker pull y\n').map((s) => s.split(':')[0]), ['2', '3', '4', '5']);
  });
  it('ignores switched-off values, comments and unrelated names', () => {
    assert.deepEqual(sites('ENV DOCKER_CONTENT_TRUST=0\n# ENV DOCKER_CONTENT_TRUST=1\nENV DOCKER_CONTENT_TRUST_SERVER=https://x\nENV MY_DOCKER_CONTENT_TRUST=1\n'), []);
  });
  it('reads compose maps and lists', () => {
    assert.equal(sites('services:\n  a:\n    environment:\n      DOCKER_CONTENT_TRUST: "1"\n  b:\n    environment:\n      - DOCKER_CONTENT_TRUST=1\n').length, 2);
  });
  it('reads the Kubernetes env list form (name and value on separate lines) and the flow form', () => {
    const k8s = 'spec:\n  containers:\n    - name: a\n      env:\n        - name: DOCKER_CONTENT_TRUST\n          value: "1"\n        - { name: DOCKER_CONTENT_TRUST, value: "true" }\n        - name: DOCKER_CONTENT_TRUST\n          value: "0"\n';
    assert.deepEqual(sites(k8s).map((s) => s.split(':')[0]), ['5', '7']);
  });
  it('does not report a commented list-form entry', () => {
    assert.deepEqual(sites('env:\n  # - name: DOCKER_CONTENT_TRUST\n  #   value: "1"\n'), []);
  });
  it('reports --disable-content-trust=false and not the bare flag', () => {
    assert.equal(sites('docker pull --disable-content-trust=false img\ndocker pull --disable-content-trust img\n').length, 1);
  });

  const dir = tree({
    'Dockerfile': 'FROM alpine\nENV DOCKER_CONTENT_TRUST=1\n',
    'deploy/k8s/pod.yaml': 'apiVersion: v1\nkind: Pod\nspec:\n  containers:\n    - name: a\n      env:\n        - name: DOCKER_CONTENT_TRUST\n          value: "1"\n',
    'docker-compose.yml': 'services:\n  a:\n    environment:\n      - DOCKER_CONTENT_TRUST=1\n',
    'scripts/build.sh': '#!/bin/sh\nexport DOCKER_CONTENT_TRUST=1\ndocker trust sign img:1\n',
    'node_modules/x/Dockerfile': 'ENV DOCKER_CONTENT_TRUST=1\n',
    'docs/readme.md': 'DOCKER_CONTENT_TRUST=1\n',
  });
  it('a directory scan reads Dockerfiles, compose, Kubernetes YAML and scripts, not node_modules or markdown', async () => {
    const r = await cli(['-C', dir, '--today', '2026-10-03', '--no-suggest', '--format', 'json', '.']);
    const files = [...new Set((JSON.parse(r.out).findings as { file: string; rule: string }[]).filter((f) => f.rule === 'docker-content-trust').map((f) => f.file))].sort();
    assert.deepEqual(files, ['Dockerfile', 'deploy/k8s/pod.yaml', 'docker-compose.yml', 'scripts/build.sh']);
    assert.equal(r.code, 0); // 66 days out: warnings only
  });
  it('an explicit Dockerfile path works and is not parsed as a workflow', async () => {
    const r = await cli(['-C', dir, '--today', '2026-10-03', '--no-suggest', 'Dockerfile']);
    assert.match(r.out, /Dockerfile\n\s+2:\d+\s+warning docker-content-trust/);
    assert.doesNotMatch(r.out, /file-unparseable/);
  });
  it('--no-deadlines skips them', async () => {
    const r = await cli(['-C', dir, '--today', '2026-10-03', '--no-suggest', '--no-deadlines', '.']);
    assert.doesNotMatch(r.out, /docker-content-trust/);
  });
  it('becomes an error 30 days before the shutdown', async () => {
    const r = await cli(['-C', dir, '--today', '2026-11-20', '--no-suggest', '.']);
    assert.equal(r.code, 1);
  });
});
