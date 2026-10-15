import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ApiError } from '../../src/adapters/tgcloud/client.js';
import { BACKUP_MODULE } from '../../src/adapters/tgcloud/entry.js';
import { tableFileName } from '../../src/app/backup.js';
import { runJob } from '../../src/app/run.js';
import { type BackupJob, validateConfig } from '../../src/core/config.js';
import { loadExporter } from '../helpers/exporter.js';
import { deps, FakePlatform, MemorySink } from '../helpers/fake-platform.js';

function backupJob(extra: Record<string, unknown> = {}): BackupJob {
  const r = validateConfig({
    jobs: { backup: { schedule: '30 2 * * *', use: 'tgcloud-cron/backup', ...extra } },
  });
  if (!r.ok || r.config.jobs[0]?.kind !== 'backup') assert.fail('bad config');
  return r.config.jobs[0];
}

const tables = {
  users: {
    sql: 'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, avatar BLOB)',
    rows: [
      { id: 1, name: 'Ann', avatar: new Uint8Array([0xff, 0x00, 0x10]) },
      { id: 2, name: 'Bo "b"', avatar: null },
      { id: 3, name: 'Cy', avatar: new Uint8Array([1, 2]) },
    ],
  },
  kv: {
    sql: 'CREATE TABLE kv (k TEXT PRIMARY KEY, v INTEGER) WITHOUT ROWID',
    rows: [{ k: 'a', v: 9007199254740993n }],
  },
  sqlite_sequence: { sql: '', rows: [] },
};

describe('exporter source', () => {
  test('lists tables and detects WITHOUT ROWID', async () => {
    const run = loadExporter(tables);
    assert.deepEqual(await run({ op: 'tables' }), [
      { name: 'kv', withoutRowid: true },
      { name: 'users', withoutRowid: false },
    ]);
  });

  test('pages by rowid and tags bytes and bigints', async () => {
    const run = loadExporter(tables);
    assert.deepEqual(await run({ op: 'page', table: 'users', after: 0, limit: 2 }), {
      rows: [
        { id: 1, name: 'Ann', avatar: { $base64: '/wAQ' } },
        { id: 2, name: 'Bo "b"', avatar: null },
      ],
      last: 2,
    });
    assert.deepEqual(await run({ op: 'page', table: 'users', after: 2, limit: 2 }), {
      rows: [{ id: 3, name: 'Cy', avatar: { $base64: 'AQI=' } }],
      last: 3,
    });
    assert.deepEqual(await run({ op: 'page', table: 'kv', offset: 0, limit: 5, noRowid: true }), {
      rows: [{ k: 'a', v: { $bigint: '9007199254740993' } }],
    });
  });

  test('base64 matches Node for every padding case', async () => {
    for (const bytes of [[], [1], [1, 2], [1, 2, 3], [250, 251, 252, 253]]) {
      const run = loadExporter({ t: { sql: '', rows: [{ b: new Uint8Array(bytes) }] } });
      const page = (await run({ op: 'page', table: 't', after: 0, limit: 1 })) as {
        rows: { b: { $base64: string } }[];
      };
      assert.equal(page.rows[0]?.b.$base64, Buffer.from(bytes).toString('base64'));
    }
  });

  test('quotes table names', async () => {
    const queries: string[] = [];
    const run = loadExporter({ 'we"ird': { sql: '', rows: [] } }, queries);
    await run({ op: 'page', table: 'we"ird', after: 0, limit: 1 });
    assert.match(queries[0] ?? '', /FROM "we""ird"/);
  });
});

function exporterPlatform(fail?: (input: Record<string, unknown>) => ApiError | undefined) {
  const exporter = loadExporter(tables);
  return new FakePlatform(
    { revision: 3, modules: { schema: 'export const users = 1;' } },
    async (call) => {
      assert.equal(call.module, BACKUP_MODULE);
      assert.equal(call.idempotent, true);
      const error = fail?.(call.args);
      if (error) return { ok: false, error, logs: [] };
      return { ok: true, value: await exporter(call.args), logs: [] };
    },
  );
}

