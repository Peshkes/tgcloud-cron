# tgcloud-api

[![npm](https://img.shields.io/npm/v/tgcloud-api)](https://www.npmjs.com/package/tgcloud-api)

A small client for the management API of [Telegram Serverless](https://core.telegram.org/bots/serverless):
read the deployed code of a bot and run a module on the platform. No
dependencies; it takes `fetch` as a parameter, so it runs in Node 18+ and in
Cloudflare Workers.

> [!IMPORTANT]
> The management API is undocumented. This client mirrors the official CLI,
> `@tgcloud/cli` 0.2.0, which is the only reference for it, and it has not been
> verified against the live platform yet. It can break when Telegram changes
> the API. Not affiliated with Telegram.

```js
import { TgcloudClient } from 'tgcloud-api';

const client = new TgcloudClient({ token: process.env.TGCLOUD_TOKEN, fetch });

const { revision, modules } = await client.getDeployed();

const result = await client.run(
  'handlers/message',
  modules,
  { chat: { id: 1 }, text: 'hi' },
);
if (result.ok) console.log(result.value, result.logs);
else console.error(result.error.message, result.logs);
```

## API

| | |
| --- | --- |
| `new TgcloudClient({ token, fetch, baseUrl?, timeoutMs?, maxRetries? })` | `token` is the CLI access token, `app<id>:<secret>`. |
| `client.appId` | The public `app<id>` part of the token, safe to print. |
| `client.getDeployed()` | `GET /get`: `{ revision, modules }`, with module sources keyed by name (`lib/cart`). |
| `client.run(module, sources, args, { ctx?, idempotent? })` | `POST /run`: runs `module` from the module space `sources`, not from the deployed code. Returns `{ ok: true, value, logs, time }` or `{ ok: false, error, logs, time }`. |
| `withModules(modules, extra)` | Adds modules for one run and refuses to shadow a project module. |
| `baseUrlFromEnv(env)` | Base URL from `TG_CLOUD_API_URL` and `TGCLOUD_BETA`, as the official CLI reads them. |

Errors are `ApiError` with a `kind`: `auth` (401, 403), `rate_limit` (429),
`server` (5xx), `network`, `request` (the platform rejected the request or the
code threw) and `protocol` (an unexpected response).

**Retries.** `getDeployed` retries 429, 5xx and network errors with backoff.
`run` retries only 429 by default: after a 5xx or a dropped connection the
code may already have run, and running it twice can, for example, send a
message twice. Pass `idempotent: true` for read-only code to retry every
transient error.

**Tokens.** The CLI token gives full control of the bot, including running
any code next to its database. The client never prints the secret part, and
strips control characters from server text it returns.

`/run` executes only modules under a runnable directory, today `handlers/`
and `endpoints/`. Modules added with `withModules` exist only for that call.

## License

[MIT](LICENSE)
