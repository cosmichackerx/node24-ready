import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Ajv } from 'ajv';
import { run } from '../src/cli.js';
import { applyIgnores, ConfigError, globToRegExp, parseConfig } from '../src/config.js';
import { majorOf } from '../src/eol.js';
import { GitHubClient } from '../src/github.js';
import { scan } from '../src/scan.js';
import { parseFile } from '../src/workflow.js';
import { startMock, nodeAction, sha, world, type MockServer } from './mock-github.js';

let mock: MockServer;
before(async () => {
  mock = await startMock(world());
});
after(async () => {
  await mock.close();
});

const wf = (...uses: string[]): string => `on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n${uses.map((u) => `      - uses: ${u}\n`).join('')}`;
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'n24f-'));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  return dir;
}
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.email=t@e.st', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
async function cli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await run(args, { stdout: (s) => (out += s), stderr: (s) => (err += s), env });
  return { code, out, err };
}
const base = (cwd: string) => ({ paths: ['.'], cwd, clientOptions: { apiUrl: mock.url, retryDelayMs: 0 } });

describe('workflow parsing edge cases found on real repositories', () => {
  it('finds uses: inside nested step groups such as `- parallel:`', () => {
    const p = parseFile('w.yml', 'jobs:\n  a:\n    steps:\n      - uses: a/b@v1\n      - parallel:\n          - name: x\n            uses: c/d@v2\n          - run: echo\n            name: y\n');
    assert.deepEqual(p.uses.map((u) => u.value), ['a/b@v1', 'c/d@v2']);
  });

  it('does not treat `with:` values named uses as steps', () => {
    const p = parseFile('w.yml', 'jobs:\n  a:\n    steps:\n      - uses: a/b@v1\n        with:\n          uses: not/a-step@v1\n');
    assert.deepEqual(p.uses.map((u) => u.value), ['a/b@v1']);
  });

  it('falls back to a line scan when the YAML parser rejects a file GitHub accepts', async () => {
    const text = `on: push\njobs:\n  a:\n    env:\n      M: '[\n        "x"\n      ]'\n    steps:\n      - uses: acme/checkout@v4\n      # - uses: acme/checkout@v3\n`;
    const cwd = project({ '.github/workflows/ci.yml': text });
    const r = await scan({ ...base(cwd), suggestions: false });
    const rules = r.findings.map((f) => f.rule).sort();
    assert.deepEqual(rules, ['action-runtime-deprecated', 'file-unparseable']);
    assert.equal(r.findings.find((f) => f.rule === 'file-unparseable')?.severity, 'info');
    assert.equal(r.findings.find((f) => f.rule === 'action-runtime-deprecated')?.line, 9);
  });

  it('warns when a file cannot be parsed and nothing can be scanned', async () => {
    const cwd = project({ '.github/workflows/ci.yml': 'a: [unclosed\n' });
    const r = await scan(base(cwd));
    assert.equal(r.findings[0]?.rule, 'file-unparseable');
    assert.equal(r.findings[0]?.severity, 'warning');
  });
});

describe('plugin actions', () => {
  it('treats runs.plugin (actions/checkout@v1 style) as fine instead of unresolved', async () => {
    const w = world();
    w['acme/legacy'] = { files: { 'action.yml@v1': "name: x\nruns:\n  plugin: 'checkout'\n" }, tags: [] };
    const server = await startMock(w);
    try {
      const cwd = project({ '.github/workflows/ci.yml': wf('acme/legacy@v1') });
      const r = await scan({ paths: ['.'], cwd, clientOptions: { apiUrl: server.url, retryDelayMs: 0 } });
      assert.deepEqual(r.findings, []);
    } finally {
      await server.close();
    }
  });
});

