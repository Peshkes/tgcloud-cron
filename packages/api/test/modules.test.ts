import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withModules } from '../src/modules.js';

test('adds modules for one run', () => {
  assert.deepEqual(withModules({ schema: 's' }, { 'endpoints/x': 'x' }), {
    schema: 's',
    'endpoints/x': 'x',
  });
});

test('refuses to shadow a project module', () => {
  assert.throws(() => withModules({ 'endpoints/x': 'mine' }, { 'endpoints/x': 'x' }), /reserved/);
});
