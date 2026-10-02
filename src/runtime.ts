import type { GitHubClient } from './github.js';
import { parseUses, refKey } from './refs.js';
import { MIN_NODE_MAJOR, nodeMajor, parseFile, type ParsedFile } from './workflow.js';

export type RemoteUses = { owner: string; repo: string; path: string; ref: string; isWorkflow: boolean };

export interface Evaluation {
  status: 'ok' | 'deprecated' | 'unresolved';
  /** Runtime of the deprecated leaf (`node20`). */
  using?: string;
  /** `runs.using` of the evaluated action itself (`node24`, `composite`, `docker`). */
  rootUsing?: string;
  /** Chain from the evaluated action down to the deprecated leaf (the action itself is not included). */
  via: string[];
  /** Why it is unresolved. */
  detail?: string;
}

const MAX_DEPTH = 4;

export function isDeprecatedUsing(using: string): boolean {
  const major = nodeMajor(using);
  return major !== null && major < MIN_NODE_MAJOR;
}

/** Resolves the effective runtime of an action or reusable workflow at an exact ref, looking through composites. */
export class Evaluator {
  private readonly memo = new Map<string, Promise<Evaluation>>();
  constructor(private readonly client: GitHubClient) {}

  evaluate(r: RemoteUses, depth = 0, stack: string[] = []): Promise<Evaluation> {
    const key = refKey(r);
    if (stack.includes(key)) return Promise.resolve({ status: 'ok', via: [] });
    let p = this.memo.get(key);
    if (!p) {
      p = this.compute(r, depth, [...stack, key]);
      this.memo.set(key, p);
    }
    return p;
  }

  private async load(r: RemoteUses): Promise<{ parsed: ParsedFile } | { fail: string }> {
    const candidates = r.isWorkflow ? [r.path] : [r.path ? `${r.path}/action.yml` : 'action.yml', r.path ? `${r.path}/action.yaml` : 'action.yaml'];
    let lastError = '';
    for (const file of candidates) {
      const res = await this.client.fileAt(r.owner, r.repo, file, r.ref);
      if (res.status === 'ok') {
        const parsed = parseFile(file, res.text);
        if (parsed.error) return { fail: `${file} is not valid YAML (${parsed.error})` };
        return { parsed };
      }
      if (res.status === 'error') lastError = res.message;
    }
    return { fail: lastError ? `could not fetch the action metadata (${lastError})` : `no action.yml at ${refKey(r)} (private, deleted or wrong ref?)` };
  }

  private async compute(r: RemoteUses, depth: number, stack: string[]): Promise<Evaluation> {
    const loaded = await this.load(r);
    if ('fail' in loaded) return { status: 'unresolved', via: [], detail: loaded.fail };
    const { parsed } = loaded;
    const rootUsing = r.isWorkflow ? 'workflow' : parsed.runsUsing?.value;
    if (!r.isWorkflow) {
      if (!rootUsing) return { status: 'unresolved', via: [], detail: 'runs.using is missing in the action metadata' };
      if (isDeprecatedUsing(rootUsing)) return { status: 'deprecated', using: rootUsing, rootUsing, via: [] };
      if (!parsed.composite) return { status: 'ok', rootUsing, via: [] };
    }
    if (depth >= MAX_DEPTH) return { status: 'ok', rootUsing, via: [], detail: 'nesting limit reached' };
    // composite action or reusable workflow: look at what it calls
    let unresolved: Evaluation | undefined;
    for (const site of parsed.uses) {
      const u = parseUses(site.value);
      if (!u || u.type !== 'remote') continue;
      const child = await this.evaluate(u, depth + 1, stack);
      const childKey = refKey(u);
      if (child.status === 'deprecated') {
        return { status: 'deprecated', using: child.using as string, rootUsing, via: [childKey, ...child.via] };
      }
      if (child.status === 'unresolved' && !unresolved) {
        unresolved = { status: 'unresolved', rootUsing, via: [childKey, ...child.via], detail: child.detail as string };
      }
    }
    return unresolved ?? { status: 'ok', rootUsing, via: [] };
  }
}
