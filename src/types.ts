export type Severity = 'error' | 'warning' | 'info';

export type Rule =
  | 'action-runtime-deprecated'
  | 'action-runtime-nested'
  | 'action-runtime-unresolved'
  | 'local-action-runtime'
  | 'setup-node-eol'
  | 'runner-image-retiring'
  | 'runner-latest-migration'
  | 'docker-content-trust'
  | 'file-unparseable'
  | 'ignore-expired';

export const RULES: Record<Rule, string> = {
  'action-runtime-deprecated': 'A referenced action still declares node12, node16 or node20; GitHub now force-runs it on Node 24 instead of the declared runtime.',
  'action-runtime-nested': 'A composite action or reusable workflow you call contains an action that declares a removed Node runtime.',
  'action-runtime-unresolved': 'The action metadata could not be fetched (private, deleted, wrong ref, network or rate limit), so its runtime is unknown.',
  'local-action-runtime': "This repository's own action.yml declares a removed Node runtime (runs.using).",
  'setup-node-eol': 'actions/setup-node installs a Node.js version that has reached (or is close to) end of life.',
  'runner-image-retiring': 'runs-on names a hosted runner label that GitHub has retired or will retire on a published date (brownouts make jobs fail before that).',
  'runner-latest-migration': 'ubuntu-latest is being moved from Ubuntu 24.04 to 26.04 in a published window; tools and packages change.',
  'docker-content-trust': 'Docker Content Trust (DOCKER_CONTENT_TRUST, docker trust, notary.docker.io) is used; the Notary v1 service shuts down on 2026-12-08.',
  'file-unparseable': 'The YAML parser rejected this file (GitHub may still accept it); uses: lines were found by a line scan or not at all.',
  'ignore-expired': 'An entry of .node24-ready.json has expired and no longer suppresses anything.',
};

export interface Suggestion {
  /** Ref to use. A moving major tag (`v5`) when the action publishes one, otherwise the exact tag. */
  ref: string;
  /** Exact release tag that was checked (`v5.0.1`). */
  tag: string;
  /** Commit the exact tag points to, for SHA pinning. */
  sha?: string;
  /** Runtime found at that release. */
  using: string;
}

export interface Finding {
  rule: Rule;
  severity: Severity;
  file: string;
  line: number;
  column: number;
  /** The `uses:` value (or the `runs.using` value for local actions). */
  uses: string;
  /** Runtime of the leaf that is deprecated (`node20`), when known. */
  runtime?: string;
  message: string;
  /** For nested findings: the chain from the referenced action down to the deprecated one. */
  via: string[];
  suggestion?: Suggestion;
  /** Why no suggestion was produced (only set when suggestions were requested). */
  noSuggestion?: string;
}

export interface UseSite {
  file: string;
  line: number;
  column: number;
  value: string;
  /** Trailing comment on the same line (often the version a SHA pin stands for). */
  comment?: string;
}

export interface IgnoredFinding {
  finding: Finding;
  reason: string;
  expires?: string;
}

export interface ScanSummary {
  files: number;
  /** Findings dropped by --changed-since because their line was not touched. */
  hidden?: number;
  /** Findings suppressed by .node24-ready.json. */
  ignored?: number;
  uses: number;
  distinctActions: number;
  ok: number;
  fetches: number;
  /** lookups answered through raw.githubusercontent.com / git ls-remote after the API rate limit was hit */
  fallbackLookups?: number;
}

export interface ScanResult {
  findings: Finding[];
  /** Suppressed by the ignore list, with the reason given there. */
  ignored?: IgnoredFinding[];
  /** Ignore entries that matched nothing. */
  unusedIgnores?: string[];
  summary: ScanSummary;
}
