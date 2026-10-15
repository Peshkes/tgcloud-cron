# tgcloud-cron: design note

Status: approved 2026-10-15, implemented in 0.1.0. Nothing here has been run
against the live platform yet.

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
`@daily` macros (Actions does not accept them). The parser has no dependency.

The two targets number weekdays differently: GitHub 0-6 from Sunday,
Cloudflare 1-7 from Sunday. `tgcron.json` uses standard cron, and the
generators rewrite only the weekday field: numbers for GitHub, names for
Cloudflare. A firing expression is matched to jobs by its parsed fields
(`scheduleKey`), not by text. `*/n` in the weekday field is rejected: it
would mean different days on the two targets and changes the OR rule.

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
| `tgcron tick --schedule "<expr>"` | Runs every enabled job whose schedule means the same as `<expr>`. Called by the generated workflow. |

`generate` output starts with a `# Generated by tgcloud-cron. Edit tgcron.json and re-run.` line;
`check` fails if the file on disk differs from what `generate` would write, so
CI can catch a forgotten regeneration.

## Adapters

### GitHub Actions

One workflow. Each distinct schedule becomes one `schedule:` entry; Actions
sets `github.event.schedule` to the expression that fired, which selects the jobs.

The generated file for the example project is
[examples/basic/.github/workflows/tgcron.yml](../examples/basic/.github/workflows/tgcron.yml).
Its parts:

- a `schedule:` entry per distinct schedule, and `workflow_dispatch` with a
  job picker;
- one concurrency group per schedule, which a manual run of a job joins too;
- `tgcron tick --schedule "$SCHEDULE"` or `tgcron run "$JOB"`, with every
  expression passed through `env`, never interpolated into the script;
- per backup job, an artifact upload, or one commit step per backup branch
  that retries a rejected push from the new tip. Both run only when the
  backup wrote its manifest.

The version is pinned to the one that generated the file. Caveats go in the
README: schedules can start late under load, and GitHub disables scheduled
workflows in public repositories after 60 days without commits.

### Cloudflare Workers Cron Triggers

`wrangler.jsonc` lists the expressions under `triggers.crons` and disables the
public URL. `worker.js`
imports the tick logic from `tgcloud-cron/worker` (Wrangler bundles it) and
embeds the job table; `event.cron` selects the jobs. The token is set with
`wrangler secret put TGCLOUD_TOKEN`. Jobs whose output is a file (backup) are
rejected for this target in 0.1.0: a Worker has no place to put it without
extra bindings.

### Management API client

A separate package, `tgcloud-api`, with two calls: `getDeployed` and `run`.
Runnable directories are not read from `/capabilities`; the entry modules use
`endpoints/`, which is runnable today. It takes `fetch` and the base URL as parameters, so
the same code runs in Node and in a Worker and is tested against recorded
fixtures. It mirrors the official CLI: same URL scheme, headers, envelope
parsing, control-character stripping of server text. `/get` and the backup
exporter's reads are retried on 429, 5xx and network errors, up to three times
with backoff, using `retry_after` if the server sends it. A job's `/run` is
retried only on 429: after a 5xx or a dropped connection the job may already
have run, and running it twice can send messages twice.

## Built-in job: backup

`use: "tgcloud-cron/backup"` exports every table to NDJSON. The export is the
separate package `tgcloud-backup`, which also has its own CLI.

- List tables from `sqlite_master`, and for each the name that reaches its
  rowid (`rowid`, `_rowid_` or `oid`, whichever the table does not use as a
  column, via `pragma_table_info`). `args.tables` filters this list.
- Read each table in pages ordered by rowid, one `/run` call per page; the
  first page has no lower bound, so rowids of zero or below are included, and
  the cursor travels as a string. `WITHOUT ROWID` tables are paged by offset.
  A page that hits a CPU or memory limit is retried with half as many rows.
  Blobs are base64-encoded inside the isolate (it has no `Buffer` or `atob`).
- Write `tgcron-backup/<job>/<UTC timestamp>/<table>.ndjson`, with table names
  made safe as file names, plus `schema.js` (from `/get`) and `manifest.json`
  with app id, times, and the table, row count and SHA-256 of each file.
- Default destination: an Actions artifact per backup job. Opt-in: commit to a
  separate branch with no shared history; branches such as `main` or
  `gh-pages` are refused. Only backups with a manifest are shipped.

The export is not a point-in-time snapshot: each page is a separate call, and
writes between pages are visible. The manifest records start and end time.
Restore is out of scope for now.

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

An npm workspace with three packages, each published on its own:

```
packages/api/      tgcloud-api: management API client. No dependencies.
packages/backup/   tgcloud-backup: exporter, runBackup, tgbackup CLI. Uses api.
packages/cron/     tgcloud-cron: uses api and backup.
  src/core/        cron parser, schedule math, config validation, job registry. Pure.
  src/adapters/    GitHub workflow and Cloudflare Worker generators (string out),
                   the synthetic entry module.
  src/app/         use cases: run, tick. Take ports, return results.
  src/cli/         argument parsing (node:util parseArgs), file I/O, printing, exit codes.
  src/worker.ts    Worker entry used by the Cloudflare adapter.
```

Dependencies point inward: `cron` uses `backup` and `api`, `backup` uses `api`.
Inside `cron`, `core` imports nothing, `adapters` import `core`, `app` wires
them through small interfaces, and `cli` is the only layer that touches the
file system, `process.env` and stdout.

No third-party runtime dependencies. Dev dependencies: `typescript`,
`@types/node` (pinned to the Node 18 API), `@biomejs/biome`. Tests use
`node:test` on the compiled output. TypeScript strict, ESM, Node 18+.

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
- Contract: the API client against fixtures (`packages/api/test/fixtures/api/*.json`)
  through a fake `fetch`: success, job error with logs, 401, 429 with retry,
  non-JSON body, network error.
- End-to-end: `tgcron generate github` on `examples/basic`, compared to a
  committed workflow file.
- The exporter's SQL runs against real SQLite (`node:sqlite`, Node 22+).
- Live verification: `npm run verify:live` with `TGCLOUD_TOKEN` set. It runs a
  no-op job, a `db` probe, the synthetic-entry check and one backup page, and
  writes sanitized responses to `packages/api/test/fixtures/live/` so the contract tests can
  be checked against real data. Until it has run, the README marks every
  API-dependent feature as unverified.

## Name

Checked 2026-10-15 on npm and GitHub (`Peshkes/<name>`), all free:
`tgcloud-cron`, `tgcron`, `tgcloud-scheduler`, `tgcloud-jobs`, `tgcloud-tick`.
Later the same day: `tgcloud-api` and `tgcloud-backup`, also free.

Proposal: package and repository `tgcloud-cron`, binary `tgcron`. It follows
the community naming (`tgcloud-mcp`, `tgcloud-secrets`, `tgcloud-vendor-wasm`)
and is what people will search for. Alternative: `tgcloud-scheduler`.

## Out of scope for 0.1.0

Restore from backup, backup encryption, job retries with state, other
schedulers (cron-job.org, Deno Deploy, a plain crontab), timezones.
