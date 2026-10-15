import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { FetchLike } from 'tgcloud-api';
import { BACKUP_MODULE } from 'tgcloud-backup';
import { EXIT, type Io, runCli } from '../src/cli/cli.js';
import { loadExporter } from './helpers/exporter.js';

const EXAMPLE = '../../examples/basic';
const WORKFLOW = '.github/workflows/tgcron.yml';

function io(cwd: string, overrides: Partial<Io> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const value: Io = {
    cwd,
    env: {},
    stdout: (l) => void out.push(l),
    stderr: (l) => void err.push(l),
    fetch: async () => assert.fail('no network in this test'),
    now: () => new Date('2026-10-16T09:00:20Z'),
    version: '0.1.0',
    ...overrides,
  };
  return { io: value, out, err };
}

/** A management API backed by the example's local files and an in-memory exporter. */
function platform(
  dir: string,
  requests: { path: string; body: Record<string, unknown> }[],
): FetchLike {
  const exporter = loadExporter({ subscribers: [{ chat_id: 1 }, { chat_id: 2 }] });
  return async (url, init) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : {};
    requests.push({ path, body });
    const reply = (result: unknown) => ({
      status: 200,
      text: async () => JSON.stringify({ ok: true, result }),
    });
    if (path.endsWith('/get')) {
      return reply({
        revision: 5,
        canonical_modules: {
          schema: readFileSync(join(dir, 'tgcloud/schema.js'), 'utf8'),
          'lib/cron/dailyDigest': readFileSync(
            join(dir, 'tgcloud/lib/cron/dailyDigest.js'),
            'utf8',
          ),
        },
      });
    }
    if (body.module === BACKUP_MODULE)
      return reply({ result: await exporter(body.args), log: [], time: 0.01 });
    return reply({
      result: { sent: 2 },
      log: [{ _: 'log', t: 0.003, m: 'hello', o: 'lib/cron/dailyDigest:9' }],
      time: 0.2,
    });
  };
}

