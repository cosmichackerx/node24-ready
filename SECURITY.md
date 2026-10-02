# Security policy

node24-ready only reads workflow files and calls two read-only GitHub REST endpoints (`contents` and `tags`).
The token is taken from `GITHUB_TOKEN` / `GH_TOKEN`, sent only to the configured API URL, and never logged.
`--fix` is the only command that writes files, and only the `uses:` lines of findings.

Report vulnerabilities privately through GitHub: Security > Report a vulnerability on this repository.
Please do not open public issues for undisclosed vulnerabilities.
