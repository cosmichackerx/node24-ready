import { createHash } from 'node:crypto';
import { CONFIG_FILE } from './config.js';
import { RULES, type Finding, type ScanResult, type Severity } from './types.js';

const RANK: Record<Severity, number> = { info: 0, warning: 1, error: 2 };

export function counts(findings: Finding[]): Record<Severity, number> {
  const c: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of findings) c[f.severity]++;
  return c;
}

export function meetsThreshold(findings: Finding[], threshold: Severity): boolean {
  return findings.some((f) => RANK[f.severity] >= RANK[threshold]);
}

function suggestionText(f: Finding): string {
  if (f.suggestion) {
    const s = f.suggestion;
    const sha = s.sha ? `; pinned: @${s.sha} # ${s.tag}` : '';
    const rt = s.using === 'composite' || s.using === 'workflow' ? `${s.using}, nothing removed inside` : s.using;
    return `upgrade to @${s.ref} (${s.tag}, ${rt})${sha}`;
  }
  return f.noSuggestion ? `no upgrade found: ${f.noSuggestion}` : '';
}

function summaryLine(r: ScanResult): string {
  const c = counts(r.findings);
  const head =
    r.findings.length === 0
      ? `No action declaring node12/16/20 found in ${r.summary.uses} reference(s).`
      : `${r.findings.length} finding(s): ${c.error} error, ${c.warning} warning.`;
  const extra = [
    r.summary.ignored ? `${r.summary.ignored} ignored by ${CONFIG_FILE}` : '',
    r.summary.hidden ? `${r.summary.hidden} on unchanged lines hidden by --changed-since` : '',
  ].filter(Boolean);
  return `${head}${extra.length ? ` (${extra.join('; ')})` : ''} Checked ${r.summary.distinctActions} distinct action reference(s) in ${r.summary.files} file(s) with ${r.summary.fetches} API request(s)${r.summary.fallbackLookups ? ` and ${r.summary.fallbackLookups} lookup(s) through the raw/git fallback (API rate limit reached)` : ''}.`;
}

export function renderText(r: ScanResult): string {
  const out: string[] = [];
  let last = '';
  for (const f of r.findings) {
    if (f.file !== last) {
      if (last) out.push('');
      out.push(f.file);
      last = f.file;
    }
    out.push(`  ${String(f.line).padStart(4)}:${String(f.column).padEnd(3)} ${f.severity.padEnd(7)} ${f.rule.padEnd(26)} ${f.message}`);
    const s = suggestionText(f);
    if (s) out.push(`${' '.repeat(16)}-> ${s}`);
  }
  if (r.findings.length) out.push('');
  out.push(summaryLine(r));
  for (const i of r.ignored ?? []) out.push(`  ignored: ${i.finding.file}:${i.finding.line} ${i.finding.uses} (${i.finding.rule}) - ${i.reason}${i.expires ? ` [until ${i.expires}]` : ''}`);
  for (const u of r.unusedIgnores ?? []) out.push(`  unused ignore entry (matches nothing, remove it?): ${u}`);
  return out.join('\n');
}

export function renderMarkdown(r: ScanResult): string {
  const out = ['### node24-ready', '', `**${summaryLine(r)}**`, ''];
  if (r.findings.length) {
    out.push('| Severity | Location | Rule | Detail | Fix |', '|---|---|---|---|---|');
    for (const f of r.findings) {
      const esc = (t: string): string => t.replace(/\|/g, '\\|').replace(/\n/g, ' ');
      out.push(`| ${f.severity} | \`${f.file}:${f.line}\` | \`${f.rule}\` | ${esc(f.message)} | ${esc(suggestionText(f))} |`);
    }
  }
  return out.join('\n');
}

export function renderJson(r: ScanResult): string {
  return JSON.stringify(
    {
      schema: 1,
      summary: { ...r.summary, ...counts(r.findings) },
      findings: r.findings,
      ignored: (r.ignored ?? []).map((i) => ({ ...i.finding, ignoredReason: i.reason, ...(i.expires ? { ignoredUntil: i.expires } : {}) })),
      unusedIgnores: r.unusedIgnores ?? [],
    },
    null,
    2,
  );
}

const ghProp = (s: string): string => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/:/g, '%3A').replace(/,/g, '%2C');
const ghData = (s: string): string => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

/** GitHub Actions workflow commands (`::error file=...`). */
export function renderGithub(r: ScanResult): string {
  return r.findings
    .map((f) => {
      const s = suggestionText(f);
      return `::${f.severity === 'info' ? 'notice' : f.severity} file=${ghProp(f.file)},line=${f.line},col=${f.column},title=${ghProp(f.rule)}::${ghData(f.message + (s ? `. ${s}` : ''))}`;
    })
    .join('\n');
}

const LEVEL: Record<Severity, string> = { error: 'error', warning: 'warning', info: 'note' };
const SECURITY: Record<Severity, string> = { error: '7.0', warning: '4.0', info: '1.0' };
const RULE_SEVERITY: Record<keyof typeof RULES, Severity> = {
  'action-runtime-deprecated': 'error',
  'action-runtime-nested': 'error',
  'action-runtime-unresolved': 'warning',
  'local-action-runtime': 'error',
  'setup-node-eol': 'warning',
  'runner-image-retiring': 'error',
  'runner-latest-migration': 'warning',
  'docker-content-trust': 'warning',
  'file-unparseable': 'warning',
  'ignore-expired': 'warning',
};

/** SARIF 2.1.0 for GitHub code scanning. */
export function renderSarif(r: ScanResult, version: string): string {
  const ids = Object.keys(RULES);
  const rules = ids.map((id) => ({
    id,
    name: id.replace(/(^|-)([a-z])/g, (_m, _d, c: string) => c.toUpperCase()),
    shortDescription: { text: RULES[id as keyof typeof RULES] },
    helpUri: 'https://github.com/cosmichackerx/node24-ready#rules',
    defaultConfiguration: { level: LEVEL[RULE_SEVERITY[id as keyof typeof RULES]] },
    properties: { tags: ['maintainability', 'github-actions'], 'security-severity': SECURITY[RULE_SEVERITY[id as keyof typeof RULES]] },
  }));
  const toResult = (f: Finding, suppression?: string): Record<string, unknown> => ({
    ruleId: f.rule,
    ruleIndex: ids.indexOf(f.rule),
    level: LEVEL[f.severity],
    message: { text: f.message + (suggestionText(f) ? `. ${suggestionText(f)}` : '') },
    locations: [{ physicalLocation: { artifactLocation: { uri: f.file, uriBaseId: '%SRCROOT%' }, region: { startLine: f.line, startColumn: f.column } } }],
    partialFingerprints: { 'node24Ready/v1': createHash('sha256').update(`${f.rule}\n${f.file}\n${f.uses}`).digest('hex').slice(0, 32) },
    ...(suppression !== undefined ? { suppressions: [{ kind: 'external', justification: suppression }] } : {}),
  });
  const results = [...r.findings.map((f) => toResult(f)), ...(r.ignored ?? []).map((i) => toResult(i.finding, i.reason))];
  return JSON.stringify(
    {
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'node24-ready', version, informationUri: 'https://github.com/cosmichackerx/node24-ready', rules } },
          originalUriBaseIds: { '%SRCROOT%': { description: { text: 'Repository root' } } },
          results,
        },
      ],
    },
    null,
    2,
  );
}
