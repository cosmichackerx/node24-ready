import { LineCounter, isMap, isScalar, isSeq, parseDocument, type Node, type YAMLMap } from 'yaml';
import type { UseSite } from './types.js';

export interface ParsedFile {
  uses: UseSite[];
  /** `runs.using` of an action metadata file. */
  runsUsing?: { value: string; line: number; column: number };
  /** `runs.using` was `composite`. */
  composite: boolean;
  /** The action metadata declares `runs.plugin` (first-party actions implemented inside the runner, e.g. actions/checkout@v1). */
  plugin?: boolean;
  /** `actions/setup-node` steps with their node-version / node-version-file inputs. */
  setupNode: SetupNodeSite[];
  /** `runs-on` labels of every job (matrix lists expanded). */
  runners: RunnerSite[];
  /** Set when the file could not be parsed as YAML. */
  error?: string;
  /** The YAML parser rejected the file but a line scan still found `uses:` lines (see `error`). */
  fallback?: boolean;
  /** Line of the YAML error (1-based), when known. */
  errorLine?: number;
}

export interface RunnerSite {
  file: string;
  line: number;
  column: number;
  label: string;
  fromMatrix: boolean;
}

export interface SetupNodeSite {
  file: string;
  /** Position of the `node-version` (or `node-version-file`) value. */
  line: number;
  column: number;
  /** Literal versions found (matrix lists are expanded). */
  versions: string[];
  fromMatrix: boolean;
  /** `node-version-file` input, when used instead. */
  versionFile?: string;
}

function getMap(map: YAMLMap, key: string): Node | null {
  for (const pair of map.items) {
    if (isScalar(pair.key) && pair.key.value === key) return (pair.value as Node | null) ?? null;
  }
  return null;
}

const STEP_SKIP_KEYS = new Set(['with', 'env', 'run', 'if', 'name', 'id', 'shell', 'continue-on-error', 'timeout-minutes', 'working-directory']);

