import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
  /** Directory for the response cache (ETag revalidation; commit-SHA refs are never re-fetched). */
  cacheDir?: string;
}

export class RateLimitError extends Error {}

interface CacheEntry {
  etag?: string;
  body: string;
}

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
  private readonly cacheDir: string | undefined;
  requests = 0;
  /** Answered from the cache without a request, or revalidated with a free 304. */
  cacheHits = 0;

  constructor(opts: ClientOptions = {}) {
    this.apiUrl = (opts.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.retryDelayMs = opts.retryDelayMs ?? 400;
    this.maxConcurrency = opts.maxConcurrency ?? 6;
    this.cacheDir = opts.cacheDir;
    if (this.cacheDir) mkdirSync(this.cacheDir, { recursive: true });
  }

  private cachePath(key: string): string {
    return join(this.cacheDir as string, `${createHash('sha256').update(`${this.apiUrl}\n${key}`).digest('hex')}.json`);
  }

  private readCache(key: string): CacheEntry | undefined {
    if (!this.cacheDir) return undefined;
    try {
      return JSON.parse(readFileSync(this.cachePath(key), 'utf8')) as CacheEntry;
    } catch {
      return undefined;
    }
  }

  private writeCache(key: string, entry: CacheEntry): void {
    if (!this.cacheDir) return;
    try {
      writeFileSync(this.cachePath(key), JSON.stringify(entry));
    } catch {
      /* a cache that cannot be written is not an error */
    }
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

  private async request(path: string, accept: string, etag?: string): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'node24-ready',
    };
    if (etag) headers['If-None-Match'] = etag;
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
      const key = `file:${owner}/${repo}/${path}@${ref}`;
      const cached = this.readCache(key);
      if (cached && /^[0-9a-f]{40}$/i.test(ref)) {
        this.cacheHits++;
        return { status: 'ok', text: cached.body };
      }
      const res = await this.request(`/repos/${owner}/${repo}/contents/${enc}?ref=${encodeURIComponent(ref)}`, 'application/vnd.github.raw+json', cached?.etag);
      if (res.status === 304 && cached) {
        this.cacheHits++;
        return { status: 'ok', text: cached.body };
      }
      if (res.status === 404) return { status: 'missing' };
      if (!res.ok) return { status: 'error', message: `HTTP ${res.status}` };
      const text = await res.text();
      const etag = res.headers.get('etag');
      this.writeCache(key, { ...(etag ? { etag } : {}), body: text });
      return { status: 'ok', text };
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
        const key = `tags:${owner}/${repo}:${page}`;
        const cached = this.readCache(key);
        const res = await this.request(`/repos/${owner}/${repo}/tags?per_page=100&page=${page}`, 'application/vnd.github+json', cached?.etag);
        let bodyText: string;
        if (res.status === 304 && cached) {
          this.cacheHits++;
          bodyText = cached.body;
        } else {
          if (!res.ok) return page === 1 ? null : out;
          bodyText = await res.text();
          const etag = res.headers.get('etag');
          this.writeCache(key, { ...(etag ? { etag } : {}), body: bodyText });
        }
        const items = JSON.parse(bodyText) as { name?: string; commit?: { sha?: string } }[];
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
