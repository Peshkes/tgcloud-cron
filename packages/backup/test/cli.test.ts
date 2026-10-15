import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { FetchLike } from 'tgcloud-api';
import { EXIT, type Io, runCli } from '../src/cli.js';
import { loadExporter } from './helpers/exporter.js';

const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
const exporter = loadExporter({
  async all(sql, params = {}) {
    if (sql.includes('sqlite_master')) return [{ name: 'users', sql: 'CREATE TABLE users (id)' }];
    if (sql.includes('pragma_table_info')) return [{ name: 'id' }];
    const after =
      params[':after'] === undefined ? Number.NEGATIVE_INFINITY : Number(params[':after']);
    return rows
      .map((r) => ({ __tgbackup_rowid: r.id, ...r }))
      .filter((r) => r.__tgbackup_rowid > after)
      .slice(0, Number(params[':limit']));
  },
});

function platform(calls: string[], status = 200): FetchLike {
  return async (url, init) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (status !== 200) {
      return {
        status,
        text: async () => JSON.stringify({ ok: false, description: 'Unauthorized' }),
      };
    }
    const body = init.body ? JSON.parse(init.body) : {};
    const result = path.endsWith('/get')
      ? { revision: 1, canonical_modules: { schema: 'S' } }
      : { result: await exporter(body.args), log: [] };
    return { status: 200, text: async () => JSON.stringify({ ok: true, result }) };
  };
}

function io(cwd: string, overrides: Partial<Io> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const value: Io = {
    cwd,
    env: { TGCLOUD_TOKEN: 'app5:secret-value' },
    stdout: (l) => void out.push(l),
    stderr: (l) => void err.push(l),
    fetch: async () => assert.fail('no network'),
    now: () => new Date('2026-10-16T02:30:00Z'),
    version: '0.1.0',
    ...overrides,
  };
  return { io: value, out, err };
}

describe('tgbackup', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'tgbackup-'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('exports to <out>/<timestamp>/', async () => {
    const calls: string[] = [];
    const { io: env, out } = io(dir, { fetch: platform(calls) });
    assert.equal(await runCli(['export', '--out', 'snap', '--page-size', '2'], env), EXIT.ok);
    const target = join(dir, 'snap', '2026-10-16T02-30-00Z');
    assert.deepEqual(readdirSync(target).sort(), ['manifest.json', 'schema.js', 'users.ndjson']);
    assert.equal(
      readFileSync(join(target, 'users.ndjson'), 'utf8'),
      '{"id":1}\n{"id":2}\n{"id":3}\n',
    );
    assert.equal(calls[0], '/app5/manage/get');
    assert.match(
      out.join('\n'),
      /done: 3 row\(s\) from 1 table\(s\) in snap\/2026-10-16T02-30-00Z/,
    );
    assert.doesNotMatch(out.join('\n'), /secret-value/);
  });

  test('prints JSON lines with --json', async () => {
    const { io: env, out } = io(dir, { fetch: platform([]) });
    assert.equal(await runCli(['export', '--json', '--tables', 'users'], env), EXIT.ok);
    const events = out.map((l) => JSON.parse(l));
    assert.equal(events[0].type, 'start');
    assert.equal(events.at(-1).type, 'end');
    assert.equal(events.at(-1).rows, 3);
  });

  test('maps a rejected token to exit code 3', async () => {
    const { io: env, err } = io(dir, { fetch: platform([], 401) });
    assert.equal(await runCli(['export'], env), EXIT.auth);
    assert.match(err.join('\n'), /Unauthorized/);
  });

  test('requires a token', async () => {
    const { io: env } = io(dir, { env: {} });
    assert.equal(await runCli(['export'], env), EXIT.auth);
  });

  test('rejects bad usage', async () => {
    for (const argv of [
      [],
      ['import'],
      ['export', 'x'],
      ['export', '--page-size', '0'],
      ['export', '--tables', 'a;b'],
      ['--nope'],
    ]) {
      const { io: env } = io(dir);
      assert.equal(await runCli(argv, env), EXIT.usage, argv.join(' '));
    }
  });
});
