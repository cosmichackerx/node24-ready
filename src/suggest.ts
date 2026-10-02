import type { GitHubClient } from './github.js';
import { compareVersions, isFullSha, parseTagVersion, type Semver } from './refs.js';
import type { Evaluator, RemoteUses } from './runtime.js';
import type { Suggestion } from './types.js';

interface MajorInfo {
  major: number;
  /** Highest concrete release tag of that major. */
  exact: { name: string; sha: string; v: Semver };
  /** A moving `vN` tag exists. */
  floating?: string;
}

export interface SuggestResult {
  suggestion?: Suggestion;
  reason?: string;
}

const MAX_CHECKS = 6;

/** Find the smallest upgrade (lowest newer major) whose release resolves to a supported Node runtime. */
export async function suggest(client: GitHubClient, evaluator: Evaluator, r: RemoteUses): Promise<SuggestResult> {
  const tags = await client.tags(r.owner, r.repo);
  if (tags === null) return { reason: `tags of ${r.owner}/${r.repo} could not be listed` };
  const majors = new Map<number, MajorInfo>();
  for (const t of tags) {
    const v = parseTagVersion(t.name);
    if (!v) continue;
    const cur = majors.get(v.major);
    if (v.floating) {
      if (cur) cur.floating = t.name;
      else majors.set(v.major, { major: v.major, exact: { name: t.name, sha: t.sha, v }, floating: t.name });
      continue;
    }
    if (!cur) majors.set(v.major, { major: v.major, exact: { name: t.name, sha: t.sha, v } });
    else if (cur.exact.v.floating || compareVersions(v, cur.exact.v) > 0) cur.exact = { name: t.name, sha: t.sha, v };
  }
  if (majors.size === 0) return { reason: `${r.owner}/${r.repo} has no version tags` };

  let currentMajor: number | undefined;
  const parsed = parseTagVersion(r.ref);
  if (parsed) currentMajor = parsed.major;
  else if (isFullSha(r.ref)) {
    const hit = tags.map((t) => ({ t, v: parseTagVersion(t.name) })).find((x) => x.v && x.t.sha.toLowerCase() === r.ref.toLowerCase());
    if (hit?.v) currentMajor = hit.v.major;
  }

  const sorted = [...majors.values()].sort((a, b) => a.major - b.major);
  // with a known current major check the next ones in ascending order (smallest upgrade first);
  // otherwise only the newest major is worth a look
  const candidates = currentMajor === undefined ? sorted.slice(-1) : sorted.filter((m) => m.major > (currentMajor as number)).slice(0, MAX_CHECKS);
  if (candidates.length === 0) {
    return { reason: currentMajor === undefined ? 'no version tags found' : `no release newer than v${currentMajor} exists yet; ask the maintainers to publish a node24 release` };
  }
  for (const c of candidates) {
    const ev = await evaluator.evaluate({ ...r, ref: c.exact.name });
    if (ev.status === 'ok') {
      return {
        suggestion: { ref: c.floating ?? c.exact.name, tag: c.exact.name, sha: c.exact.sha, using: ev.rootUsing ?? 'node24' },
      };
    }
  }
  const last = candidates[candidates.length - 1] as MajorInfo;
  return { reason: `none of the newer releases (up to ${last.exact.name}) declares node24 yet; ask the maintainers or replace the action` };
}
