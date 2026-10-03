import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { run } from '../src/cli.js';
import { dctFindings, dctSites, DCT, RUNNER_DEADLINES, runnerFindings, UBUNTU_LATEST } from '../src/deadlines.js';
import { parseFile, type RunnerSite } from '../src/workflow.js';

const site = (label: string, fromMatrix = false): RunnerSite => ({ file: 'w.yml', line: 3, column: 14, label, fromMatrix });
const one = (label: string, today: string, fromMatrix = false) => runnerFindings([site(label, fromMatrix)], { today })[0];

describe('runner label deadlines (dates from the runner-images announcements)', () => {
  it('macos-14 two days before the first brownout is an error that names the dates and the replacement', () => {
    const f = one('macos-14', '2026-10-03');
    assert.equal(f?.rule, 'runner-image-retiring');
    assert.equal(f?.severity, 'error');
    assert.match(f?.message ?? '', /retired on 2026-11-02 \(30 days\)/);
    assert.match(f?.message ?? '', /next brownout 2026-10-05T14:00Z \(2 days\)/);
    assert.match(f?.message ?? '', /macos-latest, macos-15 or macos-26/);
  });

  it('far from the dates it is only a warning', () => {
    assert.equal(one('macos-14', '2026-08-01')?.severity, 'warning');
    assert.equal(one('ubuntu-22.04', '2026-10-03')?.severity, 'warning');
    assert.match(one('ubuntu-22.04', '2026-10-03')?.message ?? '', /retired on 2027-04-17/);
  });

  it('inside a brownout day and after retirement it is an error', () => {
    assert.match(one('macos-14', '2026-10-05')?.message ?? '', /scheduled brownout/);
    assert.match(one('macos-14', '2026-10-31')?.message ?? '', /scheduled brownout/);
    assert.match(one('macos-14', '2026-11-03')?.message ?? '', /was retired on 2026-11-02/);
    assert.equal(one('macos-14', '2026-11-03')?.severity, 'error');
  });

  it('labels that are already gone are errors today', () => {
    for (const l of ['ubuntu-20.04', 'windows-2019', 'macos-12', 'macos-13']) assert.equal(one(l, '2026-10-03')?.severity, 'error', l);
  });

  it('the large and xlarge macOS variants and the arm Ubuntu label are covered, other labels are not', () => {
    for (const l of ['macos-14-large', 'macos-14-xlarge', 'ubuntu-22.04-arm', 'MACOS-14']) assert.ok(one(l, '2026-10-03'), l);
    for (const l of ['macos-15', 'macos-latest', 'ubuntu-24.04', 'ubuntu-26.04', 'windows-2022', 'windows-latest', 'self-hosted', 'my-runner-group']) assert.equal(one(l, '2026-10-03'), undefined, l);
  });

  it('a matrix entry that is not yet failing is never louder than a warning', () => {
    assert.equal(one('macos-14', '2026-10-03', true)?.severity, 'warning');
    assert.equal(one('macos-14', '2026-11-03', true)?.severity, 'error');
  });

  it('ubuntu-latest is information before the migration window, a warning close to it, silent afterwards', () => {
    assert.equal(one('ubuntu-latest', '2026-09-01')?.severity, 'info');
    assert.equal(one('ubuntu-latest', '2026-10-10')?.severity, 'warning');
    assert.match(one('ubuntu-latest', '2026-10-25')?.message ?? '', /right now/);
    assert.equal(one('ubuntu-latest', '2026-11-20'), undefined);
    assert.equal(one('ubuntu-latest', '2026-11-19')?.rule, 'runner-latest-migration');
  });

  it('every registry entry is internally consistent and cites a source', () => {
    for (const d of RUNNER_DEADLINES) {
      assert.ok(d.sources.length > 0 && d.sources.every((s) => s.startsWith('https://')), d.id);
      assert.match(d.verified, /^\d{4}-\d{2}-\d{2}$/);
      if (d.deprecated) assert.ok(d.deprecated < d.retired, d.id);
      const times = d.brownouts.map((b) => b.from);
      assert.deepEqual([...times].sort(), times, `${d.id} brownouts sorted`);
      for (const b of d.brownouts) assert.ok(b.from < b.to && b.to.slice(0, 10) <= d.retired, `${d.id} ${b.from}`);
    }
    assert.equal(RUNNER_DEADLINES.find((d) => d.id === 'macos-14')?.brownouts.length, 8);
    assert.equal(RUNNER_DEADLINES.find((d) => d.id === 'ubuntu-22.04')?.brownouts.length, 4);
    assert.equal(UBUNTU_LATEST.from, '2026-10-19');
    assert.equal(DCT.shutdown, '2026-12-08');
  });
});

