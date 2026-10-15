# Contributing

Issues and pull requests are welcome. For anything larger than a fix, open an
issue first so we can agree on the approach.

## Setup

Node 18 or newer.

```bash
npm install
npm test
npm run lint
npm run typecheck
```

`npm test` compiles `src/` and `test/` with `tsc` and runs them with
`node:test`. Generator tests compare against files in `test/golden/`; after an
intended change run `UPDATE_GOLDEN=1 npm test` and review the diff.

## Layout

```
src/core/       cron parser, config validation, job registry. Pure, no I/O.
src/adapters/   GitHub and Cloudflare generators, management API client.
src/app/        use cases (run, tick, backup) against small interfaces.
src/cli/        argument parsing, files, output, exit codes.
src/worker.ts   Cloudflare Worker entry.
```

Imports point inward: `cli` may import anything, `core` imports nothing.
Only `cli` touches the file system, `process` or stdout.

## Rules

- No new runtime dependencies without an issue explaining why.
- Every change to the management API client needs a fixture in
  `test/fixtures/api/` and a test. Say whether the behaviour was seen live.
- Never put a real token in code, tests, fixtures or issues.
- Comments explain why, not what.
- Commit messages: imperative, short subject ("Fix weekday ranges"), body if
  the reason is not obvious.
- Add a line to `CHANGELOG.md` under Unreleased for user-visible changes.

## Live checks

If you have Telegram Serverless access, `TGCLOUD_TOKEN=... npm run verify:live`
against a test bot is the most useful thing you can run. Attach the summary
(not the token) to your pull request.
