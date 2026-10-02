# Changelog

## 0.1.0 - 2026-10-02

First release.

* Scans `.github/workflows/*.yml` and `action.yml` files for `uses:` references and reads the real `runs.using` of the pinned ref through the GitHub API (cached, concurrency-limited, retries on 5xx).
* Looks through composite actions and reusable workflows (depth 4, cycle-safe).
* Rules: `action-runtime-deprecated`, `action-runtime-nested`, `action-runtime-unresolved`, `local-action-runtime`.
* Suggests the smallest newer major whose release declares a supported runtime, with the commit SHA for pinning.
* `--fix` rewrites tag refs and SHA pins (adding the version as a comment); CRLF files are preserved.
* Output: text, markdown, json, GitHub annotations, SARIF 2.1.0 (validated against the official schema in tests).
* Composite GitHub Action with a committed bundle (no nested actions, no setup-node), Marketplace metadata.
