export interface Tag {
  name: string;
  sha: string;
}

export type FileResult = { status: 'ok'; text: string } | { status: 'missing' } | { status: 'error'; message: string };

export interface ClientOptions {
  /** Default `https://api.github.com`; point it at GitHub Enterprise or a test server. */
  apiUrl?: string;
  /** Never logged. */
  token?: string;
  fetchImpl?: typeof fetch;
  /** Delay unit for retries; tests set 0. */
  retryDelayMs?: number;
  maxConcurrency?: number;
}

export class RateLimitError extends Error {}

/** Minimal, cached GitHub REST client: file contents at a ref and tag lists. */
export class GitHubClient {
  readonly apiUrl: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelayMs: number;
  private readonly files = new Map<string, Promise<FileResult>>();
  private readonly tagLists = new Map<string, Promise<Tag[] | null>>();
  private active = 0;
  private readonly queue: (() => void)[] = [];
  private readonly maxConcurrency: number;
  requests = 0;

  constructor(opts: ClientOptions = {}) {
    this.apiUrl = (opts.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.retryDelayMs = opts.retryDelayMs ?? 400;
    this.maxConcurrency = opts.maxConcurrency ?? 6;
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrency) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }

  private async request(path: string, accept: string): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'node24-ready',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let last: Response | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      this.requests++;
      last = await this.slot(() => this.fetchImpl(`${this.apiUrl}${path}`, { headers }));
      if (last.status >= 500 && attempt < 3) {
        await new Promise((r) => setTimeout(r, this.retryDelayMs * (attempt + 1)));
        continue;
      }
      break;
    }
    const res = last as Response;
    const limited = res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0');
    if (limited) {
      throw new RateLimitError(
        this.token
          ? 'GitHub API rate limit reached; try again later'
          : 'GitHub API rate limit reached; set GITHUB_TOKEN (or GH_TOKEN) to raise the limit from 60 to 5000 requests per hour',
      );
    }
    return res;
  }

  /** Raw text of a file at a ref. */
  fileAt(owner: string, repo: string, path: string, ref: string): Promise<FileResult> {
    const key = `${owner}/${repo}/${path}@${ref}`;
    let p = this.files.get(key);
    if (!p) {
      p = this.fetchFile(owner, repo, path, ref);
      this.files.set(key, p);
    }
    return p;
  }

  private async fetchFile(owner: string, repo: string, path: string, ref: string): Promise<FileResult> {
    try {
      const enc = path.split('/').map(encodeURIComponent).join('/');
      const res = await this.request(`/repos/${owner}/${repo}/contents/${enc}?ref=${encodeURIComponent(ref)}`, 'application/vnd.github.raw+json');
      if (res.status === 404) return { status: 'missing' };
      if (!res.ok) return { status: 'error', message: `HTTP ${res.status}` };
      return { status: 'ok', text: await res.text() };
    } catch (err) {
      if (err instanceof RateLimitError) throw err;
      return { status: 'error', message: (err as Error).message };
    }
  }

  /** Tags of a repository (up to 300), or null when the repository cannot be listed. */
  tags(owner: string, repo: string): Promise<Tag[] | null> {
    const key = `${owner}/${repo}`;
    let p = this.tagLists.get(key);
    if (!p) {
      p = this.fetchTags(owner, repo);
      this.tagLists.set(key, p);
    }
    return p;
  }

  private async fetchTags(owner: string, repo: string): Promise<Tag[] | null> {
    const out: Tag[] = [];
    try {
      for (let page = 1; page <= 3; page++) {
        const res = await this.request(`/repos/${owner}/${repo}/tags?per_page=100&page=${page}`, 'application/vnd.github+json');
        if (!res.ok) return page === 1 ? null : out;
        const items = (await res.json()) as { name?: string; commit?: { sha?: string } }[];
        for (const t of items) if (t.name && t.commit?.sha) out.push({ name: t.name, sha: t.commit.sha });
        if (items.length < 100) break;
      }
    } catch (err) {
      if (err instanceof RateLimitError) throw err;
      return null;
    }
    return out;
  }
}
