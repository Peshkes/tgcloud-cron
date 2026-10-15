import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { generateCloudflare } from '../../src/adapters/cloudflare/worker.js';
import { type Config, validateConfig } from '../../src/core/config.js';
import { parseJsonc } from '../../src/core/jsonc.js';
import { assertGolden } from '../helpers/golden.js';

function config(jobs: Record<string, unknown>): Config {
  const r = validateConfig({ jobs });
  if (!r.ok) assert.fail(JSON.stringify(r.problems));
  return r.config;
}

const options = { version: '0.1.0', compatibilityDate: '2026-10-01' };

describe('generateCloudflare', () => {
  const files = generateCloudflare(
    config({
      dailyDigest: { schedule: '0 9 * * *' },
      syncPrices: { schedule: '* * * * *', args: { currency: 'USD' } },
      backup: { schedule: '30 2 * * *', use: 'tgcloud-cron/backup' },
      paused: { schedule: '0 3 * * *', enabled: false },
    }),
    options,
  );
  const byPath = Object.fromEntries(files.map((f) => [f.path, f.content]));

  test('writes three files', () => {
    assert.deepEqual(Object.keys(byPath).sort(), [
      'cloudflare/package.json',
      'cloudflare/worker.js',
      'cloudflare/wrangler.jsonc',
    ]);
    for (const f of files) assertGolden(`${f.path.replace('/', '-')}`, f.content);
  });

  test('lists crons of enabled module jobs only', () => {
    const wrangler = parseJsonc(byPath['cloudflare/wrangler.jsonc'] ?? '') as {
      triggers: { crons: string[] };
    };
    assert.deepEqual(wrangler.triggers.crons, ['0 9 * * *', '* * * * *']);
  });

  test('embeds a job table that validates', () => {
    const source = byPath['cloudflare/worker.js'] ?? '';
    const table = JSON.parse(/const jobs = (\{[\s\S]*?\n\});/.exec(source)?.[1] ?? 'null');
    assert.deepEqual(Object.keys(table), ['dailyDigest', 'syncPrices']);
    assert.equal(validateConfig({ jobs: table }).ok, true);
  });

  test('rejects an invalid Worker name', () => {
    assert.throws(
      () => generateCloudflare(config({}), { ...options, name: 'Bad_Name' }),
      /invalid Worker name/,
    );
  });
});
