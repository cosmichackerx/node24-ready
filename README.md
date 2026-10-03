# node24-ready

[![CI](https://github.com/cosmichackerx/node24-ready/actions/workflows/ci.yml/badge.svg)](https://github.com/cosmichackerx/node24-ready/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/cosmichackerx/node24-ready?sort=semver)](https://github.com/cosmichackerx/node24-ready/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Find GitHub Actions workflows that still use actions declaring `node20` (or `node16` / `node12`), see through composite actions and reusable workflows, and get the smallest upgrade whose release really declares `node24`. Can rewrite the `uses:` lines for you (`--fix`), emits SARIF for code scanning, and ships as a GitHub Action and a CLI.**

> On 2026-09-23 GitHub announced that [Node 20 is no longer available in GitHub Actions](https://github.blog/changelog/2026-09-23-node-20-is-no-longer-available-in-github-actions/):
> runners now use Node 24 for JavaScript actions and the `ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION` opt-out is gone.
> Actions that still declare `runs.using: node20` are force-run on Node 24 with a deprecation warning, and nobody has tested them there.
> This tool tells you which of *your* `uses:` lines that applies to, **including the ones hidden inside other actions**, and what to change them to.

Keywords: GitHub Actions, Node 20 deprecation, Node 24 migration, `runs.using`, node20 action audit, workflow linter, composite action, reusable workflow, SARIF, supply chain.

## At a glance

|  | Lite (try it in a minute) | Full (keep it in CI) |
|---|---|---|
| How | clone, `npm ci`, `node dist/src/cli.js .` (see [Quick start](#quick-start); no npm package yet) | the [GitHub Action](#quick-start) (SARIF, job summary), `--changed-since origin/main` [PR mode](#pr-mode---changed-since), the ignore list with an expiry, and the weekly [runtime watch](#runtime-watch-keeps-the-hard-coded-facts-honest) |

### Validation / results

Every number below is from this repository's own tests or scripts (see the linked sections). "Not proven" is as important as "Result".

| What is claimed | Checked against | Size | Result | Not proven |
|---|---|---|---|---|
| `runs.using` is read correctly, including nested actions | An independent regex re-implementation on the same 240-repository corpus ([Measured precision](#measured-precision-and-what-that-does-not-prove)) | 1277 distinct action references | 1264 agree (99.0 %); of the 13 disagreements I checked by hand the tool was right in 12 and wrong in 1 (fixed) | Two implementations by one author can share a blind spot; ground truth is `action.yml`, not GitHub's runtime warnings |
| Node end-of-life rule | 12 random findings read by hand against the file contents | 12 | all 12 correct | Small sample |
| Dated runner / Docker deadlines | Dates copied from official announcements and changelogs, each cited in [src/deadlines.ts](src/deadlines.ts) and [Dated deadlines](#dated-deadlines---no-deadlines-turns-them-off) | 9 runner labels, `ubuntu-latest`, Docker Content Trust and CodeQL Action v3 (month precision) | Unit tests on the date arithmetic and the text matching | **No oracle**: GitHub's scheduler cannot be queried, so correctness rests on the cited pages; some announcements are ambiguous (stated in the README) |
| `--fix-runners` | Unit tests (position check, matrix, CRLF, idempotence, `git apply --check`) | 7 tests | green | Not run against a real workflow on the new image; the new runner image is a different machine |
| Docker Content Trust text matching | Hand review of every hit in 46 files from GitHub code search for the literal `DOCKER_CONTENT_TRUST` | 46 files, 29 flagged | 23 real uses, 6 documentation-like text; 17 correctly not flagged; 1 template-default enablement missed | Not a random sample; says nothing about files without the literal |
| Rule logic | Unit tests on Linux, Windows, macOS (Node 20, 22, 24) | 109 tests | green | - |

**Releases:** 10 releases, v0.1.0 (2026-10-02) to v0.8.0 (2026-10-03). See [CHANGELOG.md](CHANGELOG.md) and the [Releases page](https://github.com/cosmichackerx/node24-ready/releases). The weekly runtime watch opens one issue when Node's schedule, the documented `runs.using` values, or GitHub's runner-images announcements change; it does not release anything. The project is days old, so there is no long-term cadence to show.

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
git clone --branch v0.8.0 https://github.com/cosmichackerx/node24-ready && cd node24-ready
npm ci                                   # also compiles the CLI (prepare script)
export GITHUB_TOKEN="$(gh auth token)"
node dist/src/cli.js /path/to/your/repo  # exit code 1 when something declares a removed runtime
```

(There is no npm package yet; see the roadmap.)

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
      - uses: cosmichackerx/node24-ready@v0.8.0
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
      - uses: cosmichackerx/node24-ready@v0.8.0
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

**Preview before you rewrite:** `--fix --dry-run` writes nothing and prints a unified diff on stdout (the summary goes to stderr), so you can review it, save it (`> fix.patch`) and `git apply` it. Real output (also checked with `git apply --check`):

```text
$ node24-ready --fix --dry-run
--- a/.github/workflows/a.yml
+++ b/.github/workflows/a.yml
@@ -4,8 +4,8 @@
   build:
     runs-on: ubuntu-latest
     steps:
-      - uses: actions/checkout@v3
-      - uses: actions/setup-node@v3
+      - uses: actions/checkout@v5
+      - uses: actions/setup-node@v5
         with:
           node-version: 22
       - run: npm ci
node24-ready: dry run: 2 line(s) in 1 file(s) would change; nothing was written
```

**Pin first, upgrade later:** `--pin-only` does not look at runtimes at all. It replaces every `uses: owner/repo@<tag>` by the commit the tag points to *today*, with the most specific release on that commit as a comment, so behaviour does not change and the major never moves. Branch refs (`@main`), refs that are already full SHAs, local and `docker://` actions are left alone and listed on stderr. It is idempotent and works with `--dry-run`. Real output against github.com (checked with `git apply --check`; `actions/checkout`'s `v4` tag was the same commit as `v4.4.0` at the time):

```text
$ node24-ready --pin-only --dry-run
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -3,6 +3,6 @@
   a:
     runs-on: ubuntu-latest
     steps:
-      - uses: actions/checkout@v4
-      - uses: actions/setup-node@v4.1.0
+      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
+      - uses: actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af # v4.1.0
       - uses: peter-evans/create-pull-request@main
node24-ready: skipped .github/workflows/ci.yml:8 peter-evans/create-pull-request@main: 'main' is not among the tags of peter-evans/create-pull-request (a branch, ...); branches are never pinned
node24-ready: dry run: would pin 2 line(s) in 1 file(s); 0 already pinned; 1 skipped
```

Limits: only the first 300 tags of a repository are searched; a moving tag can change between the lookup and the merge of your pull request; pinning does not make a bad action good (combine with the normal scan).

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
| `setup-node-eol` | warning / info | `actions/setup-node` installs a Node.js release that is end of life (`node-version`, `.nvmrc`, `.node-version`, `.tool-versions`, `lts/<codename>`; `${{ matrix.x }}` is expanded). Warning when pinned, info for matrix entries or EOL within 90 days. |
| `runner-image-retiring` | error / warning | `runs-on` names a hosted runner label that is retired (`macos-14*`, `ubuntu-22.04*`, and the already gone `macos-13`, `macos-12`, `windows-2019`, `ubuntu-20.04`) or retires on a published date. Error from 30 days before the next brownout or retirement, in a brownout, and after retirement; a warning before that, and for matrix entries until they fail. |
| `runner-latest-migration` | info / warning | `ubuntu-latest` is being moved from Ubuntu 24.04 to 26.04 (window 2026-10-19 to 2026-11-19). Info, a warning from 14 days before the window, gone after it. |
| `docker-content-trust` | warning / error | `DOCKER_CONTENT_TRUST` switched on, `docker trust sign|inspect|revoke|key|signer`, `--disable-content-trust=false` or `notary.docker.io` in a workflow or action file, a Dockerfile/Containerfile, a Docker Compose file, any other YAML (Kubernetes manifests: `env` entries as `name:`/`value:` pairs or flow maps), a shell script, a Makefile or an `.env` file. Docker Content Trust shuts down on 2026-12-08. Warning until 30 days before, then an error. |
| `codeql-action-v3` | info / warning | `github/codeql-action/*@v3` (a `v3`, `v3.x` or `v3.x.y` tag, or a commit SHA whose comment names one). GitHub deprecates CodeQL Action v3 in **December 2026** (month only, no day); v4 runs on Node 24. Info until 31 days before 1 December, a warning after that, never an error: the announcement says deprecation means no new updates. |
| `file-unparseable` | warning | A workflow the YAML parser rejects but GitHub may accept; its `uses:` lines are still found by a line scan. |
| `ignore-expired` | warning | An entry of `.node24-ready.json` is past its `expires` date (it no longer suppresses anything). |
| `local-action-runtime` | error | The repository's own `action.yml` declares `runs.using: node20` (or older): set `node24` and release. |

## Dated deadlines (`--no-deadlines` turns them off)

These rules read dates that GitHub and Docker published. Each entry in `src/deadlines.ts` names its source and the day it was last checked against it (2026-10-03). The scanner works on whole days and takes "today" from the clock (`--today` overrides it for tests).

| What | Dates | Official source |
|---|---|---|
| `macos-14`, `macos-14-large`, `macos-14-xlarge` | deprecation 2026-07-06; brownouts 14:00 UTC to 00:00 UTC on Oct 5, 12, 16, 19, 23, 26, 29 and 30; **retired 2026-11-02** | [runner-images #13518](https://github.com/actions/runner-images/issues/13518), [changelog 2026-10-01](https://github.blog/changelog/2026-10-01-github-actions-macos-14-runner-image-retirement/) |
| `ubuntu-22.04`, `ubuntu-22.04-arm` | deprecation 2026-09-17; brownouts on 2027-03-23, 03-30, 04-06, 04-13; **retired 2027-04-17** | [runner-images #14254](https://github.com/actions/runner-images/issues/14254) |
| `ubuntu-latest` | moves to Ubuntu 26.04 gradually between **2026-10-19 and 2026-11-19** | [changelog 2026-09-17](https://github.blog/changelog/2026-09-17-ubuntu-26-generally-available-and-latest-migration/), [runner-images #14748](https://github.com/actions/runner-images/issues/14748) |
| Docker Content Trust and the Notary v1 service | write brownouts 2026-07-14/15, read brownouts 2026-08-10/12 (all past); **shutdown 2026-12-08** | [Docker blog, 2026-06-16](https://www.docker.com/blog/docker-content-trust-retirement-and-migration-guidance/), [Docker docs](https://docs.docker.com/engine/security/trust/) |
| CodeQL Action v3 (`github/codeql-action/*@v3`) | deprecated **in December 2026** (together with GHES 3.19); the day is **not announced**, so the scanner counts days to 1 December and says "59 to 89 days", never a single date. The GHES releases page lists 2026-12-09 as the "closing down date" of 3.19, which is a hint, not a CodeQL date. Brownouts are only mentioned as possible | [changelog 2025-10-28](https://github.blog/changelog/2025-10-28-upcoming-deprecation-of-codeql-action-v3/), [GHES releases](https://docs.github.com/en/enterprise-server@3.19/admin/all-releases) |
| already retired: `macos-13` (Dec 2025), `windows-2019` (2025-06-30), `ubuntu-20.04` (2025-04-15), `macos-12` (2024-12-03) | | [#13046](https://github.com/actions/runner-images/issues/13046), [#12045](https://github.com/actions/runner-images/issues/12045), [#11101](https://github.com/actions/runner-images/issues/11101), [#10721](https://github.com/actions/runner-images/issues/10721) |

Real output (`--today 2026-10-03`, a workflow with a `macos-14` job, an `os` matrix and Docker Content Trust):

```text
.github/workflows/release.yml
     4:3   warning docker-content-trust       DOCKER_CONTENT_TRUST is switched on: Docker Content Trust and the Notary v1 service shut down on 2026-12-08 (66 days). Signing breaks first. Set DOCKER_CONTENT_TRUST=0 to keep pulls working, pin images by digest, and sign with Cosign or Notation
    10:14  warning runner-image-retiring      macos-14 is retired on 2026-11-02 (30 days); next brownout 2026-10-05T14:00Z (2 days). Move to macos-latest, macos-15 or macos-26.
    10:14  warning runner-image-retiring      ubuntu-22.04 is retired on 2027-04-17 (196 days); next brownout 2027-03-23T14:00Z (171 days). Move to ubuntu-24.04, ubuntu-26.04 or ubuntu-latest.
    10:14  info    runner-latest-migration    ubuntu-latest moves from Ubuntu 24.04 to 26.04 between 2026-10-19 and 2026-11-19 (starts in 16 days). Test with ubuntu-26.04 or pin ubuntu-24.04
    13:14  warning docker-content-trust       docker trust sign: Docker Content Trust and the Notary v1 service shut down on 2026-12-08 (66 days). Signing breaks first. Set DOCKER_CONTENT_TRUST=0 to keep pulls working, pin images by digest, and sign with Cosign or Notation
    15:14  error   runner-image-retiring      macos-14 is retired on 2026-11-02 (30 days); next brownout 2026-10-05T14:00Z (2 days). Move to macos-latest, macos-15 or macos-26.

6 finding(s): 1 error, 4 warning. Checked 0 distinct action reference(s) in 1 file(s) with 0 API request(s).
```

**How well does the Docker Content Trust text matching work?** I ran it on 46 files that GitHub code search returned for the literal `DOCKER_CONTENT_TRUST` (Dockerfiles, Compose files, CI YAML, shell scripts; searched 2026-10-03, not a random sample) and read every hit by hand. 29 files were flagged: 23 really switch Docker Content Trust on or use `docker trust`/Notary v1 (for example `ARG DOCKER_CONTENT_TRUST=1`, `- DOCKER_CONTENT_TRUST=1` in Compose, `docker trust key load`), and 6 are documentation-like text that the rule cannot tell from use (a quiz in a YAML file, and the CIS remediation text `export DOCKER_CONTENT_TRUST=1` in five docker-bench definition files). 17 files were correctly not flagged (`=0`, commented out, `DOCKER_CONTENT_TRUST_REPOSITORY_PASSPHRASE`, a regex in a rule file). One real enablement was missed: a Taskfile that sets the variable through a template default (`{{.DOCKER_CONTENT_TRUST | default "1"}}`). So roughly 4 in 5 flagged files are real uses in this sample; it says nothing about files that do not contain the literal. Use `.node24-ready.json` to ignore a documentation file.

Things to know before you trust the numbers:

* The Ubuntu 22.04 announcement writes its brownout times as "14:00 UTC - 00:00 UTC" on the same date; I read them like the macOS ones (14:00 UTC until midnight). The `macos-13` announcement says December 4 in its title and December 8 in its text; it is long gone either way.
* No Windows Server 2022 or 2025 deprecation is announced at the time of writing, so those labels are not flagged. `windows-latest` and `windows-2025` already moved to Visual Studio 2026 in June 2026 (not a retirement).
* A job on a retired or browning-out label fails in GitHub's scheduler, not in your code, so it can look like flakiness. The brownout windows are in UTC.
* Matrix entries (`runs-on: ${{ matrix.os }}`) are reported at the `runs-on` line and are never louder than a warning until the label fails.
* Not covered on purpose: self-hosted runner version enforcement, `runs-on` values built from expressions you pass in (`${{ inputs.runner }}`), Helm templates that build the variable name from values, and Docker Content Trust set outside the repository (a CI variable, a machine-wide environment). Docker Content Trust is read from Dockerfiles, Containerfiles, `*.sh`, Makefiles/`*.mk`, `.env*` and every `*.yml`/`*.yaml` under the scanned paths (up to 1 MB each); `node_modules`, `vendor`, `dist`, `target`, `.git` and `.venv` are skipped. A Kubernetes `value:` that comes **before** its `name:` is not recognised. This is text matching, not YAML parsing, and there is no oracle for it (Docker offers no way to ask "is this repository affected").
* The weekly runtime watch also lists open `Announcement` issues of actions/runner-images that talk about deprecations or labels and are neither cited in `src/deadlines.ts` nor listed as reviewed in `scripts/watch/known-announcements.txt`, and opens an issue when it finds one. "Listed" means read, not necessarily complete.
* Other tools in this corner: [runner-drift](https://github.com/Booyaka101/runner-drift) (`guard --fail-on-retirement` does a similar `runs-on` check, and it also diffs the tool versions between runner images, which this does not); actionlint flags unknown labels but has no calendar.

### `--fix-runners`: rewrite the labels (opt-in)

`--fix-runners` moves a retiring `runs-on` label one generation up, in the same family and architecture, and nothing else: `macos-14` -> `macos-15`, `macos-14-large` -> `macos-15-large`, `macos-14-xlarge` -> `macos-15-xlarge`, `ubuntu-22.04` -> `ubuntu-24.04`, `ubuntu-22.04-arm` -> `ubuntu-24.04-arm`. It handles scalars, quoted scalars, list items and `matrix` entries (including `include`), keeps comments and CRLF line endings, is idempotent, and `--dry-run` prints a diff that `git apply` accepts. It prints one caveat line per rewritten label. It is a separate flag so that `--fix` keeps meaning "node24 `uses:` bumps". Real output (`--today 2026-10-03`, two workflows; `git apply --check` accepts the diff):

```text
$ node24-ready --no-suggest --fix-runners --dry-run
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -1,6 +1,6 @@
 on: push
 jobs:
   a:
-    runs-on: macos-14
+    runs-on: macos-15
     steps:
       - run: echo hi
--- a/.github/workflows/matrix.yml
+++ b/.github/workflows/matrix.yml
@@ -4,6 +4,6 @@
     runs-on: ${{ matrix.os }}
     strategy:
       matrix:
-        os: [macos-14, ubuntu-latest, ubuntu-22.04]
+        os: [macos-15, ubuntu-latest, ubuntu-24.04]
     steps:
       - run: make test
node24-ready: .github/workflows/ci.yml:4: macos-14 -> macos-15 (macOS 15 image: different default Xcode and tool versions (same arm64 architecture))
node24-ready: .github/workflows/matrix.yml:7: macos-14 -> macos-15 (macOS 15 image: different default Xcode and tool versions (same arm64 architecture))
node24-ready: .github/workflows/matrix.yml:7: ubuntu-22.04 -> ubuntu-24.04 (Ubuntu 24.04 image: newer default toolchains and a different package set; check apt packages and pinned tool versions)
node24-ready: dry run: 3 label(s) in 2 file(s) would change; nothing was written
```

Caveats, stated plainly:

* The new image is **not** the same machine: Xcode, compilers, Python and the preinstalled package set differ, so run your CI after the rewrite. The rewrite does not check that your jobs still pass.
* It never touches `macos-latest`/`ubuntu-latest`, `macos-13` and the other already retired labels (their replacement changes the CPU architecture or jumps several generations, which is a decision for you), self-hosted labels, or `runs-on` values built from expressions.
* When the target label already appears as a runner in the same file (for example `[macos-14, macos-15]`), the entry is left alone so no duplicate is created.
* A matrix label that is also used elsewhere (`if: matrix.os == 'macos-14'`, a cache key, an artifact name) is rewritten at its definition only; those other places are yours to update. Reviewing the diff is part of the workflow.
* There is no oracle for this: GitHub offers no way to ask "is this label valid", so the checks are unit tests on the text rewrite (position check, boundary check, idempotence, CRLF, `git apply`), not a run against GitHub's scheduler.

## Ignore list with an expiry: `.node24-ready.json`

Accept a known finding for a while instead of turning the whole check off:

```json
{
  "ignore": [
    { "rule": "action-runtime-deprecated", "uses": "actions-rs/toolchain@*", "reason": "archived; migrating to dtolnay/rust-toolchain in #123", "expires": "2026-12-31" }
  ]
}
```

* `reason` and `expires` (`YYYY-MM-DD`) are mandatory; `rule`, `uses` and `file` take `*` globs, and an entry must name at least one of `uses` or `file` (a bare `rule` is refused as too broad). Unknown keys are errors, so a typo cannot silently disable a check.
* After the date the entry suppresses nothing and is reported as `ignore-expired`. Ignored findings stay visible in text output (`ignored: ...`), in JSON (`ignored`, `unusedIgnores`) and as SARIF `suppressions`.
* Unused entries are listed, so the file does not rot.

Real output on a three-step workflow (one entry active, one expired):

```text
.github/workflows/ci.yml
    10:15  error   action-runtime-deprecated  actions/checkout@v4 declares node20, but GitHub now force-runs JavaScript actions on Node 24
    13:25  info    setup-node-eol             the matrix includes Node.js 18, which reached end of life on 2025-04-30
    19:25  warning setup-node-eol             node-version Node.js 20, which reached end of life on 2026-04-30

.node24-ready.json
     1:1   warning ignore-expired             ignore entry (rule=action-runtime-deprecated uses=actions/checkout@*) expired on 2026-09-01; reason was: waiting for runner image rollout. ...

4 finding(s): 1 error, 2 warning. (1 ignored by .node24-ready.json) Checked 3 distinct action reference(s) in 1 file(s) with 3 API request(s).
  ignored: .github/workflows/ci.yml:14 actions-rs/toolchain@v1 (action-runtime-deprecated) - archived; migrating to dtolnay/rust-toolchain in #123 [until 2026-12-31]
```

## PR mode: `--changed-since`

`node24-ready --changed-since origin/main` (Action input `changed-since: origin/main`, needs `fetch-depth: 0`) reports only findings on lines you touched since the merge base, so a PR is not blocked by debt that was already on `main`. Trust model: in this mode the ignore list is read **from the base ref**, not from the PR branch, so a PR cannot extend its own exemptions. Pass `--config <file>` explicitly to override that. `--fix` cannot be combined with it. Untracked files count as changed. Example (same workflow, only the last step is new):

```text
.github/workflows/ci.yml
    19:25  warning setup-node-eol             node-version Node.js 20, which reached end of life on 2026-04-30

1 finding(s): 0 error, 1 warning. (3 on unchanged lines hidden by --changed-since) Checked 3 distinct action reference(s) in 1 file(s) with 3 API request(s).
```

## Rate limits and `--cache-dir`

Every distinct `uses:` reference costs one or two API requests. `--cache-dir <dir>` (or `NODE24_READY_CACHE`) stores responses with their ETag: revalidation of an unchanged file answers `304` and does not count against the primary rate limit, and files pinned by full SHA are never requested twice. In CI, cache that directory between runs. (I exhausted a 5000/hour token while measuring a 240-repository corpus before adding this.)

**When the limit is reached anyway** (a large organisation, or no token: 60 requests per hour), the client no longer stops. It switches for the rest of the run to `raw.githubusercontent.com` for `action.yml` files and to `git ls-remote --tags https://github.com/<owner>/<repo>.git` for tag lists; neither counts against the REST limit. The summary says how many lookups went that way, and stderr gets one line. Limits of the fallback: public repositories only (the git call is unauthenticated and never receives your token), and `git` must be on `PATH` for the upgrade suggestions (without it you still get the `declares node20` findings, just no target version). `--no-fallback` restores the old hard stop with exit code `2`. Verified here against the real hosts by pointing the REST URL at a server that always answers `403 x-ratelimit-remaining: 0`: `actions/checkout@v3` and `actions/setup-node@v3` were still resolved and got suggestions through the fallback; the unit tests use local look-alike servers and parse real `git ls-remote` output (annotated tags included).

## CLI

```text
node24-ready [paths...] [options]     paths: directories or workflow/action files (default: .)

  -C, --cwd <dir>        run as if started in <dir>
  -f, --format <fmt>     text | markdown | json | github | sarif   (default: text)
  -o, --output <file>    write the report to a file
      --fail-on <level>  exit 1 on: error | warning | never   (default: error)
      --changed-since <ref>  only findings on lines changed since the merge base with <ref> (PR mode)
      --config <file>    ignore list (default .node24-ready.json; with --changed-since it is read from the base ref)
      --no-config        do not read an ignore list
      --no-eol           skip the setup-node end-of-life rule
      --cache-dir <dir>  cache API responses (ETag revalidation is free); env NODE24_READY_CACHE
      --fix              rewrite uses: lines to the suggested node24-capable release
      --fix-runners      rewrite retiring runs-on labels one generation up (macos-14* -> macos-15*, ubuntu-22.04* -> ubuntu-24.04*)
      --pin-only         only pin: tag refs become the commit SHA they point to now (same major, no upgrade)
      --dry-run          with --fix or --pin-only: write nothing, print a unified diff (git apply / patch -p1)
      --no-fallback      stop at the API rate limit instead of using raw.githubusercontent.com / git ls-remote
      --no-suggest       do not look for upgrade targets (fewer API requests)
      --api-url <url>    GitHub API base (GitHub Enterprise Server)
      --list-rules       print the rule ids and exit
```

Exit codes: `0` ok, `1` findings at or above `--fail-on`, `2` usage, config, git or API error (including rate limit). With `--fix` the exit code is `0`.
Discovery: `.github/workflows/*.yml|yaml` and every `action.yml|yaml` below the given paths (skipping `node_modules`, `.git`, `dist`, `vendor`, `target`).
The token is read only from `GITHUB_TOKEN` / `GH_TOKEN`, is sent only to the API URL, and is never printed.

## How it compares

I looked for existing tools before writing this one (2026-10). Honest summary:

| Tool | What it does | Difference |
|---|---|---|
| [rsymo/github-actions-runtime-audit](https://github.com/rsymo/github-actions-runtime-audit) | Flags actions that are "likely affected" | Heuristic; node24-ready reads the real `runs.using` of the exact ref and looks inside composites/reusable workflows |
| [azat-io/actions-up](https://github.com/azat-io/actions-up), [ylabonte/github-actions-updater](https://github.com/ylabonte/github-actions-updater) | Generic "bump everything to latest" updaters | Great for general upkeep; node24-ready answers a narrower question (which pins are actually affected) and proposes the *smallest* clean major |
| [runner-drift](https://github.com/Booyaka101/runner-drift) | Locks the tool versions your workflows use, diffs runner images, `guard --fail-on-retirement` for pinned labels | Overlaps only on retiring `runs-on` labels. It goes much deeper on image tool changes; node24-ready adds the Docker Content Trust and `ubuntu-latest` rules and keeps everything in one report |
| Dependabot / Renovate | Open update PRs | They do not know which updates matter for the Node runtime; run node24-ready first to prioritise |
| The `Node.js 20 is deprecated` annotation in run logs | Warns after a run | Only for the actions that executed, and only when they ran |

If one of these fits you better, use it. This project exists because none of them did "authoritative + transitive + smallest upgrade + SARIF".

## Measured precision (and what that does not prove)

The corpus scripts are shipped in [`scripts/corpus/`](scripts/corpus) (`fetch.py` downloads the workflows, `compare.py` runs the tool and the independent checker and lists every disagreement), so the numbers below can be reproduced; they will drift as actions release new versions. I re-ran the shipped scripts on the same 240-repository corpus (2026-10-03): **1264 of 1277 distinct references agree (99.0 %)**, 13 disagreements, the same count as in the hand-checked run below (this re-run did not repeat the hand check; 8 of the 13 are references the independent checker could not resolve through the raw host, 5 are tool `nested` versus checker `ok`, the same class as the guardian/setup-scala case). A first run without retries scored 98.7 % because the raw host returned transient errors, which is why `compare.py` now backs off and retries.

I ran v0.2.0 over a corpus of **240 public repositories** (top-starred across 20 languages, pushed after 2026-09-01; fetched 2026-10-02): **2916 workflow files, 18 104 `uses:` sites, 1277 distinct remote action references**. Result: 3199 `action-runtime-deprecated` + 161 `action-runtime-nested` errors, 81 `setup-node-eol` findings (57 warnings, 24 infos), 6 unresolved references, 1 unparseable file.

How I checked it:

* **Independent re-implementation.** A separate regex-based script (different code, raw.githubusercontent.com instead of the contents API, recursion to depth 4) resolved the same 1277 references. It agreed with the tool on **1264 (99.0 %)**. I examined all **13 disagreements by hand against the API**: the tool was right in 12 and wrong in 1 (the checker was weaker on SHA refs and deep composite chains; for example `guardian/setup-scala` -> `sbt/setup-sbt` -> `ampel/verify` -> `upload-artifact@<sha>` really is node20).
* **The one real false positive**, `actions/checkout@v1` (a `runs.plugin` action, reported as unresolved), is fixed and covered by a test.
* **Two discovery bugs found by diffing `uses:` sites** between the parser and a regex scan: steps nested in `- parallel:` groups (appwrite, dockur, electron) were skipped, and a workflow the `yaml` library rejects but GitHub accepts (pyenv's `build.yml`, a multi-line quoted scalar) was silently ignored. Both are fixed (recursive step walk; line-scan fallback plus the `file-unparseable` rule).
* **EOL rule:** 12 random findings checked by hand against the file contents; all correct (EOL dates are the official ones: Node 12 2022-04-30, 14 2023-04-30, 16 2023-09-11, 18 2025-04-30, 20 2026-04-30).

What this is **not**: the "ground truth" is the `runs.using` in each action's `action.yml`, not GitHub's runtime warnings; I did not run those workflows. GitHub force-runs `node20` actions on Node 24, so "declares node20" is the accurate claim, not "will break". The corpus is public, popular repositories, so private actions, GHES, and very old refs are under-represented. Agreement between two implementations written by the same person can share a blind spot.

## Limitations (please read)

* It checks `runs.using` of actions and the metadata of reusable workflows, plus the Node version that `actions/setup-node` installs (EOL rule, only literal values, matrices and version files). It does **not** check `container:` images or other setup actions.
* A node24 declaration says the maintainer targets Node 24; it is not proof that the action works. Treat `--fix` as a starting point.
* Private actions are `unresolved` unless the token can read them; GitHub Enterprise Server needs `--api-url`.
* Reusable workflows and composites are followed to depth 4; deeper chains are reported as unresolved.
* `docker://` and `./local` action references are skipped (a local `action.yml` is checked via `local-action-runtime`).
* Dynamic `uses:` values (expressions) are not resolvable.
* The evaluator treats "nesting limit reached" as OK (reported only as depth-4 unresolved when the chain is cut by the limit).
* Verified on the test suite (a fake GitHub API on localhost, 53 tests) and on the corpus above; see the precision section for what that does and does not show.

## Development

```bash
npm ci
npm test            # typecheck + 53 tests (node:test) against a local mock GitHub API
npm run bundle      # regenerate action/index.mjs (committed; CI fails if it is stale)
```

MIT licensed. See [CHANGELOG.md](CHANGELOG.md), [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md).

## Runtime watch (keeps the hard-coded facts honest)

Two things in this tool are tables, not logic: the Node end-of-life dates and LTS codenames in `src/eol.ts` ("update when new lines ship"), and the idea of which
`runs.using` values exist. `.github/workflows/runtime-watch.yml` runs every Monday (and on demand) and `scripts/watch/watch-runtimes.mjs` compares them with

- the [Node.js release schedule](https://github.com/nodejs/Release/blob/main/schedule.json) (a new line, a changed end date, a new LTS codename),
- the `runs.using` values GitHub documents ("Use node24 for Node.js v24" on the metadata-syntax page), against `scripts/watch/known-runtimes.txt`,
- the GitHub changelog feed for the `actions` label (only its latest ~10 entries), filtered for Node / runtime titles, against `scripts/watch/known-changelog.txt`.

It opens **one deduplicated issue** (label `runtime-watch`). The Node schedule is authoritative; the docs page is scraped for one sentence and the changelog feed is short, so those two are signals, not proof.
The `known-*` lists mean "known when the watcher started", not "reviewed". The first run found a real gap: Node 27 was in the schedule but not in `NODE_EOL` (added). What the watcher cannot do: tell you
when GitHub *will* remove a runtime; `MIN_NODE_MAJOR` stays a manual decision after an announcement.

## Related tools

Small, independent tools by the same author, for build and CI hygiene and for migrations with a deadline. Each works on its own; none requires another.

**Gradle and Android migrations**

* [gradle-version-catalog-lint](https://github.com/cosmichackerx/gradle-version-catalog-lint): Lints `libs.versions.toml`: unused libraries, plugins and versions, dynamic or SNAPSHOT versions, hard-coded dependencies.
* [gradle10-ready](https://github.com/cosmichackerx/gradle10-ready): Static scan of Gradle build scripts for what Gradle 10 removes (space assignment, multi-string dependencies, Kotlin DSL delegates). `--fix`, PR mode.
* [agp9-ready](https://github.com/cosmichackerx/agp9-ready): Static scan of Gradle files for what Android Gradle Plugin 9 and 10 break (built-in Kotlin, legacy variant API, opt-outs), including `buildSrc`. `--fix`, PR mode.
* [kotlin24-ready](https://github.com/cosmichackerx/kotlin24-ready): Static scan of Gradle build scripts for what Kotlin 2.4 removes in the Kotlin Gradle plugin (language version 1.9, KMP `targetHierarchy`, Compose options, ABI validation). `--fix`, PR mode.
* [android-target-ready](https://github.com/cosmichackerx/android-target-ready): Static scanner for the targetSdk 36 / 37 migration in app code and manifests (edge-to-edge, predictive back, large screens).
* [android-target-lint](https://github.com/cosmichackerx/android-target-lint): The same targetSdk migration checks as real Android Lint rules (a lint jar with type resolution).

**CI and repository hygiene**

* [dependabot-gaps](https://github.com/cosmichackerx/dependabot-gaps): Finds manifests your `dependabot.yml` does not cover, and dead or overlapping entries.
* [sha256-ready](https://github.com/cosmichackerx/sha256-ready): Finds code that assumes 40-character Git hashes before Git 3.0 makes SHA-256 repositories the default.
* [agent-context-diff](https://github.com/cosmichackerx/agent-context-diff): Diffs `AGENTS.md`, `CLAUDE.md`, Cursor rules and MCP configs between git refs (new servers, widened permissions, hidden Unicode).

