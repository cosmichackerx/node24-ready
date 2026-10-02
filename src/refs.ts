export type ParsedUses =
  | { type: 'local'; path: string }
  | { type: 'docker'; image: string }
  | { type: 'remote'; owner: string; repo: string; path: string; ref: string; isWorkflow: boolean };

/** Parse the value of a `uses:` key. Returns null when it is not a valid reference. */
export function parseUses(value: string): ParsedUses | null {
  const v = value.trim();
  if (v.startsWith('./') || v.startsWith('../') || v === '.') return { type: 'local', path: v };
  if (v.startsWith('docker://')) return { type: 'docker', image: v.slice('docker://'.length) };
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)((?:\/[^@\s]+)?)@(\S+)$/.exec(v);
  if (!m) return null;
  const path = (m[3] ?? '').replace(/^\//, '');
  const isWorkflow = /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path);
  return { type: 'remote', owner: m[1] as string, repo: m[2] as string, path, ref: m[4] as string, isWorkflow };
}

export const isFullSha = (ref: string): boolean => /^[0-9a-f]{40}$/i.test(ref);

export function refKey(r: { owner: string; repo: string; path: string; ref: string }): string {
  return `${r.owner}/${r.repo}${r.path ? `/${r.path}` : ''}@${r.ref}`;
}

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  /** Tag was written with only a major (`v5`). */
  floating: boolean;
}

/** `v5`, `5`, `v5.1`, `v5.1.2` (no pre-releases). */
export function parseTagVersion(tag: string): Semver | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(tag);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2] ?? 0), patch: Number(m[3] ?? 0), floating: m[2] === undefined };
}

export function compareVersions(a: Semver, b: Semver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}
