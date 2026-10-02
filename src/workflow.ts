import { LineCounter, isMap, isScalar, isSeq, parseDocument, type Node, type YAMLMap } from 'yaml';
import type { UseSite } from './types.js';

export interface ParsedFile {
  uses: UseSite[];
  /** `runs.using` of an action metadata file. */
  runsUsing?: { value: string; line: number; column: number };
  /** `runs.using` was `composite`. */
  composite: boolean;
  /** Set when the file could not be parsed. */
  error?: string;
}

function getMap(map: YAMLMap, key: string): Node | null {
  for (const pair of map.items) {
    if (isScalar(pair.key) && pair.key.value === key) return (pair.value as Node | null) ?? null;
  }
  return null;
}

/** Extract every `uses:` reference (with position) from a workflow or an action metadata file. */
export function parseFile(file: string, text: string): ParsedFile {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, prettyErrors: false, strict: false, uniqueKeys: false });
  if (doc.errors.length > 0) return { uses: [], composite: false, error: doc.errors[0]?.message ?? 'invalid YAML' };
  const root = doc.contents;
  const out: ParsedFile = { uses: [], composite: false };
  if (!isMap(root)) return out;

  const addUse = (node: Node | null): void => {
    if (!isScalar(node) || typeof node.value !== 'string' || !node.range) return;
    const pos = lc.linePos(node.range[0]);
    const site: UseSite = { file, line: pos.line, column: pos.col, value: node.value };
    if (node.comment) site.comment = node.comment.trim();
    out.uses.push(site);
  };
  const steps = (node: Node | null): void => {
    if (!isSeq(node)) return;
    for (const step of node.items) if (isMap(step)) addUse(getMap(step, 'uses'));
  };

  // workflows: jobs.<id>.uses (reusable workflow) and jobs.<id>.steps[].uses
  const jobs = getMap(root, 'jobs');
  if (isMap(jobs)) {
    for (const pair of jobs.items) {
      if (!isMap(pair.value)) continue;
      addUse(getMap(pair.value, 'uses'));
      steps(getMap(pair.value, 'steps'));
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
    steps(getMap(runs, 'steps'));
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