describe('ignore list (.node24-ready.json)', () => {
  const entry = { uses: 'acme/stuck@*', reason: 'vendor has no node24 release yet', expires: '2026-12-31' };

  it('validates strictly', () => {
    assert.throws(() => parseConfig('{'), ConfigError);
    assert.throws(() => parseConfig('{"ignore":[{"uses":"a/b@*"}]}'), /reason/);
    assert.throws(() => parseConfig('{"ignore":[{"reason":"because"}]}'), /too broad/);
    assert.throws(() => parseConfig('{"ignore":[{"rule":"*","reason":"because"}]}'), /too broad/);
    assert.throws(() => parseConfig('{"ignore":[{"uses":"a/b@*","reason":"because","extra":1}]}'), /unknown key 'extra'/);
    assert.throws(() => parseConfig('{"ignore":[{"rule":"nope","reason":"because"}]}'), /unknown rule/);
    assert.throws(() => parseConfig('{"ignore":[{"uses":"a/b@*","reason":"because","expires":"soon"}]}'), /expires/);
    assert.throws(() => parseConfig('{"ignores":[]}'), /unknown key 'ignores'/);
    assert.deepEqual(parseConfig('{}').ignore, []);
  });

  it('globs', () => {
    assert.ok(globToRegExp('acme/*@v1').test('acme/stuck@v1'));
    assert.ok(!globToRegExp('acme/*@v1').test('acme/stuck@v2'));
    assert.ok(globToRegExp('.github/workflows/legacy-?.yml').test('.github/workflows/legacy-a.yml'));
    assert.ok(!globToRegExp('a.b').test('axb'));
  });

  it('suppresses matching findings, lists them with the reason, and reports unused entries', async () => {
    const cwd = project({ '.github/workflows/ci.yml': wf('acme/stuck@v1', 'acme/checkout@v4') });
    const config = parseConfig(JSON.stringify({ ignore: [entry, { uses: 'nobody/nothing@*', reason: 'old' }] }));
    const r = await scan({ ...base(cwd), config, today: '2026-10-02' });
    assert.deepEqual(r.findings.map((f) => f.uses), ['acme/checkout@v4']);
    assert.equal(r.ignored?.[0]?.finding.uses, 'acme/stuck@v1');
    assert.equal(r.ignored?.[0]?.reason, entry.reason);
    assert.deepEqual(r.unusedIgnores, ['uses=nobody/nothing@*']);
    assert.equal(r.summary.ignored, 1);
  });

  it('an expired entry suppresses nothing and is itself a warning', () => {
    const f = { rule: 'action-runtime-deprecated' as const, severity: 'error' as const, file: 'a.yml', line: 1, column: 1, uses: 'acme/stuck@v1', message: 'm', via: [] };
    const cfg = parseConfig(JSON.stringify({ ignore: [{ ...entry, expires: '2026-09-01' }] }));
    const r = applyIgnores([f], cfg, '2026-10-02');
    assert.equal(r.ignored.length, 0);
    assert.deepEqual(r.findings.map((x) => x.rule).sort(), ['action-runtime-deprecated', 'ignore-expired']);
  });

  it('is read from .node24-ready.json, exports SARIF suppressions, and an invalid file exits 2', async () => {
    const cwd = project({ '.github/workflows/ci.yml': wf('acme/stuck@v1'), '.node24-ready.json': JSON.stringify({ ignore: [entry] }) });
    const r = await cli(['-C', cwd, '--api-url', mock.url, '--today', '2026-10-02']);
    assert.equal(r.code, 0);
    assert.match(r.out, /1 ignored by \.node24-ready\.json/);
    assert.match(r.out, /ignored: \.github\/workflows\/ci\.yml:6 acme\/stuck@v1 .* vendor has no node24 release yet \[until 2026-12-31\]/);
    const out = join(cwd, 'r.sarif');
    await cli(['-C', cwd, '--api-url', mock.url, '--today', '2026-10-02', '-f', 'sarif', '-o', out]);
    const sarif = JSON.parse(readFileSync(out, 'utf8')) as { runs: { results: { suppressions?: { kind: string; justification: string }[] }[] }[] };
    assert.equal(sarif.runs[0]?.results[0]?.suppressions?.[0]?.kind, 'external');
    const schema = JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/sarif-schema-2.1.0.json'), 'utf8')) as object;
    const validate = new Ajv({ strict: false, allErrors: true }).compile(schema);
    assert.equal(validate(sarif), true, JSON.stringify(validate.errors));
    assert.equal((await cli(['-C', cwd, '--api-url', mock.url, '--no-config'])).code, 1, '--no-config shows the finding again');
  });

  it('exits 2 for an invalid config and 1 once the entry has expired', async () => {
    const bad = project({ '.github/workflows/ci.yml': wf('acme/stuck@v1'), '.node24-ready.json': '{"ignore":[{"uses":"acme/*"}]}' });
    const r = await cli(['-C', bad, '--api-url', mock.url]);
    assert.equal(r.code, 2);
    assert.match(r.err, /reason/);
    const cwd = project({ '.github/workflows/ci.yml': wf('acme/stuck@v1'), '.node24-ready.json': JSON.stringify({ ignore: [entry] }) });
    const late = await cli(['-C', cwd, '--api-url', mock.url, '--today', '2027-01-02']);
    assert.equal(late.code, 1);
    assert.match(late.out, /ignore-expired/);
  });
});

