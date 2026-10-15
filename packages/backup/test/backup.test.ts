import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ApiError, type Deployed, type Platform, type RunResult } from 'tgcloud-api';
import { type BackupSink, runBackup, tableFileName } from '../src/backup.js';
import { BACKUP_MODULE } from '../src/exporter.js';
import { type Exporter, loadExporter, sqlite } from './helpers/exporter.js';

const SCHEMA = `
  CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, avatar BLOB, big INTEGER);
  CREATE TABLE kv (k TEXT PRIMARY KEY, v INTEGER) WITHOUT ROWID;
  CREATE TABLE odd (id INTEGER PRIMARY KEY, rowid TEXT);
  CREATE TABLE "we""ird" (x INTEGER);
  INSERT INTO users VALUES (-5, 'neg', NULL, NULL), (0, 'zero', NULL, NULL),
    (1, 'Ann', X'FF0010', 9007199254740993), (2, 'Bo "b"', X'0102', NULL);
  INSERT INTO kv VALUES ('a', 1), ('b', 2), ('c', 3);
  INSERT INTO odd VALUES (1, 'a'), (2, NULL), (3, 'b');
  INSERT INTO "we""ird" VALUES (7);
`;
const live = sqlite(SCHEMA);
const skip = live ? false : 'node:sqlite is not available on this Node version';

class MemorySink implements BackupSink {
  readonly location = 'mem://backup';
  readonly files = new Map<string, string>();
  open(name: string) {
    let text = '';
    return {
      append: async (chunk: string) => {
        text += chunk;
      },
      close: async () => {
        this.files.set(name, text);
        return { bytes: text.length, sha256: `sha-of-${name}` };
      },
    };
  }
  lines(name: string): unknown[] {
    return (this.files.get(name) ?? '')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }
}

class ExporterPlatform implements Platform {
  readonly appId = 'app123';
  readonly calls: Record<string, unknown>[] = [];
  constructor(
    private readonly exporter: Exporter,
    private readonly fail?: (input: Record<string, unknown>) => ApiError | undefined,
    readonly modules: Record<string, string> = { schema: 'export const users = 1;' },
  ) {}
  async getDeployed(): Promise<Deployed> {
    return { revision: 3, modules: this.modules };
  }
  async run(
    module: string,
    sources: Readonly<Record<string, string>>,
    args: Record<string, unknown>,
    options: { idempotent?: boolean } = {},
  ): Promise<RunResult> {
    assert.equal(module, BACKUP_MODULE);
    assert.ok(sources[BACKUP_MODULE]);
    assert.equal(options.idempotent, true);
    this.calls.push(args);
    const error = this.fail?.(args);
    if (error) {
      if (error.kind !== 'request') throw error;
      return { ok: false, error, logs: [] };
    }
    try {
      return { ok: true, value: await this.exporter(args), logs: [] };
    } catch (err) {
      return { ok: false, error: new ApiError('request', (err as Error).message, 400), logs: [] };
    }
  }
}

describe('exporter on real SQLite', { skip }, () => {
  const exporter = loadExporter(live?.db ?? { all: async () => [] });

  test('lists tables with the name that reaches the rowid', async () => {
    assert.deepEqual(await exporter({ op: 'tables' }), [
      { name: 'kv', rowid: null },
      { name: 'odd', rowid: '_rowid_' },
      { name: 'users', rowid: 'rowid' },
      { name: 'we"ird', rowid: 'rowid' },
    ]);
  });

  test('exports every row, including rowid <= 0, with tagged values', async () => {
    const sink = new MemorySink();
    await runBackup({
      platform: new ExporterPlatform(exporter),
      sink,
      tables: ['users'],
      pageSize: 1,
    });
    assert.deepEqual(sink.lines('users.ndjson'), [
      { id: -5, name: 'neg', avatar: null, big: null },
      { id: 0, name: 'zero', avatar: null, big: null },
      { id: 1, name: 'Ann', avatar: { $base64: '/wAQ' }, big: { $bigint: '9007199254740993' } },
      { id: 2, name: 'Bo "b"', avatar: { $base64: 'AQI=' }, big: null },
    ]);
  });

  test('pages a table whose own column is called rowid', async () => {
    const sink = new MemorySink();
    await runBackup({
      platform: new ExporterPlatform(exporter),
      sink,
      tables: ['odd'],
      pageSize: 1,
    });
    assert.deepEqual(sink.lines('odd.ndjson'), [
      { id: 1, rowid: 'a' },
      { id: 2, rowid: null },
      { id: 3, rowid: 'b' },
    ]);
  });

  test('pages WITHOUT ROWID tables by offset, also when listed explicitly', async () => {
    const sink = new MemorySink();
    await runBackup({
      platform: new ExporterPlatform(exporter),
      sink,
      tables: ['kv'],
      pageSize: 2,
    });
    assert.equal(sink.lines('kv.ndjson').length, 3);
  });

  test('writes every table with safe file names and a manifest', async () => {
    const sink = new MemorySink();
    const progress: string[] = [];
    const summary = await runBackup({
      platform: new ExporterPlatform(exporter),
      sink,
      onProgress: (m) => progress.push(m),
      now: () => new Date('2026-10-16T02:30:00Z'),
    });
    assert.deepEqual(summary, { location: 'mem://backup', tables: 4, rows: 11 });
    assert.deepEqual([...sink.files.keys()].sort(), [
      'kv.ndjson',
      'manifest.json',
      'odd.ndjson',
      'schema.js',
      'users.ndjson',
      'we_ird.ndjson',
    ]);
    const manifest = JSON.parse(sink.files.get('manifest.json') ?? '');
    assert.equal(manifest.format, 'tgcloud-backup@1');
    assert.equal(manifest.app, 'app123');
    assert.deepEqual(manifest.files['we_ird.ndjson'], {
      table: 'we"ird',
      rows: 1,
      bytes: 8,
      sha256: 'sha-of-we_ird.ndjson',
    });
    assert.match(progress[0] ?? '', /found 4 table\(s\)/);
  });
});