describe('runs-on parsing', () => {
  it('reads a scalar, a list, a labels map, and expands a matrix', () => {
    const p = parseFile(
      'w.yml',
      [
        'on: push',
        'jobs:',
        '  a:',
        '    runs-on: macos-14',
        '  b:',
        '    runs-on: [self-hosted, ubuntu-22.04]',
        '  c:',
        '    runs-on:',
        '      group: big',
        '      labels: ubuntu-22.04-arm',
        '  d:',
        '    strategy:',
        '      matrix:',
        '        os: [ubuntu-latest, macos-14]',
        '        include:',
        '          - os: windows-2019',
        '    runs-on: ${{ matrix.os }}',
        '  e:',
        '    runs-on: ${{ inputs.runner }}',
        '',
      ].join('\n'),
    );
    assert.deepEqual(
      p.runners.map((r) => `${r.label}${r.fromMatrix ? '*' : ''}@${r.line}`),
      ['macos-14@4', 'self-hosted@6', 'ubuntu-22.04@6', 'ubuntu-22.04-arm@10', 'ubuntu-latest*@17', 'macos-14*@17', 'windows-2019*@17'],
    );
  });
});

describe('Docker Content Trust', () => {
  const text = [
    'env:',
    '  DOCKER_CONTENT_TRUST: 1',
    'jobs:',
    '  a:',
    '    steps:',
    '      - run: |',
    '          export DOCKER_CONTENT_TRUST=1',
    '          docker trust sign example/app:1',
    '      - run: DOCKER_CONTENT_TRUST=0 docker pull busybox',
    '      # docker trust inspect is only in a comment',
    '      - run: curl https://notary.docker.io/v2/',
    '      - env: { DOCKER_CONTENT_TRUST_REPOSITORY_PASSPHRASE: x, DOCKER_CONTENT_TRUST_SERVER: y }',
    '',
  ].join('\n');

  it('finds the enabled variable, trust commands and the Notary host, but not "0", comments or the passphrase variables', () => {
    const s = dctSites('w.yml', text);
    assert.deepEqual(s.map((x) => `${x.line}:${x.what}`), ['2:DOCKER_CONTENT_TRUST is switched on', '7:DOCKER_CONTENT_TRUST is switched on', '8:docker trust sign', '11:notary.docker.io (the Notary v1 server)']);
  });

  it('is a warning until 30 days before the shutdown, then an error, and after it an error', () => {
    const s = dctSites('w.yml', 'env:\n  DOCKER_CONTENT_TRUST: "true"\n');
    assert.equal(dctFindings(s, { today: '2026-10-03' })[0]?.severity, 'warning');
    assert.match(dctFindings(s, { today: '2026-10-03' })[0]?.message ?? '', /shut down on 2026-12-08 \(66 days\)/);
    assert.equal(dctFindings(s, { today: '2026-11-15' })[0]?.severity, 'error');
    assert.match(dctFindings(s, { today: '2026-12-09' })[0]?.message ?? '', /were shut down on 2026-12-08/);
  });
});

describe('command line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'n24d-'));
  mkdirSync(join(dir, '.github/workflows'), { recursive: true });
  writeFileSync(join(dir, '.github/workflows/ci.yml'), 'on: push\nenv:\n  DOCKER_CONTENT_TRUST: 1\njobs:\n  a:\n    runs-on: macos-14\n    steps:\n      - run: echo hi\n');
  const cli = async (args: string[]) => {
    let out = '';
    const code = await run(args, { stdout: (s) => (out += s), stderr: () => {}, env: {} });
    return { code, out };
  };

  it('fails on macos-14 two days before the brownouts and reports it in text and SARIF', async () => {
    const r = await cli(['-C', dir, '--today', '2026-10-03', '--no-suggest', '.']);
    assert.equal(r.code, 1);
    assert.match(r.out, /runner-image-retiring/);
    assert.match(r.out, /docker-content-trust/);
    const s = await cli(['-C', dir, '--today', '2026-10-03', '--no-suggest', '--format', 'sarif', '.']);
    const log = JSON.parse(s.out);
    const ids = log.runs[0].results.map((x: { ruleId: string }) => x.ruleId).sort();
    assert.deepEqual(ids, ['docker-content-trust', 'runner-image-retiring']);
    assert.ok(log.runs[0].tool.driver.rules.some((x: { id: string }) => x.id === 'runner-latest-migration'));
  });

  it('--no-deadlines switches the rules off', async () => {
    const r = await cli(['-C', dir, '--today', '2026-10-03', '--no-suggest', '--no-deadlines', '.']);
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.out, /runner-image-retiring|docker-content-trust/);
  });
});
