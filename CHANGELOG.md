# Changelog

## 0.7.0 - 2026-10-03

* **Docker Content Trust outside `.github` (issue #27):** the `docker-content-trust` rule now also reads Dockerfiles/Containerfiles, Compose files, Kubernetes manifests (`env` as `name:`/`value:` pairs or flow maps) and other YAML, `*.sh`, Makefiles, `.env*` files, and recognises `--disable-content-trust=false` and the old `ENV DOCKER_CONTENT_TRUST 1` form. An explicit Dockerfile path works and is no longer read as a workflow. `--no-deadlines` skips all of it.

## 0.6.0 - 2026-10-03

* **`--fix-runners` (issue #26):** rewrites retiring `runs-on` labels one generation up (`macos-14*` -> `macos-15*`, `ubuntu-22.04*` -> `ubuntu-24.04*`), in scalars, lists and matrix entries, with `--dry-run` diffs, CRLF safety, idempotence and a caveat line per label. Opt-in; `--fix` is unchanged.
* Runner findings now carry `labelFix` (position of the label text, from, to, caveat) in `--format json`.

## 0.5.0 - 2026-10-03

Dated deadlines (new rules, on by default; `--no-deadlines` or `deadlines: false` turns them off):

* `runner-image-retiring`: `runs-on` labels `macos-14*` (brownouts from 2026-10-05, retired 2026-11-02), `ubuntu-22.04*` (retired 2027-04-17) and the already retired `macos-13`, `macos-12`, `windows-2019`, `ubuntu-20.04`. `runs-on` scalars, lists, `labels:` maps and `${{ matrix.x }}` are read.
* `runner-latest-migration`: `ubuntu-latest` moves to Ubuntu 26.04 between 2026-10-19 and 2026-11-19.
* `docker-content-trust`: `DOCKER_CONTENT_TRUST`, `docker trust ...`, `notary.docker.io` (shutdown 2026-12-08).
* Every date cites its official source in `src/deadlines.ts` and the README; the weekly watch now also reports unreviewed runner-images announcements.
* Behaviour change: with the default `fail-on: error`, a workflow on `macos-14` fails the step from 30 days before the next brownout. Use `deadlines: false` to opt out.

## 0.4.1 - 2026-10-03

* Weekly runtime watcher (`scripts/watch/watch-runtimes.mjs`, `.github/workflows/runtime-watch.yml`): Node release schedule vs `src/eol.ts`, documented `runs.using` values, Node-related changelog entries. One deduplicated issue.
* `NODE_EOL` now has Node 27 (found by the watcher).

## 0.4.0 - 2026-10-03

* **`--pin-only` (issue #7):** replace tag refs by the commit SHA they point to now, with the most specific release as a comment; same major, no upgrade, branches and existing SHAs untouched, idempotent, `--dry-run` supported (unified diff that `git apply` accepts), CRLF safe. Implemented with a shared edit planner (`planEdits`) that `--fix` now uses too.

## 0.3.0 - 2026-10-03

* **Rate-limit fallback (issue #5):** when the REST API limit is hit, files are read from `raw.githubusercontent.com` and tags are listed with `git ls-remote` (public repositories; the token never goes to git). The summary and one stderr line say how many lookups used it. `--no-fallback` keeps the old hard stop.
* **`--fix --dry-run` (issue #7, first half):** prints a unified diff that `git apply` accepts (LF and CRLF files), writes nothing. `--pin-only` is not implemented yet.
* **Corpus scripts (issue #8):** `scripts/corpus/fetch.py` and `compare.py` reproduce the precision measurement (fetch workflows of popular repositories; compare against an independent implementation).
* Dev dependencies: esbuild 0.28.2, TypeScript 7 (Dependabot), `@types/node` majors ignored; the repository's own CI uses dependabot-gaps v0.2.0 in PR mode.

## 0.2.0 - 2026-10-03

* New rule `setup-node-eol` (issue #1): end-of-life Node.js versions in `actions/setup-node` (`node-version`, version files, `lts/<codename>`, matrix expansion).
* `.node24-ready.json` ignore list with mandatory `reason` and `expires`; expired entries become `ignore-expired` warnings; unused entries are listed; SARIF `suppressions` (issue #2).
* `--changed-since <ref>` PR mode and Action input `changed-since`; the ignore list is read from the base ref (issue #3).
* `--cache-dir` / `NODE24_READY_CACHE`: ETag revalidation and SHA-pin caching to stay within rate limits (issue #5).
* Precision work from a 240-repository corpus (see README): `runs.plugin` actions (e.g. `actions/checkout@v1`) are no longer "unresolved"; steps inside `- parallel:` groups are scanned; workflows rejected by the YAML library are line-scanned and reported as `file-unparseable`.
* `--fix` still refuses to combine with `--changed-since`.

## 0.1.1 - 2026-10-02

* `--fix` no longer prints the findings it just fixed; the report lists only what is left (for example actions without a node24 release).

## 0.1.0 - 2026-10-02

First release.

* Scans `.github/workflows/*.yml` and `action.yml` files for `uses:` references and reads the real `runs.using` of the pinned ref through the GitHub API (cached, concurrency-limited, retries on 5xx).
* Looks through composite actions and reusable workflows (depth 4, cycle-safe).
* Rules: `action-runtime-deprecated`, `action-runtime-nested`, `action-runtime-unresolved`, `local-action-runtime`.
* Suggests the smallest newer major whose release declares a supported runtime, with the commit SHA for pinning.
* `--fix` rewrites tag refs and SHA pins (adding the version as a comment); CRLF files are preserved.
* Output: text, markdown, json, GitHub annotations, SARIF 2.1.0 (validated against the official schema in tests).
* Composite GitHub Action with a committed bundle (no nested actions, no setup-node), Marketplace metadata.
