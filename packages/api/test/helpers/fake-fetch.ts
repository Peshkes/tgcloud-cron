import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FetchLike } from '../../src/client.js';

export interface Exchange {
  request: { method: string; path: string };
  response: { status: number; body?: unknown; text?: string };
}

export interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export function loadFixture(name: string): Exchange[] {
  // Tests run from the repository root; fixtures are not copied by tsc.
  return JSON.parse(readFileSync(join('test/fixtures/api', `${name}.json`), 'utf8'));
}

/** A fetch that replays exchanges in order and records what it was sent. */
export function replay(exchanges: Exchange[]): { fetch: FetchLike; calls: Recorded[] } {
  const queue = [...exchanges];
  const calls: Recorded[] = [];
  const fetch: FetchLike = async (url, init) => {
    const next = queue.shift();
    assert.ok(next, `unexpected request ${init.method} ${url}`);
    const { pathname } = new URL(url);
    assert.equal(`${init.method} ${pathname}`, `${next.request.method} ${next.request.path}`);
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    });
    const text = next.response.text ?? JSON.stringify(next.response.body);
    return { status: next.response.status, text: async () => text };
  };
  return { fetch, calls };
}

export const TEST_TOKEN = 'app123:test-secret';
export const noSleep = async () => {};
