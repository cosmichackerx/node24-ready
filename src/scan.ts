import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { applyIgnores, type Config } from './config.js';
import { changedLines, filterChanged } from './diff.js';
import { dctFindings, dctSites, runnerFindings, type DctSite } from './deadlines.js';
import { eolFindings } from './eol.js';
import { GitHubClient, type ClientOptions } from './github.js';
import { parseUses, refKey } from './refs.js';
import { Evaluator, isDeprecatedUsing } from './runtime.js';
import { suggest } from './suggest.js';
import { type Finding, type ScanResult, type UseSite } from './types.js';
import { parseFile, type RunnerSite, type SetupNodeSite } from './workflow.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'vendor', 'target', '.venv']);
const WORKFLOW_RE = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/;
const ACTION_RE = /(^|\/)action\.ya?ml$/;

/** Workflow and action metadata files below `paths` (files are taken as given). */
export function discoverFiles(paths: string[], cwd: string): string[] {
  const out = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        const rel = relative(cwd, join(dir, entry.name)).split(sep).join('/');
        if (WORKFLOW_RE.test(rel) || ACTION_RE.test(rel)) out.add(join(dir, entry.name));
      }
    }
  };
  for (const p of paths) {
    const abs = resolve(cwd, p);
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs);
    else out.add(abs);
  }
  return [...out].sort();
}

export interface ScanOptions {
  paths: string[];
  cwd: string;
  client?: GitHubClient;
  clientOptions?: ClientOptions;
  suggestions?: boolean;
  /** Only report findings on lines changed since the merge base with this ref. */
  changedSince?: string;
  /** Ignore list; see config.ts. */
  config?: Config;
  /** `YYYY-MM-DD` used for expiry and end-of-life checks (tests set it). */
  today?: string;
  /** Turn the setup-node end-of-life rule off. */
  eol?: boolean;
  /** Turn the dated deadline rules (runner labels, ubuntu-latest, Docker Content Trust) off. */
  deadlines?: boolean;
}

export const isoToday = (d = new Date()): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export async function scan(opts: ScanOptions): Promise<ScanResult> {
  const client = opts.client ?? new GitHubClient(opts.clientOptions);
  const evaluator = new Evaluator(client);
  const files = discoverFiles(opts.paths, opts.cwd);
  const findings: Finding[] = [];
  const sites: UseSite[] = [];
  const setupNode: SetupNodeSite[] = [];
  const runners: RunnerSite[] = [];
  const dct: DctSite[] = [];
  const today = opts.today ?? isoToday();

  for (const abs of files) {
    const rel = relative(opts.cwd, abs).split(sep).join('/');
    const text = readFileSync(abs, 'utf8');
    const parsed = parseFile(rel, text);
    dct.push(...dctSites(rel, text));
    if (parsed.error) {
      findings.push({
        rule: 'file-unparseable',
        severity: parsed.fallback ? 'info' : 'warning',
        file: rel,
        line: parsed.errorLine ?? 1,
        column: 1,
        uses: rel,
        message: parsed.fallback
          ? `YAML parser error (${parsed.error}); ${parsed.uses.length} uses: line(s) were found by a line scan instead`
          : `YAML parser error (${parsed.error}); no uses: lines found, so this file was not checked`,
        via: [],
      });
      if (!parsed.fallback) continue;
    }
    setupNode.push(...parsed.setupNode);
    runners.push(...parsed.runners);
    if (parsed.runsUsing && isDeprecatedUsing(parsed.runsUsing.value)) {
      findings.push({
        rule: 'local-action-runtime',
        severity: 'error',
        file: rel,
        line: parsed.runsUsing.line,
        column: parsed.runsUsing.column,
        uses: parsed.runsUsing.value,
        runtime: parsed.runsUsing.value,
        message: `this action declares runs.using: ${parsed.runsUsing.value}, but GitHub now runs JavaScript actions on Node 24 only. Set it to node24, test, and publish a new release`,
        via: [],
      });
    }
    sites.push(...parsed.uses);
  }

  const remotes = sites.map((s) => ({ site: s, u: parseUses(s.value) })).filter((x) => x.u?.type === 'remote');
  const distinct = new Set(remotes.map((x) => refKey(x.u as { owner: string; repo: string; path: string; ref: string })));
  let okCount = 0;

  // evaluate every distinct reference once (the evaluator and client cache), then report per site
  await Promise.all(
    remotes.map(async ({ site, u }) => {
      if (u?.type !== 'remote') return;
      const ev = await evaluator.evaluate(u);
      if (ev.status === 'ok') {
        okCount++;
        return;
      }
      const base = { file: site.file, line: site.line, column: site.column, uses: site.value, via: ev.via };
      if (ev.status === 'unresolved') {
        findings.push({
          ...base,
          rule: 'action-runtime-unresolved',
          severity: 'warning',
          message: `runtime unknown: ${ev.detail ?? 'unresolved'}${ev.via.length ? ` (inside ${ev.via.join(' -> ')})` : ''}`,
        });
        return;
      }
      const direct = ev.via.length === 0;
      const f: Finding = {
        ...base,
        rule: direct ? 'action-runtime-deprecated' : 'action-runtime-nested',
        severity: 'error',
        runtime: ev.using as string,
        message: direct
          ? `${refKey(u)} declares ${ev.using}, but GitHub now force-runs JavaScript actions on Node 24`
          : `${refKey(u)} is a ${ev.rootUsing === 'workflow' ? 'reusable workflow' : 'composite action'} that calls ${ev.via.join(' -> ')}, which declares ${ev.using}`,
      };
      if (opts.suggestions !== false) {
        const s = await suggest(client, evaluator, u);
        if (s.suggestion) f.suggestion = s.suggestion;
        else if (s.reason) f.noSuggestion = s.reason;
      }
      findings.push(f);
    }),
  );

  if (opts.eol !== false) findings.push(...eolFindings(setupNode, { today, cwd: opts.cwd }));
  if (opts.deadlines !== false) findings.push(...runnerFindings(runners, { today }), ...dctFindings(dct, { today }));

  let ignored: ScanResult['ignored'];
  let unusedIgnores: string[] | undefined;
  let kept = findings;
  if (opts.config) {
    const applied = applyIgnores(findings, opts.config, today);
    kept = applied.findings;
    ignored = applied.ignored;
    unusedIgnores = applied.unused;
  }
  let hidden = 0;
  if (opts.changedSince) {
    const res = filterChanged(kept, changedLines(opts.cwd, opts.changedSince), (f) => f.rule === 'ignore-expired');
    kept = res.kept;
    hidden = res.hidden;
  }
  kept.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.rule.localeCompare(b.rule));
  return {
    findings: kept,
    ...(ignored ? { ignored } : {}),
    ...(unusedIgnores && unusedIgnores.length ? { unusedIgnores } : {}),
    summary: { files: files.length, ...(hidden ? { hidden } : {}), ...(ignored && ignored.length ? { ignored: ignored.length } : {}), uses: sites.length, distinctActions: distinct.size, ok: okCount, fetches: client.requests, ...(client.fallbackLookups ? { fallbackLookups: client.fallbackLookups } : {}) },
  };
}
