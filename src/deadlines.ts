import type { Finding, Severity, UseSite } from './types.js';
import type { RunnerSite } from './workflow.js';

/**
 * Dated deadlines that are announced by GitHub or Docker and that a workflow file can trip over.
 * Every entry names the official source it was read from and the day it was last checked against it.
 * Times are UTC; the scanner works on whole days.
 */
export interface Brownout {
  from: string; // ISO date-time, UTC
  to: string;
}

export interface RunnerDeadline {
  id: string;
  labels: Record<string, string>; // label -> replacement hint
  deprecated?: string; // YYYY-MM-DD, images start to queue slowly
  brownouts: Brownout[];
  retired: string; // YYYY-MM-DD, jobs on the label fail
  note?: string;
  sources: string[];
  verified: string; // YYYY-MM-DD
}

const win = (day: string): Brownout => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return { from: `${day}T14:00:00Z`, to: `${next}T00:00:00Z` };
};

export const RUNNER_DEADLINES: RunnerDeadline[] = [
  {
    id: 'macos-14',
    labels: {
      'macos-14': 'macos-latest, macos-15 or macos-26',
      'macos-14-large': 'macos-latest-large or macos-15-large',
      'macos-14-xlarge': 'macos-latest-xlarge, macos-15-xlarge or macos-26-xlarge',
    },
    deprecated: '2026-07-06',
    brownouts: ['2026-10-05', '2026-10-12', '2026-10-16', '2026-10-19', '2026-10-23', '2026-10-26', '2026-10-29', '2026-10-30'].map(win),
    retired: '2026-11-02',
    sources: ['https://github.com/actions/runner-images/issues/13518', 'https://github.blog/changelog/2026-10-01-github-actions-macos-14-runner-image-retirement/'],
    verified: '2026-10-03',
  },
  {
    id: 'ubuntu-22.04',
    labels: {
      'ubuntu-22.04': 'ubuntu-24.04, ubuntu-26.04 or ubuntu-latest',
      'ubuntu-22.04-arm': 'ubuntu-24.04-arm or ubuntu-26.04-arm',
    },
    deprecated: '2026-09-17',
    brownouts: ['2027-03-23', '2027-03-30', '2027-04-06', '2027-04-13'].map(win),
    retired: '2027-04-17',
    note: 'the announcement lists the brownout times as "14:00 UTC - 00:00 UTC" on the same date; read here as 14:00 UTC until midnight, as in the macOS announcements',
    sources: ['https://github.com/actions/runner-images/issues/14254'],
    verified: '2026-10-03',
  },
  {
    id: 'macos-13',
    labels: { 'macos-13': 'macos-15 or macos-latest' },
    deprecated: '2025-09-22',
    brownouts: [],
    retired: '2025-12-04',
    note: 'the title of the announcement says December 4, its text says December 8, 2025',
    sources: ['https://github.com/actions/runner-images/issues/13046'],
    verified: '2026-10-03',
  },
  {
    id: 'windows-2019',
    labels: { 'windows-2019': 'windows-2022, windows-2025 or windows-latest' },
    deprecated: '2025-06-01',
    brownouts: [],
    retired: '2025-06-30',
    sources: ['https://github.com/actions/runner-images/issues/12045'],
    verified: '2026-10-03',
  },
  {
    id: 'ubuntu-20.04',
    labels: { 'ubuntu-20.04': 'ubuntu-24.04 or ubuntu-latest' },
    deprecated: '2025-02-01',
    brownouts: [],
    retired: '2025-04-15',
    sources: ['https://github.com/actions/runner-images/issues/11101'],
    verified: '2026-10-03',
  },
  {
    id: 'macos-12',
    labels: { 'macos-12': 'macos-15 or macos-latest' },
    deprecated: '2024-10-07',
    brownouts: [],
    retired: '2024-12-03',
    sources: ['https://github.com/actions/runner-images/issues/10721'],
    verified: '2026-10-03',
  },
];

/** `ubuntu-latest` moves from Ubuntu 24.04 to 26.04 during this window (gradual roll-out). */
export const UBUNTU_LATEST = {
  from: '2026-10-19',
  to: '2026-11-19',
  source: 'https://github.blog/changelog/2026-09-17-ubuntu-26-generally-available-and-latest-migration/',
  announcement: 'https://github.com/actions/runner-images/issues/14748', // says November 2026; the changelog gives the window 2026-10-19 to 2026-11-19
  verified: '2026-10-03',
};