describe('--changed-since (PR mode)', () => {
  function repo(): string {
    const cwd = project({ '.github/workflows/ci.yml': wf('acme/checkout@v4'), 'README.md': 'x\n' });
    git(cwd, 'init', '-q', '-b', 'main');
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-qm', 'base');
    git(cwd, 'checkout', '-q', '-b', 'pr');
    return cwd;
  }

  it('reports only findings on lines the change touched', async () => {
    const cwd = repo();
    writeFileSync(join(cwd, '.github/workflows/ci.yml'), wf('acme/checkout@v4', 'acme/stuck@v1'));
    git(cwd, 'commit', '-qam', 'add a step');
    const full = await cli(['-C', cwd, '--api-url', mock.url, '--no-suggest', '-f', 'json']);
    assert.equal((JSON.parse(full.out) as { findings: unknown[] }).findings.length, 2);
    const pr = JSON.parse((await cli(['-C', cwd, '--api-url', mock.url, '--no-suggest', '-f', 'json', '--changed-since', 'main'])).out) as { findings: { uses: string }[]; summary: { hidden: number } };
    assert.deepEqual(pr.findings.map((f) => f.uses), ['acme/stuck@v1']);
    assert.equal(pr.summary.hidden, 1);
    const text = await cli(['-C', cwd, '--api-url', mock.url, '--no-suggest', '--changed-since', 'main']);
    assert.match(text.out, /1 on unchanged lines hidden by --changed-since/);
    assert.equal(text.code, 1);
  });

  it('passes when the PR does not touch a deprecated line, and counts untracked files fully', async () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'README.md'), 'y\n');
    git(cwd, 'commit', '-qam', 'docs');
    assert.equal((await cli(['-C', cwd, '--api-url', mock.url, '--changed-since', 'main'])).code, 0);
    writeFileSync(join(cwd, '.github/workflows/new.yml'), wf('acme/checkout@v4'));
    assert.equal((await cli(['-C', cwd, '--api-url', mock.url, '--changed-since', 'main'])).code, 1);
  });

  it('reads the ignore list from the base, so a PR cannot silence its own finding', async () => {
    const cwd = repo();
    writeFileSync(join(cwd, '.github/workflows/ci.yml'), wf('acme/stuck@v1'));
    writeFileSync(join(cwd, '.node24-ready.json'), JSON.stringify({ ignore: [{ uses: 'acme/*', reason: 'added by the PR itself' }] }));
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-qm', 'change and silence');
    const withBase = await cli(['-C', cwd, '--api-url', mock.url, '--changed-since', 'main']);
    assert.equal(withBase.code, 1, 'the PR-added ignore entry must not count');
    const trusted = await cli(['-C', cwd, '--api-url', mock.url, '--config', '.node24-ready.json']);
    assert.equal(trusted.code, 0, 'an explicit --config is trusted');
  });

  it('errors clearly on an unknown ref and refuses --fix', async () => {
    const cwd = repo();
    const r = await cli(['-C', cwd, '--api-url', mock.url, '--changed-since', 'nope']);
    assert.equal(r.code, 2);
    assert.match(r.err, /'nope' is not a known commit/);
    assert.equal((await cli(['-C', cwd, '--fix', '--changed-since', 'main'])).code, 2);
  });
});

