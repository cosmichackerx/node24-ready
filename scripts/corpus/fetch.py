#!/usr/bin/env python3
"""Download the .github/workflows files of popular public repositories into a corpus directory.

    python3 scripts/corpus/fetch.py --out corpus [--min-stars 1500] [--pushed-after 2026-09-01] [--per-language 12]

Layout written: <out>/<owner>__<repo>/.github/workflows/*.yml, plus <out>/repos.json (name -> stars).
Needs a token for the search API: GITHUB_TOKEN or GH_TOKEN (never printed). Standard library only.
It is paced (search API allows 30 requests per minute) and uses the contents API once per repository.
"""
import argparse, concurrent.futures as cf, json, os, sys, time, urllib.parse, urllib.request

LANGS = ['python', 'javascript', 'typescript', 'go', 'rust', 'java', 'c++', 'c#', 'ruby', 'php', 'kotlin', 'swift',
         'shell', 'dart', 'scala', 'elixir', 'c', 'lua', 'haskell', 'jupyter notebook']
TOKEN = os.environ.get('GITHUB_TOKEN') or os.environ.get('GH_TOKEN')


def api(path):
    h = {'Accept': 'application/vnd.github+json', 'User-Agent': 'node24-ready-corpus', 'X-GitHub-Api-Version': '2022-11-28'}
    if TOKEN:
        h['Authorization'] = 'Bearer ' + TOKEN
    with urllib.request.urlopen(urllib.request.Request('https://api.github.com' + path, headers=h), timeout=30) as r:
        return json.load(r)


def raw(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'node24-ready-corpus'}), timeout=30) as r:
        return r.read()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', required=True)
    ap.add_argument('--min-stars', type=int, default=1500)
    ap.add_argument('--pushed-after', default='2026-09-01', help='only repositories pushed after this date (YYYY-MM-DD)')
    ap.add_argument('--per-language', type=int, default=12)
    ap.add_argument('--languages', nargs='*', default=LANGS)
    a = ap.parse_args()
    if not TOKEN:
        sys.exit('set GITHUB_TOKEN or GH_TOKEN (the search API needs authentication to be usable)')
    os.makedirs(a.out, exist_ok=True)
    repos = {}
    for lang in a.languages:
        q = f'stars:>{a.min_stars} pushed:>{a.pushed_after} language:{lang} archived:false'
        try:
            d = api('/search/repositories?' + urllib.parse.urlencode({'q': q, 'sort': 'stars', 'per_page': a.per_language}))
        except Exception as e:  # keep going: one failed language only shrinks the corpus
            print('search failed for', lang, e, file=sys.stderr)
            continue
        for it in d['items']:
            repos[it['full_name']] = it['stargazers_count']
        time.sleep(2.5)  # stay far below the 30 searches/minute limit
    print(len(repos), 'repositories')

    def grab(full):
        o = os.path.join(a.out, full.replace('/', '__'))
        try:
            items = api(f'/repos/{full}/contents/.github/workflows')
        except Exception:
            return full, 0
        n = 0
        for it in items:
            if it['type'] == 'file' and it['name'].endswith(('.yml', '.yaml')):
                p = os.path.join(o, '.github', 'workflows', it['name'])
                os.makedirs(os.path.dirname(p), exist_ok=True)
                try:
                    with open(p, 'wb') as f:
                        f.write(raw(it['download_url']))
                    n += 1
                except Exception:
                    pass
        return full, n

    with cf.ThreadPoolExecutor(4) as ex:  # modest parallelism, one contents request per repository
        res = list(ex.map(grab, repos))
    with open(os.path.join(a.out, 'repos.json'), 'w') as f:
        json.dump({k: repos[k] for k, _ in res}, f, indent=1)
    print(sum(1 for _, n in res if n), 'repositories with workflows;', sum(n for _, n in res), 'files')


if __name__ == '__main__':
    main()
