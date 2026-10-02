import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockRepo {
  /** key: `path@ref` */
  files: Record<string, string>;
  tags: { name: string; sha: string }[];
}

export interface MockServer {
  url: string;
  requests: string[];
  close(): Promise<void>;
}

const node = (using: string): string => `name: x\nruns:\n  using: ${using}\n  main: index.js\n`;
export const nodeAction = node;
export const composite = (...uses: string[]): string =>
  `name: c\nruns:\n  using: composite\n  steps:\n${uses.map((u) => `    - uses: ${u}\n`).join('')}`;

/** Fake of the two GitHub REST endpoints node24-ready uses. */
export async function startMock(repos: Record<string, MockRepo>): Promise<MockServer> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost');
    requests.push(u.pathname + u.search);
    const m = /^\/repos\/([^/]+)\/([^/]+)\/(contents\/(.+)|tags)$/.exec(u.pathname);
    const repo = m ? repos[`${m[1]}/${m[2]}`] : undefined;
    if (!m || !repo) {
      res.writeHead(404).end('{}');
      return;
    }
    if (m[3] === 'tags') {
      const page = Number(u.searchParams.get('page') ?? '1');
      const items = page === 1 ? repo.tags.map((t) => ({ name: t.name, commit: { sha: t.sha } })) : [];
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(items));
      return;
    }
    const body = repo.files[`${decodeURIComponent(m[4] as string)}@${u.searchParams.get('ref')}`];
    if (body === undefined) res.writeHead(404).end('{}');
    else res.writeHead(200, { 'content-type': 'text/plain' }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export const sha = (n: number): string => n.toString(16).padStart(40, '0');

/** A small world: checkout v4 (node20) / v5 (node24), a composite wrapping checkout@v4, etc. */
export function world(): Record<string, MockRepo> {
  return {
    'acme/checkout': {
      files: {
        'action.yml@v4': node('node20'),
        'action.yml@v4.2.0': node('node20'),
        'action.yml@v5': node('node24'),
        'action.yml@v5.1.0': node('node24'),
        [`action.yml@${sha(4)}`]: node('node20'),
        'action.yml@v3': node('node16'),
        [`action.yml@${sha(51)}`]: node('node24'),
      },
      tags: [
        { name: 'v3', sha: sha(3) },
        { name: 'v4', sha: sha(4) },
        { name: 'v4.2.0', sha: sha(4) },
        { name: 'v5', sha: sha(5) },
        { name: 'v5.0.0', sha: sha(50) },
        { name: 'v5.1.0', sha: sha(51) },
      ],
    },
    'acme/setup': {
      files: { 'action.yml@v1': composite('acme/checkout@v4'), 'action.yml@v2': composite('acme/checkout@v5'), 'action.yml@v2.0.0': composite('acme/checkout@v5') },
      tags: [
        { name: 'v1', sha: sha(11) },
        { name: 'v1.0.0', sha: sha(11) },
        { name: 'v2', sha: sha(12) },
        { name: 'v2.0.0', sha: sha(12) },
      ],
    },
    'acme/stuck': {
      files: { 'action.yml@v1': node('node20') },
      tags: [{ name: 'v1', sha: sha(21) }],
    },
    'acme/flows': {
      files: { '.github/workflows/build.yml@main': 'on: workflow_call\njobs:\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: acme/checkout@v4\n' },
      tags: [],
    },
    'acme/private': { files: {}, tags: [] },
  };
}