describe('end to end on examples/basic', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'tgcron-e2e-'));
    cpSync(EXAMPLE, dir, { recursive: true });
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('generate github reproduces the committed workflow', async () => {
    rmSync(join(dir, WORKFLOW), { force: true });
    const { io: env, out } = io(dir);
    assert.equal(await runCli(['generate', 'github'], env), EXIT.ok);
    assert.ok(out.includes(`wrote ${WORKFLOW}`));
    assert.equal(
      readFileSync(join(dir, WORKFLOW), 'utf8'),
      readFileSync(join(EXAMPLE, WORKFLOW), 'utf8'),
    );
  });

  test('check passes and lists next runs', async () => {
    const { io: env, out } = io(dir);
    assert.equal(await runCli(['check'], env), EXIT.ok, out.join('\n'));
    assert.ok(out.includes('  next: 2026-10-17T09:00Z, 2026-10-18T09:00Z, 2026-10-19T09:00Z'));
    assert.equal(out.at(-1), 'ok');
  });

  test('check fails when the workflow is stale', async () => {
    const config = join(dir, 'tgcron.json');
    const original = readFileSync(config, 'utf8');
    writeFileSync(config, original.replace('"0 9 * * *"', '"0 10 * * *"'));
    try {
      const { io: env, out } = io(dir);
      assert.equal(await runCli(['check'], env), EXIT.usage);
      assert.ok(out.some((l) => l.includes(`${WORKFLOW} is out of date`)));
    } finally {
      writeFileSync(config, original);
    }
  });

  test('generate cloudflare refuses the backup job', async () => {
    const { io: env, err } = io(dir);
    assert.equal(await runCli(['generate', 'cloudflare'], env), EXIT.usage);
    assert.ok(err.some((l) => /backup: backup jobs write files/.test(l)));
    assert.equal(existsSync(join(dir, 'cloudflare')), false);
  });

  test('tick runs the jobs of the schedule that fired', async () => {
    const requests: { path: string; body: Record<string, unknown> }[] = [];
    const { io: env, out } = io(dir, {
      env: { TGCLOUD_TOKEN: 'app77:secret-value' },
      fetch: platform(dir, requests),
    });
    assert.equal(await runCli(['tick', '--schedule', '0 9 * * *'], env), EXIT.ok);
    assert.deepEqual(
      requests.map((r) => r.path),
      ['/app77/manage/get', '/app77/manage/run'],
    );
    const args = requests[1]?.body.args as { args: unknown; tick: { scheduledAt: string } };
    assert.deepEqual(args.args, { limit: 200 });
    assert.equal(args.tick.scheduledAt, '2026-10-16T09:00:00.000Z');
    const log = out.join('\n');
    assert.match(
      log,
      /\[dailyDigest \w{8}\] start {3}scheduled 2026-10-16T09:00:00\.000Z, deployed code, revision 5/,
    );
    assert.match(
      log,
      /\[dailyDigest \w{8}\] {3}log {3}hello {2}\+3ms {2}\[lib\/cron\/dailyDigest:9\]/,
    );
    assert.match(log, /\[dailyDigest \w{8}\] ok {6}\{"sent":2\} {2}platform 200ms/);
    assert.doesNotMatch(log, /secret-value/);
  });

  test('run --local sends local files', async () => {
    const requests: { path: string; body: Record<string, unknown> }[] = [];
    const { io: env } = io(dir, {
      env: { TGCLOUD_TOKEN: 'app77:secret-value' },
      fetch: platform(dir, requests),
    });
    assert.equal(await runCli(['run', 'syncPrices', '--local'], env), EXIT.ok);
    assert.equal(requests.length, 1);
    const sources = requests[0]?.body.sources as Record<string, string>;
    assert.ok(sources['lib/cron/syncPrices']);
    assert.ok(sources['handlers/message']);
  });

  test('backup writes NDJSON and a manifest under tgcron-backup/', async () => {
    const requests: { path: string; body: Record<string, unknown> }[] = [];
    const { io: env, out } = io(dir, {
      env: { TGCLOUD_TOKEN: 'app77:secret-value' },
      fetch: platform(dir, requests),
    });
    assert.equal(await runCli(['run', 'backup'], env), EXIT.ok, out.join('\n'));
    const base = join(dir, 'tgcron-backup/backup');
    const [stamp] = readdirSync(base);
    assert.equal(stamp, '2026-10-16T09-00-20Z');
    const files = readdirSync(join(base, stamp ?? '')).sort();
    assert.deepEqual(files, ['manifest.json', 'schema.js', 'subscribers.ndjson']);
    assert.equal(
      readFileSync(join(base, stamp ?? '', 'subscribers.ndjson'), 'utf8'),
      '{"chat_id":1}\n{"chat_id":2}\n',
    );
    const manifest = JSON.parse(readFileSync(join(base, stamp ?? '', 'manifest.json'), 'utf8'));
    assert.match(manifest.files['subscribers.ndjson'].sha256, /^[0-9a-f]{64}$/);
  });

  test('run without a token exits with the auth code', async () => {
    const { io: env, err } = io(dir);
    assert.equal(await runCli(['run', 'dailyDigest'], env), EXIT.auth);
    assert.match(err.join('\n'), /TGCLOUD_TOKEN is not set/);
  });

  test('a failing job exits 1 and annotates in GitHub Actions', async () => {
    const summary = join(dir, 'summary.md');
    const fetch: FetchLike = async (url) => ({
      status: url.endsWith('/get') ? 200 : 400,
      text: async () =>
        JSON.stringify(
          url.endsWith('/get')
            ? {
                ok: true,
                result: { revision: 1, canonical_modules: { 'lib/cron/dailyDigest': 'x' } },
              }
            : { ok: false, error_code: 400, description: 'ReferenceError: x is not defined' },
        ),
    });
    const { io: env, out } = io(dir, {
      env: { TGCLOUD_TOKEN: 'app77:s', GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary },
      fetch,
    });
    assert.equal(await runCli(['run', 'dailyDigest'], env), EXIT.jobFailed);
    assert.ok(
      out.includes('::error title=tgcron job dailyDigest failed::ReferenceError: x is not defined'),
    );
    assert.match(readFileSync(summary, 'utf8'), /\| dailyDigest \| \w{8} \| failed \|/);
  });

  test('unknown schedule warns and succeeds', async () => {
    const { io: env, err } = io(dir, { env: { TGCLOUD_TOKEN: 'app77:s' } });
    assert.equal(await runCli(['tick', '--schedule', '0 4 * * *'], env), EXIT.ok);
    assert.match(err.join('\n'), /no enabled job has schedule "0 4 \* \* \*"/);
  });

  test('usage errors exit 2', async () => {
    for (const argv of [
      ['bogus'],
      ['run'],
      ['generate', 'aws'],
      ['tick'],
      ['tick', '--schedule', 'x'],
      ['--nope'],
    ]) {
      const { io: env } = io(dir);
      assert.equal(await runCli(argv, env), EXIT.usage, argv.join(' '));
    }
  });

  test('init creates files once', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'tgcron-init-'));
    try {
      const first = io(empty);
      assert.equal(await runCli(['init'], first.io), EXIT.ok);
      assert.ok(first.out.includes('created  tgcron.json'));
      assert.ok(first.out.includes('created  tgcloud/lib/cron/example.js'));
      const second = io(empty);
      await runCli(['init'], second.io);
      assert.ok(second.out.includes('exists   tgcron.json'));
      const check = io(empty);
      assert.equal(await runCli(['check'], check.io), EXIT.ok, check.out.join('\n'));
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
