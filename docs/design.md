# tgcloud-cron: design note

Status: draft for review, 2026-10-15. Nothing here has been run against the live
platform yet.

## Problem

Telegram Serverless runs bot code only in response to updates (handlers) and
Mini App calls (endpoints). There is no scheduled trigger: the server-provided
project layout (`GET https://cloud.telegram.org/capabilities`) lists 27 handler
names and none of them is time-based. Bots that need a daily digest, a price
sync or a backup have to be poked from outside.

tgcloud-cron lets a developer declare jobs in one file, generates the trigger
configuration for a free external scheduler, and at each tick runs the job on
the platform through the same management API the official CLI uses.

## What the platform gives us

Read from `@tgcloud/cli@0.2.0` (npm tarball, `src/api/client.js`,
`src/api/endpoints.js`, `src/commands/run.js`, `src/core/credentials.js`,
`src/core/project-layout.js`) and from https://core.telegram.org/bots/serverless.

| Fact | Source |
| --- | --- |
| Management API base: `https://cloud.telegram.org/app<id>/manage`, path appended (`/run`, `/get`, ...). | `client.js` |
| Auth: `Authorization: Bearer app<id>:<secret>`. Token regex `^app\d+:[A-Za-z0-9_-]+$`. `app<id>` is public, the secret is not. | `client.js`, `credentials.js`, docs |
| Envelope: `{ ok: true, result }` or `{ ok: false, description, error_code, error_type?, parameters? }`. | `client.js` |
| `POST /run` body: `{ module, sources, args, ctx }`. `sources` is the whole module space `{ "lib/x": "<code>" }`; the deployed state is not consulted. | `endpoints.js`, `run.js` |
| `/run` result: `{ result, log, time }`; `log` entries are `{ _: "log"\|"dbg"\|"inf"\|"wrn"\|"err", t, m \| M, o }`. On failure the same `log` and `time` come back in `parameters`. | `run-output.js`, `run.js` |
| `GET /get` returns `{ revision, canonical_modules, static? }`: the deployed source of every module. | `endpoints.js` |
| Runnable directories come from `/capabilities`: today `handlers/` (closed name list) and `endpoints/` (any name). `lib/` is not runnable. | `/capabilities`, `project-layout.js` |
| `args` and `ctx` must be JSON objects. | `run.js`, docs |
| Modules can import each other by bare module name (`from 'lib/cart'`). | docs |
| `TGCLOUD_TOKEN` is the documented CI channel for the token. | docs |
| `TG_CLOUD_API_URL` overrides the base URL. | `client.js` |

Not documented, inferred or measured by others (to verify live):