function fakeDb(rows: number) {
  // Just enough SQL for the paging logic: tables, and rowid pages.
  return loadExporter({
    async all(sql, params = {}) {
      if (sql.includes('sqlite_master')) return [{ name: 't', sql: 'CREATE TABLE t (x)' }];
      if (sql.includes('pragma_table_info')) return [{ name: 'x' }];
      const after =
        params[':after'] === undefined ? Number.NEGATIVE_INFINITY : Number(params[':after']);
      const limit = Number(params[':limit']);
      return Array.from({ length: rows }, (_, i) => ({ __tgbackup_rowid: i + 1, x: i + 1 }))
        .filter((r) => r.__tgbackup_rowid > after)
        .slice(0, limit);
    },
  });
}

describe('runBackup', () => {
  test('halves the page size when a page hits a limit', async () => {
    const platform = new ExporterPlatform(fakeDb(5), (input) =>
      input.op === 'page' && (input.limit as number) > 2
        ? new ApiError('request', 'CPU timer exceeded', 400)
        : undefined,
    );
    const sink = new MemorySink();
    const progress: string[] = [];
    await runBackup({ platform, sink, pageSize: 8, onProgress: (m) => progress.push(m) });
    assert.equal(sink.lines('t.ndjson').length, 5);
    assert.ok(progress.some((m) => /retrying with 4 rows/.test(m)));
    assert.ok(progress.some((m) => /retrying with 2 rows/.test(m)));
  });

  test('keeps the kind of auth and rate-limit errors', async () => {
    for (const kind of ['auth', 'rate_limit', 'network'] as const) {
      const platform = new ExporterPlatform(fakeDb(3), (input) =>
        input.op === 'page'
          ? new ApiError(kind, 'stop', kind === 'auth' ? 401 : undefined)
          : undefined,
      );
      await assert.rejects(
        runBackup({ platform, sink: new MemorySink() }),
        (err: unknown) => err instanceof ApiError && err.kind === kind,
      );
    }
  });

  test('does not halve on errors that only mention a limit', async () => {
    const platform = new ExporterPlatform(fakeDb(3), (input) =>
      input.op === 'page' ? new ApiError('request', 'no such table: t', 400) : undefined,
    );
    await assert.rejects(
      runBackup({ platform, sink: new MemorySink() }),
      /failed after 0 rows: no such table/,
    );
    assert.equal(platform.calls.length, 2);
  });

  test('stops when the cursor does not advance', async () => {
    const stuck = loadExporter({
      async all(sql) {
        if (sql.includes('sqlite_master')) return [{ name: 't', sql: '' }];
        if (sql.includes('pragma_table_info')) return [];
        return [{ __tgbackup_rowid: 1, x: 1 }];
      },
    });
    await assert.rejects(
      runBackup({ platform: new ExporterPlatform(stuck), sink: new MemorySink(), pageSize: 1 }),
      /cursor did not advance/,
    );
  });

  test('rejects unknown and invalid table names', async () => {
    await assert.rejects(
      runBackup({
        platform: new ExporterPlatform(fakeDb(1)),
        sink: new MemorySink(),
        tables: ['nope'],
      }),
      /table\(s\) not found: nope/,
    );
    await assert.rejects(
      runBackup({
        platform: new ExporterPlatform(fakeDb(1)),
        sink: new MemorySink(),
        tables: ['a;b'],
      }),
      /invalid table name/,
    );
  });

  test('reads deployed modules when not given', async () => {
    const sink = new MemorySink();
    await runBackup({
      platform: new ExporterPlatform(fakeDb(0), undefined, { schema: 'S' }),
      sink,
    });
    assert.equal(sink.files.get('schema.js'), 'S');
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

test('base64 matches Node for every padding case', async () => {
  for (const bytes of [[], [1], [1, 2], [1, 2, 3], [250, 251, 252, 253]]) {
    const run = loadExporter({
      async all(sql) {
        if (sql.includes('sqlite_master')) return [];
        return [{ __tgbackup_rowid: 1, b: new Uint8Array(bytes) }];
      },
    });
    const page = (await run({ op: 'page', table: 't', rowid: 'rowid', after: null, limit: 1 })) as {
      rows: { b: { $base64: string } }[];
    };
    assert.equal(page.rows[0]?.b.$base64, Buffer.from(bytes).toString('base64'));
  }
});
