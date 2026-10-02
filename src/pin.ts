import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { planEdits, type Edit, type FixPlan } from './fix.js';
import type { GitHubClient } from './github.js';
import { isFullSha, parseTagVersion, parseUses, compareVersions } from './refs.js';
import { discoverFiles } from './scan.js';
import { parseFile } from './workflow.js';

export interface PinSkip {
  file: string;
  line: number;
  uses: string;
  reason: string;
}

export interface PinPlan extends FixPlan {
  skipped: PinSkip[];
  /** `uses:` lines that are already pinned to a full commit SHA */
  alreadyPinned: number;
}

/**
 * `--pin-only`: replace tag refs by the commit SHA they point to *today*, with the tag as a comment.
 * The major version never changes and nothing is upgraded: `actions/checkout@v4` becomes
 * `actions/checkout@<sha of v4> # v4.2.2` (the exact release that `v4` currently equals, when one exists).
 */
export async function planPins(opts: { paths: string[]; cwd: string; client: GitHubClient }): Promise<PinPlan> {
  const files = discoverFiles(opts.paths, opts.cwd);
  const edits: Edit[] = [];
  const skipped: PinSkip[] = [];
  let alreadyPinned = 0;
  const seen = new Set<string>();

  for (const abs of files) {
    const rel = relative(opts.cwd, abs).split(sep).join('/');
    const parsed = parseFile(rel, readFileSync(abs, 'utf8'));
    for (const site of parsed.uses) {
      const u = parseUses(site.value);
      if (!u || u.type !== 'remote') continue;
      const skip = (reason: string): void => {
        skipped.push({ file: rel, line: site.line, uses: site.value, reason });
      };
      if (isFullSha(u.ref)) {
        alreadyPinned++;
        continue;
      }
      const tags = await opts.client.tags(u.owner, u.repo);
      if (tags === null) {
        skip(`tags of ${u.owner}/${u.repo} could not be listed (private, missing or rate limited)`);
        continue;
      }
      const hit = tags.find((t) => t.name === u.ref);
      if (!hit) {
        skip(`'${u.ref}' is not among the tags of ${u.owner}/${u.repo} (a branch, or not in the first 300 tags); branches are never pinned`);
        continue;
      }
      // the most specific tag on the same commit makes the best comment (v4 -> v4.2.2)
      const same = tags
        .filter((t) => t.sha.toLowerCase() === hit.sha.toLowerCase())
        .map((t) => ({ t, v: parseTagVersion(t.name) }))
        .filter((x): x is { t: (typeof tags)[number]; v: NonNullable<ReturnType<typeof parseTagVersion>> } => x.v !== null);
      same.sort((a, b) => Number(a.v.floating) - Number(b.v.floating) || compareVersions(b.v, a.v));
      const label = same[0]?.t.name ?? u.ref;
      const key = `${rel}:${site.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edits.push({
        file: rel,
        line: site.line,
        uses: site.value,
        next: (_u, existing) => {
          const note = existing.replace(/^\s*#\s*/, '').trim();
          return { ref: hit.sha, comment: note && !note.startsWith(label) ? `${label} ${note}` : label };
        },
      });
    }
  }
  const plan = planEdits(edits, opts.cwd);
  return { ...plan, skipped, alreadyPinned };
}
