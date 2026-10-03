import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isFullSha, parseUses } from './refs.js';
import { unifiedDiff } from './udiff.js';
import type { Finding } from './types.js';

export interface FixResult {
  file: string;
  line: number;
  /** runner-label edits only */
  column?: number;
  from: string;
  to: string;
}

/** The `uses:` value on a line, with the pieces needed to rewrite it. */
const USES_LINE = /^(\s*(?:-\s+)?uses:\s*)(["']?)([^\s"'#]+)\2(\s*#.*)?$/;

export interface FixPlan {
  changes: FixResult[];
  /** per file: the new content and a unified diff against the current content */
  files: { file: string; abs: string; content: string; diff: string }[];
}

export interface Edit {
  file: string;
  line: number;
  /** the `uses:` value expected on that line; the edit is skipped when the line changed */
  uses: string;
  /** new `ref` and trailing comment for the line */
  next: (u: { owner: string; repo: string; path: string; ref: string }, existingComment: string) => { ref: string; comment: string | null } | null;
}

/** Apply `uses:` edits in memory (CRLF safe) and build a unified diff per file. Nothing is written. */
export function planEdits(edits: Edit[], cwd: string): FixPlan {
  const byFile = new Map<string, Edit[]>();
  for (const e of edits) {
    const list = byFile.get(e.file) ?? [];
    list.push(e);
    byFile.set(e.file, list);
  }
  const results: FixResult[] = [];
  const files: FixPlan['files'] = [];
  for (const [file, list] of byFile) {
    const abs = resolve(cwd, file);
    const raw = readFileSync(abs, 'utf8');
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const lines = raw.split(/\r?\n/);
    const original = [...lines];
    const forDiff = (a: string[]): string[] => {
      const b = a[a.length - 1] === '' ? a.slice(0, -1) : a.slice(); // drop the empty piece after the final newline
      return eol === '\r\n' ? b.map((x) => `${x}\r`) : b;
    };
    let changed = false;
    for (const e of list) {
      const idx = e.line - 1;
      const m = USES_LINE.exec(lines[idx] ?? '');
      if (!m || m[3] !== e.uses) continue;
      const u = parseUses(m[3] as string);
      if (!u || u.type !== 'remote') continue;
      const out = e.next(u, m[4] ?? '');
      if (!out) continue;
      const prefix = `${u.owner}/${u.repo}${u.path ? `/${u.path}` : ''}`;
      const q = m[2] as string;
      const next = `${m[1]}${q}${prefix}@${out.ref}${q}${out.comment ? ` # ${out.comment}` : (m[4] ?? '')}`;
      if (next === lines[idx]) continue;
      lines[idx] = next;
      changed = true;
      results.push({ file, line: e.line, from: e.uses, to: next.trim().replace(/^(-\s+)?uses:\s*/, '') });
    }
    if (changed) files.push({ file, abs, content: lines.join(eol), diff: unifiedDiff(file, forDiff(original), forDiff(lines)) });
  }
  return { changes: results, files };
}

/** Work out the `uses:` rewrites for findings that have a suggestion, without touching the disk. */
export function planFixes(findings: Finding[], cwd: string): FixPlan {
  const edits: Edit[] = [];
  for (const f of findings) {
    const sug = f.suggestion;
    if (!sug || f.rule === 'local-action-runtime') continue;
    edits.push({
      file: f.file,
      line: f.line,
      uses: f.uses,
      next: (u) => (isFullSha(u.ref) && sug.sha ? { ref: sug.sha, comment: sug.tag } : { ref: sug.ref, comment: null }),
    });
  }
  return planEdits(edits, cwd);
}

/** Rewrite the `uses:` lines of findings that have a suggestion. Returns what changed. */
export function applyFixes(findings: Finding[], cwd: string): FixResult[] {
  return writePlan(planFixes(findings, cwd));
}

export function writePlan(plan: FixPlan): FixResult[] {
  for (const f of plan.files) writeFileSync(f.abs, f.content);
  return plan.changes;
}

const WORD = /[A-Za-z0-9._-]/;

/** Rewrite one `runs-on` label in place: the text at the recorded position must still be exactly that label. */
export function planRunnerEdits(findings: Finding[], cwd: string): FixPlan {
  const byFile = new Map<string, { line: number; column: number; from: string; to: string }[]>();
  for (const f of findings) if (f.labelFix) {
    const list = byFile.get(f.file) ?? [];
    if (!list.some((e) => e.line === f.labelFix!.line && e.column === f.labelFix!.column)) list.push(f.labelFix);
    byFile.set(f.file, list);
  }
  const results: FixResult[] = [];
  const files: FixPlan['files'] = [];
  for (const [file, list] of byFile) {
    const abs = resolve(cwd, file);
    const raw = readFileSync(abs, 'utf8');
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const lines = raw.split(/\r?\n/);
    const original = [...lines];
    const forDiff = (a: string[]): string[] => {
      const b = a[a.length - 1] === '' ? a.slice(0, -1) : a.slice();
      return eol === '\r\n' ? b.map((x) => `${x}\r`) : b;
    };
    let changed = false;
    // right to left on a line so earlier columns stay valid
    for (const e of [...list].sort((a, b) => b.line - a.line || b.column - a.column)) {
      const text = lines[e.line - 1];
      if (text === undefined) continue;
      let i = e.column - 1;
      if (text[i] === '"' || text[i] === "'") i++;
      if (text.slice(i, i + e.from.length) !== e.from || WORD.test(text[i + e.from.length] ?? ' ')) continue;
      lines[e.line - 1] = text.slice(0, i) + e.to + text.slice(i + e.from.length);
      changed = true;
      results.push({ file, line: e.line, column: e.column, from: e.from, to: e.to });
    }
    if (changed) files.push({ file, abs, content: lines.join(eol), diff: unifiedDiff(file, forDiff(original), forDiff(lines)) });
  }
  return { changes: results, files };
}