/** Fallback for files the YAML parser rejects (GitHub's own parser is more lenient): scan for `uses:` lines. */
function lineScan(file: string, text: string, error: string, errorLine?: number): ParsedFile {
  const out: ParsedFile = { uses: [], composite: false, setupNode: [], runners: [], error, fallback: true };
  if (errorLine !== undefined) out.errorLine = errorLine;
  const re = /^(\s*(?:-\s+)?uses:\s*)(["']?)([^\s"'#]+)\2\s*(#.*)?$/;
  text.split(/\r?\n/).forEach((line, i) => {
    const m = re.exec(line);
    if (!m || /^\s*#/.test(line)) return;
    const site: UseSite = { file, line: i + 1, column: (m[1] as string).length + (m[2] ? 2 : 1), value: m[3] as string };
    if (m[4]) site.comment = m[4].replace(/^#\s*/, '').trim();
    out.uses.push(site);
  });
  return out;
}

const scalarText = (n: unknown): string | null => {
  if (isScalar(n) && n.value !== null && n.value !== undefined && typeof n.value !== 'object') return String(n.value);
  return null;
};

/** Extract every `uses:` reference (with position) from a workflow or an action metadata file. */
export function parseFile(file: string, text: string): ParsedFile {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, prettyErrors: false, strict: false, uniqueKeys: false });
  if (doc.errors.length > 0) {
    const e = doc.errors[0];
    const fb = lineScan(file, text, e?.message?.split('\n')[0] ?? 'invalid YAML', e?.linePos?.[0]?.line);
    return fb.uses.length > 0 ? fb : { ...fb, fallback: false };
  }
  const root = doc.contents;
  const out: ParsedFile = { uses: [], composite: false, setupNode: [], runners: [] };
  if (!isMap(root)) return out;

  const addUse = (node: Node | null): void => {
    if (!isScalar(node) || typeof node.value !== 'string' || !node.range) return;
    const pos = lc.linePos(node.range[0]);
    const site: UseSite = { file, line: pos.line, column: pos.col, value: node.value };
    if (node.comment) site.comment = node.comment.trim();
    out.uses.push(site);
  };

  /** values a matrix key can take: lists under `matrix.<key>` plus `include` entries */
  const matrixValues = (matrix: Node | null, key: string): string[] | null => {
    if (!isMap(matrix)) return null;
    const vals: string[] = [];
    const list = getMap(matrix, key);
    if (isSeq(list)) for (const it of list.items) {
      const t = scalarText(it);
      if (t !== null) vals.push(t);
    }
    const inc = getMap(matrix, 'include');
    if (isSeq(inc)) for (const it of inc.items) if (isMap(it)) {
      const t = scalarText(getMap(it, key));
      if (t !== null) vals.push(t);
    }
    return vals.length ? vals : null;
  };

  const noteSetupNode = (step: YAMLMap, matrix: Node | null): void => {
    const withMap = getMap(step, 'with');
    if (!isMap(withMap)) return;
    const nv = getMap(withMap, 'node-version');
    const nvf = getMap(withMap, 'node-version-file');
    const node = (nv ?? nvf) as Node | null;
    if (!isScalar(node) || !node.range) return;
    const raw = scalarText(node);
    if (raw === null) return;
    const pos = lc.linePos(node.range[0]);
    const site: SetupNodeSite = { file, line: pos.line, column: pos.col, versions: [], fromMatrix: false };
    if (!nv) {
      site.versionFile = raw;
      out.setupNode.push(site);
      return;
    }
    const expr = /^\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}$/.exec(raw.trim());
    if (expr) {
      const vals = matrixValues(matrix, expr[1] as string);
      if (!vals) return;
      site.versions = vals;
      site.fromMatrix = true;
    } else if (raw.includes('${{')) {
      return;
    } else {
      site.versions = [raw];
    }
    out.setupNode.push(site);
  };

  /** `runs-on: label`, `runs-on: [a, b]`, `runs-on: { labels: ... }` and `${{ matrix.os }}` of a job */
  const noteRunsOn = (node: Node | null, matrix: Node | null): void => {
    const add = (n: unknown, fromMatrix: boolean): void => {
      const label = scalarText(n);
      if (label === null || !isScalar(n) || !n.range || label.includes('${{')) return;
      const pos = lc.linePos(n.range[0]);
      out.runners.push({ file, line: pos.line, column: pos.col, label, fromMatrix });
    };
    if (isSeq(node)) {
      for (const it of node.items) noteRunsOn(it as Node, matrix);
      return;
    }
    if (isMap(node)) {
      const labels = getMap(node, 'labels');
      if (labels) noteRunsOn(labels, matrix);
      return;
    }
    if (!isScalar(node) || typeof node.value !== 'string' || !node.range) return;
    const expr = /^\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}$/.exec(node.value.trim());
    if (expr) {
      const pos = lc.linePos(node.range[0]);
      for (const v of matrixValues(matrix, expr[1] as string) ?? []) out.runners.push({ file, line: pos.line, column: pos.col, label: v, fromMatrix: true });
      return;
    }
    add(node, false);
  };

  // `steps` can nest (for example `- parallel:` groups), so walk sequences and maps below a step, but never into inputs
  const steps = (node: Node | null, matrix: Node | null): void => {
    if (!isSeq(node)) return;
    for (const step of node.items) {
      if (!isMap(step)) continue;
      const u = getMap(step, 'uses');
      addUse(u);
      if (isScalar(u) && typeof u.value === 'string' && u.value.startsWith('actions/setup-node@')) noteSetupNode(step, matrix);
      for (const pair of step.items) {
        const key = isScalar(pair.key) ? String(pair.key.value) : '';
        if (key === 'uses' || STEP_SKIP_KEYS.has(key)) continue;
        const v = pair.value as Node | null;
        if (isSeq(v)) steps(v, matrix);
        else if (isMap(v)) for (const inner of v.items) steps(inner.value as Node | null, matrix);
      }
    }
  };

  // workflows: jobs.<id>.uses (reusable workflow) and jobs.<id>.steps[].uses
  const jobs = getMap(root, 'jobs');
  if (isMap(jobs)) {
    for (const pair of jobs.items) {
      if (!isMap(pair.value)) continue;
      addUse(getMap(pair.value, 'uses'));
      const strategy = getMap(pair.value, 'strategy');
      const matrix = isMap(strategy) ? getMap(strategy, 'matrix') : null;
      noteRunsOn(getMap(pair.value, 'runs-on'), matrix);
      steps(getMap(pair.value, 'steps'), matrix);
    }
  }
  // actions: runs.using, runs.steps[].uses
  const runs = getMap(root, 'runs');
  if (isMap(runs)) {
    const using = getMap(runs, 'using');
    if (isScalar(using) && typeof using.value === 'string' && using.range) {
      const pos = lc.linePos(using.range[0]);
      out.runsUsing = { value: using.value, line: pos.line, column: pos.col };
      out.composite = using.value === 'composite';
    }
    if (getMap(runs, 'plugin') !== null) out.plugin = true;
    steps(getMap(runs, 'steps'), null);
  }
  return out;
}

/** Number of the Node runtime in `runs.using` (`node20` -> 20), or null for composite/docker/other. */
export function nodeMajor(using: string): number | null {
  const m = /^node(\d+)$/.exec(using.trim());
  return m ? Number(m[1]) : null;
}

/** GitHub removed node12, node16 and node20; node24 and newer are fine. */
export const MIN_NODE_MAJOR = 24;
