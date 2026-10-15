import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ApiError } from '../../src/adapters/tgcloud/client.js';
import { ENTRY_MODULE } from '../../src/adapters/tgcloud/entry.js';
import { runJob, runTick } from '../../src/app/run.js';
import { type Config, validateConfig } from '../../src/core/config.js';
import { deps, FakePlatform } from '../helpers/fake-platform.js';

function config(jobs: Record<string, unknown>): Config {
  const r = validateConfig({ jobs });
  if (!r.ok) assert.fail(JSON.stringify(r.problems));
  return r.config;
}

const deployed = {
  revision: 7,
  modules: {
    schema: 'export {}',
    'lib/cron/digest': 'export default () => 1',
    'lib/cron/prices': 'export default () => 2',
  },
};

const cfg = config({
  digest: { schedule: '0 9 * * *', args: { lang: 'en' } },
  prices: { schedule: '0 9 * * *' },
  other: { schedule: '0 10 * * *' },
});

describe('runJob', () => {
  test('runs the deployed module through a synthetic entry', async () => {
    const platform = new FakePlatform(deployed, () => ({
      ok: true,
      value: { sent: 3 },
      time: 0.2,
      logs: [{ level: 'log', t: 0.01, message: 'hi', truncated: false }],
    }));
    const d = deps(platform);
    const job = cfg.jobs[0];
    assert.ok(job);
    const outcome = await runJob(job, d, { scheduledAt: new Date('2026-10-16T09:00:00Z') });

    assert.equal(outcome.ok, true);
    const call = platform.runs[0];
    assert.equal(call?.module, ENTRY_MODULE);
    assert.equal(call?.idempotent, false);
    assert.match(
      call?.sources[ENTRY_MODULE] ?? '',
      /import job from '\.\.\/lib\/cron\/digest\.js'/,
    );
    assert.equal(call?.sources['lib/cron/digest'], deployed.modules['lib/cron/digest']);
    assert.deepEqual(call?.args, {
      args: { lang: 'en' },
      tick: { job: 'digest', runId: 'r1', scheduledAt: '2026-10-16T09:00:00.000Z' },
    });
    assert.deepEqual(
      d.events.map((e) => e.type),
      ['start', 'log', 'end'],
    );
    assert.deepEqual(d.events[0], {
      type: 'start',
      job: 'digest',
      runId: 'r1',
      scheduledAt: '2026-10-16T09:00:00.000Z',
      code: 'deployed',
      revision: 7,
    });
    const end = d.events[2];
    assert.ok(end?.type === 'end');
    assert.equal(end.ok, true);
    assert.deepEqual(end.value, { sent: 3 });
    assert.equal(end.platformTime, 0.2);
  });

  test('uses local modules when given', async () => {
    const platform = new FakePlatform(deployed, () => ({ ok: true, value: null, logs: [] }));
    const job = cfg.jobs[0];
    assert.ok(job);
    await runJob(job, deps(platform), { localModules: { 'lib/cron/digest': 'local code' } });
    assert.equal(platform.getCalls, 0);
    assert.equal(platform.runs[0]?.sources['lib/cron/digest'], 'local code');
  });

  test('fails without calling /run when the module is not deployed', async () => {
    const platform = new FakePlatform({ revision: 1, modules: {} }, () => assert.fail('no run'));
    const d = deps(platform);
    const job = cfg.jobs[0];
    assert.ok(job);
    const outcome = await runJob(job, d);
    assert.equal(outcome.ok, false);
    assert.match(outcome.error?.message ?? '', /lib\/cron\/digest not found in the deployed code/);
  });

  test('reports a job error', async () => {
    const platform = new FakePlatform(deployed, () => ({
      ok: false,
      error: new ApiError('request', 'TypeError: x', 400),
      logs: [],
    }));
    const d = deps(platform);
    const job = cfg.jobs[0];
    assert.ok(job);
    const outcome = await runJob(job, d);
    assert.equal(outcome.ok, false);
    const end = d.events.at(-1);
    assert.ok(end?.type === 'end');
    assert.equal(end.error, 'TypeError: x');
  });

  test('refuses to shadow a real module with the entry name', async () => {
    const platform = new FakePlatform(
      { revision: 1, modules: { ...deployed.modules, [ENTRY_MODULE]: 'mine' } },
      () => assert.fail('no run'),
    );
    const job = cfg.jobs[0];
    assert.ok(job);
    const outcome = await runJob(job, deps(platform));
    assert.match(outcome.error?.message ?? '', /reserves this name/);
  });

  test('rethrows auth errors after reporting them', async () => {
    const platform = new FakePlatform(deployed, () => {
      throw new ApiError('auth', 'Unauthorized', 401);
    });
    const d = deps(platform);
    const job = cfg.jobs[0];
    assert.ok(job);
    await assert.rejects(
      runJob(job, d),
      (err: unknown) => err instanceof ApiError && err.kind === 'auth',
    );
    assert.equal(d.events.at(-1)?.type, 'end');
  });
});

describe('runTick', () => {
  test('runs matching jobs in order with one /get', async () => {
    const platform = new FakePlatform(deployed, () => ({ ok: true, value: 1, logs: [] }));
    const result = await runTick(cfg, '0 9 * * *', deps(platform), null);
    assert.deepEqual(
      result.outcomes.map((o) => [o.job, o.ok]),
      [
        ['digest', true],
        ['prices', true],
      ],
    );
    assert.equal(platform.getCalls, 1);
  });

  test('continues after a job failure', async () => {
    let n = 0;
    const platform = new FakePlatform(deployed, () =>
      n++ === 0
        ? { ok: false, error: new ApiError('request', 'boom', 400), logs: [] }
        : { ok: true, value: 1, logs: [] },
    );
    const result = await runTick(cfg, '0 9 * * *', deps(platform), null);
    assert.deepEqual(
      result.outcomes.map((o) => o.ok),
      [false, true],
    );
  });

  test('stops on an auth error', async () => {
    const platform = new FakePlatform(deployed, () => {
      throw new ApiError('auth', 'Unauthorized', 401);
    });
    const result = await runTick(cfg, '0 9 * * *', deps(platform), null);
    assert.equal(result.outcomes.length, 0);
    assert.equal(result.fatal?.kind, 'auth');
    assert.equal(platform.runs.length, 1);
  });

  test('does nothing for an unknown schedule', async () => {
    const platform = new FakePlatform(deployed, () => assert.fail('no run'));
    const result = await runTick(cfg, '1 2 3 4 5', deps(platform), null);
    assert.deepEqual(result.outcomes, []);
    assert.equal(platform.getCalls, 0);
  });
});
