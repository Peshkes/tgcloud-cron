import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseJsonc } from '../../src/core/jsonc.js';

test('drops comments and trailing commas', () => {
  const text = `{
    // line comment
    "a": 1, /* block
    comment */ "b": [1, 2,],
  }`;
  assert.deepEqual(parseJsonc(text), { a: 1, b: [1, 2] });
});

test('keeps comment markers and commas inside strings', () => {
  assert.deepEqual(parseJsonc('{ "url": "https://x//y", "s": "a,}", "q": "\\"//" }'), {
    url: 'https://x//y',
    s: 'a,}',
    q: '"//',
  });
});

test('reports syntax errors from JSON.parse', () => {
  assert.throws(() => parseJsonc('{ "a": }'), SyntaxError);
});
