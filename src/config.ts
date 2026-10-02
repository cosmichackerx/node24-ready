import type { Finding, IgnoredFinding } from './types.js';
import { RULES } from './types.js';

export const CONFIG_FILE = '.node24-ready.json';

export class ConfigError extends Error {}

export interface IgnoreEntry {
  /** Glob over rule ids (default `*`). */
  rule?: string;
  /** Glob over the `uses:` value, e.g. `vendor/legacy-action@*`. */
  uses?: string;
  /** Glob over the workflow path, e.g. `.github/workflows/legacy-*.yml`. */
  file?: string;
  /** Why this is accepted. Mandatory. */
  reason: string;
  /** `YYYY-MM-DD`; after this day the entry no longer suppresses anything. */
  expires?: string;
}

export interface Config {
  ignore: IgnoreEntry[];
}

const KEYS = new Set(['rule', 'uses', 'file', 'reason', 'expires']);

/** `*` matches any run of characters (including `/`), `?` one character. Everything else is literal. */
export function globToRegExp(glob: string): RegExp {
  const src = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${src}$`, 's');
}

export function parseConfig(text: string, where = CONFIG_FILE): Config {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${where}: invalid JSON (${(err as Error).message})`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new ConfigError(`${where}: expected a JSON object`);
  const obj = data as Record<string, unknown>;
  for (const k of Object.keys(obj)) if (k !== 'ignore' && k !== '$schema') throw new ConfigError(`${where}: unknown key '${k}' (only 'ignore' is supported)`);
  const list = obj.ignore ?? [];
  if (!Array.isArray(list)) throw new ConfigError(`${where}: 'ignore' must be an array`);
  const ignore: IgnoreEntry[] = list.map((raw, i) => {
    const at = `${where}: ignore[${i}]`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ConfigError(`${at} must be an object`);
    const e = raw as Record<string, unknown>;
    for (const k of Object.keys(e)) if (!KEYS.has(k)) throw new ConfigError(`${at}: unknown key '${k}'`);
    for (const k of ['rule', 'uses', 'file', 'expires'] as const) {
      if (e[k] !== undefined && typeof e[k] !== 'string') throw new ConfigError(`${at}: '${k}' must be a string`);
    }
    if (typeof e.reason !== 'string' || e.reason.trim().length < 3) throw new ConfigError(`${at}: 'reason' is mandatory (say why this is accepted)`);
    if (e.uses === undefined && e.file === undefined && (e.rule === undefined || e.rule === '*')) {
      throw new ConfigError(`${at}: too broad; narrow it with 'uses', 'file' or a specific 'rule'`);
    }
    if (typeof e.rule === 'string' && !e.rule.includes('*') && !e.rule.includes('?') && !(e.rule in RULES)) {
      throw new ConfigError(`${at}: unknown rule '${e.rule}' (see --list-rules)`);
    }
    if (typeof e.expires === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(e.expires)) throw new ConfigError(`${at}: 'expires' must look like 2026-12-31`);
    return e as unknown as IgnoreEntry;
  });
  return { ignore };
}

export function isExpired(entry: IgnoreEntry, today: string): boolean {
  return entry.expires !== undefined && entry.expires < today;
}

function matches(entry: IgnoreEntry, f: Finding): boolean {
  if (entry.rule !== undefined && !globToRegExp(entry.rule).test(f.rule)) return false;
  if (entry.uses !== undefined && !globToRegExp(entry.uses).test(f.uses)) return false;
  if (entry.file !== undefined && !globToRegExp(entry.file).test(f.file)) return false;
  return true;
}

const describe = (e: IgnoreEntry): string =>
  [e.rule && `rule=${e.rule}`, e.uses && `uses=${e.uses}`, e.file && `file=${e.file}`].filter(Boolean).join(' ') || 'entry';

export interface Applied {
  findings: Finding[];
  ignored: IgnoredFinding[];
  unused: string[];
}

/** Split findings into kept and ignored. Expired entries ignore nothing and become `ignore-expired` warnings. */
export function applyIgnores(findings: Finding[], config: Config, today: string, configName = CONFIG_FILE): Applied {
  const kept: Finding[] = [];
  const ignored: IgnoredFinding[] = [];
  const used = new Set<IgnoreEntry>();
  const live = config.ignore.filter((e) => !isExpired(e, today));
  for (const f of findings) {
    const hit = live.find((e) => matches(e, f));
    if (hit) {
      used.add(hit);
      const item: IgnoredFinding = { finding: f, reason: hit.reason };
      if (hit.expires) item.expires = hit.expires;
      ignored.push(item);
    } else kept.push(f);
  }
  for (const e of config.ignore) {
    if (!isExpired(e, today)) continue;
    kept.push({
      rule: 'ignore-expired',
      severity: 'warning',
      file: configName,
      line: 1,
      column: 1,
      uses: describe(e),
      message: `ignore entry (${describe(e)}) expired on ${e.expires}; reason was: ${e.reason}. Fix the finding or renew the entry with a new date`,
      via: [],
    });
  }
  const unused = live.filter((e) => !used.has(e)).map(describe);
  return { findings: kept, ignored, unused };
}
