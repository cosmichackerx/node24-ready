import { execFileSync } from 'node:child_process';
import type { Finding } from './types.js';

export type ChangedLines = Map<string, { all: boolean; ranges: [number, number][] }>;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

export class GitError extends Error {}

function baseOf(cwd: string, ref: string): string {
  try {
    return git(cwd, ['merge-base', ref, 'HEAD']).trim();
  } catch {
    try {
      return git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
    } catch {
      throw new GitError(`--changed-since: '${ref}' is not a known commit or branch in ${cwd} (a shallow checkout needs fetch-depth: 0)`);
    }
  }
}

/** Content of a file as it was at the merge base with `ref`, or null when it did not exist there. */
export function fileAtBase(cwd: string, ref: string, rel: string): string | null {
  const base = baseOf(cwd, ref);
  try {
    return git(cwd, ['show', `${base}:./${rel}`]);
  } catch {
    return null;
  }
}

/** Lines changed since the merge base of `ref` and HEAD (working tree included), plus untracked files. Paths are relative to `cwd`. */
export function changedLines(cwd: string, ref: string): ChangedLines {
  const base = baseOf(cwd, ref);
  const out: ChangedLines = new Map();
  const diff = git(cwd, ['diff', '--relative', '-U0', '--no-color', '--no-ext-diff', '--no-renames', base, '--', '.']);
  let file: string | undefined;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4);
      file = p === '/dev/null' ? undefined : p.replace(/^b\//, '');
      if (file) out.set(file, { all: false, ranges: [] });
    } else if (line.startsWith('@@') && file) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      if (count > 0) out.get(file)?.ranges.push([start, start + count - 1]);
    }
  }
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard', '--', '.']);
  for (const p of untracked.split('\n')) if (p) out.set(p, { all: true, ranges: [] });
  return out;
}

/** Keep findings on touched lines. `hidden` counts the others. */
export function filterChanged(findings: Finding[], changed: ChangedLines, keepAlways: (f: Finding) => boolean): { kept: Finding[]; hidden: number } {
  const kept: Finding[] = [];
  let hidden = 0;
  for (const f of findings) {
    const c = changed.get(f.file);
    const touched = keepAlways(f) || (c !== undefined && (c.all || c.ranges.some(([a, b]) => f.line >= a && f.line <= b)));
    if (touched) kept.push(f);
    else hidden++;
  }
  return { kept, hidden };
}
