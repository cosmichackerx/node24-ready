# Changelog

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
