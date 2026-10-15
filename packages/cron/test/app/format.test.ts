import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatEvent, formatEventJson } from '../../src/app/format.js';

test('start, log and end lines', () => {
  assert.deepEqual(
    formatEvent({
      type: 'start',
      job: 'digest',
      runId: '7f3a',
      scheduledAt: '2026-10-16T09:00:00.000Z',
      code: 'deployed',
      revision: 41,
    }),
    ['[digest 7f3a] start   scheduled 2026-10-16T09:00:00.000Z, deployed code, revision 41'],
  );
  assert.deepEqual(
    formatEvent({
      type: 'log',
      job: 'digest',
      runId: '7f3a',
      entry: {
        level: 'wrn',
        t: 0.012,
        message: 'slow',
        truncated: true,
        origin: 'lib/cron/digest:4',
      },
    }),
    ['[digest 7f3a]   warn  slow [truncated]  +12ms  [lib/cron/digest:4]'],
  );
  assert.deepEqual(
    formatEvent({
      type: 'end',
      job: 'digest',
      runId: '7f3a',
      ok: true,
      value: { sent: 42 },
      platformTime: 0.84,
      durationMs: 1310,
    }),
    ['[digest 7f3a] ok      {"sent":42}  platform 840ms, total 1.31s'],
  );
});

test('multi-line messages keep the prefix on every line', () => {
  assert.deepEqual(
    formatEvent({
      type: 'end',
      job: 'j',
      runId: 'r',
      ok: false,
      error: 'Error: x\n  at y',
      durationMs: 50,
    }),
    ['[j r] FAILED  Error: x', '[j r]           at y  total 0.05s'],
  );
});

test('a returned string cannot start a line of its own', () => {
  const lines = formatEvent({
    type: 'end',
    job: 'j',
    runId: 'r',
    ok: true,
    value: 'done\n::error title=x::forged\u001b[2J',
    durationMs: 0,
  });
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.startsWith('[j r]')));
  assert.ok(!lines.join('').includes('\u001b'));
});

test('long values are cut', () => {
  const [line] = formatEvent({
    type: 'end',
    job: 'j',
    runId: 'r',
    ok: true,
    value: 'x'.repeat(500),
    durationMs: 0,
  });
  assert.ok((line?.length ?? 0) < 400);
  assert.match(line ?? '', /\.\.\. {2}total/);
});

test('JSON lines carry a timestamp', () => {
  const line = formatEventJson(
    { type: 'progress', job: 'j', runId: 'r', message: 'm' },
    new Date('2026-10-16T09:00:00Z'),
  );
  assert.deepEqual(JSON.parse(line), {
    ts: '2026-10-16T09:00:00.000Z',
    type: 'progress',
    job: 'j',
    runId: 'r',
    message: 'm',
  });
});
