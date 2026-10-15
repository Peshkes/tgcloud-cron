# Live verification

What to do once Telegram Serverless access is granted. Use a **separate test
bot**, not a bot with real users: the backup probe reads its tables.

## 1. Prepare a test bot

```bash
mkdir tgcron-live && cd tgcron-live
npm create @tgcloud/bot .
```

Give it a table with a few rows of every column type, including a blob and a
large integer, so the backup probe has something to read:

```js
// tgcloud/schema.js
import { blob, integer, table, text } from 'sdk/db';

export const probe = table('probe', {
  id: integer('id').primaryKey(),
  name: text('name'),
  data: blob('data'),
  big: integer('big'),
});
```

```bash
npx tgcloud push
npx tgcloud migrate --safe
npx tgcloud run handlers/message '{ chat: { id: 1 }, text: "hi" }'
```

Insert a few rows with a throwaway handler run, for example
`db.insert(probe).values({ id: 1, name: 'a', data: new Uint8Array([1, 2, 3]), big: 9007199254740993n })`.

## 2. Run the probe

From a checkout of this repository:

```bash
npm ci
TGCLOUD_TOKEN=app123:... npm run verify:live
```

It checks, in order:

| Check | If it fails |
| --- | --- |
| `GET /get` returns deployed modules | The client's URL, auth or envelope is wrong. Compare the recorded response with `src/adapters/tgcloud/client.ts`. |
| `/run` accepts synthetic modules and passes args | The core design does not hold. Fall back to a real `endpoints/` module guarded by a secret argument (see `docs/design.md`). |
| `/run` reports a thrown error with logs | Error mapping in `TgcloudClient.run` needs the real shape. |
| `/run` can read `sqlite_master` | Backups need `args.tables`; make it required or find another listing. |
| `/run` can page a table by rowid | The exporter query or parameter binding needs changing. |

The run writes `test/fixtures/live/<date>.json` with sources and row values
removed. Read it before committing.

## 3. Update the project

1. Compare the recorded exchanges with `test/fixtures/api/*.json`. Fix every
   fixture whose shape differs, then the client, until `npm test` passes.
2. Run the example end to end: copy `examples/basic` into a new private
   repository, push the bot, add `TGCLOUD_TOKEN`, and trigger each job from
   the Actions tab. Let the schedules run for a day.
3. Run a backup of the probe table and check the NDJSON against the inserted
   rows, including the `$base64` and `$bigint` values.
4. Measure: CPU time of a 500-row backup page, the largest `/run` response that
   succeeds, and what a 429 looks like. Put the numbers in the README limits
   section.
5. In the README, change each row of "Verification status" that now holds to
   "yes, <date>, @tgcloud/cli <version>", and remove the warning at the top if
   all of them do.
6. Release a minor version and mention the verification in the changelog.

## When the official CLI changes

The management API is reconstructed from `@tgcloud/cli`. On a new CLI release,
diff `src/api/client.js`, `src/api/endpoints.js` and `src/commands/run.js`
against the previous version and rerun `npm run verify:live`.

```bash
npm pack @tgcloud/cli@<new> && tar xzf tgcloud-cli-<new>.tgz
```
