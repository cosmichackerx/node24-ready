import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SetupNodeSite } from './workflow.js';
import type { Finding } from './types.js';

/** End-of-life dates of Node.js release lines (nodejs.org/en/about/previous-releases). Update when new lines ship. */
export const NODE_EOL: Record<number, string> = {
  8: '2019-12-31',
  10: '2021-04-30',
  12: '2022-04-30',
  14: '2023-04-30',
  16: '2023-09-11',
  17: '2022-06-01',
  18: '2025-04-30',
  19: '2023-06-01',
  20: '2026-04-30',
  21: '2024-06-01',
  22: '2027-04-30',
  23: '2025-06-01',
  24: '2028-04-30',
  25: '2026-06-01',
  26: '2029-04-30',
  27: '2030-04-30',
};

const LTS_NAMES: Record<string, number> = {
  argon: 4, boron: 6, carbon: 8, dubnium: 10, erbium: 12, fermium: 14, gallium: 16, hydrogen: 18, iron: 20, jod: 22, krypton: 24,
};

/** Major version from a setup-node style spec (`20`, `v20.11.1`, `20.x`, `^20`, `lts/iron`), or null when it is not pinned. */
export function majorOf(spec: string): number | null {
  const s = spec.trim().replace(/^['"]|['"]$/g, '');
  const lts = /^lts\/([a-z]+)$/i.exec(s);
  if (lts) return LTS_NAMES[(lts[1] as string).toLowerCase()] ?? null;
  const m = /^(?:[v^~=]\s*)?(\d+)(?:\.(?:\d+|x|\*)){0,2}(?:-[\w.]+)?$/i.exec(s);
  return m ? Number(m[1]) : null;
}

const DAY = 86_400_000;

export interface EolOptions {
  today: string;
  /** Warn this many days ahead of the end-of-life date (info severity). */
  horizonDays?: number;
  cwd: string;
}

function versionFromFile(cwd: string, rel: string): string | null {
  try {
    const text = readFileSync(join(cwd, rel), 'utf8');
    if (/\.tool-versions$/.test(rel)) {
      const m = /^\s*nodejs\s+(\S+)/m.exec(text);
      return m ? (m[1] as string) : null;
    }
    if (/package\.json$/.test(rel)) return null;
    return (text.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith('#')) ?? '').trim() || null;
  } catch {
    return null;
  }
}

/** Findings for setup-node steps that install an end-of-life (or soon end-of-life) Node.js line. */
export function eolFindings(sites: SetupNodeSite[], opts: EolOptions): Finding[] {
  const out: Finding[] = [];
  const today = Date.parse(opts.today);
  const horizon = (opts.horizonDays ?? 90) * DAY;
  for (const site of sites) {
    let specs = site.versions;
    if (site.versionFile) {
      const v = versionFromFile(opts.cwd, site.versionFile);
      if (!v) continue;
      specs = [v];
    }
    const seen = new Set<number>();
    for (const spec of specs) {
      const major = majorOf(spec);
      if (major === null || seen.has(major)) continue;
      seen.add(major);
      const eol = NODE_EOL[major];
      if (!eol) continue;
      const left = Date.parse(eol) - today;
      if (left > horizon) continue;
      const expired = left <= 0;
      // a matrix that tests several versions is usually deliberate (libraries), so it is only information
      const severity = expired && !site.fromMatrix ? 'warning' : 'info';
      const where = site.versionFile ? `${site.versionFile} says` : site.fromMatrix ? 'the matrix includes' : 'node-version';
      out.push({
        rule: 'setup-node-eol',
        severity,
        file: site.file,
        line: site.line,
        column: site.column,
        uses: `node ${spec.trim()}`,
        runtime: `node${major}`,
        message: expired
          ? `${where} Node.js ${major}, which reached end of life on ${eol}`
          : `${where} Node.js ${major}, which reaches end of life on ${eol} (${Math.ceil(left / DAY)} days)`,
        via: [],
      });
    }
  }
  return out;
}
