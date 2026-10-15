# Management API fixtures

Each file is a list of request/response exchanges replayed by
`test/helpers/fake-fetch.ts`.

Provenance: **reconstructed**, not recorded. The shapes follow
`@tgcloud/cli` 0.2.0 (`src/api/client.js`, `src/api/endpoints.js`,
`src/commands/run.js`, `src/core/run-output.js`). Field values are invented.
Running `npm run verify:live` writes recorded responses to `test/fixtures/live/`;
when those exist, compare them with these files and fix any difference here.

The token in every fixture is the fake `app123:test-secret`.
