#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CONFIG_FILE, ConfigError, parseConfig, type Config } from './config.js';
import { fileAtBase, GitError } from './diff.js';
import { applyFixes, planFixes } from './fix.js';
import { RateLimitError } from './github.js';
import { meetsThreshold, renderGithub, renderJson, renderMarkdown, renderSarif, renderText } from './report.js';
import { scan } from './scan.js';
import { RULES, type Severity } from './types.js';

const HELP = `node24-ready - find GitHub Actions that still declare the removed Node 20 runtime

Usage:
  node24-ready [paths...] [options]     paths: directories or workflow/action files (default: .)

Options:
  -C, --cwd <dir>        run as if started in <dir>
  -f, --format <fmt>     text | markdown | json | github | sarif   (default: text)
  -o, --output <file>    write the report to a file
      --fail-on <level>  exit 1 on: error | warning | never   (default: error)
      --changed-since <ref>  only report findings on lines changed since the merge base with <ref> (PR mode)
      --config <file>    ignore list (default: ${CONFIG_FILE}; with --changed-since it is read from the base ref)
      --no-config        do not read an ignore list
      --no-eol           skip the setup-node end-of-life rule
      --today <date>     YYYY-MM-DD used for expiry and end-of-life checks (for tests)
      --fix              rewrite uses: lines to the suggested node24-capable release (review the changelog first)
      --dry-run          with --fix: write nothing, print a unified diff (git apply / patch -p1 accept it)
      --no-suggest       do not look for upgrade targets (fewer API requests)
      --cache-dir <dir>  cache API responses (ETag revalidation costs no rate limit; SHA-pinned files are never re-fetched). Env: NODE24_READY_CACHE
      --api-url <url>    GitHub API base (GitHub Enterprise Server, or a test server)
      --list-rules       print the rule ids and exit
  -v, --version          print the version
  -h, --help             print this help

Authentication: set GITHUB_TOKEN (or GH_TOKEN). Without a token the API allows 60 requests per hour.
Exit codes: 0 ok, 1 findings at or above --fail-on, 2 usage or API error.
`;

function version(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../../package.json', '../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(join(here, rel), 'utf8')) as { name?: string; version?: string };
      if (pkg.name === 'node24-ready' && pkg.version) return pkg.version;
    } catch {
      /* try next */
    }
  }
  return 'unknown';
}

