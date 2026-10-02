import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isFullSha, parseUses } from './refs.js';
import type { Finding } from './types.js';

export interface FixResult {
  file: string;
  line: number;
  from: string;
  to: string;
}

/** The `uses:` value on a line, with the pieces needed to rewrite it. */
const USES_LINE = /^(\s*(?:-\s+)?uses:\s*)(["']?)([^\s"'#]+)\2(\s*#.*)?$/;

/** Rewrite the `uses:` lines of findings that have a suggestion. Returns what changed. */
export function applyFixes(findings: Finding[], cwd: string): FixResult[] {
  const byFile = new Map<string, Finding[]>();
  for (const f of findings) {
    if (!f.suggestion || f.rule === 'local-action-runtime') continue;
    const list = byFile.get(f.file) ?? [];
    list.push(f);
    byFile.set(f.file, list);
  }
  const results: FixResult[] = [];
  for (const [file, list] of byFile) {
    const abs = resolve(cwd, file);
    const raw = readFileSync(abs, 'utf8');
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const lines = raw.split(/\r?\n/);
    let changed = false;
    for (const f of list) {
      const idx = f.line - 1;
      const m = USES_LINE.exec(lines[idx] ?? '');
      const sug = f.suggestion;
      if (!m || !sug || m[3] !== f.uses) continue;
      const u = parseUses(m[3] as string);
      if (!u || u.type !== 'remote') continue;
      const prefix = `${u.owner}/${u.repo}${u.path ? `/${u.path}` : ''}`;
      const q = m[2] as string;
      let next: string;
      if (isFullSha(u.ref) && sug.sha) next = `${m[1]}${q}${prefix}@${sug.sha}${q} # ${sug.tag}`;
      else next = `${m[1]}${q}${prefix}@${sug.ref}${q}${m[4] ?? ''}`;
      if (next === lines[idx]) continue;
      lines[idx] = next;
      changed = true;
      results.push({ file, line: f.line, from: f.uses, to: next.trim().replace(/^(-\s+)?uses:\s*/, '') });
    }
    if (changed) writeFileSync(abs, lines.join(eol));
  }
  return results;
}
