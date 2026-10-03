# Contributing

```bash
npm ci
npm test          # builds, typechecks, runs node:test against a local mock of the GitHub API
npm run bundle    # regenerate action/index.mjs; commit it with your change (CI checks it is up to date)
```

* Tests never touch the real GitHub API: extend `test/mock-github.ts` with the fake repositories you need.
* New findings need a rule id in `src/types.ts`, an entry in the README table and a test.
* If you report a false positive or false negative, include the `uses:` line and the `runs.using` you see in that action's `action.yml`.
* Keep the action free of other actions (`test/action-metadata.test.ts` enforces it).
* Releasing: bump the version and the README pins in a PR, merge when green, then run **Actions > Release gate** with the new tag (for example `v1.2.3`) *before* you create the tag. The same check runs again on the tag, and a weekly job (`claims-latest.yml`) fails when the README pins an older release than the newest tag.
