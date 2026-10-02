# Corpus scripts

Reproduce the precision numbers in the main README.

```bash
export GITHUB_TOKEN=...            # never commit it; used for the search/contents API and by node24-ready
npm ci && npm run build
python3 scripts/corpus/fetch.py --out corpus --min-stars 1500 --pushed-after 2026-09-01
python3 scripts/corpus/compare.py --corpus corpus --cache-dir .corpus-cache --out corpus-report.json
```

* `fetch.py` downloads `.github/workflows/*.y(a)ml` of the most-starred recently pushed repositories of 20 languages (one search request per language, 2.5 s apart; one contents request per repository).
* `compare.py` runs node24-ready over the corpus and re-derives every verdict with a different code path (line regex + raw.githubusercontent.com). It prints the agreement and each disagreement.

The result is agreement between two implementations by the same author, not ground truth from GitHub's runner. Every disagreement still has to be checked by hand against the action's `action.yml` at that ref. Results change over time (actions release new versions), so expect different numbers from the README's.
