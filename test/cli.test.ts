import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Ajv } from 'ajv';
import { run } from '../src/cli.js';
import { startMock, world, type MockServer } from './mock-github.js';

let mock: MockServer;
before(async () => {
  mock = await startMock(world());
});
after(async () => {
  await mock.close();
});

function project(uses: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'n24cli-'));
  mkdirSync(join(dir, '.github/workflows'), { recursive: true });
  writeFileSync(join(dir, '.github/workflows/ci.yml'), `on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n${uses.map((u) => `      - uses: ${u}\n`).join('')}`);
  return dir;
}

async function cli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await run(args, { stdout: (s) => (out += s), stderr: (s) => (err += s), env });
  return { code, out, err };
}

describe('cli', () => {
  it('exits 1 with findings, 0 when clean, 0 with --fail-on never', async () => {
    const bad = project(['acme/checkout@v4']);
    const good = project(['acme/checkout@v5']);
    assert.equal((await cli(['-C', bad, '--api-url', mock.url])).code, 1);
    assert.equal((await cli(['-C', good, '--api-url', mock.url])).code, 0);
    assert.equal((await cli(['-C', bad, '--api-url', mock.url, '--fail-on', 'never'])).code, 0);
  });

  it('--fail-on warning turns unresolved actions into a failure', async () => {
    const dir = project(['acme/private@v1']);
    assert.equal((await cli(['-C', dir, '--api-url', mock.url])).code, 0);
    assert.equal((await cli(['-C', dir, '--api-url', mock.url, '--fail-on', 'warning'])).code, 1);
  });

  it('prints text with the upgrade hint', async () => {
    const dir = project(['acme/checkout@v4']);
    const r = await cli(['-C', dir, '--api-url', mock.url]);
    assert.match(r.out, /\.github\/workflows\/ci\.yml/);
    assert.match(r.out, /acme\/checkout@v4 declares node20/);
    assert.match(r.out, /upgrade to @v5 \(v5\.1\.0, node24\)/);
  });

  it('emits json, markdown and github annotations', async () => {
    const dir = project(['acme/checkout@v4']);
    const j = JSON.parse((await cli(['-C', dir, '--api-url', mock.url, '-f', 'json'])).out) as { findings: unknown[]; summary: { error: number } };
    assert.equal(j.findings.length, 1);
    assert.equal(j.summary.error, 1);
    assert.match((await cli(['-C', dir, '--api-url', mock.url, '-f', 'markdown'])).out, /\| error \| `\.github\/workflows\/ci\.yml:6` \|/);
    assert.match((await cli(['-C', dir, '--api-url', mock.url, '-f', 'github'])).out, /^::error file=\.github\/workflows\/ci\.yml,line=6,col=15,title=action-runtime-deprecated::/);
  });

  it('writes SARIF that validates against the 2.1.0 schema', async () => {
    const dir = project(['acme/checkout@v4', 'acme/private@v1', 'acme/setup@v1']);
    const out = join(dir, 'r.sarif');
    const r = await cli(['-C', dir, '--api-url', mock.url, '-f', 'sarif', '-o', out]);
    assert.equal(r.code, 1);
    const sarif = JSON.parse(readFileSync(out, 'utf8')) as { runs: { results: { ruleId: string; ruleIndex: number }[]; tool: { driver: { rules: { id: string }[] } } }[] };
    const schema = JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/sarif-schema-2.1.0.json'), 'utf8')) as object;
    const ajv = new Ajv({ strict: false, allErrors: true });
    const validate = ajv.compile(schema);
    assert.equal(validate(sarif), true, JSON.stringify(validate.errors));
    const run0 = sarif.runs[0]!;
    assert.equal(run0.results.length, 3);
    for (const res of run0.results) assert.equal(run0.tool.driver.rules[res.ruleIndex]?.id, res.ruleId);
  });

  it('--fix rewrites files, reports it and exits 0', async () => {
    const dir = project(['acme/checkout@v4']);
    const r = await cli(['-C', dir, '--api-url', mock.url, '--fix']);
    assert.equal(r.code, 0);
    assert.match(r.err, /fixed \.github\/workflows\/ci\.yml:6: acme\/checkout@v4 -> acme\/checkout@v5/);
    assert.match(readFileSync(join(dir, '.github/workflows/ci.yml'), 'utf8'), /acme\/checkout@v5/);
    assert.match(r.out, /^No action declaring node12\/16\/20 found/, 'fixed findings are not reported again');
    assert.equal((await cli(['-C', dir, '--api-url', mock.url])).code, 0);
  });

  it('--fix still reports what it could not fix', async () => {
    const dir = project(['acme/checkout@v4', 'acme/stuck@v1']);
    const r = await cli(['-C', dir, '--api-url', mock.url, '--fix']);
    assert.equal(r.code, 0);
    assert.match(r.out, /acme\/stuck@v1 declares node20/);
    assert.ok(!/acme\/checkout@v4/.test(r.out));
  });

  it('usage errors exit 2; help, version and rule list exit 0', async () => {
    assert.equal((await cli(['--nope'])).code, 2);
    assert.equal((await cli(['-f', 'xml'])).code, 2);
    assert.equal((await cli(['--fail-on', 'x'])).code, 2);
    assert.equal((await cli(['/does/not/exist', '--api-url', mock.url])).code, 2);
    assert.match((await cli(['--help'])).out, /Usage:/);
    assert.match((await cli(['--version'])).out, /^node24-ready \d+\.\d+\.\d+/);
    assert.match((await cli(['--list-rules'])).out, /action-runtime-nested/);
  });

  it('never prints the token', async () => {
    const dir = project(['acme/checkout@v4']);
    const r = await cli(['-C', dir, '--api-url', mock.url, '-f', 'json'], { GITHUB_TOKEN: 'ghp_SECRET_TOKEN_VALUE' });
    assert.ok(!r.out.includes('SECRET_TOKEN_VALUE') && !r.err.includes('SECRET_TOKEN_VALUE'));
  });
});
