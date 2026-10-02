#!/usr/bin/env python3
"""Cross-check node24-ready against an independent implementation on a corpus made by fetch.py.

    python3 scripts/corpus/compare.py --corpus corpus [--cli dist/src/cli.js] [--cache-dir .corpus-cache] [--out report.json]

1. runs node24-ready over the whole corpus (JSON, --no-suggest, --no-config);
2. independently re-derives a verdict for every distinct remote `uses:` reference with a different code path
   (regex line scan + raw.githubusercontent.com, no GitHub API): `deprecated` (runs.using is node12/16/20),
   `nested` (a composite action or reusable workflow reachable within 4 levels declares one), `ok` or `unresolved`;
3. prints the agreement and every disagreement so each can be checked by hand.

This measures AGREEMENT between two implementations written by the same author, not ground truth from the Actions runtime.
Standard library only. Environment: GITHUB_TOKEN/GH_TOKEN is passed to node24-ready only (never printed).
"""
import argparse, collections, concurrent.futures as cf, json, os, re, subprocess, sys, time, urllib.error, urllib.request

USES = re.compile(r'^\s*(?:-\s*)?uses:\s*[\'"]?([^\s\'"#]+)', re.M)


def fetch(owner, repo, path, ref, names):
    for n in names:
        p = (path + '/' if path else '') + n
        url = f'https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{p}'
        for attempt in range(4):  # the raw host answers 429/5xx under load: back off and retry before giving up
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'node24-ready-compare'}), timeout=30) as r:
                    return r.read().decode('utf8', 'replace')
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    break
                time.sleep(1.5 * (attempt + 1))
            except Exception:
                time.sleep(1.5 * (attempt + 1))
        else:
            return None
    return ''


def parse(u):
    if u.startswith(('./', 'docker://')) or '@' not in u:
        return None
    body, ref = u.rsplit('@', 1)
    parts = body.split('/')
    if len(parts) < 2:
        return None
    return parts[0], parts[1], '/'.join(parts[2:]), ref


def make_verdict():
    cache = {}

    def verdict(u, depth=0, seen=()):
        p = parse(u)
        if not p:
            return 'skip'
        if u in cache:
            return cache[u]
        o, r, path, ref = p
        if '${{' in u:
            return 'unresolved'
        wf = path.startswith('.github/workflows/')
        txt = fetch(o, r, '', ref, [path]) if wf else fetch(o, r, path, ref, ['action.yml', 'action.yaml'])
        if not txt:
            cache[u] = 'unresolved'
            return 'unresolved'
        res = 'ok'
        m = None if wf else re.search(r'^\s*using:\s*[\'"]?([A-Za-z0-9_.-]+)', txt, re.M)
        if m and re.fullmatch(r'node(12|16|20)', m.group(1)):
            res = 'deprecated'
        elif depth < 4:
            for n in USES.finditer(txt):
                c = n.group(1)
                if c in seen or c == u:
                    continue
                if verdict(c, depth + 1, seen + (u,)) == 'deprecated':
                    res = 'nested'
                    break
        cache[u] = res
        return res

    return verdict


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--corpus', required=True)
    ap.add_argument('--cli', default=os.path.join(os.path.dirname(__file__), '..', '..', 'dist', 'src', 'cli.js'))
    ap.add_argument('--cache-dir', default='.corpus-cache')
    ap.add_argument('--out')
    a = ap.parse_args()

    sites = collections.Counter()
    files = 0
    for dp, _, fs in os.walk(a.corpus):
        for f in fs:
            if f.endswith(('.yml', '.yaml')) and '/.github/workflows' in dp.replace('\\', '/'):
                files += 1
                with open(os.path.join(dp, f), errors='replace') as fh:
                    for m in USES.finditer(fh.read()):
                        sites[m.group(1)] += 1
    print(f'corpus: {files} workflow files, {sum(sites.values())} uses: lines, {len(sites)} distinct references')

    cmd = ['node', a.cli, a.corpus, '--format', 'json', '--fail-on', 'never', '--no-suggest', '--no-config', '--cache-dir', a.cache_dir]
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode not in (0, 1):
        sys.exit('node24-ready failed:\n' + p.stderr[-2000:])
    tool = json.loads(p.stdout)
    flagged = collections.defaultdict(set)
    for f in tool['findings']:
        if f['rule'] in ('action-runtime-deprecated', 'action-runtime-nested', 'action-runtime-unresolved'):
            flagged[f['uses']].add(f['rule'])
    print('node24-ready:', json.dumps(tool['summary']))

    remote = [u for u in sites if parse(u)]
    verdict = make_verdict()
    with cf.ThreadPoolExecutor(4) as ex:
        indep = dict(zip(remote, ex.map(verdict, remote)))
    print('independent verdicts:', dict(collections.Counter(indep.values())))

    def tool_class(u):
        r = flagged.get(u, set())
        return 'deprecated' if 'action-runtime-deprecated' in r else 'nested' if 'action-runtime-nested' in r else 'unresolved' if r else 'ok'

    agree, dis = 0, []
    for u in remote:
        t, i = tool_class(u), indep[u]
        if t == i or (t == 'unresolved' and i == 'unresolved'):
            agree += 1
        else:
            dis.append({'uses': u, 'tool': t, 'independent': i, 'sites': sites[u]})
    print(f'agreement on distinct references: {agree}/{len(remote)} = {100 * agree / max(1, len(remote)):.1f} %')
    print(f'disagreements to check by hand: {len(dis)}')
    for d in sorted(dis, key=lambda d: -d['sites'])[:50]:
        print(f"  {d['uses']}: tool={d['tool']} independent={d['independent']} ({d['sites']} site(s))")
    if a.out:
        with open(a.out, 'w') as f:
            json.dump({'files': files, 'distinct': len(remote), 'agree': agree, 'disagreements': dis}, f, indent=1)


if __name__ == '__main__':
    main()