export async function run(
  argv: string[],
  io: { stdout: (s: string) => void; stderr: (s: string) => void; env: NodeJS.ProcessEnv } = {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    env: process.env,
  },
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        cwd: { type: 'string', short: 'C' },
        format: { type: 'string', short: 'f', default: 'text' },
        output: { type: 'string', short: 'o' },
        'fail-on': { type: 'string', default: 'error' },
        fix: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        'changed-since': { type: 'string' },
        config: { type: 'string' },
        'no-config': { type: 'boolean', default: false },
        'no-eol': { type: 'boolean', default: false },
        today: { type: 'string' },
        'no-suggest': { type: 'boolean', default: false },
        'api-url': { type: 'string' },
        'cache-dir': { type: 'string' },
        'list-rules': { type: 'boolean', default: false },
        version: { type: 'boolean', short: 'v', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    io.stderr(`node24-ready: ${(err as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) return io.stdout(HELP), 0;
  if (values.version) return io.stdout(`node24-ready ${version()}\n`), 0;
  if (values['list-rules']) {
    for (const [id, desc] of Object.entries(RULES)) io.stdout(`${id.padEnd(28)} ${desc}\n`);
    return 0;
  }
  const format = values.format as string;
  if (!['text', 'markdown', 'json', 'github', 'sarif'].includes(format)) {
    io.stderr(`node24-ready: unknown --format '${format}' (text, markdown, json, github, sarif)\n`);
    return 2;
  }
  const failOnRaw = values['fail-on'] as string;
  if (!['error', 'warning', 'never'].includes(failOnRaw)) {
    io.stderr(`node24-ready: unknown --fail-on '${failOnRaw}' (error, warning, never)\n`);
    return 2;
  }
  const cwd = resolve(values.cwd ?? '.');
  if (values.today !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(values.today)) {
    io.stderr('node24-ready: --today must look like 2026-10-02\n');
    return 2;
  }
  if (values['dry-run'] && !values.fix) {
    io.stderr('node24-ready: --dry-run only makes sense together with --fix\n');
    return 2;
  }
  if (values.fix && values['changed-since']) {
    io.stderr('node24-ready: --fix cannot be combined with --changed-since\n');
    return 2;
  }
  const token = io.env.GITHUB_TOKEN || io.env.GH_TOKEN || undefined;
  try {
    let config: Config | undefined;
    if (!values['no-config']) {
      if (values.config) {
        config = parseConfig(readFileSync(resolve(cwd, values.config), 'utf8'), values.config);
      } else if (values['changed-since']) {
        // a pull request must not be able to silence its own findings: use the ignore list of the base
        const text = fileAtBase(cwd, values['changed-since'], CONFIG_FILE);
        if (text !== null) config = parseConfig(text, `${CONFIG_FILE} (at ${values['changed-since']})`);
      } else if (existsSync(join(cwd, CONFIG_FILE))) {
        config = parseConfig(readFileSync(join(cwd, CONFIG_FILE), 'utf8'));
      }
    }
    const result = await scan({
      ...(config ? { config } : {}),
      ...(values['changed-since'] ? { changedSince: values['changed-since'] } : {}),
      ...(values.today ? { today: values.today } : {}),
      eol: !values['no-eol'],
      paths: positionals.length ? positionals : ['.'],
      cwd,
      suggestions: !values['no-suggest'] || values.fix === true,
      clientOptions: { ...(values['api-url'] ? { apiUrl: values['api-url'] } : io.env.GITHUB_API_URL ? { apiUrl: io.env.GITHUB_API_URL } : {}), ...(token ? { token } : {}), ...(values['cache-dir'] || io.env.NODE24_READY_CACHE ? { cacheDir: resolve(cwd, (values['cache-dir'] || io.env.NODE24_READY_CACHE) as string) } : {}) },
    });
    if (values.fix && values['dry-run']) {
      const plan = planFixes(result.findings, cwd);
      for (const f of plan.files) io.stdout(f.diff);
      io.stderr(plan.changes.length ? `node24-ready: dry run: ${plan.changes.length} line(s) in ${plan.files.length} file(s) would change; nothing was written\n` : 'node24-ready: dry run: nothing it could rewrite safely\n');
      return 0;
    }
    if (values.fix) {
      const changes = applyFixes(result.findings, cwd);
      for (const c of changes) io.stderr(`node24-ready: fixed ${c.file}:${c.line}: ${c.from} -> ${c.to}\n`);
      if (changes.length === 0) io.stderr('node24-ready: --fix found nothing it could rewrite safely\n');
      // report only what is left: findings that were rewritten are resolved
      const fixed = new Set(changes.map((c) => `${c.file}:${c.line}`));
      result.findings = result.findings.filter((f) => !fixed.has(`${f.file}:${f.line}`));
    }
    let text: string;
    switch (format) {
      case 'markdown':
        text = renderMarkdown(result);
        break;
      case 'json':
        text = renderJson(result);
        break;
      case 'github':
        text = renderGithub(result);
        break;
      case 'sarif':
        text = renderSarif(result, version());
        break;
      default:
        text = renderText(result);
    }
    if (values.output) writeFileSync(values.output, `${text}\n`);
    else if (text) io.stdout(`${text}\n`);
    const threshold = failOnRaw as Severity | 'never';
    return threshold !== 'never' && !values.fix && meetsThreshold(result.findings, threshold) ? 1 : 0;
  } catch (err) {
    if (err instanceof RateLimitError) {
      io.stderr(`node24-ready: ${err.message}\n`);
      return 2;
    }
    if (err instanceof ConfigError || err instanceof GitError) {
      io.stderr(`node24-ready: ${err.message}\n`);
      return 2;
    }
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      io.stderr(`node24-ready: ${(err as Error).message}\n`);
      return 2;
    }
    throw err;
  }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url) || /node24-ready(\.js)?$/.test(invoked)) {
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`node24-ready: ${(err as Error).stack ?? String(err)}\n`);
      process.exitCode = 2;
    },
  );
}
