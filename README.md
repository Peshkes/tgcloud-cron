# tgcloud-cron

[![CI](https://github.com/Peshkes/tgcloud-cron/actions/workflows/ci.yml/badge.svg)](https://github.com/Peshkes/tgcloud-cron/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/tgcloud-cron)](https://www.npmjs.com/package/tgcloud-cron)

Scheduled jobs and database backups for [Telegram Serverless](https://core.telegram.org/bots/serverless) bots.

Telegram Serverless runs bot code when an update arrives or a Mini App calls an
endpoint. It has no timer and no way to export the bot's database.
tgcloud-cron declares jobs in one file, generates a free external trigger for
them (GitHub Actions or Cloudflare Cron Triggers), and on every tick runs the
job on the platform. A built-in job exports every table to NDJSON.

> [!IMPORTANT]
> These packages use the undocumented management API of Telegram Serverless,
> reconstructed from the official CLI (`@tgcloud/cli` 0.2.0). It can change
> without notice. **Nothing has been verified against the live platform yet**:
> see [Verification status](#verification-status). This project is not
> affiliated with Telegram.

## Packages

| Package | | |
| --- | --- | --- |
| [tgcloud-cron](packages/cron) | Jobs on a schedule: `tgcron.json`, generators for GitHub Actions and Cloudflare, the `tgcron` CLI. | [![npm](https://img.shields.io/npm/v/tgcloud-cron)](https://www.npmjs.com/package/tgcloud-cron) |
| [tgcloud-backup](packages/backup) | Export all tables to NDJSON, as a library or with `npx tgbackup export`. | [![npm](https://img.shields.io/npm/v/tgcloud-backup)](https://www.npmjs.com/package/tgcloud-backup) |
| [tgcloud-api](packages/api) | Client for the management API: read deployed code, run a module. | [![npm](https://img.shields.io/npm/v/tgcloud-api)](https://www.npmjs.com/package/tgcloud-api) |

tgcloud-cron depends on the other two; none has third-party runtime
dependencies.

## Quickstart

In a Telegram Serverless project (the folder with `tgcloud/`):

```bash
npm install -D tgcloud-cron
npx tgcron init
```

A job is a module under `tgcloud/lib/` with a default export:

```js
// tgcloud/lib/cron/dailyDigest.js
import { api, db } from 'sdk';
import { subscribers } from '../../schema.js';

export default async function (args, tick) {
  const chats = await db.select().from(subscribers).all();
  for (const c of chats) await api.sendMessage({ chat_id: c.chatId, text: 'Good morning' });
  return { sent: chats.length };
}
```

```json
{
  "jobs": {
    "dailyDigest": { "schedule": "0 9 * * *" },
    "backup": { "schedule": "30 2 * * *", "use": "tgcloud-cron/backup" }
  }
}
```

```bash
npx tgcloud push
npx tgcron generate github
```

Add the repository secret `TGCLOUD_TOKEN` (the CLI access token from
@BotFather: your bot > Serverless > CLI Access), commit
`.github/workflows/tgcron.yml` and push. The full reference is in the
[tgcloud-cron README](packages/cron); a complete project is in
[examples/basic](examples/basic).

## How it works

```
 GitHub Actions schedule          tgcron tick --schedule "0 9 * * *"
 or Cloudflare Cron Trigger ───▶  1. GET  /app<id>/manage/get   deployed modules
                                  2. POST /app<id>/manage/run    deployed modules
                                                                 + synthetic endpoints/tgcron_entry
                                                                     │
                                                                     ▼
                                  Telegram Serverless isolate: entry imports
                                  lib/cron/dailyDigest.js and calls it with (args, tick)
```

`/run` executes a module from the module space sent with the request. The
entry module that calls the job exists only in that request and is never
deployed, so jobs are not reachable from the bot's Mini App. Jobs run the
deployed code, as production does.

## Verification status

Telegram Serverless is in closed access. What each assumption is checked
against:

| Assumption | Checked against | Live |
| --- | --- | --- |
| URL scheme, auth header, response envelope | `@tgcloud/cli` 0.2.0 source | not yet |
| `/get` returns `canonical_modules` | CLI source | not yet |
| `/run` takes `{ module, sources, args, ctx }` and returns `{ result, log, time }` | CLI source, docs | not yet |
| `/run` accepts a module that exists only in the request | inferred from the API contract | not yet |
| Job code can use `db` under `/run` | docs say `run` executes on the platform; third-party projects rely on it | not yet |
| `sqlite_master` and `pragma_table_info` are readable | assumed | not yet |
| 429 carries `parameters.retry_after` | assumed; falls back to backoff | not yet |
| Exporter SQL | real SQLite in tests (`node:sqlite`) | not yet |
| Generated GitHub workflow | GitHub docs, actionlint, golden files | not yet |
| Generated Cloudflare Worker | Cloudflare docs, `wrangler deploy --dry-run`, a local scheduled run | not yet |

With a test bot, one command checks the API assumptions and records sanitized
responses for the contract tests. It only reads: it runs probe code through
`/run` and never deploys, migrates or writes to the database.

```bash
TGCLOUD_TOKEN=app123:... npm run verify:live
```

The steps for when access arrives are in
[docs/live-verification.md](docs/live-verification.md).

## Security

The CLI access token (`app<id>:<secret>`) gives full control of the bot,
including running any code next to its database; there are no scoped tokens.
The packages read it only from the `TGCLOUD_TOKEN` environment variable, never
write it to disk and print only the public `app<id>` part. Keep it in a CI
secret. Backups contain your users' data; keep them private.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Development

```bash
npm install
npm test           # builds all packages, runs node:test in each
npm run lint       # Biome
npm run typecheck
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/design.md](docs/design.md).

## License

[MIT](LICENSE)