/** Docker Content Trust and the Notary v1 service are retired. */
export const DCT = {
  brownouts: ['2026-07-14', '2026-07-15', '2026-08-10', '2026-08-12'],
  shutdown: '2026-12-08',
  sources: ['https://www.docker.com/blog/docker-content-trust-retirement-and-migration-guidance/', 'https://docs.docker.com/engine/security/trust/'],
  verified: '2026-10-03',
};

const DAY = 86_400_000;
const days = (a: string, b: string): number => Math.round((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / DAY);

/** error when the date has passed or is within `urgentDays`, warning otherwise */
function ramp(left: number, urgentDays: number): Severity {
  return left <= urgentDays ? 'error' : 'warning';
}

/** Label rewrites `--fix-runners` makes. One step to the next generation of the same family and architecture; nothing else. */
export const RUNNER_FIX: Record<string, { to: string; caveat: string }> = {
  'macos-14': { to: 'macos-15', caveat: 'macOS 15 image: different default Xcode and tool versions (same arm64 architecture)' },
  'macos-14-large': { to: 'macos-15-large', caveat: 'macOS 15 image: different default Xcode and tool versions (same Intel x64 architecture)' },
  'macos-14-xlarge': { to: 'macos-15-xlarge', caveat: 'macOS 15 image: different default Xcode and tool versions (same arm64 architecture)' },
  'ubuntu-22.04': { to: 'ubuntu-24.04', caveat: 'Ubuntu 24.04 image: newer default toolchains and a different package set; check apt packages and pinned tool versions' },
  'ubuntu-22.04-arm': { to: 'ubuntu-24.04-arm', caveat: 'Ubuntu 24.04 image: newer default toolchains and a different package set; check apt packages and pinned tool versions' },
};

const index = new Map<string, { d: RunnerDeadline; hint: string }>();
for (const d of RUNNER_DEADLINES) for (const [label, hint] of Object.entries(d.labels)) index.set(label, { d, hint });

export interface DeadlineOptions {
  today: string;
  urgentDays?: number;
}

/** Findings for `runs-on` labels that are retired or about to be, and for `ubuntu-latest` during its migration window. */
export function runnerFindings(sites: RunnerSite[], opts: DeadlineOptions): Finding[] {
  const urgent = opts.urgentDays ?? 30;
  const out: Finding[] = [];
  for (const s of sites) {
    const label = s.label.trim().toLowerCase();
    const hit = index.get(label);
    if (hit) {
      const { d, hint } = hit;
      const fix = RUNNER_FIX[label];
      const toRetire = days(opts.today, d.retired);
      const upcoming = d.brownouts.filter((b) => b.to.slice(0, 10) >= opts.today);
      const active = d.brownouts.find((b) => b.from.slice(0, 10) <= opts.today && b.to.slice(0, 10) >= opts.today);
      const next = upcoming[0];
      let severity: Severity;
      let msg: string;
      if (toRetire <= 0) {
        severity = 'error';
        msg = `${s.label} was retired on ${d.retired}: jobs on this label fail`;
      } else if (active) {
        severity = 'error';
        msg = `${s.label} is in a scheduled brownout (${active.from.slice(0, 16)}Z to ${active.to.slice(0, 16)}Z): jobs on it fail on purpose; it is retired on ${d.retired} (${toRetire} days)`;
      } else {
        const nextDays = next ? days(opts.today, next.from) : toRetire;
        severity = ramp(Math.min(nextDays, toRetire), urgent);
        msg = `${s.label} is retired on ${d.retired} (${toRetire} days)` + (next ? `; next brownout ${next.from.slice(0, 16)}Z (${nextDays} days)` : '') + (d.deprecated && opts.today < d.deprecated ? `; deprecation starts ${d.deprecated}` : '');
      }
      out.push({
        rule: 'runner-image-retiring',
        severity: s.fromMatrix && severity === 'error' && toRetire > 0 ? 'warning' : severity,
        file: s.file,
        line: s.line,
        column: s.column,
        uses: s.label,
        message: `${msg}. Move to ${hint}.`,
        via: [],
        ...(fix && s.at && !sites.some((o) => o.file === s.file && o.label.trim().toLowerCase() === fix.to) ? { labelFix: { line: s.at.line, column: s.at.column, from: s.label, to: fix.to, caveat: fix.caveat } } : {}),
      });
      continue;
    }
    if (label === 'ubuntu-latest' || label === 'ubuntu-latest-arm') {
      const left = days(opts.today, UBUNTU_LATEST.to);
      if (left < 0) continue;
      const start = days(opts.today, UBUNTU_LATEST.from);
      const sev: Severity = start <= 14 ? 'warning' : 'info';
      out.push({
        rule: 'runner-latest-migration',
        severity: sev,
        file: s.file,
        line: s.line,
        column: s.column,
        uses: s.label,
        message:
          start > 0
            ? `${s.label} moves from Ubuntu 24.04 to 26.04 between ${UBUNTU_LATEST.from} and ${UBUNTU_LATEST.to} (starts in ${start} days). Test with ubuntu-26.04 or pin ubuntu-24.04`
            : `${s.label} is moving from Ubuntu 24.04 to 26.04 right now (roll-out until ${UBUNTU_LATEST.to}). Test with ubuntu-26.04 or pin ubuntu-24.04`,
        via: [],
      });
    }
  }
  return out;
}

export interface DctSite {
  file: string;
  line: number;
  column: number;
  what: string;
}

const DCT_PATTERNS: Array<[RegExp, (m: RegExpExecArray) => string | null]> = [
  [/\bDOCKER_CONTENT_TRUST\b(?!_)["']?(?:\s*[:=]\s*|\s+)["']?(\w+)/, (m) => (/^(1|true|yes|on)$/i.test(m[1] as string) ? 'DOCKER_CONTENT_TRUST is switched on' : null)],
  [/\bdocker\s+trust\s+(sign|inspect|revoke|key|signer)\b/, (m) => `docker trust ${m[1]}`],
  [/\bnotary\.docker\.io\b/, () => 'notary.docker.io (the Notary v1 server)'],
  [/--disable-content-trust(?:=|\s+)["']?(false|0)\b/, () => 'content trust switched on with --disable-content-trust=false'],
];

/** Files outside `.github` that can switch Docker Content Trust on: Dockerfiles, compose files, Kubernetes manifests and other YAML, shell scripts, Makefiles, .env files. */
export const DCT_FILE_RE = /(^|\/)(Dockerfile(\.[^/]*)?|[^/]*\.Dockerfile|Containerfile(\.[^/]*)?|Makefile|GNUmakefile|[^/]*\.mk|[^/]*\.sh|\.env(\.[^/]*)?|[^/]*\.ya?ml)$/i;
export const DCT_MAX_BYTES = 1_000_000;

/** `- name: DOCKER_CONTENT_TRUST` with `value: "1"` on the next line, or `{ name: DOCKER_CONTENT_TRUST, value: "1" }` (Kubernetes / compose list form). */
const DCT_NAME_VALUE = /(^|[\s{,])name:\s*["']?DOCKER_CONTENT_TRUST["']?\s*(?:,|\r?\n)\s*value:\s*["']?(\w+)/g;

/** Lines that use Docker Content Trust. Whole-line comments are skipped; `DOCKER_CONTENT_TRUST: 0` is the recommended fix and is not reported. */
export function dctSites(file: string, text: string): DctSite[] {
  const out: DctSite[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    for (const [re, what] of DCT_PATTERNS) {
      const m = re.exec(line);
      if (!m) continue;
      const w = what(m);
      if (w) out.push({ file, line: i + 1, column: m.index + 1, what: w });
    }
  });
  // list form (`name:` and `value:` on separate lines); the single-line patterns above cannot see it
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  for (const m of text.matchAll(DCT_NAME_VALUE)) {
    if (!/^(1|true|yes|on)$/i.test(m[2] as string)) continue;
    const at = (m.index ?? 0) + (m[1] ?? '').length;
    let lo = 0;
    while (lo + 1 < lineStarts.length && (lineStarts[lo + 1] as number) <= at) lo++;
    const lineText = text.slice(lineStarts[lo] as number, at);
    if (/^\s*#/.test(lineText) || /#/.test(lineText)) continue;
    out.push({ file, line: lo + 1, column: at - (lineStarts[lo] as number) + 1, what: 'DOCKER_CONTENT_TRUST is switched on' });
  }
  return out.sort((a, b) => a.line - b.line || a.column - b.column);
}

export function dctFindings(sites: DctSite[], opts: DeadlineOptions): Finding[] {
  const left = days(opts.today, DCT.shutdown);
  const severity: Severity = left <= 0 ? 'error' : ramp(left, opts.urgentDays ?? 30);
  return sites.map((s) => ({
    rule: 'docker-content-trust' as const,
    severity,
    file: s.file,
    line: s.line,
    column: s.column,
    uses: s.what,
    message:
      `${s.what}: Docker Content Trust and the Notary v1 service ${left <= 0 ? 'were shut down on' : 'shut down on'} ${DCT.shutdown}` +
      (left > 0 ? ` (${left} days)` : '') +
      '. Signing breaks first. Set DOCKER_CONTENT_TRUST=0 to keep pulls working, pin images by digest, and sign with Cosign or Notation',
    via: [],
  }));
}

/**
 * A deadline GitHub announced with a month but no day. The scanner does not invent a day: before the month it counts whole days to the first of the month,
 * inside it every day is "possibly today", after it the outcome is unknown and the finding says so.
 */
export interface MonthDeadline {
  id: string;
  month: string; // YYYY-MM
  /** What is known about the day, if anything beyond the month (never used for the arithmetic). */
  dayHint?: string;
  sources: string[];
  verified: string; // YYYY-MM-DD
}

export const CODEQL_V3: MonthDeadline = {
  id: 'codeql-action-v3',
  month: '2026-12',
  dayHint: 'the announcement ties it to the GHES 3.19 deprecation; the GHES releases page lists 2026-12-09 as the "closing down date" of 3.19, but the CodeQL announcement itself gives only the month',
  sources: ['https://github.blog/changelog/2025-10-28-upcoming-deprecation-of-codeql-action-v3/', 'https://docs.github.com/en/enterprise-server@3.19/admin/all-releases'],
  verified: '2026-10-03',
};

export type MonthPhase = { phase: 'before' | 'during' | 'after'; daysToStart: number; daysToEnd: number };

/** Where `today` is relative to a whole month (`daysToEnd` is the number of days until the last day of the month). */
export function monthPhase(today: string, month: string): MonthPhase {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const start = `${month}-01`;
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const daysToStart = days(today, start);
  const daysToEnd = days(today, last);
  return { phase: daysToStart > 0 ? 'before' : daysToEnd >= 0 ? 'during' : 'after', daysToStart, daysToEnd };
}

const CODEQL_USES = /^github\/codeql-action(?:\/[A-Za-z0-9_./-]+)?@(\S+)$/i;
const V3_REF = /^v?3(?:\.\d+){0,2}$/;

/** Is this `uses:` a github/codeql-action reference on v3 (a v3 tag, or a commit SHA whose trailing comment names a v3 tag)? */
export function isCodeqlV3(site: UseSite): boolean {
  const m = CODEQL_USES.exec(site.value.trim());
  if (!m) return false;
  const ref = m[1] as string;
  if (V3_REF.test(ref)) return true;
  if (/^[0-9a-f]{40}$/i.test(ref) && site.comment) return /(^|[\s#(])v3(?:\.\d+){0,2}(?![\w.-])/.test(site.comment);
  return false;
}

export function codeqlFindings(sites: UseSite[], opts: DeadlineOptions): Finding[] {
  const ph = monthPhase(opts.today, CODEQL_V3.month);
  const windowText = 'December 2026 (GitHub gave the month, not the day)';
  // never an error: the announcement says deprecation means "no new updates"; brownouts are only mentioned as a possibility
  const severity: Severity = ph.phase === 'before' && ph.daysToStart > 31 ? 'info' : 'warning';
  const when =
    ph.phase === 'before'
      ? `CodeQL Action v3 is to be deprecated in ${windowText}; that is ${ph.daysToStart} to ${ph.daysToEnd} days from now`
      : ph.phase === 'during'
        ? `CodeQL Action v3 is to be deprecated in ${windowText}; it can happen on any of the next ${ph.daysToEnd + 1} days of the month`
        : `CodeQL Action v3 was to be deprecated in ${windowText}; check the announcement, it is already past`;
  return sites.filter(isCodeqlV3).map((s) => {
    const base = s.value.split('@')[0] as string;
    const ref = s.value.split('@')[1] as string;
    const label = /^[0-9a-f]{40}$/i.test(ref) ? `${base}@${ref.slice(0, 7)} (${(s.comment ?? '').replace(/^#\s*/, '').trim()})` : s.value;
    return {
      rule: 'codeql-action-v3' as const,
      severity,
      file: s.file,
      line: s.line,
      column: s.column,
      uses: s.value,
      message: `${label}: ${when}. Deprecated means no new updates (brownouts are only mentioned as a possibility). Move to ${base}@v4, which runs on Node 24`,
      via: [] as string[],
    };
  });
}
