# Contributing

Issues and pull requests are welcome. For anything larger than a fix, open an
issue first so we can agree on the approach.

## Setup

Node 18 or newer. The repository is an npm workspace with three packages.

```bash
npm install
npm test          # builds every package, then runs node:test in each
npm run lint
npm run typecheck
```

Each package compiles `src/` and `test/` with `tsc` and runs them with
`node:test`. Generator tests compare against files in
`packages/cron/test/golden/`; after an intended change run
`UPDATE_GOLDEN=1 npm test` and review the diff. The exporter's SQL is tested
against real SQLite on Node versions that have `node:sqlite` and skipped on
the others.

## Layout

```
packages/api/      tgcloud-api: management API client. No dependencies.
packages/backup/   tgcloud-backup: exporter, runBackup, tgbackup CLI. Depends on api.
packages/cron/     tgcloud-cron: depends on api and backup.
  src/core/        cron parser, config validation, job registry. Pure, no I/O.
  src/adapters/    GitHub and Cloudflare generators, the synthetic entry module.
  src/app/         use cases (run, tick) against small interfaces.
  src/cli/         argument parsing, files, output, exit codes.
  src/worker.ts    Cloudflare Worker entry.
examples/basic/    a Serverless project using all of it.
scripts/           test runner and live verification.
```

Dependencies point inward: `cron` uses `backup` and `api`, `backup` uses
`api`, and inside `cron` only `cli` touches the file system, `process` or
stdout.

## Rules

- No new runtime dependencies without an issue explaining why.
- Every change to the management API client needs a fixture in
  `packages/api/test/fixtures/api/` and a test. Say whether the behaviour was
  seen live.
- Never put a real token in code, tests, fixtures or issues.
- Comments explain why, not what.
- Commit messages: imperative, short subject ("Fix weekday ranges"), body if
  the reason is not obvious.
- Add a line to the package's `CHANGELOG.md` under Unreleased for
  user-visible changes.

## Releasing

Packages are versioned separately. Publish in dependency order, from a clean
`main` with CI green:

```bash
npm test
npm publish -w tgcloud-api
npm publish -w tgcloud-backup
npm publish -w tgcloud-cron
```

Skip a package whose version did not change. Then tag each published package
as `<name>@<version>` (for example `tgcloud-cron@0.2.0`), push the tags and
create a GitHub release per tag with that version's changelog section.
When `tgcloud-cron`'s version changes, regenerate
`examples/basic/.github/workflows/tgcron.yml`, which pins it.

## Live checks

If you have Telegram Serverless access, `TGCLOUD_TOKEN=... npm run verify:live`
against a test bot is the most useful thing you can run. Attach the summary
(not the token) to your pull request.
