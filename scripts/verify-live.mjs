// Checks the assumptions tgcloud-cron makes about the management API against
// a real bot, and records sanitized responses for the contract tests.
//
//   TGCLOUD_TOKEN=app<id>:<secret> npm run verify:live
//
// Read-only: it runs probe code through /run and never deploys, migrates or
// writes to the database. Recorded responses keep shapes and drop content:
// module sources become their length, table rows become their column names.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TgcloudClient } from '../dist/adapters/tgcloud/client.js';
import {
  BACKUP_MODULE,
  BACKUP_SOURCE,
  ENTRY_MODULE,
  entrySource,
} from '../dist/adapters/tgcloud/entry.js';

const token = process.env.TGCLOUD_TOKEN;
if (!token) {
  console.error('Set TGCLOUD_TOKEN to the CLI access token of a test bot.');
  process.exit(3);
}
const baseUrl = process.env.TG_CLOUD_API_URL || 'https://cloud.telegram.org';

const exchanges = [];
const recordingFetch = async (url, init) => {
  const res = await fetch(url, init);
  const text = await res.text();
  exchanges.push({
    request: {
      method: init.method,
      path: new URL(url).pathname.replace(/app\d+/, 'app123'),
      body: redactRequest(init.body),
    },
    response: { status: res.status, body: redactResponse(text) },
  });
  return { status: res.status, text: async () => text };
};

const client = new TgcloudClient({ token, baseUrl, fetch: recordingFetch, maxRetries: 1 });
console.log(`Bot ${client.appId}, API ${baseUrl}\n`);

const checks = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    checks.push({ name, ok: true, detail });
    console.log(`ok    ${name}${detail ? `: ${detail}` : ''}`);
  } catch (err) {
    checks.push({ name, ok: false, detail: err.message });
    console.log(`FAIL  ${name}: ${err.message}`);
  }
}

let deployed;
await check('GET /get returns deployed modules', async () => {
  deployed = await client.getDeployed();
  return `revision ${deployed.revision}, ${Object.keys(deployed.modules).length} modules`;
});
const modules = deployed?.modules ?? {};

const PROBE_JOB = 'lib/tgcron_probe';
const probe = `export default async function (args, tick) {
  console.log('probe', JSON.stringify(args));
  return { echo: args, tick };
}
`;
await check('/run accepts synthetic modules and passes args', async () => {
  const sources = { ...modules, [PROBE_JOB]: probe, [ENTRY_MODULE]: entrySource(PROBE_JOB) };
  const tick = { job: 'probe', runId: 'live', scheduledAt: null };
  const r = await client.run(ENTRY_MODULE, sources, { args: { n: 1 }, tick });
  if (!r.ok) throw r.error;
  if (JSON.stringify(r.value?.echo) !== '{"n":1}')
    throw new Error(`unexpected value ${JSON.stringify(r.value)}`);
  if (!r.logs.some((l) => l.message.includes('probe')))
    throw new Error('console output not captured');
  return `platform time ${r.time ?? '?'}s`;
});

await check('/run reports a thrown error with logs', async () => {
  const failing = `export default async function () { console.error('before'); throw new Error('probe failure'); }\n`;
  const sources = { ...modules, [PROBE_JOB]: failing, [ENTRY_MODULE]: entrySource(PROBE_JOB) };
  const r = await client.run(ENTRY_MODULE, sources, { args: {}, tick: {} });
  if (r.ok) throw new Error('expected a failure');
  if (!/probe failure/.test(r.error.message)) throw new Error(`message was "${r.error.message}"`);
  return `HTTP ${r.error.status}, ${r.logs.length} log entries`;
});

const backupSources = { ...modules, [BACKUP_MODULE]: BACKUP_SOURCE };
let tables = [];
await check('/run can read sqlite_master', async () => {
  const r = await client.run(BACKUP_MODULE, backupSources, { op: 'tables' }, { idempotent: true });
  if (!r.ok) throw r.error;
  tables = r.value;
  return `${tables.length} tables`;
});

await check('/run can page a table by rowid', async () => {
  const table = tables.find((t) => !t.withoutRowid);
  if (!table) return 'skipped: no rowid table';
  const r = await client.run(
    BACKUP_MODULE,
    backupSources,
    { op: 'page', table: table.name, after: 0, limit: 5 },
    { idempotent: true },
  );
  if (!r.ok) throw r.error;
  return `${table.name}: ${r.value.rows.length} rows`;
});

const dir = join('test', 'fixtures', 'live');
mkdirSync(dir, { recursive: true });
const file = join(dir, `${new Date().toISOString().slice(0, 10)}.json`);
writeFileSync(file, `${JSON.stringify({ checks, exchanges }, null, 2)}\n`);

const failed = checks.filter((c) => !c.ok).length;
console.log(
  `\n${checks.length - failed}/${checks.length} checks passed. Recorded ${exchanges.length} exchanges in ${file}.`,
);
console.log('Review the file before committing it.');
process.exit(failed === 0 ? 0 : 1);

function redactRequest(body) {
  if (!body) return undefined;
  const parsed = JSON.parse(body);
  if (parsed.sources) {
    parsed.sources = Object.fromEntries(
      Object.entries(parsed.sources).map(([k, v]) => [k, `<${v.length} chars>`]),
    );
  }
  return parsed;
}

function redactResponse(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return `<non-JSON, ${text.length} chars>`;
  }
  const r = data?.result;
  if (r?.canonical_modules) {
    r.canonical_modules = Object.fromEntries(
      Object.entries(r.canonical_modules).map(([k, v]) => [k, `<${String(v).length} chars>`]),
    );
  }
  if (Array.isArray(r?.result?.rows)) {
    r.result.rows = r.result.rows.map((row) =>
      Object.fromEntries(Object.keys(row).map((k) => [k, '<redacted>'])),
    );
  }
  return data;
}
