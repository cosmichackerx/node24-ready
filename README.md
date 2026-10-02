# node24-ready

[![CI](https://github.com/cosmichackerx/node24-ready/actions/workflows/ci.yml/badge.svg)](https://github.com/cosmichackerx/node24-ready/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Find GitHub Actions workflows that still use actions declaring `node20` (or `node16` / `node12`), see through composite actions and reusable workflows, and get the smallest upgrade whose release really declares `node24`. Can rewrite the `uses:` lines for you (`--fix`), emits SARIF for code scanning, and ships as a GitHub Action and a CLI.**

> On 2026-09-23 GitHub announced that [Node 20 is no longer available in GitHub Actions](https://github.blog/changelog/2026-09-23-node-20-is-no-longer-available-in-github-actions/):
> runners now use Node 24 for JavaScript actions and the `ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION` opt-out is gone.
> Actions that still declare `runs.using: node20` are force-run on Node 24 with a deprecation warning, and nobody has tested them there.
> This tool tells you which of *your* `uses:` lines that applies to, **including the ones hidden inside other actions**, and what to change them to.

Keywords: GitHub Actions, Node 20 deprecation, Node 24 migration, `runs.using`, node20 action audit, workflow linter, composite action, reusable workflow, SARIF, supply chain.

## Why not just grep `uses:` or run a version bumper?

The `node20`/`node24` fact lives in the **`action.yml` of the exact ref you pin**, not in the version number.
`node24-ready` fetches that file for every `uses:` (through the GitHub API, cached, a handful of requests) and evaluates it:

* **Authoritative.** It reads `runs.using` at the pinned tag, branch or commit SHA. A SHA pin is checked at that commit.
* **Transitive.** A composite action or a reusable workflow that calls a node20 action is flagged too (depth 4, cycle-safe). `actions/upload-pages-artifact@v3` looks harmless and is not: see the example below.
* **Smallest upgrade.** It lists the tags, then evaluates the next majors in ascending order and proposes the **lowest** major whose newest release is clean. It does not blindly jump to the latest.
* **SHA-aware fix.** For SHA-pinned lines `--fix` writes the new commit SHA and the exact version as a comment.
* **Honest about unknowns.** Private, deleted or unreachable actions are `action-runtime-unresolved` warnings, never silently "fine".

## Quick start

```bash
# needs Node 20+; GITHUB_TOKEN is optional but raises the API limit from 60 to 5000 requests/hour
export GITHUB_TOKEN="$(gh auth token)"
npx github:cosmichackerx/node24-ready .          # scan the repository in the current directory
```

As a GitHub Action (no `setup-node`, no node20 action inside; it runs the bundled file with the runner's Node):

```yaml
name: node24-ready
on:
  pull_request:
    paths: [".github/**", "**/action.yml"]
  schedule:
    - cron: "17 5 * * 1"
permissions:
  contents: read
jobs:
  node24:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: cosmichackerx/node24-ready@v0.1.1
        with:
          fail-on: error          # error | warning | never
```

Errors show up as annotations on the workflow files and as a table in the job summary.

### Code scanning (SARIF)

```yaml
    permissions:
      contents: read
      security-events: write
    steps:
      - uses: actions/checkout@v5
      - uses: cosmichackerx/node24-ready@v0.1.1
        with:
          sarif-file: node24-ready.sarif
          fail-on: never
      - uses: github/codeql-action/upload-sarif@v4
        with:
          sarif_file: node24-ready.sarif
          category: node24-ready
```

(`upload-sarif` needs a public repository or GitHub Code Security on a private one.)

## Real output

Run against the `.github` directory of [typicode/husky](https://github.com/typicode/husky) (a snapshot cloned on 2026-03-20; the live API answered on 2026-10-02):

```text
s256-corpus/husky/.github/workflows/deploy.yml
    35:15  error   action-runtime-deprecated  actions/checkout@v4 declares node20, but GitHub now force-runs JavaScript actions on Node 24
                -> upgrade to @v5 (v5.1.0, node24); pinned: @fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0
    41:15  error   action-runtime-deprecated  actions/setup-node@v4 declares node20, but GitHub now force-runs JavaScript actions on Node 24
                -> upgrade to @v5 (v5.0.0, node24); pinned: @a0853c24544627f65ddf259abe73b1d18a591444 # v5.0.0
    46:15  error   action-runtime-deprecated  actions/configure-pages@v4 declares node20, but GitHub now force-runs JavaScript actions on Node 24
                -> upgrade to @v6 (v6.0.0, node24); pinned: @45bfe0192ca1faeb007ade9deae92b16b8254a0d # v6.0.0
    52:15  error   action-runtime-nested      actions/upload-pages-artifact@v3 is a composite action that calls actions/upload-artifact@v4, which declares node20
                -> upgrade to @v5 (v5.0.0, composite, nothing removed inside); pinned: @fc324d3547104276b827a68afc52ff2a11cc49c9 # v5.0.0
    67:15  error   action-runtime-deprecated  actions/deploy-pages@v4 declares node20, but GitHub now force-runs JavaScript actions on Node 24
                -> upgrade to @v5 (v5.0.1, node24); pinned: @368f82528645a54fb793d4d04e342629a3f51346 # v5.0.1

5 finding(s): 5 error, 0 warning. Checked 5 distinct action reference(s) in 1 file(s) with 20 API request(s).
```

Note the `upload-pages-artifact@v3` finding: that is a **composite action**; the node20 action is inside it (`upload-artifact@v4`). A plain `uses:` grep cannot see it.

When there is nothing to upgrade to, it says so instead of guessing ([git-cliff](https://github.com/orhun/git-cliff) still uses the archived `actions-rs/*`, which declares `node12`):

```text
s256-corpus/git-cliff/.github/workflows/cd.yml
   145:15  error   action-runtime-deprecated  actions-rs/toolchain@16499b5e05bf2e26879000db0c1d13f7e13fa3af declares node12, but GitHub now force-runs JavaScript actions on Node 24
                -> no upgrade found: no release newer than v1 exists yet; ask the maintainers to publish a node24 release
   152:15  error   action-runtime-deprecated  actions-rs/cargo@844f36862e911db73fe0815f00a4a2602c279505 declares node12, but GitHub now force-runs JavaScript actions on Node 24
```

`--fix` on a copy of that husky directory rewrote 5 lines in `deploy.yml` (`checkout@v4` -> `@v5`, `setup-node@v4` -> `@v5`, ...), and a second run printed `No action declaring node12/16/20 found ...` with exit code 0. Always read the upstream changelog of each major bump (they can have breaking input changes) and run your CI.

Machine readable (`--format json`, one finding):

```json
{
  "file": "s256-corpus/husky/.github/workflows/deploy.yml",
  "line": 52,
  "column": 15,
  "uses": "actions/upload-pages-artifact@v3",
  "via": [
    "actions/upload-artifact@v4"
  ],
  "rule": "action-runtime-nested",
  "severity": "error",
  "runtime": "node20",
  "message": "actions/upload-pages-artifact@v3 is a composite action that calls actions/upload-artifact@v4, which declares node20",
  "suggestion": {
    "ref": "v5",
    "tag": "v5.0.0",
    "sha": "fc324d3547104276b827a68afc52ff2a11cc49c9",
    "using": "composite"
  }
}
```

## Rules

| Rule | Default severity | Meaning |
|---|---|---|
| `action-runtime-deprecated` | error | The referenced action's `action.yml` declares `node12`, `node16` or `node20`. |
| `action-runtime-nested` | error | A composite action or reusable workflow you call contains such an action (the `via` chain shows where). |
| `action-runtime-unresolved` | warning | `action.yml` could not be fetched (private, deleted, wrong ref, rate limit), so the runtime is unknown. |
| `local-action-runtime` | error | The repository's own `action.yml` declares `runs.using: node20` (or older): set `node24` and release. |

## CLI

```text
node24-ready [paths...] [options]     paths: directories or workflow/action files (default: .)

  -C, --cwd <dir>        run as if started in <dir>
  -f, --format <fmt>     text | markdown | json | github | sarif   (default: text)
  -o, --output <file>    write the report to a file
      --fail-on <level>  exit 1 on: error | warning | never   (default: error)
      --fix              rewrite uses: lines to the suggested node24-capable release
      --no-suggest       do not look for upgrade targets (fewer API requests)
      --api-url <url>    GitHub API base (GitHub Enterprise Server)
      --list-rules       print the rule ids and exit
```

Exit codes: `0` ok, `1` findings at or above `--fail-on`, `2` usage or API error (including rate limit). With `--fix` the exit code is `0`.
Discovery: `.github/workflows/*.yml|yaml` and every `action.yml|yaml` below the given paths (skipping `node_modules`, `.git`, `dist`, `vendor`, `target`).
The token is read only from `GITHUB_TOKEN` / `GH_TOKEN`, is sent only to the API URL, and is never printed.

## How it compares

I looked for existing tools before writing this one (2026-10). Honest summary:

| Tool | What it does | Difference |
|---|---|---|
| [rsymo/github-actions-runtime-audit](https://github.com/rsymo/github-actions-runtime-audit) | Flags actions that are "likely affected" | Heuristic; node24-ready reads the real `runs.using` of the exact ref and looks inside composites/reusable workflows |
| [azat-io/actions-up](https://github.com/azat-io/actions-up), [ylabonte/github-actions-updater](https://github.com/ylabonte/github-actions-updater) | Generic "bump everything to latest" updaters | Great for general upkeep; node24-ready answers a narrower question (which pins are actually affected) and proposes the *smallest* clean major |
| Dependabot / Renovate | Open update PRs | They do not know which updates matter for the Node runtime; run node24-ready first to prioritise |
| The `Node.js 20 is deprecated` annotation in run logs | Warns after a run | Only for the actions that executed, and only when they ran |

If one of these fits you better, use it. This project exists because none of them did "authoritative + transitive + smallest upgrade + SARIF".

## Limitations (please read)

* It checks `runs.using` of actions and the metadata of reusable workflows. It does **not** check the `node-version:` input of `actions/setup-node` (your own project's Node), nor `container:` images.
* A node24 declaration says the maintainer targets Node 24; it is not proof that the action works. Treat `--fix` as a starting point.
* Private actions are `unresolved` unless the token can read them; GitHub Enterprise Server needs `--api-url`.
* Reusable workflows and composites are followed to depth 4; deeper chains are reported as unresolved.
* `docker://` and `./local` action references are skipped (a local `action.yml` is checked via `local-action-runtime`).
* Dynamic `uses:` values (expressions) are not resolvable.
* Verified on the test-suite (a fake GitHub API on localhost, 32 tests) and by hand against live API data for ~20 repositories; precision on arbitrary repositories is not proven.

## Development

```bash
npm ci
npm test            # typecheck + 32 tests (node:test) against a local mock GitHub API
npm run bundle      # regenerate action/index.mjs (committed; CI fails if it is stale)
```

MIT licensed. See [CHANGELOG.md](CHANGELOG.md), [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md).