describe('setup-node end of life rule', () => {
  const nodeWf = (version: string, extra = ''): string => `on: push\njobs:\n  a:\n    runs-on: x\n${extra}    steps:\n      - uses: actions/setup-node@v5\n        with:\n          node-version: ${version}\n`;
  const eol = (r: Awaited<ReturnType<typeof scan>>) => r.findings.filter((f) => f.rule === 'setup-node-eol');
  const opts = (cwd: string) => ({ ...base(cwd), suggestions: false, today: '2026-10-02' });

  it('majorOf understands the usual spellings', () => {
    for (const [spec, major] of [['20', 20], ['v20.11.1', 20], ['20.x', 20], ['^18.0.0', 18], ['~22', 22], ['lts/iron', 20], ['lts/hydrogen', 18], ['16.20.2', 16]] as const) assert.equal(majorOf(spec), major, spec);
    for (const spec of ['lts/*', 'latest', 'node', '>=18', '18 || 20', '']) assert.equal(majorOf(spec), null, spec);
  });

  it('warns for a pinned end-of-life version and is silent for a supported one', async () => {
    const old = await scan(opts(project({ '.github/workflows/ci.yml': nodeWf('18') })));
    assert.equal(eol(old)[0]?.severity, 'warning');
    assert.match(eol(old)[0]?.message ?? '', /Node\.js 18, which reached end of life on 2025-04-30/);
    assert.equal(eol(old)[0]?.line, 8);
    const fine = await scan(opts(project({ '.github/workflows/ci.yml': nodeWf('24') })));
    assert.deepEqual(eol(fine), []);
    const lts = await scan(opts(project({ '.github/workflows/ci.yml': nodeWf("'lts/iron'") })));
    assert.equal(eol(lts)[0]?.runtime, 'node20');
  });

  it('only informs about versions in a matrix (libraries test old versions on purpose) and expands it', async () => {
    const w = 'on: push\njobs:\n  a:\n    strategy:\n      matrix:\n        node: [18, 20, 22, 24]\n    runs-on: x\n    steps:\n      - uses: actions/setup-node@v5\n        with:\n          node-version: ${{ matrix.node }}\n';
    const r = await scan(opts(project({ '.github/workflows/ci.yml': w })));
    assert.deepEqual(eol(r).map((f) => [f.runtime, f.severity]), [['node18', 'info'], ['node20', 'info']]);
  });

  it('warns shortly before end of life and reads node-version-file', async () => {
    const soon = await scan({ ...opts(project({ '.github/workflows/ci.yml': nodeWf('22') })), today: '2027-03-01' });
    assert.match(eol(soon)[0]?.message ?? '', /reaches end of life on 2027-04-30 \(60 days\)/);
    assert.equal(eol(soon)[0]?.severity, 'info');
    const cwd = project({ '.github/workflows/ci.yml': 'on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - uses: actions/setup-node@v5\n        with:\n          node-version-file: .nvmrc\n', '.nvmrc': 'v16.20.0\n' });
    const f = await scan(opts(cwd));
    assert.equal(eol(f)[0]?.runtime, 'node16');
    assert.match(eol(f)[0]?.message ?? '', /\.nvmrc says Node\.js 16/);
  });

  it('can be switched off', async () => {
    const r = await scan({ ...opts(project({ '.github/workflows/ci.yml': nodeWf('18') })), eol: false });
    assert.deepEqual(eol(r), []);
  });
});

describe('response cache', () => {
  it('revalidates with free 304s and never re-fetches commit-pinned files', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'n24cache-'));
    const w = world();
    w['acme/pinned'] = { files: { [`action.yml@${sha(77)}`]: nodeAction('node24') }, tags: [] };
    const server = await startMock(w);
    try {
      const cwd = project({ '.github/workflows/ci.yml': wf('acme/checkout@v4', `acme/pinned@${sha(77)}`) });
      const mk = () => new GitHubClient({ apiUrl: server.url, retryDelayMs: 0, cacheDir });
      const first = await scan({ paths: ['.'], cwd, client: mk() });
      const requests1 = server.requests.length;
      const second = await scan({ paths: ['.'], cwd, client: mk() });
      assert.deepEqual(second.findings, first.findings);
      const requests2 = server.requests.length - requests1;
      assert.ok(requests2 < requests1, `second run made ${requests2} requests, first ${requests1}`);
      assert.ok(server.revalidated.count > 0, 'moving refs are revalidated with If-None-Match');
      assert.ok(!server.requests.slice(requests1).some((r) => r.includes(sha(77))), 'the pinned commit is not requested again');
    } finally {
      await server.close();
    }
  });
});