- `/run` has access to `db`. Inferred from the docs ("run executes a handler on
  the platform") and from third-party projects that do it.
- Whether `/run` accepts a module that exists only in `sources` and not on
  disk. The CLI never does this; the API contract suggests it works.
- Limits measured by `DaYzTm/telegram-serverless-limits` (2026-10-09): about
  3 s CPU per call, about 128 MiB heap, about 496 MiB SQLite, HTTP 429 at 16
  parallel management calls. Maximum `/run` response size is unknown.
- Whether `sqlite_master` is readable from user code.
- Whether 429 responses carry `parameters.retry_after`.

## How a job runs

A job is an ordinary module in `tgcloud/lib/cron/<name>.js`:

```js
// tgcloud/lib/cron/dailyDigest.js
import { api, db } from 'sdk';

export default async function (args, tick) {
  // tick = { job: 'dailyDigest', scheduledAt: '2026-10-16T09:00:00Z', runId: '...' }
  ...
  return { sent: 42 };
}
```

`lib/` is deployed with `tgcloud push` but is not runnable and not reachable
from a Mini App. To invoke it, tgcloud-cron sends `/run` a module space with
one extra, synthetic entry module that is never deployed:

```js
// endpoints/tgcron_entry — exists only inside the /run request
import job from 'lib/cron/dailyDigest';
export default (input) => job(input.args, input.tick);
```

Per tick, for each due job:

1. `GET /get` to fetch the deployed modules (`canonical_modules`).
2. `POST /run` with `module: "endpoints/tgcron_entry"`, `sources` = deployed
   modules + entry, `args = { args, tick }`.
3. Print the job's console output and result, map the outcome to an exit code.

Why run the deployed code and not the files in the CI checkout: a scheduled
job should behave like production. A branch with unpushed changes must not
change what the nightly job does. `tgcron run <job> --local` sends local files
instead, for testing.

Why a synthetic entry and not a real `endpoints/` file: a deployed endpoint is
callable by any user who opens the bot's Mini App. A job is not meant to be.

Fallback if the platform rejects synthetic modules: the job lives in
`endpoints/` and checks a shared secret in `args`. Worse, but workable; decided
after live verification.

## Configuration

`tgcron.json` at the project root, next to `tgcloud.jsonc`. JSON with comments
allowed (same rules as `tgcloud.jsonc`). Data rather than code, so `check` and
`generate` never execute user code.

```jsonc
{
  "$schema": "./node_modules/tgcloud-cron/schema.json",
  "jobs": {
    "dailyDigest": { "schedule": "0 9 * * *" },
    "syncPrices": { "schedule": "*/15 * * * *", "args": { "currency": "USD" } },
    "backup": { "schedule": "30 2 * * *", "use": "tgcloud-cron/backup" }
  }
}
```

| Key | Meaning |
| --- | --- |
| `jobs.<name>` | Job name, `^[a-zA-Z][a-zA-Z0-9_-]{0,63}$`. |
| `schedule` | Five-field cron expression, always UTC. |
| `module` | Module to run. Default `lib/cron/<name>`. Must be under `lib/`. |
| `args` | JSON object passed as the first argument. Default `{}`. |
| `use` | Built-in job instead of a module. Only `tgcloud-cron/backup` in 0.1.0. |
| `enabled` | `false` keeps the job in the file but out of generated triggers. |

Both target schedulers run in UTC only, so there is no `timezone` key. A
schedule that fires more often than every 5 minutes is an error for the
GitHub target (Actions does not run schedules more often than that).

### Cron dialect

Supported: `*`, numbers, ranges `a-b`, steps `*/n` and `a-b/n`, lists `a,b`,
month and weekday names (`JAN`, `MON`), weekday `0` and `7` as Sunday. Standard
day-of-month / day-of-week OR rule. Not supported: `L`, `W`, `#`, `?`, seconds,
`@daily` macros (Actions does not accept them). The parser is about 150 lines
and has no dependency.

## CLI

Binary `tgcron`. Exit codes: `0` success, `1` a job failed, `2` usage or
config error, `3` auth error, `4` transient error (network, 429, 5xx).

| Command | What it does |
| --- | --- |
| `tgcron init` | Writes `tgcron.json` with one example job and `tgcloud/lib/cron/example.js`. Never overwrites. |
| `tgcron check` | Validates config and expressions, checks that each job module exists locally, prints the next three fire times per job. Offline. |
| `tgcron generate github` | Writes `.github/workflows/tgcron.yml`. |
| `tgcron generate cloudflare` | Writes `cloudflare/wrangler.toml` and `cloudflare/worker.js`. |
| `tgcron run <job> [--local] [--json]` | Runs one job now. |
| `tgcron tick --schedule "<expr>"` | Runs every enabled job whose schedule equals `<expr>`. Called by the generated workflow. |

`generate` output starts with a `# Generated by tgcloud-cron. Edit tgcron.json and re-run.` line;
`check` fails if the file on disk differs from what `generate` would write, so
CI can catch a forgotten regeneration.

## Adapters

### GitHub Actions

One workflow. Each distinct schedule becomes one `schedule:` entry; Actions
sets `github.event.schedule` to the expression that fired, which selects the jobs.

```yaml
# Generated by tgcloud-cron. Edit tgcron.json and re-run `tgcron generate github`.
name: tgcron
on:
  schedule:
    - cron: "0 9 * * *"
    - cron: "*/15 * * * *"
    - cron: "30 2 * * *"
  workflow_dispatch:
    inputs:
      job: { description: "Job name", required: true }
concurrency: { group: "tgcron-${{ github.event.schedule || inputs.job }}", cancel-in-progress: false }
permissions: { contents: read }
jobs:
  tick:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npx --yes tgcloud-cron@0.1.0 tick --schedule "${{ github.event.schedule }}"
        if: github.event_name == 'schedule'
        env: { TGCLOUD_TOKEN: "${{ secrets.TGCLOUD_TOKEN }}" }
      - run: npx --yes tgcloud-cron@0.1.0 run "${{ inputs.job }}"
        if: github.event_name == 'workflow_dispatch'
        env: { TGCLOUD_TOKEN: "${{ secrets.TGCLOUD_TOKEN }}" }
      # present only when a backup job exists
      - uses: actions/upload-artifact@v4
        if: hashFiles('tgcron-backup/**') != ''
        with: { name: "backup-${{ github.run_id }}", path: tgcron-backup/, retention-days: 30 }
```

The version is pinned to the one that generated the file. Caveats go in the
README: schedules can start late under load, and GitHub disables scheduled
workflows in public repositories after 60 days without commits.

### Cloudflare Workers Cron Triggers

`wrangler.toml` lists the expressions under `[triggers] crons`. `worker.js`
imports the tick logic from `tgcloud-cron/worker` (Wrangler bundles it) and
embeds the job table; `event.cron` selects the jobs. The token is set with
`wrangler secret put TGCLOUD_TOKEN`. Jobs whose output is a file (backup) are
rejected for this target in 0.1.0: a Worker has no place to put it without
extra bindings.

### Management API client

One module, `src/adapters/tgcloud/client.ts`, with three calls: `getDeployed`,
`run`, and `capabilities`. It takes `fetch` and the base URL as parameters, so
the same code runs in Node and in a Worker and is tested against recorded
fixtures. It mirrors the official CLI: same URL scheme, headers, envelope
parsing, control-character stripping of server text. On 429 and 5xx it retries
up to three times with backoff, using `retry_after` if the server sends it.

## Built-in job: backup

`use: "tgcloud-cron/backup"` exports every table to NDJSON.

- Discover tables with `SELECT name FROM sqlite_master WHERE type = 'table'`,
  or take them from `args.tables` if that query is not allowed.
- Read each table in pages: `WHERE rowid > ? ORDER BY rowid LIMIT ?`, one `/run`
  call per page, page size adapted to stay well under the 3 s CPU limit.
  Blobs are base64-encoded inside the isolate (it has no `Buffer` or `atob`, so
  the exporter carries its own encoder).
- Write `tgcron-backup/<UTC timestamp>/<table>.ndjson`, plus `schema.js` (from
  `/get`) and `manifest.json` with revision, row counts and SHA-256 per file.
- Default destination: an Actions artifact. Opt-in: commit to a separate
  `tgcron-backups` branch. The README warns that backups contain user data and
  a public repository makes them public.

The export is not a point-in-time snapshot: each page is a separate call, and
writes between pages are visible. The manifest records start and end time.
Restore is out of scope for 0.1.0.

## Logs

One line per event, prefixed with the job name and run id:

```
[dailyDigest 7f3a] start  scheduled 2026-10-16T09:00:00Z  revision 41
[dailyDigest 7f3a]   log  sending to 42 chats  +12ms  [lib/cron/dailyDigest:18]
[dailyDigest 7f3a] ok     { sent: 42 }  platform 840ms  total 1.31s
```

`--json` prints NDJSON for machines. Under GitHub Actions, failures also emit
`::error::` annotations and a table in the step summary.

## Architecture

```
src/
  core/        cron parser, schedule math, config validation, job registry. Pure.
  adapters/
    github/      workflow generator (string out)
    cloudflare/  wrangler.toml + worker generator (string out)
    tgcloud/     management API client, entry-module builder, backup exporter source
  app/         use cases: check, generate, run, tick, backup. Take ports, return results.
  cli/         argument parsing (node:util parseArgs), file I/O, printing, exit codes.
  worker.ts    Worker entry used by the Cloudflare adapter.
```

`core` imports nothing. `adapters` import `core`. `app` wires `core` and
`adapters` through small interfaces. `cli` is the only layer that touches the
file system, `process.env` and stdout.

Runtime dependencies: none. Dev dependencies: `typescript`, `@types/node`,
`@biomejs/biome` (lint and format in one tool). Tests use `node:test` on the
compiled output, so there is no test runner dependency. TypeScript strict, ESM,
Node 18+.

## Security

- The CLI token gives full control of the bot, including arbitrary code
  execution next to the database. It is read only from `TGCLOUD_TOKEN`. The
  tool never writes it to disk, never prints it (only `app<id>`), and never
  reads `.tgcloud/credentials`.
- Server-provided strings are stripped of control characters before printing.
- The generated workflow requests `contents: read` only; the commit-backup
  option adds `contents: write`.
- Backups are personal data under Telegram's developer ToS (section 4). The
  README says so and recommends private repositories and short retention.

## Testing

- Unit: cron parser (table-driven, including invalid input), next-fire-time
  calculation, config validation, both generators (golden files).
- Contract: the API client against recorded fixtures (`test/fixtures/api/*.json`)
  through a fake `fetch`: success, job error with logs, 401, 429 with retry,
  non-JSON body, network error.
- End-to-end: `tgcron generate github` on `examples/basic`, compared to a
  committed workflow file.
- Live verification: `npm run verify:live` with `TGCLOUD_TOKEN` set. It runs a
  no-op job, a `db` probe, the synthetic-entry check and one backup page, and
  writes sanitized responses to `test/fixtures/live/` so the contract tests can
  be checked against real data. Until it has run, the README marks every
  API-dependent feature as unverified.

## Name

Checked 2026-10-15 on npm and GitHub (`Peshkes/<name>`), all free:
`tgcloud-cron`, `tgcron`, `tgcloud-scheduler`, `tgcloud-jobs`, `tgcloud-tick`.

Proposal: package and repository `tgcloud-cron`, binary `tgcron`. It follows
the community naming (`tgcloud-mcp`, `tgcloud-secrets`, `tgcloud-vendor-wasm`)
and is what people will search for. Alternative: `tgcloud-scheduler`.

## Out of scope for 0.1.0

Restore from backup, backup encryption, job retries with state, other
schedulers (cron-job.org, Deno Deploy, a plain crontab), timezones.
