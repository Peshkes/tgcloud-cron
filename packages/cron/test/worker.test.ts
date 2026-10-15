import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { createScheduledHandler } from '../src/worker.js';

const jobs = { digest: { schedule: '0 9 * * *', module: 'lib/cron/digest' } };

describe('createScheduledHandler', () => {
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  let logged: string[] = [];
  let requests: string[] = [];

  beforeEach(() => {
    logged = [];
    requests = [];
    console.log = (line: string) => void logged.push(line);
    globalThis.fetch = (async (url: string, init: { method: string }) => {
      requests.push(`${init.method} ${url}`);
      const body = url.endsWith('/get')
        ? { ok: true, result: { revision: 2, canonical_modules: { 'lib/cron/digest': 'x' } } }
        : { ok: true, result: { result: { done: true }, log: [], time: 0.1 } };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    console.log = realLog;
  });

  test('rejects an invalid table at load time', () => {
    assert.throws(
      () => createScheduledHandler({ jobs: { a: { schedule: 'nope' } } }),
      /invalid job table/,
    );
  });

  test('runs the jobs for the cron that fired', async () => {
    const handler = createScheduledHandler({ jobs });
    await handler(
      { cron: '0 9 * * *', scheduledTime: Date.parse('2026-10-16T09:00:00Z') },
      { TGCLOUD_TOKEN: 'app5:secret', TG_CLOUD_API_URL: 'https://example.test' },
    );
    assert.deepEqual(requests, [
      'GET https://example.test/app5/manage/get',
      'POST https://example.test/app5/manage/run',
    ]);
    assert.match(logged.join('\n'), /\[digest \w+\] ok {6}\{"done":true\}/);
    assert.doesNotMatch(logged.join('\n'), /secret/);
  });

  test('fails without a token', async () => {
    const handler = createScheduledHandler({ jobs });
    await assert.rejects(
      handler({ cron: '0 9 * * *', scheduledTime: 0 }, {}),
      /TGCLOUD_TOKEN is not set/,
    );
  });
});
