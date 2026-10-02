export type Severity = 'error' | 'warning' | 'info';

export type Rule = 'action-runtime-deprecated' | 'action-runtime-nested' | 'action-runtime-unresolved' | 'local-action-runtime';

export const RULES: Record<Rule, string> = {
  'action-runtime-deprecated': 'A referenced action still declares node12, node16 or node20; GitHub now force-runs it on Node 24 instead of the declared runtime.',
  'action-runtime-nested': 'A composite action or reusable workflow you call contains an action that declares a removed Node runtime.',
  'action-runtime-unresolved': 'The action metadata could not be fetched (private, deleted, wrong ref, network or rate limit), so its runtime is unknown.',
  'local-action-runtime': "This repository's own action.yml declares a removed Node runtime (runs.using).",
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

export interface ScanSummary {
  files: number;
  uses: number;
  distinctActions: number;
  ok: number;
  fetches: number;
}

export interface ScanResult {
  findings: Finding[];
  summary: ScanSummary;
}