describe('backup job', () => {
  test('writes one NDJSON file per table, the schema and a manifest', async () => {
    const platform = exporterPlatform();
    const sink = new MemorySink();
    const d = deps(platform, { backupSink: () => sink });
    const outcome = await runJob(backupJob({ args: { pageSize: 2 } }), d);
    assert.equal(outcome.ok, true);

    assert.equal(
      sink.files.get('users.ndjson'),
      [
        '{"id":1,"name":"Ann","avatar":{"$base64":"/wAQ"}}',
        '{"id":2,"name":"Bo \\"b\\"","avatar":null}',
        '{"id":3,"name":"Cy","avatar":{"$base64":"AQI="}}',
        '',
      ].join('\n'),
    );
    assert.equal(sink.files.get('kv.ndjson'), '{"k":"a","v":{"$bigint":"9007199254740993"}}\n');
    assert.equal(sink.files.get('schema.js'), 'export const users = 1;');

    const manifest = JSON.parse(sink.files.get('manifest.json') ?? '{}');
    assert.equal(manifest.app, 'app123');
    assert.deepEqual(manifest.files['users.ndjson'], {
      table: 'users',
      rows: 3,
      bytes: sink.files.get('users.ndjson')?.length,
      sha256: 'sha-of-users.ndjson',
    });

    const end = d.events.at(-1);
    assert.ok(end?.type === 'end');
    assert.deepEqual(end.value, { location: 'mem://backup', tables: 2, rows: 4 });
    // users: pages of 2 -> [2, 1]; kv: [1]; plus the table list.
    assert.equal(platform.runs.length, 4);
  });

  test('uses the configured table list without querying sqlite_master', async () => {
    const platform = exporterPlatform();
    const sink = new MemorySink();
    await runJob(
      backupJob({ args: { tables: ['users'] } }),
      deps(platform, { backupSink: () => sink }),
    );
    assert.equal(platform.runs[0]?.args.op, 'page');
    assert.deepEqual([...sink.files.keys()].sort(), ['manifest.json', 'schema.js', 'users.ndjson']);
  });

  test('halves the page size when a page hits a limit', async () => {
    const platform = exporterPlatform((input) =>
      input.op === 'page' && (input.limit as number) > 1
        ? new ApiError('request', 'CPU timer exceeded', 400)
        : undefined,
    );
    const sink = new MemorySink();
    const d = deps(platform, { backupSink: () => sink });
    const outcome = await runJob(backupJob({ args: { tables: ['users'], pageSize: 4 } }), d);
    assert.equal(outcome.ok, true);
    assert.equal(sink.files.get('users.ndjson')?.split('\n').length, 4);
    assert.ok(
      d.events.some((e) => e.type === 'progress' && /retrying with 2 rows/.test(e.message)),
    );
  });

  test('fails with the table name on other errors', async () => {
    const platform = exporterPlatform(() => new ApiError('request', 'no such table: users', 400));
    const outcome = await runJob(
      backupJob({ args: { tables: ['users'] } }),
      deps(platform, { backupSink: () => new MemorySink() }),
    );
    assert.equal(outcome.ok, false);
    assert.match(
      outcome.error?.message ?? '',
      /backup of table "users" failed after 0 rows: no such table/,
    );
  });
});

describe('tableFileName', () => {
  test('keeps safe names and rewrites the rest', () => {
    const used = new Set<string>();
    assert.equal(tableFileName('users', used), 'users');
    assert.equal(tableFileName('../evil', used), '___evil');
    assert.equal(tableFileName('my table', used), 'my_table');
    assert.equal(tableFileName('', used), 'table');
  });

  test('avoids collisions, case-insensitively, and the reserved names', () => {
    const used = new Set<string>(['schema', 'manifest']);
    assert.equal(tableFileName('Users', used), 'Users');
    assert.equal(tableFileName('users', used), 'users-2');
    assert.equal(tableFileName('a b', used), 'a_b');
    assert.equal(tableFileName('a_b', used), 'a_b-2');
    assert.equal(tableFileName('schema', used), 'schema-2');
  });
});
