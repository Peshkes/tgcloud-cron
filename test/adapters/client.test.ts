import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ApiError, appIdFromToken, TgcloudClient } from '../../src/adapters/tgcloud/client.js';
import { loadFixture, noSleep, replay, TEST_TOKEN } from '../helpers/fake-fetch.js';

function client(fixture: string, extra: { sleep?: (ms: number) => Promise<void> } = {}) {
  const fake = replay(loadFixture(fixture));
  const c = new TgcloudClient({
    token: TEST_TOKEN,
    fetch: fake.fetch,
    sleep: extra.sleep ?? noSleep,
  });
  return { c, calls: fake.calls };
}

describe('token', () => {
  test('exposes only the app id', () => {
    assert.equal(appIdFromToken('app42:s3cr3t'), 'app42');
  });

  test('rejects a malformed token without echoing it', () => {
    for (const bad of ['', 'app42', '42:secret', 'app42:se cret', 'bot42:secret']) {
      assert.throws(
        () => appIdFromToken(bad),
        (err: unknown) =>
          err instanceof ApiError && err.kind === 'auth' && !(bad && err.message.includes(bad)),
      );
    }
  });
});

describe('getDeployed', () => {
  test('sends GET /app<id>/manage/get with the bearer token', async () => {
    const { c, calls } = client('get-ok');
    const deployed = await c.getDeployed();
    assert.equal(deployed.revision, 41);
    assert.deepEqual(Object.keys(deployed.modules).sort(), [
      'handlers/message',
      'lib/cron/dailyDigest',
      'schema',
    ]);
    assert.equal(calls[0]?.url, 'https://cloud.telegram.org/app123/manage/get');
    assert.equal(calls[0]?.headers.Authorization, `Bearer ${TEST_TOKEN}`);
    assert.equal(calls[0]?.body, undefined);
  });

  test('honours a custom base URL', async () => {
    const fake = replay(loadFixture('get-ok'));
    const c = new TgcloudClient({
      token: TEST_TOKEN,
      fetch: fake.fetch,
      baseUrl: 'http://localhost:9/',
    });
    await c.getDeployed();
    assert.equal(fake.calls[0]?.url, 'http://localhost:9/app123/manage/get');
  });

  test('maps 401 to an auth error', async () => {
    const { c } = client('auth-401');
    await assert.rejects(c.getDeployed(), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.kind, 'auth');
      assert.equal(err.status, 401);
      assert.equal(err.message, 'Unauthorized: token revoked');
      return true;
    });
  });

  test('retries a 5xx with a non-JSON body', async () => {
    const waits: number[] = [];
    const { c, calls } = client('get-502-html', { sleep: async (ms) => void waits.push(ms) });
    const deployed = await c.getDeployed();
    assert.equal(deployed.revision, 1);
    assert.equal(calls.length, 2);
    assert.deepEqual(waits, [1000]);
  });

  test('wraps network failures', async () => {
    const c = new TgcloudClient({
      token: TEST_TOKEN,
      maxRetries: 1,
      sleep: noSleep,
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await assert.rejects(c.getDeployed(), (err: unknown) => {
      return (
        err instanceof ApiError &&
        err.kind === 'network' &&
        /GET \/get: fetch failed/.test(err.message)
      );
    });
  });

  test('rejects an unexpected response shape', async () => {
    const c = new TgcloudClient({
      token: TEST_TOKEN,
      fetch: async () => ({ status: 200, text: async () => '{"hello":1}' }),
    });
    await assert.rejects(
      c.getDeployed(),
      (err: unknown) => err instanceof ApiError && err.kind === 'protocol',
    );
  });
});

describe('run', () => {
  test('sends module, sources, args and ctx', async () => {
    const { c, calls } = client('run-ok');
    const result = await c.run('endpoints/x', { 'endpoints/x': 'code' }, { a: 1 });
    assert.deepEqual(calls[0]?.body, {
      module: 'endpoints/x',
      sources: { 'endpoints/x': 'code' },
      args: { a: 1 },
      ctx: {},
    });
    assert.equal(calls[0]?.headers['Content-Type'], 'application/json');
    assert.deepEqual(result, {
      ok: true,
      value: { sent: 42 },
      time: 0.84,
      logs: [
        {
          level: 'log',
          t: 0.004,
          message: 'sending to 42 chats',
          truncated: false,
          origin: 'lib/cron/dailyDigest:18',
        },
        {
          level: 'wrn',
          t: 0.31,
          message: 'slow chat 1001',
          truncated: true,
          origin: 'lib/cron/dailyDigest:25',
        },
      ],
    });
  });

  test('returns a job error with its logs, stripped of control characters', async () => {
    const { c } = client('run-job-error');
    const result = await c.run('endpoints/x', {}, {});
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.kind, 'request');
    assert.equal(result.error.details.type, 'RUNTIME_ERROR');
    assert.equal(
      result.error.message,
      "TypeError: Cannot read properties of undefined (reading 'id') [31m",
    );
    assert.equal(result.time, 0.021);
    assert.equal(result.logs[0]?.message, 'about to fail\nat line 3');
  });

  test('treats { __error } in the result as a failure', async () => {
    const { c } = client('run-error-in-result');
    const result = await c.run('endpoints/x', {}, {});
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error.message, 'boom');
  });

  test('retries 429 using retry_after', async () => {
    const waits: number[] = [];
    const { c, calls } = client('run-429-then-ok', { sleep: async (ms) => void waits.push(ms) });
    const result = await c.run('endpoints/x', {}, {});
    assert.equal(result.ok, true);
    assert.equal(calls.length, 2);
    assert.deepEqual(waits, [2000]);
  });

  test('does not retry a 5xx, because the job may already have run', async () => {
    const { c, calls } = client('run-502');
    await assert.rejects(c.run('endpoints/x', {}, {}), (err: unknown) => {
      return err instanceof ApiError && err.kind === 'server' && err.transient;
    });
    assert.equal(calls.length, 1);
  });
});
